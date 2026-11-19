// C9 · accessibility from captured cells: focus visible, target size, non-text contrast.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAccessibility, crowdedTargets, focusIndicator, shadowLayer, type C9Stats } from "../src/checks/c9Accessibility.js";
import { parseConfig } from "../src/config.js";
import { probeProduct } from "../src/runtime/browser.js";
import type { FocusLook, SnapshotCell, TargetSample } from "../src/types.js";

const look = (over: Partial<FocusLook> = {}): FocusLook => ({
  outlineStyle: "none",
  outlineWidth: 0,
  outlineColor: "rgb(0, 0, 0)",
  outlineOffset: 0,
  boxShadow: "none",
  border: null,
  fill: "#ffffff",
  color: "rgb(17, 17, 17)",
  backdrop: "#ffffff",
  ...over,
});

const target = (label: string, box: TargetSample["box"], over: Partial<TargetSample> = {}): TargetSample => ({
  path: `button#${label}`,
  label: `button#${label}`,
  role: "button",
  box,
  inline: false,
  hidden: false,
  disabled: false,
  textEntry: false,
  hasText: true,
  backdrop: "#ffffff",
  fill: "#ffffff",
  border: null,
  icon: null,
  viewFraction: 1,
  ancestorOf: [],
  ...over,
});

const cell = (over: Partial<SnapshotCell>): SnapshotCell => ({ surface: "s", state: "x", context: "light", url: "u", browser: "b", tokens: {}, nodes: [], ...over });

describe("focus indicator", () => {
  it("accepts a visible outline and rejects nothing or a faint change", () => {
    expect(focusIndicator({ focused: look({ outlineStyle: "solid", outlineWidth: 2, outlineColor: "rgb(24, 119, 215)" }), rest: look() })).toMatchObject({ kind: "ok" });
    expect(focusIndicator({ focused: look(), rest: look() })).toMatchObject({ kind: "none" });
    const weak = focusIndicator({ focused: look({ fill: "#f2f2f2" }), rest: look() });
    expect(weak.kind).toBe("weak");
    expect(weak.what).toContain("background #ffffff → #f2f2f2");
  });

  it("reads focus rings drawn with box-shadow, including inset rings", () => {
    expect(shadowLayer("rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgb(24, 119, 215) 0px 0px 0px 2px")).toMatchObject({ spread: 2, inset: false });
    expect(shadowLayer("rgb(24, 119, 215) 0px 0px 0px 2px inset")).toMatchObject({ inset: true });
    expect(shadowLayer("none")).toBeNull();
    expect(focusIndicator({ focused: look({ boxShadow: "rgb(24, 119, 215) 0px 0px 0px 2px" }), rest: look() }).kind).toBe("ok");
  });

  it("compares the active option with a sibling when there is no unfocused look", () => {
    expect(focusIndicator({ focused: look({ outlineStyle: "solid", outlineWidth: 2, outlineColor: "rgb(0, 0, 0)" }), rest: null }).kind).toBe("ok");
    expect(focusIndicator({ focused: look({ fill: "#f5f5f5" }), rest: null }).kind).toBe("none");
  });
});

describe("target size", () => {
  it("fails undersized targets that crowd a neighbour, and passes them when a 24 px circle is clear", () => {
    const ts = [target("a", { x: 0, y: 0, width: 16, height: 16 }), target("b", { x: 20, y: 0, width: 16, height: 16 }), target("alone", { x: 300, y: 0, width: 16, height: 16 }), target("big", { x: 0, y: 100, width: 40, height: 40 })];
    const stats: C9Stats = { focusChecked: 0, targetsChecked: 0, targetsSpaced: 0, boundariesChecked: 0, iconsChecked: 0 };
    expect(crowdedTargets(ts, 24, stats).map((x) => `${x.t.label}~${x.near.label}`)).toEqual(["button#a~button#b", "button#b~button#a"]);
    expect(stats).toMatchObject({ targetsChecked: 4, targetsSpaced: 1 });
  });

  it("exempts inline links, disabled and hidden controls, and nested targets", () => {
    const ts = [
      target("link", { x: 0, y: 0, width: 30, height: 16 }, { inline: true }),
      target("off", { x: 32, y: 0, width: 16, height: 16 }, { disabled: true }),
      target("sr", { x: 34, y: 0, width: 1, height: 1 }, { hidden: true }),
      target("row", { x: 100, y: 0, width: 300, height: 40 }, { ancestorOf: [4] }),
      target("icon", { x: 110, y: 12, width: 16, height: 16 }),
    ];
    expect(crowdedTargets(ts)).toEqual([]);
  });
});

describe("C9 findings", () => {
  it("reports focus problems, crowded targets, faint field borders and faint icons once per element and theme", () => {
    const c = cell({
      focus: { path: "button#x", label: "button#x", box: { x: 0, y: 0, width: 80, height: 32 }, via: "focus", focused: look(), rest: look(), obscured: { samples: 5, covered: 5, centerCovered: true, by: ["div#cover"], overlayOnly: false } },
      targets: [
        target("field", { x: 0, y: 100, width: 200, height: 32 }, { textEntry: true, hasText: false, border: { width: 1, color: "#e6e6e6" } }),
        target("okfield", { x: 0, y: 140, width: 200, height: 32 }, { textEntry: true, hasText: false, border: { width: 1, color: "#767676" } }),
        target("icon", { x: 0, y: 200, width: 32, height: 32 }, { hasText: false, icon: "#cccccc" }),
        target("iconok", { x: 40, y: 200, width: 32, height: 32 }, { hasText: false, icon: "#555555" }),
        target("filled", { x: 0, y: 260, width: 200, height: 32 }, { textEntry: true, hasText: false, fill: "#333333", border: { width: 1, color: "#3a3a3a" } }),
      ],
    });
    const f = checkAccessibility([c, { ...c, state: "y" }]);
    const cats = f.map((x) => `${x.category}/${x.severity} ${x.component}`).sort();
    expect([...new Set(cats)]).toEqual([
      "field-boundary-contrast/medium button#field",
      "focus-not-visible/high button#x",
      "focus-obscured/high button#x",
      "icon-contrast/medium button#icon",
    ]);
    // The same problem in two states is one fingerprint (merged by the pipeline).
    expect(new Set(f.map((x) => x.fingerprint)).size).toBe(4);
    expect(f.find((x) => x.category === "focus-not-visible")!.expected?.source).toBe("WCAG 2.2 AA 2.4.7");
  });

  it("skips cells without target or focus data", () => {
    expect(checkAccessibility([cell({})])).toEqual([]);
  });
});

describe("C9 and the matrix on a real page in Chromium", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-c9-"));
  const url = pathToFileURL(join(import.meta.dirname, "fixtures", "pages", "a11y.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ${join(import.meta.dirname, "fixtures")}, themeEntry: x.css }
contexts: [{ name: light, colorScheme: light }]
runtime:
  forceContextAttributes: false
  collectSelector: "[data-testid]"
  viewports:
    - { name: default, width: 800, height: 900 }
    - { name: z200, width: 800, height: 900, zoom: 2, states: [default] }
    - { name: de, width: 800, height: 900, locale: de, states: [default] }
  surfaces:
    - name: a11y
      url: "${url}"
      states:
        - { name: default }
        - { name: focus-good, actions: [{ tabTo: "#good-focus" }] }
        - { name: focus-none, actions: [{ tabTo: "#no-focus" }] }
        - { name: focus-weak, actions: [{ tabTo: "#weak-focus" }] }
        - { name: focus-option, actions: [{ tabTo: "#listbox" }] }
        - { name: focus-covered, actions: [{ tabTo: "#covered" }] }
        - { name: focus-hidden, actions: [{ tabTo: "[data-testid=sr-only-box]" }] }
        - { name: focus-labelled, actions: [{ tabTo: "#labelled-box" }] }
`,
    join(out, "c.yaml"),
  );
  const { cells, warnings } = await probeProduct(cfg, [], out);
  const byState = (s: string, vp?: string) => cells.find((c) => c.state === s && c.viewport === vp)!;
  const f = checkAccessibility(cells);
  // One category per element (the same finding in several cells merges in the pipeline).
  const about = (who: string) => [...new Set(f.filter((x) => x.component?.includes(`"${who}"`) || x.component?.endsWith(`#${who}`)).map((x) => x.category))];

  it("captures every state once, and the zoom and language variants only where asked", () => {
    expect(warnings).toEqual([]);
    expect(cells.map((c) => `${c.state}${c.viewport ? "@" + c.viewport : ""}`).sort()).toEqual(
      ["default", "default@de", "default@z200", "focus-covered", "focus-good", "focus-hidden", "focus-labelled", "focus-none", "focus-option", "focus-weak"].sort(),
    );
    const z = byState("default", "z200");
    expect(z.zoom).toBe(2);
    expect(z.page!.innerWidth).toBe(400); // browser zoom: the layout viewport shrinks
    expect(z.nodes.find((n) => n.testId === "lang")!.text).toContain("width=400");
    const de = byState("default", "de");
    expect(de.locale).toBe("de");
    expect(de.nodes.find((n) => n.testId === "lang")!.text).toContain("lang=de");
    expect(byState("default").focus).toBeNull();
  });

  it("tells a visible focus ring from none, a weak one, a weak active option and a covered focus", () => {
    expect(about("good-focus")).toEqual([]);
    expect(about("no-focus")).toEqual(["focus-not-visible"]);
    expect(about("weak-focus")).toEqual(["focus-indicator-contrast"]);
    expect(byState("focus-option").focus!.via).toBe("activedescendant");
    expect(f.filter((x) => x.cell?.state === "focus-option" && x.property === "focus").map((x) => x.category)).toEqual(["focus-indicator-contrast"]);
    expect(about("covered")).toContain("focus-obscured");
    // A visually hidden control: its label shows focus, or nothing does.
    expect(byState("focus-labelled").focus!.via).toBe("label");
    expect(f.filter((x) => x.cell?.state === "focus-labelled" && x.property === "focus")).toEqual([]);
    expect(byState("focus-hidden").focus!.via).toBe("hidden");
    expect(f.find((x) => x.cell?.state === "focus-hidden" && x.property === "focus")!.title).toContain("visually hidden control");
  });

  it("finds controls taken out of the Tab order, but not roving-focus widget items", () => {
    expect(about("untabbable")).toEqual(["not-keyboard-reachable"]);
    expect(about("roving")).toEqual([]);
  });

  it("finds crowded small targets but not spaced ones, inline links or sr-only inputs", () => {
    expect(about("tiny-a")).toContain("target-size");
    expect(about("tiny-b")).toContain("target-size");
    expect(about("tiny-alone")).toEqual([]);
    expect(about("inline-link")).toEqual([]);
    expect(about("sr-only-box")).not.toContain("target-size");
  });

  it("finds faint field borders and icons, not good or disabled ones", () => {
    expect(about("faint-field")).toEqual(expect.arrayContaining(["field-boundary-contrast"]));
    expect(about("good-field")).toEqual([]);
    expect(about("faint-icon")).toEqual(["icon-contrast"]);
    expect(about("good-icon")).toEqual([]);
    expect(about("disabled-icon")).toEqual([]);
  });
});

describe("matrix variants in the config", () => {
  const base = `target: { repo: r, themeEntry: t }\ncontexts: [{ name: l }]\nruntime:\n  surfaces: [{ name: s, url: u, states: [{ name: a }, { name: b }] }]\n`;
  it("reads zoom, locale and the states a variant applies to", () => {
    const c = parseConfig(`${base}  viewports:\n    - { name: d, width: 600, height: 900 }\n    - { name: z, width: 600, height: 900, zoom: 1.5, states: [a] }\n    - { name: fi, width: 600, height: 900, locale: fi }\n`, "/a.yaml");
    expect(c.runtime.viewports).toEqual([
      { name: "d", width: 600, height: 900 },
      { name: "z", width: 600, height: 900, zoom: 1.5, states: ["a"] },
      { name: "fi", width: 600, height: 900, locale: "fi" },
    ]);
  });
  it("explains broken variants", () => {
    const bad = (v: string) => () => parseConfig(`${base}  viewports:\n    - { name: d, width: 600, height: 900 }\n    - ${v}\n`, "/a.yaml");
    expect(bad("{ name: z, width: 600, height: 900, zoom: 9 }")).toThrow(/between 0.25 and 5/);
    expect(bad("{ name: z, width: 600, height: 900, locale: German }")).toThrow(/language tag/);
    expect(bad("{ name: z, width: 600, height: 900, states: [nope] }")).toThrow(/state "nope"/);
    expect(() => parseConfig(`${base}  viewports:\n    - { name: d, width: 600, height: 900, states: [a] }\n`, "/a.yaml")).toThrow(/applies to every state/);
  });
});

describe("state retries in the launch driver", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-retry-"));
  const url = pathToFileURL(join(import.meta.dirname, "fixtures", "pages", "a11y.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ${join(import.meta.dirname, "fixtures")}, themeEntry: x.css }
contexts: [{ name: light, colorScheme: light }]
runtime:
  forceContextAttributes: false
  actionTimeoutMs: 300
  collectSelector: "[data-testid]"
  viewports: [{ name: short, width: 800, height: 300 }]
  surfaces:
    - name: a11y
      url: "${url}"
      states:
        - { name: never, waitFor: "#does-not-exist", retries: 1 }
        - { name: ok, actions: [{ reload: true }, { fill: "#good-field", value: "typed" }, { scrollIntoView: "#lang" }], waitFor: "#good-field" }
`,
    join(out, "c.yaml"),
  );
  const { cells, warnings } = await probeProduct(cfg, [], out);
  it("runs a failing state again and says how many attempts it took", () => {
    expect(warnings).toEqual([expect.stringMatching(/^a11y\/never\/light: .*\(after 2 attempts\)$/)]);
    expect(cells.map((c) => c.state)).toEqual(["ok"]);
    // scrollIntoView scrolled the page down to the last element (at y ≈ 800 before scrolling)
    expect(cells[0]!.nodes.find((n) => n.testId === "lang")!.box.y).toBeLessThan(300);
  });
});
