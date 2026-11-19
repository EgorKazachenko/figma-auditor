// C7: Figma component variants (per state and theme) vs what the product renders.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Context, ReferenceToken, SnapshotCell, SnapshotNode } from "../src/types.js";
import {
  findVariant,
  loadComponentSets,
  makeEffectResolver,
  makeVariableResolver,
  parseFigmaEffect,
  variantProps,
  type FigmaComponentSet,
} from "../src/reference/components.js";
import { checkFigmaStates, extraSelectors, figmaSelfChecks, matchNodes, parseSelector, parseShadow, tokensFor, type ComponentMapping } from "../src/checks/c7FigmaStates.js";

const light: Context = { name: "light", html: {}, colorScheme: "light", figmaMode: "light", backdrop: "#ffffff" };
const dark: Context = { name: "dark", html: {}, colorScheme: "dark", figmaMode: "dark", backdrop: "#000000" };

const tok = (figmaName: string, mode: string, value: string, kind: ReferenceToken["kind"] = "color"): ReferenceToken => ({
  name: figmaName,
  figmaName,
  kind,
  mode,
  value,
  source: { type: "test" },
});

const reference: ReferenceToken[] = [
  tok("var(--color-level-5)", "light", "#f7f7f8"),
  tok("var(--color-level-5)", "dark", "#101213"),
  tok("var(--color-text-1)", "light", "#171a1c"),
  tok("var(--color-text-1)", "dark", "#dee0e3"),
  tok("var(--color-neutral-92-60)", "light", "#e9ebec99"),
  tok("var(--color-neutral-92-60)", "dark", "#3f454a99"),
  tok("ElevationShadow/Light/E5", "light", "Effect(type: DROP_SHADOW, color: #171A1C1F, offset: (0, 6), radius: 16, spread: 0)", "effect"),
  tok("ElevationShadow/Dark/E5", "dark", "Effect(type: DROP_SHADOW, color: #0000004D, offset: (0, 6), radius: 20, spread: 0)", "effect"),
];

const option: FigmaComponentSet = {
  id: "1:1",
  name: "List Option",
  page: "0:1",
  fileKey: "FILE",
  fileName: "Lib",
  variantProps: { State: ["Default", "Hover", "Disabled"] },
  variants: [
    {
      id: "1:2",
      name: "State=Default",
      layers: [
        { path: ".", type: "COMPONENT", box: [0, 0, 196, 40], pad: [8, 8, 8, 8], gap: 8, align: ["MIN", "CENTER"], sizing: ["FILL", "FIXED"], radius: 8 },
        { path: "/Label", type: "TEXT", box: [8, 12, 45, 17], text: { chars: "Option", size: 14, weight: 400, font: "SF Pro", lh: "auto", color: { c: "#171a1c", v: "var(--color-text-1)" } } },
      ],
    },
    {
      id: "1:3",
      name: "State=Hover",
      layers: [
        { path: ".", type: "COMPONENT", box: [0, 0, 196, 40], pad: [8, 8, 8, 8], sizing: ["FILL", "FIXED"], radius: 8, fill: { c: "#e9ebec66", v: "var(--color-neutral-92-60)" } },
        { path: "/Label", type: "TEXT", box: [8, 12, 45, 17], text: { chars: "Option", size: 14, weight: 400, font: "SF Pro", lh: "auto", color: { c: "#171a1c", v: "var(--color-text-1)" } } },
      ],
    },
    { id: "1:4", name: "State=Disabled", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 196, 40] }] },
  ],
};

const menu: FigmaComponentSet = {
  id: "2:1",
  name: "Menu",
  page: "0:1",
  fileKey: "FILE",
  variantProps: { "Property 1": ["Default"] },
  variants: [
    {
      id: "2:2",
      name: "Property 1=Default",
      layers: [
        {
          path: ".",
          type: "COMPONENT",
          box: [0, 0, 226, 300],
          sizing: ["FIXED", "HUG"],
          radius: 12,
          fill: { c: "#f7f7f8", v: "var(--color-level-5)" },
          shadow: { x: 0, y: 6, blur: 16, spread: 0, c: "#171a1c1f", style: "ElevationShadow/Light/E5" },
        },
      ],
    },
  ],
};

let nextId = 0;
function node(testId: string, css: Record<string, string>, box = { x: 0, y: 0, width: 196, height: 40 }, extra: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    component: null,
    testId,
    path: `div[data-testid="${testId}"]`,
    box,
    hasText: false,
    text: "",
    css: { "background-color": "rgba(0, 0, 0, 0)", "border-top-left-radius": "8px", "padding-top": "8px", "padding-right": "8px", "padding-bottom": "8px", "padding-left": "8px", ...css },
    layout: {
      id: nextId++,
      ancestors: [],
      interactive: false,
      overlay: false,
      role: null,
      scroll: { w: 0, h: 0, cw: 0, ch: 0 },
      visibleFraction: 1,
      textRects: [],
      occlusion: { samples: 5, covered: 0, centerCovered: false, by: [], overlayOnly: false },
      insets: { top: 8, right: 8, bottom: 8, left: 8 },
      childGaps: [],
    },
    ...extra,
  };
}

function labelOf(parent: SnapshotNode, css: Record<string, string>): SnapshotNode {
  const n = node("option-label", { color: "rgb(23, 26, 28)", "font-size": "14px", "font-weight": "400", "font-family": "-apple-system, sans-serif", "line-height": "20px", ...css }, { x: 8, y: 12, width: 45, height: 17 }, { hasText: true, text: "GPT" });
  n.layout!.ancestors = [parent.layout!.id];
  return n;
}

function cell(state: string, ctx: Context, nodes: SnapshotNode[], tokens: SnapshotCell["tokens"] = {}): SnapshotCell {
  return { surface: "panel", state, context: ctx.name, url: "x", browser: "Test 1", tokens, nodes, screenshot: `shots/${state}.png` };
}

const lightTokens = {
  "--color-level-5": { raw: "#f7f7f8", color: "rgb(247, 247, 248)" },
  "--color-text-01": { raw: "#171a1c", color: "rgb(23, 26, 28)" },
  "--color-neutral-92-60": { raw: "#e9ebec99", color: "rgba(233, 235, 236, 0.6)" },
  "--color-neutral-90": { raw: "#e3e6e8", color: "rgb(227, 230, 232)" },
} as SnapshotCell["tokens"];

const optionMapping: ComponentMapping = {
  figma: "List Option",
  element: "[data-testid=option]",
  text: { Label: "[data-testid=option-label]" },
  variants: { "State=Default": "default" as never, "State=Hover": { state: "hover", nth: 0 }, "State=Disabled": null },
};
// The config loader turns "default" into { state: "default" }; do the same here.
optionMapping.variants["State=Default"] = { state: "default" };

function run(cells: SnapshotCell[], mappings: ComponentMapping[], contexts = [light], sets = [option, menu], unresolved?: Set<string>) {
  return checkFigmaStates(cells, {
    sets,
    mappings,
    contexts,
    resolveVar: makeVariableResolver(reference, "light"),
    resolveEffect: makeEffectResolver(reference),
    colorDeltaE: 2,
    px: 1,
    unresolved,
  });
}

describe("Figma component reference", () => {
  it("reads variant names and finds variants by their properties", () => {
    expect(variantProps("State=NotActive, Size=XS")).toEqual({ State: "NotActive", Size: "XS" });
    expect(findVariant(option, "State=Hover")!.id).toBe("1:3");
    expect(findVariant(option, "State=Nope")).toBeUndefined();
  });

  it("loads component files and keeps the file key for links", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-comp-"));
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ source: { fileKey: "K", fileName: "Lib" }, sets: [option] }));
    const sets = loadComponentSets([p]);
    expect(sets[0]!.fileKey).toBe("K");
    writeFileSync(p, JSON.stringify({ nope: 1 }));
    expect(() => loadComponentSets([p])).toThrow(/sets/);
  });

  it("resolves a variable per mode, and the layer's own colour only in the default mode", () => {
    const r = makeVariableResolver(reference, "light");
    expect(r("var(--color-level-5)", "dark")).toEqual({ value: "#101213", from: "tokens" });
    expect(r("var(--color-text-2)", "light", "#464c53")).toEqual({ value: "#464c53", from: "component" });
    expect(r("var(--color-text-2)", "dark", "#464c53")).toBeNull();
  });

  it("keeps a layer's opacity override in every mode, as Figma renders it", () => {
    const r = makeVariableResolver(reference, "light");
    const d = r("var(--color-neutral-92-60)", "dark", "#e9ebec66")!;
    expect(d.value).toBe("#3f454a66");
    expect(d.opacityOverride).toEqual({ layer: 0.4, variable: 0.6 });
    expect(r("var(--color-neutral-92-60)", "dark", "#e9ebec99")).toEqual({ value: "#3f454a99", from: "tokens" });
  });

  it("parses effect styles and picks the Light/Dark pair member for the scheme", () => {
    expect(parseFigmaEffect("Effect(type: DROP_SHADOW, color: #0000004D, offset: (0, 6), radius: 20, spread: 0)")).toEqual({ x: 0, y: 6, blur: 20, spread: 0, c: "#0000004d" });
    expect(parseFigmaEffect("Effect(type: LAYER_BLUR, radius: 4)")).toBeNull();
    const e = makeEffectResolver(reference);
    const layer = menu.variants[0]!.layers[0]!.shadow!;
    expect(e(layer, "dark")).toMatchObject({ blur: 20, c: "#0000004d", style: "ElevationShadow/Dark/E5" });
    expect(e(layer, "light")).toMatchObject({ blur: 16, style: "ElevationShadow/Light/E5" });
    expect(makeEffectResolver([])(layer, "dark")).toBeNull();
    expect(makeEffectResolver([])({ ...layer, style: undefined }, "dark")).toMatchObject({ blur: 16 });
  });
});

describe("C7 helpers", () => {
  it("parses data-testid and data-ds-component selectors only", () => {
    expect(parseSelector("[data-testid=model-selector]")).toEqual({ attr: "testId", value: "model-selector" });
    expect(parseSelector('[data-ds-component="Button"]')).toEqual({ attr: "component", value: "Button" });
    expect(parseSelector(".class")).toBeNull();
    expect(matchNodes([node("a", {}), node("b", {})], "[data-testid=b]")).toHaveLength(1);
    // any other selector is matched by the probe, which tags the nodes
    expect(matchNodes([node("a", {}, undefined, { matches: [".menu"] }), node("b", {})], ".menu").map((n) => n.testId)).toEqual(["a"]);
    expect(extraSelectors([{ element: "[data-testid=a]" }, { element: ".menu", text: { Label: ".menu span" } }, { element: ".menu" }])).toEqual([".menu", ".menu span"]);
  });

  it("reads the first visible layer of a composed box-shadow", () => {
    expect(parseShadow("rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(23, 26, 28, 0.12) 0px 6px 16px 0px")).toEqual({ x: 0, y: 6, blur: 16, spread: 0, color: "rgba(23, 26, 28, 0.12)" });
    expect(parseShadow("rgba(0, 0, 0, 0.2) 0px 1px 0px 0px inset")).toBeNull();
    expect(parseShadow("none")).toBeNull();
    expect(parseShadow(undefined)).toBeNull();
  });

  it("names the token the product most likely used, preferring ones named after the element", () => {
    const c = cell("x", light, [], {
      "--color-level-1-1": { raw: "", color: "rgb(247, 247, 248)" },
      "--color-model-selector-bg": { raw: "", color: "rgb(247, 247, 248)" },
      "--color-text-01": { raw: "", color: "rgb(23, 26, 28)" },
    } as SnapshotCell["tokens"]);
    expect(tokensFor(c, "#f7f7f8", "#ffffff", "model-selector-menu")).toEqual(["--color-model-selector-bg", "--color-level-1-1"]);
  });
});

describe("C7 check", () => {
  it("is quiet when every variant matches Figma", () => {
    const def = node("option", {});
    const hov = node("option", { "background-color": "rgba(233, 235, 236, 0.4)" });
    const f = run([cell("default", light, [def, labelOf(def, {})], lightTokens), cell("hover", light, [hov, labelOf(hov, {})], lightTokens)], [optionMapping]);
    expect(f.filter((x) => x.category !== "state-not-verified")).toEqual([]);
    // the variant the product cannot show is still listed, as low
    expect(f.map((x) => `${x.category}/${x.severity}`)).toEqual(["state-not-verified/low"]);
    expect(f[0]!.title).toContain("not reachable");
  });

  it("reports each property that differs, with Figma's variable and the token the product used", () => {
    const def = node("option", { "border-top-left-radius": "6px", "padding-left": "12px" }, { x: 0, y: 0, width: 196, height: 44 });
    def.layout!.insets = { top: 8, right: 8, bottom: 8, left: 12 };
    const hov = node("option", { "background-color": "rgb(227, 230, 232)" });
    const f = run(
      [
        cell("default", light, [def, labelOf(def, { "font-size": "13px", "font-weight": "600", color: "rgb(70, 77, 83)", "font-family": "Georgia, serif" })], lightTokens),
        cell("hover", light, [hov, labelOf(hov, {})], lightTokens),
      ],
      [optionMapping],
    );
    const byCat = Object.fromEntries(f.map((x) => [x.category, x]));
    expect(byCat["figma-state-radius"]!.title).toContain("radius 6px, Figma 8px");
    expect(byCat["figma-state-padding"]!.title).toContain("left 12px (Figma 8px)");
    expect(byCat["figma-state-height"]!.title).toContain("height 44px, Figma 40px");
    expect(byCat['figma-state-text-"Label"-size']!.title).toContain("13px, Figma 14px");
    expect(byCat['figma-state-text-"Label"-weight']!.title).toContain("weight 600, Figma 400");
    expect(byCat['figma-state-text-"Label"-colour']!.severity).toBe("medium");
    expect(byCat['figma-state-text-"Label"-font']!.severity).toBe("low");
    const bg = byCat["figma-state-background"]!;
    expect(bg.component).toBe("List Option / State=Hover");
    expect(bg.title).toContain("(= --color-neutral-90)");
    expect(bg.expected).toMatchObject({ value: "#e9ebec66", token: "var(--color-neutral-92-60)" });
    expect(bg.links.figma).toBe("https://www.figma.com/design/FILE/?node-id=1-3");
    expect(bg.evidence?.screenshot).toBe("shots/hover.png");
    expect(f.every((x) => x.check === "C7" && x.gap === "A")).toBe(true);
  });

  it("tells 'padding looks right but is made by the child' from 'padding differs'", () => {
    const def = node("option", { "padding-left": "0px" });
    def.layout!.insets = { top: 8, right: 8, bottom: 8, left: 0 };
    def.layout!.visualInsets = { top: 8, right: 8, bottom: 8, left: 9 };
    const mapping: ComponentMapping = { figma: "List Option", element: "[data-testid=option]", properties: ["padding"], variants: { "State=Default": { state: "default" } } };
    const f = run([cell("default", light, [def], lightTokens)], [mapping]).filter((x) => x.category.startsWith("figma-state-padding"));
    expect(f.map((x) => `${x.category}/${x.severity}`)).toEqual(["figma-state-padding-mechanism/low"]);
    expect(f[0]!.title).toContain("left 9px on screen but padding + child margin = 0px");
    def.layout!.visualInsets = { top: 8, right: 8, bottom: 8, left: 2 };
    const g = run([cell("default", light, [def], lightTokens)], [mapping]).filter((x) => x.category.startsWith("figma-state-padding"));
    expect(g.map((x) => `${x.category}/${x.severity}`)).toEqual(["figma-state-padding/medium"]);
  });

  it("accepts the system font for Figma's SF Pro", () => {
    const def = node("option", {});
    const f = run([cell("default", light, [def, labelOf(def, { "font-family": "system-ui, sans-serif" })], lightTokens)], [optionMapping]);
    expect(f.filter((x) => x.category.includes("font"))).toEqual([]);
  });

  it("separates 'state not captured' and 'element missing' from 'not mapped'", () => {
    const f = run([cell("default", light, [], lightTokens)], [optionMapping]);
    const titles = f.map((x) => `${x.category}: ${x.title}`);
    expect(titles).toContain("state-unreachable: List Option / State=Default: [data-testid=option] #0 not found in light");
    expect(titles).toContain('state-unreachable: List Option / State=Hover: state "hover" was not captured in light');
    const unmapped = run([cell("default", light, [], lightTokens)], [{ figma: "List Option", element: "[data-testid=option]", variants: {} }]);
    expect(unmapped.map((x) => x.title)).toEqual(expect.arrayContaining([expect.stringContaining("no captured state is mapped")]));
  });

  it("compares only the listed properties", () => {
    const m = node("menu", { "background-color": "rgb(255, 0, 0)", "border-top-left-radius": "4px", "box-shadow": "none" }, { x: 0, y: 0, width: 226, height: 300 });
    const mapping: ComponentMapping = { figma: "Menu", element: "[data-testid=menu]", properties: ["radius"], variants: { "Property 1=Default": { state: "open" } } };
    const f = run([cell("open", light, [m], lightTokens)], [mapping]);
    expect(f.map((x) => x.category)).toEqual(["figma-state-radius"]);
  });

  it("checks shadows against the Light/Dark effect pair of the theme", () => {
    const darkShadow = "rgba(0, 0, 0, 0.3) 0px 6px 20px 0px";
    const lightShadow = "rgba(23, 26, 28, 0.12) 0px 6px 16px 0px";
    const mapping: ComponentMapping = { figma: "Menu", element: "[data-testid=menu]", properties: ["shadow"], variants: { "Property 1=Default": { state: "open" } } };
    const box = { x: 0, y: 0, width: 226, height: 300 };
    const ok = run(
      [cell("open", light, [node("menu", { "box-shadow": lightShadow }, box)]), cell("open", dark, [node("menu", { "box-shadow": darkShadow }, box)])],
      [mapping],
      [light, dark],
    );
    expect(ok).toEqual([]);
    const wrong = run([cell("open", dark, [node("menu", { "box-shadow": lightShadow }, box)])], [mapping], [dark]);
    expect(wrong.map((x) => x.title)).toEqual([expect.stringContaining("Figma ElevationShadow/Dark/E5 0 6 20 #0000004d")]);
    const none = run([cell("open", light, [node("menu", { "box-shadow": "none" }, box)])], [mapping]);
    expect(none[0]).toMatchObject({ category: "figma-state-shadow", severity: "medium" });
  });

  it("flags a colour that matches Figma by eye but comes from another token", () => {
    const m = node("menu", { "background-color": "rgb(247, 247, 248)", "border-top-left-radius": "12px", "box-shadow": "rgba(23, 26, 28, 0.12) 0px 6px 16px 0px" }, { x: 0, y: 0, width: 226, height: 300 });
    const tokens = { ...lightTokens, "--color-level-5": { raw: "#ffffff", color: "rgb(255, 255, 255)" }, "--color-menu-bg": { raw: "#f7f7f8", color: "rgb(247, 247, 248)" } } as SnapshotCell["tokens"];
    const mapping: ComponentMapping = { figma: "Menu", element: "[data-testid=menu]", variants: { "Property 1=Default": { state: "open" } } };
    const f = run([cell("open", light, [m], tokens)], [mapping]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: "figma-state-background-token", severity: "low" });
    expect(f[0]!.title).toContain("--color-menu-bg");
    expect(f[0]!.title).toContain("--color-level-5 is #ffffff here");
  });

  it("explains Figma's opacity override when the product uses the variable's own value", () => {
    const hov = node("option", { "background-color": "rgba(63, 69, 74, 0.6)", color: "rgb(222, 224, 227)" });
    const tokens = { "--color-neutral-92-60": { raw: "", color: "rgba(63, 69, 74, 0.6)" }, "--color-text-01": { raw: "", color: "rgb(222, 224, 227)" } } as SnapshotCell["tokens"];
    const mapping: ComponentMapping = { figma: "List Option", element: "[data-testid=option]", properties: ["background"], variants: { "State=Hover": { state: "hover" } } };
    const f = run([cell("hover", dark, [hov], tokens)], [mapping], [dark]).filter((x) => x.category === "figma-state-background");
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toContain("same token name, different value");
    expect(f[0]!.title).toContain("Figma paints it at 40% instead of the variable's 60%");
  });

  it("collects colours it has no Figma value for instead of guessing", () => {
    const unresolved = new Set<string>();
    const set: FigmaComponentSet = { ...menu, name: "Chip", variants: [{ id: "3:1", name: "Property 1=Default", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 10, 10], fill: { c: "#e9ebec", v: "var(--color-neutral-92)" } }] }] };
    const mapping: ComponentMapping = { figma: "Chip", element: "[data-testid=chip]", variants: { "Property 1=Default": { state: "s" } } };
    const f = run([cell("s", dark, [node("chip", { "background-color": "rgb(1, 2, 3)" })])], [mapping], [dark], [set], unresolved);
    expect(f).toEqual([]);
    expect([...unresolved]).toEqual(["var(--color-neutral-92) (dark)"]);
  });

  it("reports Figma layers that paint a variable at another opacity", () => {
    const f = figmaSelfChecks([option], makeVariableResolver(reference, "light"));
    expect(f).toHaveLength(1);
    expect(f[0]!.title).toContain("List Option / State=Hover . fill is #e9ebec66 although var(--color-neutral-92-60) is #e9ebec99");
  });
});
