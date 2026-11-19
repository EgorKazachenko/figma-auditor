import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import type { StaticHit } from "../types.js";
import { blameFile } from "../git.js";

export interface ScanOptions {
  repo: string;
  include: string[];
  extensions: string[];
  exclude: string[];
  /** Custom properties declared by the theme files; other known names are discovered across the whole include tree. */
  knownVars: Iterable<string>;
  /** Variables with these prefixes are provided at runtime (Tailwind, the browser) and never reported as unknown. */
  knownVarPrefixes?: string[];
  /** File extensions where hex colours count as hard-coded UI colours. */
  hexExtensions?: string[];
  blame?: boolean;
}

const COLOR_UTILS = "bg|text|border(?:-[trblxy])?|fill|stroke|from|via|to|shadow|ring|outline|decoration|divide|placeholder|caret|accent";
// Only utilities whose values belong to a design scale. Widths, heights and offsets are layout, not tokens.
const SPACING_UTILS = "p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y";
const RADIUS_UTILS = "rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?";
const TYPE_UTILS = "text|leading";
const arbitraryPx = (utils: string) => new RegExp(`(?<![\\w-])-?(?:${utils})-\\[-?\\d*\\.?\\d+(?:px|rem)\\]`, "g");

// Arbitrary colours in any CSS colour syntax: [#1877d7], [rgb(24,119,215)], [hsl(…)], [oklch(…)], [color(…)].
const RE_TW_COLOR = new RegExp(
  `(?<![\\w-])-?(?:${COLOR_UTILS})-\\[(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\\([^\\]\\s]*\\))\\]`,
  "g",
);
// Inline style objects in JSX: style={{ paddingLeft: 10 }} or { gap: "6px" }. Zero is never drift.
const RE_INLINE_SPACING = /(?<![\w.])(?:padding|margin)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?\s*:\s*(?:-?\d*\.?\d+(?![\w.])|["'`]-?\d*\.?\d+(?:px|rem)["'`])|(?<![\w.])(?:gap|rowGap|columnGap)\s*:\s*(?:\d*\.?\d+(?![\w.])|["'`]\d*\.?\d+(?:px|rem)["'`])/g;
const RE_INLINE_RADIUS = /(?<![\w.])border(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:\s*(?:\d*\.?\d+(?![\w.])|["'`]\d*\.?\d+(?:px|rem)["'`])/g;
// Plain CSS declarations; custom property definitions are tokens and are skipped.
const RE_CSS_SPACING_DECL = /^\s*(padding|margin|gap|row-gap|column-gap|padding-[a-z-]+|margin-[a-z-]+)\s*:\s*([^;]+);?/;
const RE_CSS_RADIUS_DECL = /^\s*(border-radius|border-[a-z-]+-radius)\s*:\s*([^;]+);?/;
const RE_LENGTH = /(?<![\w.(,-])-?\d*\.?\d+(?:px|rem)(?![\w(])/g;
/** Margins above this are layout offsets, not spacing steps. */
const MAX_SCANNED_MARGIN = 64;
const RE_TW_SPACING = arbitraryPx(SPACING_UTILS);
const RE_TW_RADIUS = arbitraryPx(RADIUS_UTILS);
const RE_TW_TYPE = arbitraryPx(TYPE_UTILS);
const RE_HEX = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const RE_VAR_USE = /var\(\s*(--[a-zA-Z0-9-_]+)/g;
const RE_VAR_DEF_CSS = /(--[a-zA-Z0-9-_]+)\s*:/g;
const RE_VAR_DEF_TS = /["'`](--[a-zA-Z0-9-_]+)["'`]\s*[:,)]/g;

/**
 * Is line i inside a style object? Looks a few lines back for style={{, style: {, CSSProperties or sx=,
 * so option objects such as floating-ui's shift({ padding: 8 }) are not taken for styles.
 */
function inStyleContext(lines: string[], i: number): boolean {
  for (let j = i; j >= Math.max(0, i - 6); j--) {
    const l = lines[j]!;
    if (/\b(?:style|sx)\s*=\s*\{|\bstyle\s*:\s*\{|CSSProperties|\bstyles?\s*=\s*\{/.test(l)) return true;
    if (j < i && /^\s*\}\)?[;,]?\s*$/.test(l)) return false; // an object closed before this line
  }
  return false;
}

/** Length in px of the number in a match: "px-[0.625rem]" → 10, "paddingLeft: 10" → 10, "'6px'" → 6. */
export function lengthPx(match: string, remPx = 16): number {
  const m = /(-?\d*\.?\d+)(px|rem)?(?![\d.])/.exec(match.replace(/^[^:[]*[:[]\s*/, ""));
  if (!m) return NaN;
  const v = Math.abs(parseFloat(m[1]!));
  return m[2] === "rem" ? v * remPx : v;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*");
}

// Exclude entries are path prefixes ("src/tests"), bare directory names ("__tests__") or globs with * and **.
export function isExcluded(rel: string, patterns: string[]): boolean {
  return patterns.some((e) => {
    if (e.includes("*")) {
      const re = new RegExp(
        "^" +
          e
            .split("**")
            .map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
            .join(".*") +
          "$",
      );
      return re.test(rel);
    }
    return rel === e || rel.startsWith(e + "/") || rel.split("/").includes(e);
  });
}

export function listFiles(opts: Pick<ScanOptions, "repo" | "include" | "extensions" | "exclude">): string[] {
  const out: string[] = [];
  const excluded = (rel: string) => isExcluded(rel, opts.exclude);
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(opts.repo, abs).split(sep).join("/");
      if (excluded(rel)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (opts.extensions.includes(extname(name))) out.push(rel);
    }
  };
  for (const inc of opts.include) walk(join(opts.repo, inc));
  return out.sort();
}

export interface ScanTextOptions {
  knownVarPrefixes?: string[];
  hexExtensions?: string[];
  /** Receives problems with inline directives (an ignore without a reason). */
  warnings?: string[];
}

/**
 * Inline suppression: `design-auditor-ignore <category|rule|*> -- <reason>` covers its own line,
 * `design-auditor-ignore-next-line …` the next one. Works in //, /* *\/ and {/* *\/} comments. A reason is required.
 */
export function parseIgnoreDirective(line: string): { nextLine: boolean; category: string; reason?: string } | null {
  const at = line.indexOf("design-auditor-ignore");
  if (at < 0) return null;
  const rest = line
    .slice(at)
    .replace(/\*\/\s*\}?\s*$/, "")
    .trim();
  const m = /^design-auditor-ignore(-next-line)?(?:\s+(?!--)(\S+))?(?:\s+--\s*(.*))?$/.exec(rest);
  if (!m) return null;
  const reason = m[3]?.trim();
  return { nextLine: Boolean(m[1]), category: m[2] ?? "*", reason: reason || undefined };
}

/** Scans one file's text. Exported for tests; `known` is the set of declared custom properties. */
export function scanText(file: string, text: string, known: Set<string>, opts: ScanTextOptions = {}): StaticHit[] {
  const hits: StaticHit[] = [];
  const isCss = file.endsWith(".css");
  const hexHere = isCss || (opts.hexExtensions ?? [".tsx"]).some((ext) => file.endsWith(ext));
  const prefixes = opts.knownVarPrefixes ?? ["--tw-"];
  const lines = text.split("\n");
  const add = (rule: StaticHit["rule"], lineNo: number, index: number, match: string, line: string) =>
    hits.push({ rule, file, line: lineNo, column: index + 1, match, snippet: line.trim().slice(0, 160) });

  const ignores = new Map<number, { category: string; reason: string }[]>();
  lines.forEach((line, i) => {
    const d = parseIgnoreDirective(line);
    if (!d) return;
    if (!d.reason) {
      opts.warnings?.push(`${file}:${i + 1}: design-auditor-ignore without a reason is not applied (write "-- <why>")`);
      return;
    }
    const target = d.nextLine ? i + 2 : i + 1;
    ignores.set(target, [...(ignores.get(target) ?? []), { category: d.category, reason: d.reason }]);
  });

  lines.forEach((line, i) => {
    const n = i + 1;
    if (isCommentLine(line)) return;
    const covered: [number, number][] = [];

    for (const m of line.matchAll(RE_TW_COLOR)) {
      add("tailwind-arbitrary-color", n, m.index!, m[0], line);
      covered.push([m.index!, m.index! + m[0].length]);
    }
    if (!isCss) {
      for (const m of line.matchAll(RE_TW_SPACING)) add("tailwind-arbitrary-spacing", n, m.index!, m[0], line);
      for (const m of line.matchAll(RE_TW_RADIUS)) add("tailwind-arbitrary-radius", n, m.index!, m[0], line);
      for (const m of line.matchAll(RE_TW_TYPE)) add("tailwind-arbitrary-type", n, m.index!, m[0], line);
      if (/\.(tsx|jsx)$/.test(file) && inStyleContext(lines, i)) {
        for (const m of line.matchAll(RE_INLINE_SPACING)) if (lengthPx(m[0]) !== 0) add("inline-style-spacing", n, m.index!, m[0], line);
        for (const m of line.matchAll(RE_INLINE_RADIUS)) if (lengthPx(m[0]) !== 0) add("inline-style-radius", n, m.index!, m[0], line);
      }
    } else {
      const sp = RE_CSS_SPACING_DECL.exec(line);
      const rd = sp ? null : RE_CSS_RADIUS_DECL.exec(line);
      const decl = sp ?? rd;
      if (decl && !/var\(|calc\(|env\(/.test(decl[2]!)) {
        const isMargin = decl[1]!.startsWith("margin");
        const valueAt = line.indexOf(decl[2]!);
        const seenValues = new Set<string>();
        for (const m of decl[2]!.matchAll(RE_LENGTH)) {
          const v = lengthPx(m[0]);
          if (v === 0 || (isMargin && Math.abs(v) > MAX_SCANNED_MARGIN) || seenValues.has(m[0])) continue;
          seenValues.add(m[0]);
          add(sp ? "css-spacing" : "css-radius", n, valueAt + m.index!, `${decl[1]}: ${m[0]}`, line);
        }
      }
    }

    if (hexHere) for (const m of line.matchAll(RE_HEX)) {
      const at = m.index!;
      if (covered.some(([a, b]) => at >= a && at < b)) continue;
      if (isCss) {
        // Only values of declarations count; custom property definitions are the tokens themselves.
        const decl = /^\s*([a-z-]+)\s*:/.exec(line);
        if (!decl || decl[1]!.startsWith("--")) continue;
        add("hex-in-css", n, at, m[0], line);
      } else {
        add("hex-in-source", n, at, m[0], line);
      }
    }

    for (const m of line.matchAll(RE_VAR_USE)) {
      const name = m[1]!;
      if (known.has(name) || prefixes.some((p) => name.startsWith(p))) continue;
      // var(--x, fallback) still renders; it is a weaker signal than a bare var(--x).
      add("unknown-css-var", n, m.index!, name, line);
    }
  });
  for (const h of hits) {
    const d = ignores.get(h.line);
    // The C1 check decides whether the directive's category fits the hit (rule or verdict category).
    if (d?.length) h.suppress = d.length === 1 ? d[0] : { category: d.map((x) => x.category).join(" "), reason: d.map((x) => x.reason).join("; ") };
  }
  return hits;
}

/** Collects custom property names defined anywhere in the scanned files, so local definitions are not reported. */
export function discoverDefinitions(files: { file: string; text: string }[]): Set<string> {
  const names = new Set<string>();
  for (const { file, text } of files) {
    const re = file.endsWith(".css") ? RE_VAR_DEF_CSS : RE_VAR_DEF_TS;
    for (const m of text.matchAll(re)) names.add(m[1]!);
    for (const m of text.matchAll(/setProperty\(\s*["'`](--[a-zA-Z0-9-_]+)/g)) names.add(m[1]!);
  }
  return names;
}

export function scanRepo(opts: ScanOptions): { hits: StaticHit[]; files: number; warnings: string[] } {
  const read = (file: string) => ({ file, text: readFileSync(join(opts.repo, file), "utf8") });
  const files = listFiles(opts).map(read);
  // Definitions are discovered across the whole include tree: excluded folders (themes, tests) still define variables.
  const defFiles = listFiles({ ...opts, exclude: ["node_modules"], extensions: [".css", ".ts", ".tsx", ".js", ".jsx"] }).map(read);
  const known = discoverDefinitions(defFiles);
  for (const k of opts.knownVars) known.add(k);
  const warnings: string[] = [];
  const hits = files.flatMap(({ file, text }) =>
    scanText(file, text, known, { knownVarPrefixes: opts.knownVarPrefixes, hexExtensions: opts.hexExtensions, warnings }),
  );
  if (opts.blame) {
    const byFile = new Map<string, StaticHit[]>();
    for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
    for (const [file, list] of byFile) {
      const blame = blameFile(opts.repo, file);
      for (const h of list) {
        const b = blame.get(h.line);
        if (b) h.blame = b;
      }
    }
  }
  return { hits, files: files.length, warnings };
}
