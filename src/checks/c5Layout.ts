import type { Finding, Rect, SnapshotCell, SnapshotNode } from "../types.js";
import { makeFinding, cellWhere } from "../findings.js";

export interface C5Options {
  /** Smallest overlap of two text boxes that counts, in px². */
  minOverlapPx: number;
}

const label = (n: SnapshotNode) => n.component ?? n.testId ?? n.path;

/** Overlap of two text boxes. Thin slivers from tight line-height are ignored by the caller's thresholds. */
export function overlap(a: Rect, b: Rect): { w: number; h: number; area: number } {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : { w: 0, h: 0, area: 0 };
}

function related(a: SnapshotNode, b: SnapshotNode): boolean {
  const la = a.layout!;
  const lb = b.layout!;
  return la.ancestors.includes(lb.id) || lb.ancestors.includes(la.id);
}

/** Pairs of elements whose own text boxes overlap: the clearest visible layout bug. */
export function textOverlaps(nodes: SnapshotNode[], minOverlapPx: number): [SnapshotNode, SnapshotNode, number][] {
  const out: [SnapshotNode, SnapshotNode, number][] = [];
  const withText = nodes.filter((n) => n.layout && n.layout.textRects.length);
  for (let i = 0; i < withText.length; i++) {
    for (let j = i + 1; j < withText.length; j++) {
      const a = withText[i]!;
      const b = withText[j]!;
      // Overlays (tooltips, menus, dialogs) are meant to sit on top of other text.
      if (related(a, b) || a.layout!.overlay || b.layout!.overlay) continue;
      let worst = 0;
      for (const ra of a.layout!.textRects)
        for (const rb of b.layout!.textRects) {
          const o = overlap(ra, rb);
          // A real collision covers a good part of a line, not the 1–2 px a tight line-height produces.
          if (o.area >= minOverlapPx && o.w >= 2 && o.h >= 0.3 * Math.min(ra.h, rb.h)) worst = Math.max(worst, o.area);
        }
      if (worst > 0) out.push([a, b, Math.round(worst)]);
    }
  }
  return out;
}

const clips = (v: string | undefined) => v === "hidden" || v === "clip";

/** C5 · layout integrity: overlapping text, covered elements, clipped or cropped text, horizontal page overflow. */
export function checkLayout(cells: SnapshotCell[], opts: C5Options): Finding[] {
  const findings: Finding[] = [];
  for (const cell of cells) {
    const where = cellWhere(cell);
    const base = (n: SnapshotNode | null) => ({
      check: "C5" as const,
      gap: "B" as const,
      context: cell.context,
      cell: where,
      component: n ? n.component ?? n.testId : undefined,
      links: { source: n?.path },
      evidence: { screenshot: cell.screenshot, box: n?.box },
    });

    if (cell.page && cell.page.scrollWidth > cell.page.innerWidth + 1) {
      findings.push(
        makeFinding(
          {
            ...base(null),
            category: "page-horizontal-overflow",
            severity: "medium",
            title: `Page is ${cell.page.scrollWidth}px wide in a ${cell.page.innerWidth}px viewport and scrolls sideways`,
            actual: { value: `${cell.page.scrollWidth}px`, source: "document scroll width" },
            expected: { value: `≤ ${cell.page.innerWidth}px`, source: "viewport width" },
          },
          [cell.surface, cell.state, cell.context],
        ),
      );
    }

    // Text partly outside the viewport where nobody can scroll to it (a menu pushed past the left edge at
    // 200 % zoom, a popover wider than a narrow panel). Text entirely off screen is hidden on purpose.
    if (cell.page && cell.texts) {
      const vw = cell.page.innerWidth;
      const scrollsSideways = cell.page.scrollWidth > vw + 1;
      const seen = new Set<string>();
      for (const t of cell.texts) {
        if (t.viewFraction === 0 || t.box.width <= 2 || t.box.height <= 2) continue;
        const left = t.box.x;
        const right = t.box.x + t.box.width;
        const pastLeft = left < -1 && right > 0 ? -left : 0;
        const pastRight = !scrollsSideways && right > vw + 1 && left < vw ? right - vw : 0;
        if (!pastLeft && !pastRight) continue;
        if (seen.has(t.anchor)) continue;
        seen.add(t.anchor);
        const edge = pastLeft ? "left" : "right";
        const px = Math.round(pastLeft || pastRight);
        findings.push(
          makeFinding(
            {
              ...base(null),
              component: t.anchor,
              category: "off-viewport",
              severity: "high",
              title: `${t.anchor} "${t.text.slice(0, 40)}": cut off by the ${edge} edge of the ${vw}px viewport (${px}px outside, cannot be scrolled to)`,
              actual: { value: `${px}px outside`, source: `text box x ${Math.round(left)}–${Math.round(right)}` },
              expected: { value: `inside 0–${vw}px`, source: "viewport" },
              links: { source: t.path },
              evidence: { screenshot: cell.screenshot, box: t.box },
            },
            // One finding per element and state; widths and zoom levels where it happens merge into it.
            [t.anchor, cell.surface, cell.state, cell.context, edge],
          ),
        );
      }
    }

    const overlaps = textOverlaps(cell.nodes, opts.minOverlapPx);
    const partners = new Map<string, Set<string>>();
    for (const [a, b, area] of overlaps) {
      const sorted = [label(a), label(b)].sort();
      const la = sorted[0]!;
      const lb = sorted[1]!;
      for (const [x, y] of [[label(a), label(b)], [label(b), label(a)]] as const) {
        const set = partners.get(x) ?? new Set<string>();
        set.add(y);
        partners.set(x, set);
      }
      findings.push(
        makeFinding(
          {
            ...base(a),
            category: "text-overlap",
            severity: "high",
            title: `Text of ${la} and ${lb} overlaps (${area}px²)`,
            related: [lb],
          },
          [cell.surface, cell.state, cell.context, la, lb],
        ),
      );
    }

    for (const n of cell.nodes) {
      const l = n.layout;
      if (!l) continue;
      const css = n.css;

      // Covered by something that is not an overlay; overlaps already reported as text collisions are not repeated.
      const occ = l.occlusion;
      const mine = [...(partners.get(label(n)) ?? new Set<string>())];
      const isPartner = (b: string) => mine.some((p) => b === p || b.includes(`"${p}"`));
      const coveredBy = occ.by.filter((b) => !isPartner(b));
      if ((n.hasText || l.interactive) && occ.covered >= 2 && !occ.overlayOnly && coveredBy.length) {
        findings.push(
          makeFinding(
            {
              ...base(n),
              category: "occluded",
              severity: l.interactive && occ.centerCovered ? "high" : "medium",
              title: `${label(n)} is covered by ${coveredBy.join(", ")} at ${occ.covered} of ${occ.samples} points${l.interactive && occ.centerCovered ? "; its centre cannot be clicked" : ""}`,
              related: coveredBy,
            },
            [cell.surface, cell.state, cell.context, n.path, coveredBy.join("|")],
          ),
        );
      }

      if (!n.hasText) continue;

      if (clips(css["overflow-x"]) && l.scroll.cw > 0 && l.scroll.w > l.scroll.cw + 1 && css["text-overflow"] !== "ellipsis") {
        findings.push(
          makeFinding(
            {
              ...base(n),
              category: "text-clipped",
              severity: "medium",
              title: `${label(n)}: text is cut off at ${l.scroll.cw}px without an ellipsis (needs ${l.scroll.w}px)`,
              actual: { value: `${l.scroll.w}px of text in ${l.scroll.cw}px`, source: "scroll width" },
            },
            [cell.surface, cell.state, cell.context, n.path, "x"],
          ),
        );
      } else if (
        clips(css["overflow-y"]) &&
        l.scroll.ch > 0 &&
        l.scroll.h > l.scroll.ch + 1 &&
        (css["-webkit-line-clamp"] ?? "none") === "none"
      ) {
        findings.push(
          makeFinding(
            {
              ...base(n),
              category: "text-clipped",
              severity: "medium",
              title: `${label(n)}: text is cut off at ${l.scroll.ch}px height (needs ${l.scroll.h}px)`,
              actual: { value: `${l.scroll.h}px of text in ${l.scroll.ch}px`, source: "scroll height" },
            },
            [cell.surface, cell.state, cell.context, n.path, "y"],
          ),
        );
      }

      if (
        (css["overflow-x"] ?? "visible") === "visible" &&
        /nowrap|pre$/.test(css["white-space"] ?? "") &&
        l.scroll.cw > 0 &&
        l.scroll.w > l.scroll.cw + 1
      ) {
        findings.push(
          makeFinding(
            {
              ...base(n),
              category: "text-spills",
              severity: "medium",
              title: `${label(n)}: text runs ${l.scroll.w - l.scroll.cw}px past its ${l.scroll.cw}px box`,
              actual: { value: `${l.scroll.w}px`, source: "scroll width" },
              expected: { value: `≤ ${l.scroll.cw}px`, source: "box width" },
            },
            [cell.surface, cell.state, cell.context, n.path],
          ),
        );
      }

      if (l.visibleFraction > 0.02 && l.visibleFraction < 0.98) {
        findings.push(
          makeFinding(
            {
              ...base(n),
              category: "text-cropped",
              severity: "medium",
              title: `${label(n)}: only ${Math.round(l.visibleFraction * 100)}% visible, cropped by a container with hidden overflow`,
              actual: { value: `${Math.round(l.visibleFraction * 100)}%`, source: "visible area" },
            },
            [cell.surface, cell.state, cell.context, n.path],
          ),
        );
      }
    }
  }
  return findings;
}
