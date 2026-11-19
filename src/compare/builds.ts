import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SnapshotCell, SnapshotNode } from "../types.js";
import { cellName } from "../findings.js";
import { colorDistance, isTransparent, normalizeColor } from "../color.js";
import { STYLE_PROPERTIES } from "../contract.js";
import { compareLayout, layoutEntries, type LayoutChange } from "../checks/c6Regression.js";

/**
 * Parity of two captures of the same product: React vs Svelte rewrite, Neon vs Opera One build, before
 * vs after a refactor. Cells are matched by surface/state/theme/viewport, elements by test id (or DS
 * component) and order, then styles, geometry and text are compared. Different browsers are fine: the
 * comparison is on values, not pixels.
 */

export interface StyleDiff {
  element: string;
  property: string;
  a: string;
  b: string;
  deltaE?: number;
}

export interface CellDiff {
  cell: string;
  layout: LayoutChange[];
  styles: StyleDiff[];
  text: { element: string; a: string; b: string }[];
}

export interface CompareResult {
  a: string;
  b: string;
  matchedCells: number;
  onlyInA: string[];
  onlyInB: string[];
  cells: CellDiff[];
  /** The same difference across cells, counted once: element · property · a → b. */
  grouped: { element: string; property: string; a: string; b: string; cells: string[]; deltaE?: number }[];
}

export function loadCapture(path: string): SnapshotCell[] {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "snapshot.json") : path;
  if (!existsSync(file)) throw new Error(`${path}: no snapshot.json (run the audit with --runtime to capture)`);
  return JSON.parse(readFileSync(file, "utf8")) as SnapshotCell[];
}

const keyed = (cell: SnapshotCell) => {
  const entries = layoutEntries(cell);
  return new Map(entries.map((e, i) => [e.key, cell.nodes[i]!]));
};

const SKIP = new Set(["display", "position", "z-index", "align-items", "justify-content", "flex-direction", "overflow-x", "overflow-y"]);

function diffStyles(element: string, na: SnapshotNode, nb: SnapshotNode, backdrop: string, colorDeltaE: number, px: number): StyleDiff[] {
  const out: StyleDiff[] = [];
  for (const [prop, spec] of Object.entries(STYLE_PROPERTIES)) {
    if (SKIP.has(prop)) continue;
    const a = na.css[prop];
    const b = nb.css[prop];
    if (a === undefined || b === undefined || a === b) continue;
    if (spec.kind === "color") {
      if (isTransparent(a) && isTransparent(b)) continue;
      const d = colorDistance(a, b, backdrop);
      if (d !== null && d <= colorDeltaE) continue;
      out.push({ element, property: prop, a: normalizeColor(a) ?? a, b: normalizeColor(b) ?? b, deltaE: d === null ? undefined : Math.round(d * 100) / 100 });
    } else if (spec.kind === "length" || spec.kind === "lengths") {
      const pa = a.split(/\s+/).map(parseFloat);
      const pb = b.split(/\s+/).map(parseFloat);
      const close = pa.length === pb.length && pa.every((x, i) => (Number.isNaN(x) && Number.isNaN(pb[i]!)) || Math.abs(x - pb[i]!) <= px);
      if (!close) out.push({ element, property: prop, a, b });
    } else if (spec.kind === "font-family") {
      const first = (s: string) => s.split(",")[0]!.trim().replace(/["']/g, "").toLowerCase();
      if (first(a) !== first(b)) out.push({ element, property: prop, a, b });
    } else out.push({ element, property: prop, a, b });
  }
  return out;
}

export function compareCaptures(
  a: SnapshotCell[],
  b: SnapshotCell[],
  opts: { colorDeltaE?: number; px?: number; backdrop?: (context: string) => string; labels?: [string, string] } = {},
): CompareResult {
  const colorDeltaE = opts.colorDeltaE ?? 2;
  const px = opts.px ?? 1;
  const byName = (cells: SnapshotCell[]) => new Map(cells.map((c) => [cellName(c), c]));
  const A = byName(a);
  const B = byName(b);
  const cells: CellDiff[] = [];
  for (const [name, ca] of A) {
    const cb = B.get(name);
    if (!cb) continue;
    const backdrop = opts.backdrop?.(ca.context) ?? (/dark/i.test(ca.context) ? "#000000" : "#ffffff");
    const ka = keyed(ca);
    const kb = keyed(cb);
    const styles: StyleDiff[] = [];
    const text: CellDiff["text"] = [];
    for (const [key, na] of ka) {
      const nb = kb.get(key);
      if (!nb) continue;
      styles.push(...diffStyles(key, na, nb, backdrop, colorDeltaE, px));
      if (na.hasText && nb.hasText && na.text !== nb.text) text.push({ element: key, a: na.text, b: nb.text });
    }
    cells.push({ cell: name, layout: compareLayout(layoutEntries(ca), layoutEntries(cb), px * 2), styles, text });
  }
  const grouped = new Map<string, CompareResult["grouped"][number]>();
  for (const c of cells)
    for (const s of c.styles) {
      const element = s.element.replace(/#\d+$/, "");
      const k = `${element}|${s.property}|${s.a}|${s.b}`;
      const g = grouped.get(k) ?? { element, property: s.property, a: s.a, b: s.b, cells: [], deltaE: s.deltaE };
      if (!g.cells.includes(c.cell)) g.cells.push(c.cell);
      grouped.set(k, g);
    }
  return {
    a: opts.labels?.[0] ?? "A",
    b: opts.labels?.[1] ?? "B",
    matchedCells: cells.length,
    onlyInA: [...A.keys()].filter((k) => !B.has(k)),
    onlyInB: [...B.keys()].filter((k) => !A.has(k)),
    cells,
    grouped: [...grouped.values()].sort((x, y) => y.cells.length - x.cells.length || x.element.localeCompare(y.element)),
  };
}

export function renderCompare(r: CompareResult, limit = 60): string {
  const layout = r.cells.flatMap((c) => c.layout.map((l) => ({ cell: c.cell, l })));
  const texts = r.cells.flatMap((c) => c.text.map((t) => ({ cell: c.cell, t })));
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    `# Parity: ${r.a} vs ${r.b}`,
    "",
    `${r.matchedCells} cells compared · ${r.grouped.length} style differences · ${layout.length} layout changes · ${texts.length} text differences`,
  ];
  if (r.onlyInA.length || r.onlyInB.length) lines.push("", `Only in ${r.a}: ${r.onlyInA.join(", ") || "—"} · only in ${r.b}: ${r.onlyInB.join(", ") || "—"}`);
  if (!r.grouped.length && !layout.length && !texts.length) {
    lines.push("", "The two captures match within the thresholds.");
    return lines.join("\n");
  }
  if (r.grouped.length) {
    lines.push("", "## Styles", "", `| Element | Property | ${r.a} | ${r.b} | Cells |`, "| --- | --- | --- | --- | --- |");
    for (const g of r.grouped.slice(0, limit))
      lines.push(`| ${esc(g.element)} | ${g.property} | ${esc(g.a)} | ${esc(g.b)}${g.deltaE !== undefined ? ` (ΔE ${g.deltaE})` : ""} | ${g.cells.length} |`);
    if (r.grouped.length > limit) lines.push("", `…and ${r.grouped.length - limit} more.`);
  }
  if (layout.length) {
    lines.push("", "## Layout", "");
    for (const { cell, l } of layout.slice(0, limit)) {
      const what = l.kind === "moved" ? `moved ${l.dx},${l.dy}px` : l.kind === "resized" ? `resized ${l.dw},${l.dh}px` : l.kind === "missing" ? `only in ${r.a}` : `only in ${r.b}`;
      lines.push(`- ${cell}: ${l.entry.key} ${what}`);
    }
  }
  if (texts.length) {
    lines.push("", "## Text", "");
    for (const { cell, t } of texts.slice(0, limit)) lines.push(`- ${cell}: ${t.element}: "${t.a}" → "${t.b}"`);
  }
  return lines.join("\n");
}
