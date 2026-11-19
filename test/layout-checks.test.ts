import { describe, expect, it } from "vitest";
import { checkLayout, overlap, textOverlaps } from "../src/checks/c5Layout.js";
import { checkSpecs, matchesSpec, type ComponentSpec } from "../src/checks/c4Spec.js";
import { checkOffToken } from "../src/checks/c3OffToken.js";
import type { NodeLayout, SnapshotCell, SnapshotNode } from "../src/types.js";

let nextId = 0;
const layout = (over: Partial<NodeLayout> = {}): NodeLayout => ({
  id: nextId++,
  ancestors: [],
  interactive: false,
  overlay: false,
  role: null,
  scroll: { w: 100, h: 20, cw: 100, ch: 20 },
  visibleFraction: 1,
  textRects: [],
  occlusion: { samples: 5, covered: 0, centerCovered: false, by: [], overlayOnly: false },
  insets: null,
  childGaps: [],
  ...over,
});
const node = (testId: string, over: Partial<SnapshotNode> = {}, lay: Partial<NodeLayout> = {}): SnapshotNode => ({
  component: null,
  testId,
  path: `div[data-testid="${testId}"]`,
  box: { x: 0, y: 0, width: 100, height: 20 },
  hasText: true,
  text: testId,
  css: { "overflow-x": "visible", "overflow-y": "visible", "white-space": "normal", "text-overflow": "clip" },
  layout: layout(lay),
  ...over,
});
const cell = (nodes: SnapshotNode[], page?: SnapshotCell["page"]): SnapshotCell => ({
  surface: "s",
  state: "default",
  context: "light",
  url: "x",
  browser: "chromium",
  tokens: {},
  nodes,
  page,
});

describe("overlap and textOverlaps", () => {
  it("computes intersection", () => {
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ w: 5, h: 5, area: 25 });
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }).area).toBe(0);
  });

  it("ignores slivers from tight line-height, related elements and overlays", () => {
    const line = (y: number) => [{ x: 0, y, w: 100, h: 17 }];
    const a = node("a", {}, { textRects: line(0) });
    const sliver = node("b", {}, { textRects: line(15) }); // 2px of overlap on a 17px line
    const real = node("c", {}, { textRects: line(4) });
    const child = node("d", {}, { textRects: line(2), ancestors: [a.layout!.id] });
    const tooltip = node("e", {}, { textRects: line(3), overlay: true });
    const pairs = textOverlaps([a, sliver, real, child, tooltip], 16).map(([x, y]) => `${x.testId}-${y.testId}`);
    // a–b share 2px of a 17px line (tight line-height): ignored. b–c share 6px (> 30% of a line): a collision.
    // a–d are parent and child; e is a tooltip.
    expect(pairs).toEqual(["a-c", "b-c", "c-d"]);
  });
});

describe("C5 · layout integrity", () => {
  it("reports covered text and controls, but not overlays or single-point touches", () => {
    const f = checkLayout(
      [
        cell([
          node("btn", { hasText: false }, { interactive: true, occlusion: { samples: 5, covered: 3, centerCovered: true, by: ["div#cover"], overlayOnly: false } }),
          node("label", {}, { occlusion: { samples: 5, covered: 2, centerCovered: false, by: ["div#banner"], overlayOnly: false } }),
          node("under-menu", {}, { occlusion: { samples: 5, covered: 5, centerCovered: true, by: ['ul[role="menu"]'], overlayOnly: true } }),
          node("corner-badge", {}, { occlusion: { samples: 5, covered: 1, centerCovered: false, by: ["span#badge"], overlayOnly: false } }),
          node("decor", { hasText: false }, { occlusion: { samples: 5, covered: 5, centerCovered: true, by: ["div#x"], overlayOnly: false } }),
        ]),
      ],
      { minOverlapPx: 16 },
    );
    expect(f.map((x) => `${x.component}:${x.severity}`)).toEqual(["btn:high", "label:medium"]);
    expect(f[0]!.title).toContain("its centre cannot be clicked");
  });

  it("separates clipped text from intended truncation", () => {
    const narrow = { w: 220, h: 20, cw: 80, ch: 20 };
    const f = checkLayout(
      [
        cell([
          node("cut", { css: { "overflow-x": "hidden", "text-overflow": "clip" } }, { scroll: narrow }),
          node("ellipsis", { css: { "overflow-x": "hidden", "text-overflow": "ellipsis" } }, { scroll: narrow }),
          node("tall", { css: { "overflow-x": "visible", "overflow-y": "hidden", "-webkit-line-clamp": "none" } }, { scroll: { w: 80, h: 60, cw: 80, ch: 40 } }),
          node("clamped", { css: { "overflow-x": "visible", "overflow-y": "hidden", "-webkit-line-clamp": "2" } }, { scroll: { w: 80, h: 60, cw: 80, ch: 40 } }),
          node("spill", { css: { "overflow-x": "visible", "white-space": "nowrap" } }, { scroll: narrow }),
          node("inline", { css: { "overflow-x": "visible", "white-space": "nowrap" } }, { scroll: { w: 0, h: 0, cw: 0, ch: 0 } }),
        ]),
      ],
      { minOverlapPx: 16 },
    );
    expect(f.map((x) => `${x.component}:${x.category}`)).toEqual(["cut:text-clipped", "tall:text-clipped", "spill:text-spills"]);
  });

  it("reports partly cropped text and page overflow", () => {
    const f = checkLayout(
      [
        cell([node("half", {}, { visibleFraction: 0.5 }), node("almost", {}, { visibleFraction: 0.99 }), node("box", { hasText: false }, { visibleFraction: 0.5 })], {
          scrollWidth: 1400,
          innerWidth: 1280,
          scrollHeight: 900,
          innerHeight: 860,
        }),
      ],
      { minOverlapPx: 16 },
    );
    expect(f.map((x) => x.category)).toEqual(["page-horizontal-overflow", "text-cropped"]);
    expect(f[1]!.title).toContain("only 50% visible");
  });
});

describe("C4 · component spec", () => {
  const spec: ComponentSpec = { name: "Option", match: { testId: "option*" }, padding: [8, 12, null, 12], gap: 4 };
  const pad = (t: number, r: number, b: number, l: number) => ({
    "padding-top": `${t}px`,
    "padding-right": `${r}px`,
    "padding-bottom": `${b}px`,
    "padding-left": `${l}px`,
  });

  it("matches by test id or component with wildcards", () => {
    expect(matchesSpec(node("option-a"), spec)).toBe(true);
    expect(matchesSpec(node("other"), spec)).toBe(false);
    expect(matchesSpec(node("x", { component: "Menu.Option" }), { name: "m", match: { component: "Menu.*" } })).toBe(true);
  });

  it("skips null sides and falls back to padding for text-only elements", () => {
    const f = checkSpecs([cell([node("option-text", { css: pad(8, 12, 30, 12) })])], [spec], 1);
    expect(f).toEqual([]);
  });

  it("reports looks-different before built-differently, never both", () => {
    const f = checkSpecs(
      [
        cell([
          node("option-margin", { css: pad(0, 0, 0, 0) }, { insets: { top: 8, right: 12, bottom: 0, left: 12 } }),
          node("option-wide", { css: pad(0, 0, 0, 0) }, { insets: { top: 8, right: 16, bottom: 0, left: 16 } }),
        ]),
      ],
      [spec],
      1,
    );
    expect(f.map((x) => `${x.component}:${x.category}`)).toEqual(["option-margin:spacing-mechanism", "option-wide:spacing-differs-from-spec"]);
    expect(f[1]!.title).toContain("right 16px (spec 12px), left 16px (spec 12px)");
  });

  it("checks gaps and their construction", () => {
    const gaps = (gap: number, fromGap: number) => [{ gap, axis: "x" as const, fromGap, marginA: 0, marginB: gap - fromGap, a: "span 1", b: "span 2" }];
    const f = checkSpecs(
      [cell([node("option-1", { css: pad(8, 12, 0, 12) }, { childGaps: gaps(4, 4) }), node("option-2", { css: pad(8, 12, 0, 12) }, { childGaps: gaps(4, 0) }), node("option-3", { css: pad(8, 12, 0, 12) }, { childGaps: gaps(10, 10) })])],
      [spec],
      1,
    );
    expect(f.map((x) => `${x.component}:${x.category}`)).toEqual(["option-2:gap-mechanism", "option-3:gap-differs-from-spec"]);
  });
});

describe("C3 · margins and visual gaps", () => {
  const opts = { contexts: [], spacingScale: [0, 4, 8, 12], radiusScale: [0], colorDeltaE: 2, px: 1, maxCheckedSpacing: 64 };
  const margins = (t: string, r: string, b: string, l: string) => ({
    "background-color": "rgba(0, 0, 0, 0)",
    "margin-top": t,
    "margin-right": r,
    "margin-bottom": b,
    "margin-left": l,
  });

  it("checks margins, but not auto-centring or large layout offsets", () => {
    const f = checkOffToken(
      [
        cell([
          node("m10", { hasText: false, css: margins("10px", "0px", "0px", "0px") }),
          node("centred", { hasText: false, css: margins("0px", "212px", "0px", "212px") }),
          node("offset", { hasText: false, css: margins("120px", "0px", "0px", "0px") }),
          node("neg", { hasText: false, css: margins("-10px", "0px", "0px", "0px") }),
        ]),
      ],
      opts,
    );
    expect(f.map((x) => `${x.component}:${x.category}:${x.actual?.value}`)).toEqual(["m10:off-scale-margin:10px", "neg:off-scale-margin:-10px"]);
  });

  it("reports an off-scale visual gap once per value with its make-up", () => {
    const g = (gap: number) => ({ gap, axis: "y" as const, fromGap: 4, marginA: gap - 4, marginB: 0, a: "li 1", b: "li 2" });
    const f = checkOffToken([cell([node("list", { hasText: false, css: margins("0px", "0px", "0px", "0px") }, { childGaps: [g(10), g(10), g(8), g(0)] })])], opts);
    expect(f.map((x) => x.title)).toEqual(["list: 10px between li 1 and li 2 is off the scale (nearest 8px); made of gap 4px + margin 6px on li 1"]);
  });
});

describe("C5 · text cut by the viewport edge", () => {
  const sample = (anchor: string, x: number, width: number, viewFraction = 1) => ({
    path: anchor, anchor, text: anchor, box: { x, y: 10, width, height: 16 }, fontSize: 14, fontWeight: 400,
    fg: "#000000", bg: "#ffffff", bgUnknown: null, disabled: false, viewFraction,
  });
  const cell = (texts: ReturnType<typeof sample>[], scrollWidth = 300): SnapshotCell => ({
    surface: "s", state: "menu", context: "light", viewport: "z200", url: "u", browser: "b", tokens: {}, nodes: [],
    page: { scrollWidth, innerWidth: 300, scrollHeight: 400, innerHeight: 400 }, texts,
  });

  it("reports text partly past the left edge, or past the right edge when the page cannot scroll", () => {
    const f = checkLayout([cell([sample("menu-item", -7, 100), sample("badge", 280, 40), sample("fits", 10, 100)])], { minOverlapPx: 16 });
    const off = f.filter((x) => x.category === "off-viewport");
    expect(off.map((x) => x.title)).toEqual([
      'menu-item "menu-item": cut off by the left edge of the 300px viewport (7px outside, cannot be scrolled to)',
      'badge "badge": cut off by the right edge of the 300px viewport (20px outside, cannot be scrolled to)',
    ]);
    expect(off[0]!.severity).toBe("high");
  });

  it("leaves alone text hidden on purpose (fully off screen, clipped away) and pages that scroll sideways", () => {
    const f = checkLayout([cell([sample("skip-link", -9999, 80), sample("slide", -50, 100, 0)])], { minOverlapPx: 16 });
    expect(f.filter((x) => x.category === "off-viewport")).toEqual([]);
    const scrolls = checkLayout([cell([sample("wide", 280, 60)], 360)], { minOverlapPx: 16 });
    expect(scrolls.map((x) => x.category)).toEqual(["page-horizontal-overflow"]);
  });
});
