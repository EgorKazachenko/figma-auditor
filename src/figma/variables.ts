import type { Finding, ReferenceToken } from "../types.js";
import { toHex } from "../color.js";
import { cssVarName, tokenKey } from "../names.js";
import { makeFinding } from "../findings.js";

/**
 * Figma variables from the REST API (GET /v1/files/:key/variables/local, Enterprise), merged across files.
 * A product file usually holds only aliases; the values live in library files, through collections whose
 * modes stand for themes (Light/Dark) or products (Neon/Opera One/GX). Resolving a variable for a theme
 * means following aliases and picking, in every collection on the way, the mode the theme uses.
 */

export interface RestVariable {
  id: string;
  name: string;
  key?: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string };
  remote?: boolean;
}

export interface RestCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
  remote?: boolean;
}

export interface VariableGraph {
  variables: Map<string, RestVariable>;
  /** Variable key → variable: a library's own listing uses local ids ("VariableID:2439:84"), other files
   * reference the same variable as "VariableID:<key>/<node>", so aliases are matched by key as well. */
  byKey: Map<string, RestVariable>;
  collections: Map<string, RestCollection>;
  /** Files the graph was built from: key → version. */
  files: Record<string, { version?: string; name?: string }>;
}

/** "VariableID:9e76dee1…/3668:12" → "9e76dee1…"; local ids carry no key. */
export function keyOfId(id: string): string | undefined {
  return /^VariableID:([0-9a-f]{40})\//.exec(id)?.[1];
}

/** A variable by id, or by the key a remote reference carries. */
export function lookupVariable(g: VariableGraph, id: string): RestVariable | undefined {
  const direct = g.variables.get(id);
  const key = direct?.key ?? keyOfId(id);
  const own = key ? g.byKey.get(key) : undefined;
  // The library's own definition beats a consumer file's remote copy, whose aliases may lead nowhere.
  if (own && (!direct || (direct.remote && !own.remote))) return own;
  return direct ?? own;
}

export function buildVariableGraph(responses: { fileKey: string; json: any; version?: string; name?: string }[]): VariableGraph {
  const g: VariableGraph = { variables: new Map(), byKey: new Map(), collections: new Map(), files: {} };
  for (const r of responses) {
    const meta = r.json?.meta;
    if (!meta?.variables || !meta?.variableCollections) throw new Error(`${r.fileKey}: not a variables/local response`);
    g.files[r.fileKey] = { version: r.version, name: r.name };
    for (const c of Object.values<any>(meta.variableCollections)) {
      // A library's own (local) definition wins over the remote copy another file holds.
      if (!g.collections.has(c.id) || !c.remote) g.collections.set(c.id, c);
    }
    for (const v of Object.values<any>(meta.variables)) {
      if (!g.variables.has(v.id) || !v.remote) g.variables.set(v.id, v);
      const key = v.key ?? keyOfId(v.id);
      if (key && (!g.byKey.has(key) || !v.remote)) g.byKey.set(key, v);
    }
  }
  return g;
}

/**
 * Which mode a theme uses in each collection: collection name → mode names in order of preference.
 * The first name the collection has wins; otherwise its default mode. Example for Neon dark:
 * { Pairs: ["Dark"], Colors: ["Neon", "Dark Mode"], "✅ Mode": ["🌗 Dark"] }.
 */
export type ModeChoice = Record<string, string | string[]>;

function modeFor(c: RestCollection, choice: ModeChoice): string {
  const wanted = choice[c.name];
  const list = wanted === undefined ? [] : Array.isArray(wanted) ? wanted : [wanted];
  for (const name of list) {
    const m = c.modes.find((x) => x.name === name);
    if (m) return m.modeId;
  }
  return c.defaultModeId;
}

export interface Resolved {
  value?: string;
  kind: ReferenceToken["kind"];
  /** Variable names followed, first to last. */
  path: string[];
  /** Set when an alias points to a variable no fetched file holds. */
  missing?: { id: string; from: string };
}

const rgba = (v: any) => toHex({ r: Math.round(v.r * 255), g: Math.round(v.g * 255), b: Math.round(v.b * 255), a: typeof v.a === "number" ? v.a : 1 });

export function resolveVariable(g: VariableGraph, id: string, choice: ModeChoice): Resolved {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur = lookupVariable(g, id);
  let kind: ReferenceToken["kind"] = "other";
  let from = "";
  while (cur) {
    if (seen.has(cur.id)) return { kind, path, missing: { id: cur.id, from: `alias cycle at ${cur.name}` } };
    seen.add(cur.id);
    path.push(cur.name);
    kind = cur.resolvedType === "COLOR" ? "color" : cur.resolvedType === "FLOAT" ? "number" : "other";
    const c = g.collections.get(cur.variableCollectionId);
    const modeId = c ? modeFor(c, choice) : Object.keys(cur.valuesByMode)[0]!;
    const raw = cur.valuesByMode[modeId] ?? Object.values(cur.valuesByMode)[0];
    if (raw && typeof raw === "object" && (raw as any).type === "VARIABLE_ALIAS") {
      from = cur.name;
      const next = lookupVariable(g, (raw as any).id);
      if (!next) return { kind, path, missing: { id: (raw as any).id, from } };
      cur = next;
      continue;
    }
    if (kind === "color" && raw && typeof raw === "object") return { kind, path, value: rgba(raw) };
    if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return { kind, path, value: String(raw) };
    return { kind, path };
  }
  return { kind, path, missing: { id, from: "unknown variable" } };
}

/** Name the code uses for a variable: its WEB code syntax (var(--x) → --x), else a slug of its Figma name. */
export function codeNameOf(v: RestVariable): string {
  const web = v.codeSyntax?.WEB;
  if (web) return cssVarName(web) ?? web;
  return v.name;
}

/** Words and numbers of a name, numbers without leading zeros: "Text/T-04" → [text, t, 4]. */
function nameParts(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p));
}

/**
 * How well a Figma variable's name matches the CSS name it exports: numbers count most ("N-92-60%" vs
 * "--color-neutral-92-60"), then words. Picks the intended variable when several export one name.
 */
export function nameMatch(figmaName: string, codeName: string): number {
  const f = nameParts(figmaName);
  const c = nameParts(codeName);
  const nums = (xs: string[]) => xs.filter((x) => /^\d+$/.test(x)).join("-");
  let score = nums(f) === nums(c) ? 10 : 0;
  for (const w of new Set(f)) if (!/^\d+$/.test(w) && c.includes(w)) score += 1;
  return score;
}

export interface RestTokensResult {
  tokens: ReferenceToken[];
  unresolved: { variable: string; mode: string; from: string }[];
}

/**
 * Reference tokens for every variable that has WEB code syntax (what the code is meant to use), resolved
 * for each theme. Variables without code syntax are internal steps (primitives, pairs) and are skipped,
 * unless `includeWithoutCodeSyntax` is set.
 */
export function toReferenceTokens(
  g: VariableGraph,
  modes: Record<string, ModeChoice>,
  opts: { includeWithoutCodeSyntax?: boolean; fileKey?: string; include?: string[]; exclude?: string[] } = {},
): RestTokensResult {
  const tokens: ReferenceToken[] = [];
  const unresolved: RestTokensResult["unresolved"] = [];
  const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  const inc = (opts.include ?? []).map(glob);
  const exc = (opts.exclude ?? []).map(glob);
  // When several variables export one CSS name (a Figma-side defect reported by codeSyntaxFindings), the
  // reference uses the one whose Figma name matches that CSS name, not whichever came last.
  const owner = new Map<string, RestVariable>();
  for (const v of g.variables.values()) {
    if (!v.codeSyntax?.WEB) continue;
    const k = tokenKey(v.codeSyntax.WEB);
    const prev = owner.get(k);
    if (!prev || nameMatch(v.name, v.codeSyntax.WEB) > nameMatch(prev.name, prev.codeSyntax!.WEB!)) owner.set(k, v);
  }
  for (const v of g.variables.values()) {
    if (!v.codeSyntax?.WEB && !opts.includeWithoutCodeSyntax) continue;
    if (v.codeSyntax?.WEB && owner.get(tokenKey(v.codeSyntax.WEB)) !== v) continue;
    const n = codeNameOf(v);
    if (inc.length && !inc.some((r) => r.test(n))) continue;
    if (exc.some((r) => r.test(n))) continue;
    for (const [mode, choice] of Object.entries(modes)) {
      const r = resolveVariable(g, v.id, choice);
      if (r.value === undefined) {
        if (r.missing) unresolved.push({ variable: v.name, mode, from: r.missing.from });
        continue;
      }
      const name = codeNameOf(v);
      tokens.push({
        name,
        figmaName: v.codeSyntax?.WEB ?? v.name,
        kind: r.kind,
        mode,
        value: r.value,
        source: { type: "figma-rest", fileKey: opts.fileKey, fileName: `${v.name}${r.path.length > 1 ? ` → ${r.path.slice(1).join(" → ")}` : ""}` },
      });
    }
  }
  return { tokens, unresolved };
}

/**
 * Figma-side defects in code syntax: two different variables exporting the same CSS name (a designer picks
 * one, the developer gets the other), and code syntax that is not a CSS variable at all.
 */
export function codeSyntaxFindings(g: VariableGraph, modes: Record<string, ModeChoice>, figmaUrl?: (v: RestVariable) => string | undefined): Finding[] {
  const byName = new Map<string, RestVariable[]>();
  const out: Finding[] = [];
  // A library variable appears twice when both the library and a consumer file were fetched (local id
  // and remote id); count it once.
  const unique = new Map<string, RestVariable>();
  for (const v of g.variables.values()) {
    const k = v.key ?? keyOfId(v.id) ?? v.id;
    if (!unique.has(k) || !v.remote) unique.set(k, v);
  }
  for (const v of unique.values()) {
    const web = v.codeSyntax?.WEB;
    if (!web) continue;
    if (!cssVarName(web)) {
      out.push(
        makeFinding(
          { check: "C2", category: "figma-code-syntax-invalid", gap: "A", severity: "low", title: `Figma variable ${v.name} exports "${web}", which is not a CSS variable`, token: v.name, links: { figma: figmaUrl?.(v) } },
          [v.id, web],
        ),
      );
      continue;
    }
    const k = tokenKey(web);
    byName.set(k, [...(byName.get(k) ?? []), v]);
  }
  for (const [, vars] of byName) {
    const distinct = [...new Map(vars.map((v) => [v.name, v])).values()];
    if (distinct.length < 2) continue;
    const values = Object.keys(modes).map((m) => {
      const vals = distinct.map((v) => resolveVariable(g, v.id, modes[m]!).value ?? "?");
      return `${m}: ${distinct.map((v, i) => `${v.name} = ${vals[i]}`).join(", ")}`;
    });
    const resolvedAll = Object.keys(modes).every((m) => distinct.every((v) => resolveVariable(g, v.id, modes[m]!).value !== undefined));
    const differ = resolvedAll && Object.keys(modes).some((m) => new Set(distinct.map((v) => resolveVariable(g, v.id, modes[m]!).value)).size > 1);
    const web = distinct[0]!.codeSyntax!.WEB!;
    out.push(
      makeFinding(
        {
          check: "C2",
          category: "figma-code-syntax-collision",
          gap: "A",
          severity: differ ? "high" : resolvedAll ? "low" : "medium",
          title: `In Figma, ${distinct.map((v) => v.name).join(" and ")} all export ${web}${differ ? "; their values differ, so code cannot match both" : resolvedAll ? "; same values today" : "; values not compared (library file not fetched)"}`,
          token: cssVarName(web) ?? web,
          expected: { value: "one Figma variable per CSS name", source: "Figma code syntax" },
          actual: { value: values.join(" · "), source: "Figma REST variables" },
          links: { figma: figmaUrl?.(distinct[0]!) },
        },
        [web, ...distinct.map((v) => v.name).sort()],
      ),
    );
  }
  return out;
}
