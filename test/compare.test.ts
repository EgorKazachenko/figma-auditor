// Parity of two captures of the same product (e.g. the React build and its Svelte rewrite).
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCaptures, loadCapture, renderCompare } from "../src/compare/builds.js";
import type { SnapshotCell, SnapshotNode } from "../src/types.js";

const node = (testId: string, css: Record<string, string>, box = { x: 0, y: 0, width: 100, height: 40 }, text = ""): SnapshotNode => ({
  component: null,
  testId,
  path: testId,
  box,
  hasText: Boolean(text),
  text,
  css: { "background-color": "rgb(247, 247, 248)", color: "rgb(23, 26, 28)", "padding-left": "8px", "font-family": "-apple-system, sans-serif", display: "flex", ...css },
});
const cell = (state: string, context: string, nodes: SnapshotNode[], viewport?: string): SnapshotCell => ({ surface: "panel", state, context, viewport, url: "", browser: "B", tokens: {}, nodes });

const react = [
  cell("menu", "light", [node("menu", {}), node("item", {}, { x: 0, y: 40, width: 100, height: 40 }, "GPT-5.2"), node("item", {}, { x: 0, y: 80, width: 100, height: 40 }, "Gemini")]),
  cell("menu", "dark", [node("menu", { "background-color": "rgb(16, 18, 19)" })]),
  cell("input", "light", [node("chip", {})]),
];
const svelte = [
  cell("menu", "light", [
    node("menu", { "background-color": "rgb(224, 227, 230)", display: "grid", "font-family": "system-ui, sans-serif" }),
    node("item", { "padding-left": "12px" }, { x: 0, y: 40, width: 100, height: 40 }, "GPT-5.2"),
    node("item", { "padding-left": "12px" }, { x: 0, y: 86, width: 100, height: 40 }, "Gemini 3"),
  ]),
  cell("menu", "dark", [node("menu", { "background-color": "rgb(17, 18, 19)" })]),
  cell("effort", "light", [node("row", {})]),
];

describe("compareCaptures", () => {
  const r = compareCaptures(react, svelte, { labels: ["React", "Svelte"] });

  it("matches cells by surface, state and theme and lists the unmatched ones", () => {
    expect(r.matchedCells).toBe(2);
    expect(r.onlyInA).toEqual(["panel/input/light"]);
    expect(r.onlyInB).toEqual(["panel/effort/light"]);
  });

  it("reports style differences beyond the thresholds, counted once across elements and cells", () => {
    const g = r.grouped.map((x) => `${x.element} ${x.property} ${x.a} → ${x.b} ×${x.cells.length}`);
    expect(g).toContain("menu background-color #f7f7f8 → #e0e3e6 ×1");
    expect(g).toContain("item padding-left 8px → 12px ×1");
    expect(g.some((x) => x.includes("rgb(16") || x.includes("#101213"))).toBe(false); // ΔE < 2 in dark
    expect(g.some((x) => x.includes("display"))).toBe(false); // layout keywords are not design values
    expect(g.some((x) => x.includes("font-family"))).toBe(true); // first family differs
  });

  it("reports geometry and text differences per element", () => {
    const light = r.cells.find((c) => c.cell === "panel/menu/light")!;
    expect(light.layout.map((l) => `${l.entry.key} ${l.kind}`)).toEqual(["item#1 moved"]);
    expect(light.text).toEqual([{ element: "item#1", a: "Gemini", b: "Gemini 3" }]);
  });

  it("renders a parity report, and says so when captures match", () => {
    const md = renderCompare(r);
    expect(md).toContain("# Parity: React vs Svelte");
    expect(md).toContain("| item | padding-left | 8px | 12px | 1 |");
    expect(md).toContain('panel/menu/light: item#1: "Gemini" → "Gemini 3"');
    expect(renderCompare(compareCaptures(react, react))).toContain("The two captures match within the thresholds.");
  });

  it("loads a capture from a run folder or a snapshot file", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-cmp-"));
    mkdirSync(join(dir, "run"));
    writeFileSync(join(dir, "run", "snapshot.json"), JSON.stringify(react));
    expect(loadCapture(join(dir, "run"))).toHaveLength(3);
    expect(loadCapture(join(dir, "run", "snapshot.json"))).toHaveLength(3);
    expect(() => loadCapture(join(dir, "nope"))).toThrow(/no snapshot.json/);
  });
});
