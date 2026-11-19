import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CellRef, SnapshotCell } from "./types.js";
import { layoutEntries, type LayoutBaseline } from "./checks/c6Regression.js";
import { cellWhere } from "./findings.js";

export const cellKey = (c: CellRef) =>
  `${c.surface}__${c.state}__${c.context}${c.viewport ? `__${c.viewport}` : ""}`.replace(/[^\w.-]+/g, "_");

export function loadBaseline(dir: string, cell: SnapshotCell): { baseline: LayoutBaseline; shot?: string } | null {
  const json = join(dir, `${cellKey(cell)}.json`);
  if (!existsSync(json)) return null;
  const png = join(dir, `${cellKey(cell)}.png`);
  return { baseline: JSON.parse(readFileSync(json, "utf8")) as LayoutBaseline, shot: existsSync(png) ? png : undefined };
}

/** Stores the cell's element boxes and its screenshot as the new baseline. */
export function saveBaseline(dir: string, cell: SnapshotCell, runDir: string, meta: { commit?: string; at: string }) {
  mkdirSync(dir, { recursive: true });
  const baseline: LayoutBaseline = {
    cell: cellWhere(cell),
    browser: cell.browser,
    commit: meta.commit,
    at: meta.at,
    page: cell.page,
    entries: layoutEntries(cell),
  };
  writeFileSync(join(dir, `${cellKey(cell)}.json`), JSON.stringify(baseline, null, 2));
  if (cell.screenshot && existsSync(join(runDir, cell.screenshot))) copyFileSync(join(runDir, cell.screenshot), join(dir, `${cellKey(cell)}.png`));
}

/**
 * Pixel diff of two screenshots of the same renderer. Anti-aliasing differences are ignored.
 * Returns null when the images cannot be compared (missing file, different size).
 */
export function diffScreenshots(beforePng: string, afterPng: string, outPng: string): { changed: number; ratio: number } | null {
  if (!existsSync(beforePng) || !existsSync(afterPng)) return null;
  const a = PNG.sync.read(readFileSync(beforePng));
  const b = PNG.sync.read(readFileSync(afterPng));
  if (a.width !== b.width || a.height !== b.height) return null;
  const out = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  writeFileSync(outPng, PNG.sync.write(out));
  return { changed, ratio: changed / (a.width * a.height) };
}
