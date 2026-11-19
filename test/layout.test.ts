// Layout defects on a real page in Chromium: overlap, covering, clipping, cropping,
// and "same look, different construction" (padding vs margin, gap vs margin).
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig } from "../src/config.js";
import { probeProduct } from "../src/runtime/browser.js";
import { checkLayout } from "../src/checks/c5Layout.js";
import { checkSpecs } from "../src/checks/c4Spec.js";
import { checkOffToken } from "../src/checks/c3OffToken.js";

const fixtures = join(import.meta.dirname, "fixtures");

describe("layout fixture in Chromium", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-layout-"));
  const url = pathToFileURL(join(fixtures, "pages", "layout.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ${fixtures}, themeEntry: x.css }
contexts: [{ name: light, colorScheme: light }]
componentSpecs:
  - { name: Model option, match: { testId: "model-option*" }, padding: [8, 12, 8, 12] }
  - { name: Chips, match: { testId: "chips-*" }, gap: 8 }
runtime:
  forceContextAttributes: false
  collectSelector: "[data-testid]"
  surfaces: [{ name: layout, url: "${url}" }]
`,
    join(out, "c.yaml"),
  );
  const { cells } = await probeProduct(cfg, [], out);
  const cell = cells[0]!;
  const node = (id: string) => cell.nodes.find((n) => n.testId === id);
  const c5 = checkLayout(cells, { minOverlapPx: 16 });
  const c4 = checkSpecs(cells, cfg.componentSpecs, 1);
  const c3 = checkOffToken(cells, { contexts: cfg.contexts, spacingScale: [0, 2, 4, 8, 12], radiusScale: [0], colorDeltaE: 2, px: 1 });
  const has = (list: typeof c5, category: string, who: string) => list.some((f) => f.category === category && f.title.includes(who));

  it("measures hit-testing, clipping and spacing facts in the page", () => {
    expect(node("covered-button")!.layout!.occlusion).toMatchObject({ covered: 5, centerCovered: true, overlayOnly: false });
    expect(node("covered-button")!.layout!.occlusion.by).toEqual(['div[data-testid="promo-cover"]']);
    expect(node("under-tip")!.layout!.occlusion.overlayOnly).toBe(true);
    expect(node("cropped")!.layout!.visibleFraction).toBe(0.5);
    expect(node("slide-1")!.layout!.visibleFraction).toBe(1);
    expect(node("slide-2")).toBeUndefined(); // fully hidden by its carousel: not on screen, not checked
    expect(node("model-option")!.layout!.insets).toEqual({ top: 8, right: 12, bottom: 8, left: 12 });
    expect(node("model-option-margin")!.layout!.insets).toEqual({ top: 8, right: 12, bottom: 8, left: 12 });
    expect(node("model-option-margin")!.css["padding-left"]).toBe("0px");
    // on screen both options look the same; only insets tell how it is built
    expect(node("model-option")!.layout!.visualInsets).toMatchObject({ top: 8, bottom: 8, left: 12 });
    expect(node("model-option-margin")!.layout!.visualInsets).toMatchObject({ top: 8, bottom: 8, left: 12 }); // right side = free space
    expect(node("chips-margins")!.layout!.childGaps[0]).toMatchObject({ gap: 10, fromGap: 0, marginA: 0, marginB: 10 });
    expect(cell.page!.scrollWidth).toBeGreaterThan(cell.page!.innerWidth);
  });

  it("C5 reports collisions, covered controls, cut-off and cropped text, and page overflow", () => {
    expect(has(c5, "text-overlap", "overlap-a")).toBe(true);
    const covered = c5.find((f) => f.category === "occluded" && f.title.includes("covered-button"))!;
    expect(covered.severity).toBe("high");
    expect(covered.title).toContain("promo-cover");
    expect(has(c5, "text-clipped", "clipped")).toBe(true);
    expect(has(c5, "text-spills", "spilling")).toBe(true);
    expect(has(c5, "text-cropped", "cropped")).toBe(true);
    expect(c5.some((f) => f.category === "page-horizontal-overflow")).toBe(true);
  });

  it("C5 stays quiet about intended overlaps and truncation", () => {
    const about = (id: string) => c5.filter((f) => f.component === id || f.related?.some((r) => r.includes(`"${id}"`)));
    expect(about("under-tip")).toEqual([]); // the tooltip covers it on purpose
    expect(about("ellipsis")).toEqual([]); // truncated with an ellipsis
    expect(about("slide-1")).toEqual([]);
    expect(c5.filter((f) => f.category === "occluded" && f.component === "overlap-a")).toEqual([]); // already a text collision
  });

  it("C4 tells 'looks wrong' from 'looks right, built with margins'", () => {
    const byNode = (id: string) => c4.filter((f) => f.title.includes(`(${id})`)).map((f) => `${f.category}/${f.severity}`);
    expect(byNode("model-option")).toEqual([]);
    expect(byNode("model-option-margin")).toEqual(["spacing-mechanism/low"]);
    expect(byNode("model-option-wide")).toEqual(["spacing-differs-from-spec/medium"]);
    expect(byNode("chips-margins")).toEqual(["gap-differs-from-spec/medium"]);
    expect(byNode("chips-gap")).toEqual([]);
    expect(byNode("chips-margin8")).toEqual(["gap-mechanism/low"]);
    expect(c4.find((f) => f.category === "spacing-mechanism")!.title).toContain("left 12px comes from padding 0px + child margin 12px");
  });

  it("C3 measures the gap users see, whatever builds it", () => {
    const gap = c3.find((f) => f.category === "off-scale-visual-gap")!;
    expect(gap.title).toContain("chips-margins: 10px between span 1 and span 2");
    expect(gap.actual?.source).toBe("gap 0px + margin 10px on span 2");
    expect(c3.some((f) => f.category === "off-scale-visual-gap" && f.title.startsWith("chips-gap"))).toBe(false);
  });
});

describe("hidden controls and scrolled-out content in Chromium", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-hidden-"));
  const url = pathToFileURL(join(fixtures, "pages", "hidden-and-scrolled.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ${fixtures}, themeEntry: x.css }
contexts: [{ name: light, colorScheme: light }]
runtime:
  forceContextAttributes: false
  collectSelector: "[data-testid]"
  surfaces: [{ name: hidden, url: "${url}" }]
figmaComponents:
  - { figma: X, element: ".generated-anchor", variants: {} }
  - { figma: Y, element: ".stable-anchor", variants: {} }
`,
    join(out, "c.yaml"),
  );
  const { cells } = await probeProduct(cfg, [], out);
  const node = (id: string) => cells[0]!.nodes.find((n) => n.testId === id)!;
  const c5 = checkLayout(cells, { minOverlapPx: 16 });
  const about = (id: string) => c5.filter((f) => f.component === id || f.related?.some((r) => r.includes(`"${id}"`)));

  it("measures what is on screen through scroll containers", () => {
    expect(node("scroll-top").layout!.viewFraction).toBe(1);
    expect(node("scroll-half").layout!.viewFraction).toBe(0.5);
    expect(node("scroll-out").layout!.viewFraction).toBe(0);
    expect(node("scroll-out").layout!.visibleFraction).toBe(1); // scrolling is not cropping
    expect(node("scroll-out").layout!.textRects).toEqual([]);
    expect(node("scroll-out").layout!.occlusion.samples).toBe(0);
    expect(node("scroll-half").layout!.occlusion.samples).toBeGreaterThan(0);
  });

  it("does not report content scrolled out of view as covered or colliding", () => {
    expect(about("scroll-out")).toEqual([]);
    expect(about("scroll-half")).toEqual([]);
  });

  it("does not report a form control under its own label, or a transparent control", () => {
    expect(node("upload-input").layout!.occlusion.covered).toBe(0);
    expect(cells[0]!.nodes.find((n) => n.testId === "invisible-button")).toBeUndefined(); // opacity 0: not collected
    expect(about("upload-input")).toEqual([]);
    expect(about("invisible-button")).toEqual([]);
  });

  it("does not anchor paths on ids generated per render", () => {
    const tagged = (sel: string) => cells[0]!.nodes.find((n) => n.matches?.includes(sel))!.path;
    expect(tagged(".generated-anchor")).not.toContain("_r_24_");
    expect(tagged(".stable-anchor")).toBe("div#sidebar > div");
  });

  it("still reports a control covered by an unrelated element", () => {
    const f = c5.find((x) => x.category === "occluded" && x.component === "stranger-button")!;
    expect(f.severity).toBe("high");
    expect(f.title).toContain("stranger-cover");
  });
});
