// C8 · text contrast (WCAG 2.2 AA): maths, rules, and the probe's painted colours in Chromium.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SnapshotCell, TextSample } from "../src/types.js";
import { checkContrast, contrastRatio, isLargeText, luminance, samplesOf, type C8Stats } from "../src/checks/c8Contrast.js";
import { parseConfig } from "../src/config.js";
import { probeProduct } from "../src/runtime/browser.js";
import { cellKey } from "../src/baseline.js";
import { cellName } from "../src/findings.js";

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

describe("WCAG contrast maths", () => {
  it("matches known pairs", () => {
    expect(r2(contrastRatio("#000000", "#ffffff"))).toBe(21);
    expect(r2(contrastRatio("#ffffff", "#ffffff"))).toBe(1);
    expect(r2(contrastRatio("#767676", "#ffffff"))).toBe(4.54); // the classic lightest AA grey on white
    expect(r2(contrastRatio("#777777", "#ffffff"))).toBe(4.48);
    expect(r2(contrastRatio("#949494", "#ffffff"))).toBe(3.03);
    expect(contrastRatio("#ffffff", "#767676")).toBe(contrastRatio("#767676", "#ffffff")); // order does not matter
    expect(contrastRatio("nope", "#fff")).toBeNull();
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBe(1);
  });

  it("knows large text", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.66, 600)).toBe(false);
    expect(isLargeText(14, 900)).toBe(false);
  });
});

const sample = (over: Partial<TextSample>): TextSample => ({
  path: 'span[data-testid="x"]',
  anchor: 'span[data-testid="x"]',
  text: "Label",
  box: { x: 0, y: 0, width: 50, height: 20 },
  fontSize: 14,
  fontWeight: 400,
  fg: "#171a1c",
  bg: "#ffffff",
  bgUnknown: null,
  disabled: false,
  viewFraction: 1,
  ...over,
});
const cell = (texts: TextSample[], state = "s", context = "light"): SnapshotCell => ({ surface: "p", state, context, url: "", browser: "b", tokens: {}, nodes: [], texts, screenshot: "shots/s.png" });

describe("C8 check", () => {
  it("fails normal text under 4.5:1 and large text under 3:1, high below 3:1", () => {
    const f = checkContrast([
      cell([
        sample({ path: "a", text: "Grey", fg: "#9ca3ab" }), // 2.5 → high
        sample({ path: "b", text: "Almost", fg: "#777777" }), // 4.48 → medium
        sample({ path: "c", text: "Fine", fg: "#767676" }), // 4.54 → pass
        sample({ path: "d", text: "Big", fg: "#949494", fontSize: 24 }), // 3.03 large → pass
        sample({ path: "e", text: "Big faint", fg: "#aaaaaa", fontSize: 24 }), // 2.32 large → medium
      ]),
    ]);
    expect(f.map((x) => `${x.links.source}:${x.severity}`)).toEqual(["a:high", "b:medium", "e:medium"]);
    expect(f[0]).toMatchObject({ check: "C8", category: "text-contrast", gap: "B", context: "light", expected: { value: "4.5:1" }, actual: { value: "2.54:1", source: "#9ca3ab on #ffffff" } });
    expect(f[0]!.title).toContain('"Grey": contrast 2.54:1 (#9ca3ab on #ffffff), needs 4.5:1 for normal text');
    expect(f[2]!.expected?.value).toBe("3:1");
    expect(f[0]!.evidence?.swatches).toEqual(["#9ca3ab", "#ffffff"]);
  });

  it("skips disabled text, unknown backdrops and text scrolled out of view, and counts them", () => {
    const stats: C8Stats = { checked: 0, disabled: 0, unknownBackdrop: 0 };
    const f = checkContrast(
      [cell([sample({ fg: "#eeeeee", disabled: true }), sample({ fg: "#eeeeee", bgUnknown: "background image" }), sample({ fg: "#eeeeee", viewFraction: 0 }), sample({})])],
      {},
      stats,
    );
    expect(f).toEqual([]);
    expect(stats).toEqual({ checked: 1, disabled: 1, unknownBackdrop: 1 });
  });

  it("gives the same text in the same theme one fingerprint across states", () => {
    const bad = sample({ fg: "#9ca3ab" });
    const f = checkContrast([cell([bad], "a"), cell([bad], "b"), cell([bad], "a", "dark")]);
    expect(new Set(f.map((x) => x.fingerprint)).size).toBe(2);
  });

  it("honours configured ratios (e.g. AAA)", () => {
    expect(checkContrast([cell([sample({ fg: "#767676" })])], { normal: 7, large: 4.5 })).toHaveLength(1);
  });

  it("falls back to collected elements when a capture has no text scan", () => {
    const c: SnapshotCell = {
      surface: "p", state: "s", context: "light", url: "", browser: "b", tokens: {},
      nodes: [
        { component: null, testId: "t", path: 'span[data-testid="t"]', box: { x: 0, y: 0, width: 10, height: 10 }, hasText: true, text: "Hi", css: { "font-size": "14px", "font-weight": "400" }, layout: { id: 0, ancestors: [], interactive: false, overlay: false, role: null, scroll: { w: 0, h: 0, cw: 0, ch: 0 }, visibleFraction: 1, textRects: [], occlusion: { samples: 0, covered: 0, centerCovered: false, by: [], overlayOnly: false }, insets: null, childGaps: [], contrast: { fg: "#9ca3ab", bg: "#ffffff", bgUnknown: null } } },
        { component: null, testId: "u", path: "u", box: { x: 0, y: 0, width: 10, height: 10 }, hasText: false, text: "", css: {} },
      ],
    };
    expect(samplesOf(c)).toHaveLength(1);
    expect(checkContrast([c])[0]!.component).toBe('[data-testid="t"]');
  });
});

describe("painted text colours in Chromium, at two viewport sizes", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-contrast-"));
  const url = pathToFileURL(join(import.meta.dirname, "fixtures", "pages", "contrast.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ., themeEntry: x.css }
contexts: [{ name: light, colorScheme: light }]
runtime:
  forceContextAttributes: false
  collectSelector: "[data-testid]"
  viewports:
    - { name: desktop, width: 800, height: 700 }
    - { name: narrow, width: 400, height: 700 }
  surfaces: [{ name: contrast, url: "${url}" }]
figmaComponents:
  - { figma: Panel, element: ".row.dark", variants: {} }
`,
    join(out, "c.yaml"),
  );
  const { cells, warnings } = await probeProduct(cfg, [], out);
  const [desktop, narrow] = cells;
  const t = (c: SnapshotCell | undefined, id: string) => c!.texts!.find((x) => x.path === `span[data-testid="${id}"]` || x.path === `button[data-testid="${id}"]`);

  it("captures one cell per viewport; only extra viewports carry a name", () => {
    expect(warnings).toEqual([]);
    expect(cells.map((c) => c.viewport)).toEqual([undefined, "narrow"]);
    expect(cellKey(narrow!)).toBe("contrast__default__light__narrow");
    expect(cellKey(desktop!)).toBe("contrast__default__light");
    expect(cellName(narrow!)).toBe("contrast/default/light@narrow");
    expect(narrow!.page!.innerWidth).toBe(400);
    expect(narrow!.screenshot).toMatch(/-narrow\.png$/);
  });

  it("composites backgrounds and opacity as painted", () => {
    expect(t(desktop, "good")).toMatchObject({ fg: "#171a1c", bg: "#ffffff", bgUnknown: null, fontSize: 14, fontWeight: 400 });
    expect(t(desktop, "grey")).toMatchObject({ fg: "#9ca3ab", bg: "#ffffff" });
    // rgba(255,255,255,.5) over #101213 → #888989; white text stays white
    expect(t(desktop, "tinted")).toMatchObject({ fg: "#ffffff", bg: "#888989" });
    // the parent's opacity 0.4 blends text and its white backdrop with the white page
    expect(t(desktop, "faded")).toMatchObject({ fg: "#a2a3a4", bg: "#ffffff" });
    expect(t(desktop, "big")!.fontSize).toBe(24);
  });

  it("marks backdrops it cannot know and disabled controls", () => {
    expect(t(desktop, "gradient")!.bgUnknown).toMatch(/background image or gradient/);
    expect(t(desktop, "over-sibling")!.bgUnknown).toMatch(/painted over/);
    expect(t(desktop, "disabled")!.disabled).toBe(true);
    expect(t(desktop, "scrolled-out")).toBeUndefined(); // scrolled out of its container
    expect(desktop!.texts!.some((x) => x.text === "Unmarked plain text")).toBe(true); // not only marked elements
  });

  it("reports what fails, per viewport, and nothing it cannot judge", () => {
    const f = checkContrast(cells);
    const who = f.map((x) => `${(x.component ?? "").replace(/.*testid="([^"]+)".*/, "$1")}${x.cell?.viewport ? "@" + x.cell.viewport : ""}`);
    expect(who).toEqual(expect.arrayContaining(["grey", "faded", "tinted", "responsive@narrow"]));
    expect(who.some((w) => /good|mid|big|gradient|over-sibling|disabled/.test(w))).toBe(false);
    expect(who).not.toContain("responsive"); // grey only in the narrow layout
  });

  it("collects and tags elements named by a plain CSS selector in a mapping", () => {
    const tagged = desktop!.nodes.filter((n) => n.matches?.includes(".row.dark"));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.css["background-color"]).toBe("rgb(16, 18, 19)");
  });

  it("keeps collected elements' own colours too", () => {
    const n = desktop!.nodes.find((x) => x.testId === "grey")!;
    expect(n.layout!.contrast).toEqual({ fg: "#9ca3ab", bg: "#ffffff", bgUnknown: null });
  });
});
