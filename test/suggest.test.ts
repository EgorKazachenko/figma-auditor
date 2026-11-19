// Mapping suggestions: which captured element looks like a Figma component set, and in which state.
import { describe, expect, it } from "vitest";
import { scoreNode, suggestMappings, suggestionYaml } from "../src/figma/suggest.js";
import { makeVariableResolver, type FigmaComponentSet } from "../src/reference/components.js";
import type { Context, SnapshotCell, SnapshotNode } from "../src/types.js";

const ctx: Context = { name: "light", html: {}, colorScheme: "light", figmaMode: "light", backdrop: "#ffffff" };
const resolveVar = makeVariableResolver([], "light");
const chip: FigmaComponentSet = {
  id: "1",
  name: "Chip",
  page: "",
  variantProps: { State: ["Default", "Hover"] },
  variants: [
    { id: "2", name: "State=Default", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 100, 32], sizing: ["HUG", "FIXED"], radius: 8, pad: [0, 0, 0, 8] }, { path: "/L", type: "TEXT", box: [8, 8, 50, 17], text: { chars: "x", size: 14, weight: 400, font: "SF Pro", lh: "auto" } }] },
    { id: "3", name: "State=Hover", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 100, 32], sizing: ["HUG", "FIXED"], radius: 8, pad: [0, 0, 0, 8], fill: { c: "#e9ebec66" } }, { path: "/L", type: "TEXT", box: [8, 8, 50, 17], text: { chars: "x", size: 14, weight: 400, font: "SF Pro", lh: "auto" } }] },
  ],
};
const node = (testId: string, css: Record<string, string>, box = { x: 0, y: 0, width: 98, height: 32 }, insets = { top: 0, right: 0, bottom: 0, left: 8 }): SnapshotNode => ({
  component: null,
  testId,
  path: testId,
  box,
  hasText: true,
  text: "Opera AI",
  css: { "border-top-left-radius": "8px", "font-size": "14px", "font-weight": "400", "background-color": "rgba(0, 0, 0, 0)", ...css },
  layout: { id: 0, ancestors: [], interactive: true, overlay: false, role: null, scroll: { w: 0, h: 0, cw: 0, ch: 0 }, visibleFraction: 1, textRects: [], occlusion: { samples: 5, covered: 0, centerCovered: false, by: [], overlayOnly: false }, insets, childGaps: [] },
});
const cell = (state: string, nodes: SnapshotNode[]): SnapshotCell => ({ surface: "s", state, context: "light", url: "", browser: "B", tokens: {}, nodes });

describe("mapping suggestions", () => {
  const cells = [
    cell("input", [node("chip", {}), node("send", { "border-top-left-radius": "16px" }, { x: 0, y: 0, width: 32, height: 32 }, { top: 8, right: 8, bottom: 8, left: 8 })]),
    cell("chip-hover", [node("chip", { "background-color": "rgba(233, 235, 236, 0.4)" }), node("send", { "border-top-left-radius": "16px" }, { x: 0, y: 0, width: 32, height: 32 })]),
  ];

  it("scores measurable properties and says which matched", () => {
    const s = scoreNode(chip.variants[1]!, cells[1]!.nodes[0]!, ctx, resolveVar);
    expect(s.score).toBeGreaterThan(0.9);
    expect(s.why).toEqual(expect.arrayContaining(["height 32", "radius 8", "padding 0/0/0/8", "fill #e9ebec66", "text 14px"]));
  });

  it("ranks the right element first and picks the state that shows each variant", () => {
    const [s] = suggestMappings([chip], cells, { contexts: [ctx], resolveVar });
    expect(s!.candidates[0]!.element).toBe("[data-testid=chip]");
    expect(s!.candidates[0]!.states["State=Hover"]!.state).toBe("chip-hover");
    expect(s!.candidates[0]!.states["State=Default"]!.state).toBe("input");
    expect(s!.candidates[0]!.score).toBeGreaterThan(s!.candidates[1]!.score);
    const yaml = suggestionYaml(s!);
    expect(yaml).toContain('element: "[data-testid=chip]"');
    expect(yaml).toContain('"State=Hover": chip-hover');
  });

  it("says so when nothing was captured", () => {
    const [s] = suggestMappings([chip], [], { contexts: [ctx], resolveVar });
    expect(suggestionYaml(s!)).toContain("no candidate element");
  });
});
