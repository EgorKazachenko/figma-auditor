import { readFileSync } from "node:fs";
import type { ReferenceSource } from "../config.js";
import type { ReferenceToken } from "../types.js";
import { cssVarName } from "../names.js";
import { toHex } from "../color.js";
import { fromDtcg } from "./dtcg.js";
import { progress } from "../progress.js";
import { buildVariableGraph, toReferenceTokens, type ModeChoice, type VariableGraph } from "../figma/variables.js";
import { cachedFigma, figmaClient } from "../figma/rest.js";

/** Variable graphs loaded by figma-rest sources, for checks that look at Figma itself (code syntax). */
export interface ReferenceExtras {
  graphs: { graph: VariableGraph; modes: Record<string, ModeChoice>; files: string[] }[];
}

export function figmaNodeUrl(fileKey?: string, nodeId?: string): string | undefined {
  if (!fileKey) return undefined;
  const node = nodeId ? `?node-id=${nodeId.replace(/:/g, "-")}` : "";
  return `https://www.figma.com/design/${fileKey}/${node}`;
}

function kindOf(value: string): ReferenceToken["kind"] {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return "color";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  if (v.startsWith("Font(")) return "font";
  if (v.startsWith("Effect(")) return "effect";
  return "other";
}

/**
 * File captured from the Figma MCP `get_variable_defs` tool for one node:
 * { "source": { "fileKey", "nodeId", "fileName", "mode" }, "variables": { "var(--color-level-5)": "#f7f7f8", ... } }
 * One file covers one mode, because a node renders in one mode at a time.
 */
export function fromVariableDefs(json: any, origin = "figma-variable-defs"): ReferenceToken[] {
  const src = json?.source ?? {};
  const vars = json?.variables;
  if (!vars || typeof vars !== "object") throw new Error(`${origin}: expected a "variables" object`);
  if (!src.mode) throw new Error(`${origin}: expected source.mode (for example "light" or "dark")`);
  return Object.entries(vars as Record<string, string>).map(([figmaName, value]) => ({
    name: cssVarName(figmaName) ?? figmaName,
    figmaName,
    kind: kindOf(String(value)),
    mode: String(src.mode),
    value: String(value),
    source: {
      type: "figma-variable-defs",
      fileKey: src.fileKey,
      nodeId: src.nodeId,
      fileName: src.fileName,
      url: figmaNodeUrl(src.fileKey, src.nodeId),
    },
  }));
}

interface RestVariable {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, any>;
  codeSyntax?: { WEB?: string };
}
interface RestCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
}

/**
 * Response of GET /v1/files/:key/variables/local (Figma Enterprise).
 * Uses each variable's WEB code syntax as its name when set, and resolves aliases within the same mode name.
 */
export function fromRestVariables(json: any, fileKey: string | undefined, modeMap: Record<string, string> = {}): ReferenceToken[] {
  const variables: Record<string, RestVariable> = json?.meta?.variables ?? {};
  const collections: Record<string, RestCollection> = json?.meta?.variableCollections ?? {};
  const modeName = (collectionId: string, modeId: string) =>
    collections[collectionId]?.modes.find((m) => m.modeId === modeId)?.name ?? modeId;
  const mapMode = (name: string) => modeMap[name] ?? name.toLowerCase();

  const valueIn = (v: RestVariable, mode: string, depth = 0): any => {
    const coll = collections[v.variableCollectionId];
    const modeId =
      coll?.modes.find((m) => mapMode(m.name) === mode)?.modeId ?? coll?.defaultModeId ?? Object.keys(v.valuesByMode)[0];
    const raw = modeId ? v.valuesByMode[modeId] : undefined;
    if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
      const target = variables[raw.id];
      if (!target || depth > 10) return undefined;
      return valueIn(target, mode, depth + 1);
    }
    return raw;
  };

  const out: ReferenceToken[] = [];
  for (const v of Object.values(variables)) {
    const coll = collections[v.variableCollectionId];
    if (!coll) continue;
    const figmaName = v.codeSyntax?.WEB ?? v.name;
    for (const m of coll.modes) {
      const mode = mapMode(modeName(coll.id, m.modeId));
      const raw = valueIn(v, mode);
      if (raw === undefined) continue;
      let value: string;
      let kind: ReferenceToken["kind"];
      if (v.resolvedType === "COLOR") {
        value = toHex({ r: raw.r * 255, g: raw.g * 255, b: raw.b * 255, a: raw.a ?? 1 });
        kind = "color";
      } else if (v.resolvedType === "FLOAT") {
        value = String(raw);
        kind = "number";
      } else {
        value = String(raw);
        kind = "other";
      }
      out.push({
        name: cssVarName(figmaName) ?? figmaName,
        figmaName,
        kind,
        mode,
        value,
        source: { type: "figma-rest-variables", fileKey, url: figmaNodeUrl(fileKey) },
      });
    }
  }
  return out;
}

async function fetchRestVariables(fileKey: string): Promise<any> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("FIGMA_TOKEN is not set; it is needed to read variables from the Figma REST API");
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
    headers: { "X-Figma-Token": token },
  });
  if (!res.ok) throw new Error(`Figma REST API answered ${res.status} for file ${fileKey}`);
  return res.json();
}

/** Loads every configured reference source and merges them. Later sources win for the same name and mode. */
export async function loadReference(
  sources: ReferenceSource[],
  warnings: string[] = [],
  extras: ReferenceExtras = { graphs: [] },
  opts: { refresh?: boolean; client?: ReturnType<typeof figmaClient> } = {},
): Promise<ReferenceToken[]> {
  const merged = new Map<string, ReferenceToken>();
  for (const s of sources) {
    let tokens: ReferenceToken[];
    if (s.type === "figma-rest") {
      const client = opts.client !== undefined ? opts.client : figmaClient();
      const loaded = [];
      for (const key of s.files ?? []) {
        const f = await cachedFigma(client, s.cacheDir!, key, "variables", `/v1/files/${key}/variables/local`, { refresh: opts.refresh });
        progress(`Figma: ${f.name ?? key} (${f.from === "network" ? "downloaded" : "unchanged, from cache"})`);
        loaded.push({ fileKey: key, json: f.json, version: f.version, name: f.name });
      }
      const graph = buildVariableGraph(loaded);
      const res = toReferenceTokens(graph, s.modes ?? {}, { fileKey: s.files?.[0], include: s.include, exclude: s.exclude });
      extras.graphs.push({ graph, modes: s.modes ?? {}, files: s.files ?? [] });
      if (res.unresolved.length) {
        // Name where the aliases lead, so the missing library file can be added to `files`.
        const leaving = new Map<string, number>();
        for (const u of res.unresolved) {
          const v = [...graph.variables.values()].find((x) => x.name === u.from);
          const col = v ? graph.collections.get(v.variableCollectionId)?.name ?? "?" : u.from;
          leaving.set(col, (leaving.get(col) ?? 0) + 1);
        }
        warnings.push(
          `figma-rest: ${new Set(res.unresolved.map((u) => u.variable)).size} variables could not be resolved: their aliases leave the fetched files through ${[...leaving.entries()].map(([c, n]) => `${c} (${n})`).join(", ")}. Add the library file that defines those collections to "files".`,
        );
      }
      tokens = res.tokens;
    } else if (s.type === "figma-variable-defs") {
      if (!s.path) throw new Error("figma-variable-defs source needs a path");
      tokens = fromVariableDefs(JSON.parse(readFileSync(s.path, "utf8")), s.path);
    } else if (s.type === "dtcg") {
      if (!s.path || !s.mode) throw new Error("dtcg source needs a path and a mode");
      const res = fromDtcg(JSON.parse(readFileSync(s.path, "utf8")), {
        mode: s.mode,
        origin: s.path,
        nameTemplate: s.nameTemplate,
        separator: s.separator,
        remPx: s.remPx,
      });
      warnings.push(...res.warnings);
      tokens = res.tokens;
    } else {
      const json = s.path ? JSON.parse(readFileSync(s.path, "utf8")) : await fetchRestVariables(s.fileKey ?? "");
      tokens = fromRestVariables(json, s.fileKey, s.modeMap);
    }
    for (const t of tokens) merged.set(`${t.name}@${t.mode}`, t);
  }
  return [...merged.values()];
}

/** Numeric scale values such as spacing_1..4, radius_2 or --spacing-2 (DTCG) found in the reference. */
export function referenceScale(tokens: ReferenceToken[], prefix: string | string[]): number[] {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  const values = new Set<number>();
  for (const t of tokens) if (t.kind === "number" && prefixes.some((p) => t.name.startsWith(p))) values.add(parseFloat(t.value));
  return [...values].sort((a, b) => a - b);
}
