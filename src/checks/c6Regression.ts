import type { Finding, SnapshotCell, SnapshotNode, CellRef } from "../types.js";
import { makeFinding, cellWhere } from "../findings.js";

/** One element's place on screen, as stored in a baseline. */
export interface LayoutEntry {
  key: string;
  label: string;
  box: { x: number; y: number; width: number; height: number };
  /** Keys of stored elements that contain this one. */
  ancestors: string[];
  text: string;
}

export interface LayoutBaseline {
  cell: CellRef;
  browser: string;
  commit?: string;
  at: string;
  page?: SnapshotCell["page"];
  entries: LayoutEntry[];
}

const labelOf = (n: SnapshotNode) => n.component ?? n.testId ?? n.path;

/** Stable keys: label plus occurrence index, so repeated list items keep their identity in order. */
export function layoutEntries(cell: SnapshotCell): LayoutEntry[] {
  const seen = new Map<string, number>();
  const keys = cell.nodes.map((n) => {
    const l = labelOf(n);
    const i = seen.get(l) ?? 0;
    seen.set(l, i + 1);
    return `${l}#${i}`;
  });
  const byId = new Map(cell.nodes.map((n, i) => [n.layout?.id ?? i, keys[i]!]));
  return cell.nodes.map((n, i) => ({
    key: keys[i]!,
    label: labelOf(n),
    box: n.box,
    ancestors: (n.layout?.ancestors ?? []).map((a) => byId.get(a)).filter((k): k is string => Boolean(k)),
    text: n.text,
  }));
}

export interface LayoutChange {
  kind: "moved" | "resized" | "missing" | "added";
  entry: LayoutEntry;
  before?: LayoutEntry["box"];
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
}

/**
 * Element-level layout diff. An element that moved together with its parent is not reported again:
 * only the outermost element of a shift is named, which is where the change was made.
 */
export function compareLayout(before: LayoutEntry[], after: LayoutEntry[], tol: number): LayoutChange[] {
  const prev = new Map(before.map((e) => [e.key, e]));
  const next = new Map(after.map((e) => [e.key, e]));
  const delta = new Map<string, { dx: number; dy: number }>();
  const changes: LayoutChange[] = [];

  for (const e of after) {
    const b = prev.get(e.key);
    if (!b) continue;
    delta.set(e.key, { dx: e.box.x - b.box.x, dy: e.box.y - b.box.y });
  }

  const shiftedWithParent = (e: LayoutEntry, d: { dx: number; dy: number }) =>
    e.ancestors.some((a) => {
      const pd = delta.get(a);
      return pd && (Math.abs(pd.dx) > tol || Math.abs(pd.dy) > tol) && Math.abs(pd.dx - d.dx) <= tol && Math.abs(pd.dy - d.dy) <= tol;
    });

  for (const e of after) {
    const b = prev.get(e.key);
    if (!b) {
      if (!e.ancestors.some((a) => !prev.has(a) && next.has(a))) changes.push({ kind: "added", entry: e });
      continue;
    }
    const d = delta.get(e.key)!;
    const dw = e.box.width - b.box.width;
    const dh = e.box.height - b.box.height;
    const moved = (Math.abs(d.dx) > tol || Math.abs(d.dy) > tol) && !shiftedWithParent(e, d);
    if (Math.abs(dw) > tol || Math.abs(dh) > tol) changes.push({ kind: "resized", entry: e, before: b.box, dx: d.dx, dy: d.dy, dw, dh });
    else if (moved) changes.push({ kind: "moved", entry: e, before: b.box, dx: d.dx, dy: d.dy });
  }

  for (const b of before) {
    if (next.has(b.key)) continue;
    if (b.ancestors.some((a) => !next.has(a) && prev.has(a))) continue; // its container is gone too
    changes.push({ kind: "missing", entry: b });
  }
  return changes;
}

const px = (n: number) => `${n > 0 ? "+" : ""}${n}px`;

/** C6 · layout regression: what moved, changed size, appeared or disappeared since the baseline run. */
export function regressionFindings(
  cell: SnapshotCell,
  baseline: LayoutBaseline,
  changes: LayoutChange[],
  evidence: { diff?: string; baselineShot?: string; changedRatio?: number },
): Finding[] {
  const where = cellWhere(cell);
  const since = baseline.commit ? `baseline ${baseline.commit.slice(0, 9)}` : `baseline from ${baseline.at}`;
  const findings = changes.map((c) => {
    const title =
      c.kind === "moved"
        ? `${c.entry.label} moved ${px(c.dx!)} horizontally, ${px(c.dy!)} vertically since the ${since}`
        : c.kind === "resized"
          ? `${c.entry.label} changed size by ${px(c.dw!)} × ${px(c.dh!)} since the ${since}`
          : c.kind === "missing"
            ? `${c.entry.label} is gone since the ${since}`
            : `${c.entry.label} appeared since the ${since}`;
    return makeFinding(
      {
        check: "C6",
        category: `layout-${c.kind}`,
        gap: "B",
        severity: c.kind === "added" ? "low" : "medium",
        title,
        component: c.entry.label,
        context: cell.context,
        cell: where,
        expected: c.before ? { value: `${c.before.x},${c.before.y} ${c.before.width}×${c.before.height}`, source: since } : undefined,
        actual: c.kind === "missing" ? undefined : { value: `${c.entry.box.x},${c.entry.box.y} ${c.entry.box.width}×${c.entry.box.height}`, source: cell.browser },
        links: { source: c.entry.key },
        evidence: { screenshot: cell.screenshot, box: c.entry.box, diff: evidence.diff, baseline: evidence.baselineShot },
      },
      [cell.surface, cell.state, cell.context, cell.viewport, c.entry.key, c.kind],
    );
  });

  // Pixels changed but no tracked element explains it: something unmarked moved or restyled.
  if (!findings.length && (evidence.changedRatio ?? 0) > 0.001) {
    findings.push(
      makeFinding(
        {
          check: "C6",
          category: "layout-pixels-changed",
          gap: "B",
          severity: "low",
          title: `${((evidence.changedRatio ?? 0) * 100).toFixed(2)}% of the screen changed since the ${since}, outside the tracked elements`,
          context: cell.context,
          cell: where,
          links: {},
          evidence: { screenshot: cell.screenshot, diff: evidence.diff, baseline: evidence.baselineShot },
        },
        [cell.surface, cell.state, cell.context, cell.viewport, "pixels"],
      ),
    );
  }
  return findings;
}
