import type { Context, Finding, SnapshotCell, SnapshotNode } from "../types.js";
import { colorDistance, isTransparent, normalizeColor } from "../color.js";
import { makeFinding, cellWhere } from "../findings.js";

export interface C3Options {
  contexts: Context[];
  spacingScale: number[];
  radiusScale: number[];
  colorDeltaE: number;
  px: number;
  /** Margins above this are layout offsets, not spacing tokens (and auto margins resolve to large values). */
  maxCheckedSpacing?: number;
}

const SIDES = ["top", "right", "bottom", "left"] as const;
const SPACING_PROPS = ["padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "row-gap", "column-gap"];
const MARGIN_PROPS = ["margin-top", "margin-right", "margin-bottom", "margin-left"];
const RADIUS_PROPS = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
const round = (n: number) => Math.round(n * 100) / 100;

export interface PaletteEntry {
  name: string;
  color: string;
}

export function paletteOf(tokens: SnapshotCell["tokens"]): PaletteEntry[] {
  return Object.entries(tokens)
    .filter(([, v]) => v.color && !isTransparent(v.color))
    .map(([name, v]) => ({ name, color: v.color! }));
}

export function nearestToken(value: string, palette: PaletteEntry[], backdrop: string): { token: PaletteEntry; dE: number } | null {
  let best: { token: PaletteEntry; dE: number } | null = null;
  for (const t of palette) {
    const d = colorDistance(value, t.color, backdrop);
    if (d !== null && (!best || d < best.dE)) best = { token: t, dE: d };
  }
  return best;
}

/** Pixel value of a computed length, or null for keywords and percentages. */
export function px(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? parseFloat(m[1]!) : null;
}

function nodeLabel(n: SnapshotNode): string {
  return n.component ?? n.testId ?? n.path;
}

/** C3 · off-token values (gap B): element styles inside the product compared with the palette and scales of its theme. */
export function checkOffToken(cells: SnapshotCell[], opts: C3Options): Finding[] {
  const findings: Finding[] = [];
  for (const cell of cells) {
    const ctx = opts.contexts.find((c) => c.name === cell.context);
    const backdrop = ctx?.backdrop ?? "#ffffff";
    const palette = paletteOf(cell.tokens);
    const where = cellWhere(cell);

    for (const node of cell.nodes) {
      // Visually hidden elements (the sr-only pattern: 1×1 px, margin -1px, clipped) are not seen by anyone.
      if (node.box.width <= 2 && node.box.height <= 2) continue;
      const colorProps: string[] = [];
      if (!isTransparent(node.css["background-color"] ?? "transparent")) colorProps.push("background-color");
      if (node.hasText) colorProps.push("color");
      for (const side of SIDES) {
        const w = px(node.css[`border-${side}-width`]);
        if (w && w > 0) colorProps.push(`border-${side}-color`);
      }

      for (const prop of colorProps) {
        const value = node.css[prop];
        if (!value || isTransparent(value) || palette.length === 0) continue;
        const near = nearestToken(value, palette, backdrop);
        if (!near || near.dE <= opts.colorDeltaE) continue;
        const actualHex = normalizeColor(value) ?? value;
        findings.push(
          makeFinding(
            {
              check: "C3",
              category: "off-token-color",
              gap: "B",
              severity: "medium",
              title: `${nodeLabel(node)}: ${prop} ${actualHex} matches no token (nearest ${near.token.name}, ΔE ${round(near.dE)})`,
              component: node.component ?? node.testId,
              context: cell.context,
              cell: where,
              property: prop,
              expected: { value: normalizeColor(near.token.color) ?? near.token.color, source: "nearest token", token: near.token.name },
              actual: { value: actualHex, source: `computed style in ${cell.browser}` },
              deltaE: round(near.dE),
              links: { source: node.path },
              evidence: { swatches: [normalizeColor(near.token.color) ?? near.token.color, actualHex], screenshot: cell.screenshot, box: node.box },
            },
            [cell.surface, cell.state, cell.context, node.path, prop, actualHex],
          ),
        );
      }

      const scaleCheck = (props: string[], scale: number[], category: string, allowExtra: (v: number) => boolean) => {
        if (scale.length === 0) return;
        const seen = new Set<number>();
        for (const prop of props) {
          const v = px(node.css[prop]);
          if (v === null || v === 0 || allowExtra(v) || seen.has(v)) continue;
          // Scale membership allows sub-pixel rounding only (rem → px), not a whole pixel: with steps of 2px,
          // a 1px tolerance would accept every odd value between steps.
          if (scale.some((s) => Math.abs(s - v) <= Math.min(opts.px, 0.5))) continue;
          seen.add(v);
          const nearest = scale.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
          findings.push(
            makeFinding(
              {
                check: "C3",
                category,
                gap: "B",
                severity: "low",
                title: `${nodeLabel(node)}: ${prop} ${v}px is off the scale (nearest ${nearest}px)`,
                component: node.component ?? node.testId,
                context: cell.context,
                cell: where,
                property: prop,
                expected: { value: `${nearest}px`, source: "scale" },
                actual: { value: `${v}px`, source: `computed style in ${cell.browser}` },
                links: { source: node.path },
                evidence: { screenshot: cell.screenshot, box: node.box },
              },
              [cell.surface, cell.state, cell.context, node.path, category, v],
            ),
          );
        }
      };
      scaleCheck(SPACING_PROPS, opts.spacingScale, "off-scale-spacing", () => false);
      // Margins: equal left and right margins usually mean auto-centring; very large ones are layout offsets.
      const maxSpacing = opts.maxCheckedSpacing ?? 64;
      const centred = px(node.css["margin-left"]) !== null && node.css["margin-left"] === node.css["margin-right"];
      scaleCheck(
        MARGIN_PROPS.filter((p) => !(centred && (p === "margin-left" || p === "margin-right"))),
        opts.spacingScale,
        "off-scale-margin",
        (v) => Math.abs(v) > maxSpacing,
      );

      // What the user sees between children, however it is built (gap, margins or both).
      const seenGaps = new Set<number>();
      for (const g of node.layout?.childGaps ?? []) {
        if (g.gap === 0 || seenGaps.has(g.gap) || g.gap > maxSpacing) continue;
        if (opts.spacingScale.some((s) => Math.abs(s - g.gap) <= opts.px)) continue;
        seenGaps.add(g.gap);
        const nearest = opts.spacingScale.reduce((a, b) => (Math.abs(b - g.gap) < Math.abs(a - g.gap) ? b : a));
        const parts = [`gap ${g.fromGap}px`, g.marginA ? `margin ${g.marginA}px on ${g.a}` : "", g.marginB ? `margin ${g.marginB}px on ${g.b}` : ""]
          .filter(Boolean)
          .join(" + ");
        findings.push(
          makeFinding(
            {
              check: "C3",
              category: "off-scale-visual-gap",
              gap: "B",
              severity: "low",
              title: `${nodeLabel(node)}: ${g.gap}px between ${g.a} and ${g.b} is off the scale (nearest ${nearest}px); made of ${parts}`,
              component: node.component ?? node.testId,
              context: cell.context,
              cell: where,
              property: g.axis === "x" ? "column spacing" : "row spacing",
              expected: { value: `${nearest}px`, source: "scale" },
              actual: { value: `${g.gap}px`, source: parts },
              links: { source: node.path },
              evidence: { screenshot: cell.screenshot, box: node.box },
            },
            [cell.surface, cell.state, cell.context, node.path, "visual-gap", g.gap],
          ),
        );
      }
      // Pills and circles use huge radii on purpose.
      scaleCheck(RADIUS_PROPS, opts.radiusScale, "off-scale-radius", (v) => v >= 999 || v >= Math.min(node.box.width, node.box.height) / 2 - 0.5);
    }
  }
  return findings;
}
