import type { Context, SnapshotCell, SnapshotNode } from "../types.js";
import type { FigmaComponentSet, FigmaLayer, FigmaVariant, makeVariableResolver } from "../reference/components.js";
import { colorDistance, isTransparent } from "../color.js";

/**
 * Proposes C7 mappings: for each Figma component set, which captured element looks like it and which state
 * shows each variant. Mapping by hand is the main upkeep cost of C7; this turns it into confirming a list.
 * Scores compare measurable properties only (size, radius, padding, gap, fill, text size and weight, shadow).
 */

export interface Candidate {
  element: string;
  score: number;
  /** Best captured state per variant name. */
  states: Record<string, { state: string; nth: number; score: number }>;
  why: string[];
}

export interface Suggestion {
  figma: string;
  mapped?: string;
  candidates: Candidate[];
}

const px = (v: string | undefined) => (v && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);

function selectorOf(n: SnapshotNode): string | null {
  if (n.testId) return `[data-testid=${n.testId}]`;
  if (n.component) return `[data-ds-component=${n.component}]`;
  return null;
}

function firstText(variant: FigmaVariant): FigmaLayer | undefined {
  return variant.layers.find((l) => l.text);
}

export function scoreNode(
  variant: FigmaVariant,
  node: SnapshotNode,
  ctx: Context,
  resolveVar: ReturnType<typeof makeVariableResolver>,
): { score: number; why: string[] } {
  const root = variant.layers[0];
  if (!root) return { score: 0, why: [] };
  let got = 0;
  let max = 0;
  const why: string[] = [];
  const feature = (weight: number, ok: number, label: string) => {
    max += weight;
    got += weight * ok;
    if (ok >= 0.99) why.push(label);
  };
  const [, , fw, fh] = root.box;
  const near = (a: number, b: number, tol: number) => (Math.abs(a - b) <= tol ? 1 : Math.max(0, 1 - Math.abs(a - b) / Math.max(b, 1)));
  if (root.sizing?.[1] === "FIXED") feature(2, near(node.box.height, fh, 1), `height ${fh}`);
  else feature(1, near(node.box.height, fh, Math.max(2, fh * 0.15)) * 0.8, `height ≈ ${fh}`);
  if (root.sizing?.[0] === "FIXED") feature(2, near(node.box.width, fw, 1), `width ${fw}`);
  if (root.radius !== undefined) {
    const r = px(node.css["border-top-left-radius"]);
    feature(2, r !== null && Math.abs(r - root.radius) <= 1 ? 1 : 0, `radius ${root.radius}`);
  }
  if (root.pad) {
    const ins = node.layout?.insets;
    const sides = ["top", "right", "bottom", "left"] as const;
    const hit = ins ? sides.filter((s, i) => Math.abs((ins[s] ?? 0) - root.pad![i]!) <= 1).length : 0;
    feature(2, hit / 4, `padding ${root.pad.join("/")}`);
  }
  if (root.gap !== undefined && root.align?.[0] !== "SPACE_BETWEEN" && node.layout?.childGaps.length) {
    feature(1, Math.abs(node.layout.childGaps[0]!.gap - root.gap) <= 1 ? 1 : 0, `gap ${root.gap}`);
  }
  const bg = node.css["background-color"];
  if (root.fill) {
    const want = resolveVar(root.fill.v, ctx.figmaMode, root.fill.c);
    const d = want && bg && !isTransparent(bg) ? colorDistance(want.value, bg, ctx.backdrop) : null;
    feature(2, d !== null && d <= 2 ? 1 : 0, `fill ${root.fill.v ?? root.fill.c}`);
  } else feature(1, !bg || isTransparent(bg) ? 1 : 0, "no fill");
  const t = firstText(variant)?.text;
  if (t) {
    const fs = px(node.css["font-size"]);
    feature(1, fs !== null && Math.abs(fs - t.size) <= 0.5 ? 1 : 0, `text ${t.size}px`);
    const fwt = parseFloat(node.css["font-weight"] ?? "");
    feature(0.5, !Number.isNaN(fwt) && Math.abs(fwt - t.weight) <= 50 ? 1 : 0, `weight ${t.weight}`);
    feature(0.5, node.text ? 1 : 0, "has text");
  }
  if (root.shadow) feature(1, node.css["box-shadow"] && node.css["box-shadow"] !== "none" && !/^rgba\(0, 0, 0, 0\)[^,]*$/.test(node.css["box-shadow"]) ? 1 : 0, "shadow");
  return { score: max ? got / max : 0, why };
}

export function suggestMappings(
  sets: FigmaComponentSet[],
  cells: SnapshotCell[],
  opts: { contexts: Context[]; resolveVar: ReturnType<typeof makeVariableResolver>; mapped?: Map<string, string>; top?: number },
): Suggestion[] {
  const top = opts.top ?? 3;
  return sets.map((set) => {
    const byElement = new Map<string, Candidate>();
    for (const cell of cells) {
      const ctx = opts.contexts.find((c) => c.name === cell.context);
      if (!ctx) continue;
      const seen = new Map<string, number>();
      for (const node of cell.nodes) {
        const sel = selectorOf(node);
        if (!sel) continue;
        const nth = seen.get(sel) ?? 0;
        seen.set(sel, nth + 1);
        if (node.box.width < 4 || node.box.height < 4) continue;
        for (const variant of set.variants) {
          const s = scoreNode(variant, node, ctx, opts.resolveVar);
          const c = byElement.get(sel) ?? { element: sel, score: 0, states: {}, why: [] };
          const prev = c.states[variant.name];
          if (!prev || s.score > prev.score) c.states[variant.name] = { state: cell.state, nth, score: s.score };
          if (s.score > c.score) {
            c.score = s.score;
            c.why = s.why;
          }
          byElement.set(sel, c);
        }
      }
    }
    // An element should explain the set as a whole: average its best score per variant.
    const ranked = [...byElement.values()]
      .map((c) => ({ ...c, score: Object.values(c.states).reduce((a, s) => a + s.score, 0) / Math.max(1, set.variants.length) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
    return { figma: set.name, mapped: opts.mapped?.get(set.name), candidates: ranked };
  });
}

/** YAML for `figmaComponents`, ready to paste after a human check. */
export function suggestionYaml(s: Suggestion): string {
  const c = s.candidates[0];
  if (!c) return `# ${s.figma}: no candidate element in the captured states`;
  const lines = [`  - figma: ${JSON.stringify(s.figma)}            # score ${c.score.toFixed(2)}: ${c.why.slice(0, 4).join(", ")}`, `    element: "${c.element}"`, "    variants:"];
  for (const [variant, st] of Object.entries(c.states)) {
    const value = st.score < 0.5 ? "null   # no state looks like it" : st.nth ? `{ state: ${st.state}, nth: ${st.nth} }` : st.state;
    lines.push(`      ${JSON.stringify(variant)}: ${value}`);
  }
  return lines.join("\n");
}
