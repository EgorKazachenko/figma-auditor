import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";
import type { CodeTokenDecl } from "../types.js";
import { tokenKey } from "../names.js";

export interface LoadedCss {
  /** All files concatenated in cascade order, with @import rules inlined. */
  css: string;
  files: string[];
  decls: CodeTokenDecl[];
  warnings: string[];
}

/** Splits "a, b" at top-level commas only, ignoring commas inside parentheses. */
export function splitTopLevel(input: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Reads `env(-neon-color-x, fallback)` into its parts. Returns null for values that are not a single env() call. */
export function parseEnv(value: string): { envName: string; fallback?: string } | null {
  const v = value.trim();
  if (!v.toLowerCase().startsWith("env(") || !v.endsWith(")")) return null;
  let depth = 0;
  for (let i = 3; i < v.length; i++) {
    if (v[i] === "(") depth++;
    if (v[i] === ")") depth--;
    if (depth === 0 && i !== v.length - 1) return null; // env(...) followed by more tokens
  }
  const inner = v.slice(4, -1);
  const [name, ...rest] = splitTopLevel(inner);
  if (!name) return null;
  const fallback = rest.length ? rest.join(", ") : undefined;
  return fallback === undefined ? { envName: name } : { envName: name, fallback };
}

function importPath(rule: AtRule): string | null {
  const m = /^(?:url\()?\s*["']([^"']+)["']\s*\)?/.exec(rule.params.trim());
  return m ? m[1]! : null;
}

function contextSelector(decl: Declaration): string {
  const chain: string[] = [];
  let node: { type: string; parent?: unknown } | undefined = decl.parent as { type: string; parent?: unknown } | undefined;
  while (node && node.type !== "root" && node.type !== "document") {
    if (node.type === "rule") chain.unshift((node as unknown as Rule).selector);
    else if (node.type === "atrule") chain.unshift(`@${(node as unknown as AtRule).name} ${(node as unknown as AtRule).params}`);
    node = node.parent as { type: string; parent?: unknown } | undefined;
  }
  return chain.join(" > ");
}

/**
 * Loads a theme entry CSS file, follows relative @import rules in order and lists every custom property declaration.
 * Imports that cannot be resolved (package aliases, URLs) are reported as warnings and skipped.
 */
export function loadThemeCss(entry: string, repoRoot: string): LoadedCss {
  const files: string[] = [];
  const decls: CodeTokenDecl[] = [];
  const warnings: string[] = [];
  const chunks: string[] = [];
  const seen = new Set<string>();

  const visit = (file: string) => {
    const abs = resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    if (!existsSync(abs)) {
      warnings.push(`Missing CSS file: ${relative(repoRoot, abs)}`);
      return;
    }
    const source = readFileSync(abs, "utf8");
    const root = postcss.parse(source, { from: abs });

    root.walkAtRules("import", (rule) => {
      const p = importPath(rule);
      if (p && (p.startsWith(".") || p.startsWith("/"))) visit(resolve(dirname(abs), p));
      else warnings.push(`Skipped @import ${rule.params} in ${relative(repoRoot, abs)}`);
      rule.remove();
    });

    files.push(relative(repoRoot, abs));
    root.walkDecls((d) => {
      if (!d.prop.startsWith("--")) return;
      const env = parseEnv(d.value);
      const decl: CodeTokenDecl = {
        name: d.prop,
        key: tokenKey(d.prop),
        selector: contextSelector(d),
        file: relative(repoRoot, abs),
        line: d.source?.start?.line ?? 0,
        value: d.value.trim(),
      };
      if (env) {
        decl.envName = env.envName;
        if (env.fallback !== undefined) decl.fallback = env.fallback;
      }
      decls.push(decl);
    });
    chunks.push(`/* ${relative(repoRoot, abs)} */\n${root.toString()}`);
  };

  visit(entry);
  return { css: chunks.join("\n"), files, decls, warnings };
}

/** Parses `html[data-theme="opera"][data-product="Neon"]` style selectors into attribute requirements. */
function selectorRequirements(part: string): Record<string, string | null> | null {
  const s = part.trim();
  const m = /^(?:html|:root)((?:\[[^\]]+\])*)$/i.exec(s);
  if (!m) return null;
  const req: Record<string, string | null> = {};
  for (const attr of m[1]!.matchAll(/\[\s*([\w-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]/g)) {
    req[attr[1]!] = attr[2] ?? null;
  }
  return req;
}

/**
 * Returns the declaration that wins for `name` on an <html> element with the given attributes,
 * using attribute-count specificity and source order. Declarations inside at-rules are ignored.
 */
export function winningDecl(
  decls: CodeTokenDecl[],
  name: string,
  html: Record<string, string>,
): CodeTokenDecl | undefined {
  let best: { decl: CodeTokenDecl; spec: number; order: number } | undefined;
  decls.forEach((d, order) => {
    if (d.name !== name || d.selector.includes("@")) return;
    for (const part of splitTopLevel(d.selector)) {
      const req = selectorRequirements(part);
      if (!req) continue;
      const ok = Object.entries(req).every(([k, v]) => (v === null ? k in html : html[k] === v));
      if (!ok) continue;
      const spec = Object.keys(req).length;
      if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) best = { decl: d, spec, order };
    }
  });
  return best?.decl;
}

/** Reads a spacing scale such as `"aria-3": "8px"` from a Tailwind config file without executing it. */
export function readTailwindScale(file: string, prefix: string): number[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`["']${esc}[\\w.]+["']\\s*:\\s*["'](\\d+(?:\\.\\d+)?)px["']`, "g");
  const values = new Set<number>();
  for (const m of text.matchAll(re)) values.add(parseFloat(m[1]!));
  return [...values].sort((a, b) => a - b);
}
