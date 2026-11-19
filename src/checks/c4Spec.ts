import type { Finding, SnapshotCell, SnapshotNode } from "../types.js";
import { makeFinding, cellWhere } from "../findings.js";

/**
 * Spacing a component is designed with, usually read from its Figma auto-layout:
 * padding = inside the component, gap = between its children. null leaves a side unchecked
 * (for example a fixed-height row whose content is centred).
 */
export interface ComponentSpec {
  name: string;
  match: { testId?: string; component?: string };
  padding?: [number | null, number | null, number | null, number | null];
  gap?: number;
  figma?: string;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

function globMatch(pattern: string | undefined, value: string | null): boolean {
  if (!pattern || value === null) return false;
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(value);
}

export function matchesSpec(node: SnapshotNode, spec: ComponentSpec): boolean {
  return globMatch(spec.match.testId, node.testId) || globMatch(spec.match.component, node.component);
}

const px = (v: string | undefined) => (v && /px$/.test(v) ? parseFloat(v) : 0);

/**
 * C4 · component spec. Compares what the user sees (measured distances) with the spec first,
 * then how it is built. "Looks right, built differently" — spacing from child margins instead of
 * padding — is reported separately and lower: the picture matches, but background, hover area,
 * focus ring and click target do not.
 */
export function checkSpecs(cells: SnapshotCell[], specs: ComponentSpec[], tol: number): Finding[] {
  const findings: Finding[] = [];
  for (const cell of cells) {
    const where = cellWhere(cell);
    for (const node of cell.nodes) {
      for (const spec of specs.filter((s) => matchesSpec(node, s))) {
        const name = `${spec.name} (${node.testId ?? node.component})`;
        const base = {
          check: "C4" as const,
          gap: "A" as const,
          context: cell.context,
          cell: where,
          component: node.component ?? node.testId,
          links: { source: node.path, figma: spec.figma },
          evidence: { screenshot: cell.screenshot, box: node.box },
        };

        if (spec.padding) {
          const looksOff: string[] = [];
          const builtOff: string[] = [];
          SIDES.forEach((side, i) => {
            const want = spec.padding![i];
            if (want === null || want === undefined) return;
            const padding = px(node.css[`padding-${side}`]);
            const seen = node.layout?.insets?.[side] ?? padding;
            if (Math.abs(seen - want) > tol) looksOff.push(`${side} ${seen}px (spec ${want}px)`);
            else if (Math.abs(padding - want) > tol) builtOff.push(`${side} ${want}px comes from padding ${padding}px + child margin ${Math.round((seen - padding) * 10) / 10}px`);
          });
          if (looksOff.length)
            findings.push(
              makeFinding(
                {
                  ...base,
                  category: "spacing-differs-from-spec",
                  severity: "medium",
                  title: `${name}: inner spacing differs from the spec — ${looksOff.join(", ")}`,
                  expected: { value: spec.padding.map((v) => (v === null ? "·" : `${v}px`)).join(" "), source: "component spec" },
                  actual: { value: SIDES.map((s) => `${node.layout?.insets?.[s] ?? px(node.css[`padding-${s}`])}px`).join(" "), source: "measured inset" },
                },
                [cell.surface, cell.state, cell.context, node.path, spec.name, "padding"],
              ),
            );
          else if (builtOff.length)
            findings.push(
              makeFinding(
                {
                  ...base,
                  category: "spacing-mechanism",
                  severity: "low",
                  title: `${name}: looks like the spec, but ${builtOff.join("; ")}. Background, hover area and click target are smaller than designed`,
                  expected: { value: "padding", source: "component spec" },
                  actual: { value: "child margins", source: "computed style" },
                },
                [cell.surface, cell.state, cell.context, node.path, spec.name, "padding-mechanism"],
              ),
            );
        }

        if (spec.gap !== undefined) {
          for (const g of node.layout?.childGaps ?? []) {
            const between = `${g.a} → ${g.b}`;
            if (Math.abs(g.gap - spec.gap) > tol) {
              findings.push(
                makeFinding(
                  {
                    ...base,
                    category: "gap-differs-from-spec",
                    severity: "medium",
                    title: `${name}: ${g.gap}px between ${between}, spec ${spec.gap}px`,
                    expected: { value: `${spec.gap}px`, source: "component spec" },
                    actual: { value: `${g.gap}px`, source: `gap ${g.fromGap} + margins ${g.marginA} + ${g.marginB}` },
                  },
                  [cell.surface, cell.state, cell.context, node.path, spec.name, "gap", between],
                ),
              );
            } else if (Math.abs(g.fromGap - spec.gap) > tol) {
              findings.push(
                makeFinding(
                  {
                    ...base,
                    category: "gap-mechanism",
                    severity: "low",
                    title: `${name}: ${g.gap}px between ${between} matches the spec but comes from margins (gap ${g.fromGap}px). It breaks when items wrap, reorder or hide`,
                    expected: { value: `gap ${spec.gap}px`, source: "component spec" },
                    actual: { value: `margins ${g.marginA} + ${g.marginB}px`, source: "computed style" },
                  },
                  [cell.surface, cell.state, cell.context, node.path, spec.name, "gap-mechanism", between],
                ),
              );
            }
          }
        }
      }
    }
  }
  return findings;
}
