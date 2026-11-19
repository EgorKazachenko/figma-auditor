// Harness driver: the product's own Playwright suite captures the states; design-auditor writes the
// capture spec, runs the command and reads the cells back. A Node script stands in for Playwright here.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig } from "../src/config.js";
import { buildCaptureSpec, harnessCommand, readCaptureDir, runHarness } from "../src/runtime/harness.js";
import { PROBE_PATH, PROBE_PROPS } from "../src/runtime/browser.js";
import { runAudit } from "../src/pipeline.js";
import { cellKey } from "../src/baseline.js";

const fixtures = join(import.meta.dirname, "fixtures");

function setup(extra = "", viewports = "") {
  const dir = mkdtempSync(join(tmpdir(), "da-harness-"));
  const product = join(dir, "product");
  mkdirSync(product);
  writeFileSync(join(product, "the-spec.test.ts"), "// harness spec placeholder\n");
  writeFileSync(join(product, "themes.css"), ":root { --color-level-5: #f7f7f8; }\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify([{ id: "gpt", model_group: "gpt" }]));
  writeFileSync(
    join(dir, "components.json"),
    JSON.stringify({
      source: { fileKey: "LIB" },
      sets: [
        {
          id: "1:1",
          name: "Model",
          page: "0:1",
          variantProps: { "Property 1": ["Default", "Hover"] },
          variants: [
            { id: "1:2", name: "Property 1=Default", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 100, 33], radius: 8 }] },
            { id: "1:3", name: "Property 1=Hover", layers: [{ path: ".", type: "COMPONENT", box: [0, 0, 100, 33], radius: 8, fill: { c: "#e9ebec66", v: "var(--color-neutral-92-60)" } }] },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "audit.yaml"),
    `
target: { repo: product, themeEntry: themes.css }
contexts:
  - { name: light, colorScheme: light }
  - { name: dark, colorScheme: dark }
reference:
  components: [components.json]
figmaComponents:
  - figma: Model
    element: "[data-testid=chip]"
    variants: { "Property 1=Default": input, "Property 1=Hover": hover }
runtime:
  driver: harness
  actionTimeoutMs: 4000
  harness:
    cwd: product
    spec: the-spec.test.ts
    command: [node, ${join(fixtures, "harness", "fake-harness.mjs")}, "{spec}"]
    env: { FAKE_ENV: "from-config" }
    flags: [{ effort_model: false }, { effort_model: true }]
    routes:
      - { url: "**/available-models**", file: models.json }
      - { url: "**/inline**", json: { ok: true } }
    viewport: { width: 604, height: 900 }
${viewports}
  surfaces:
    - name: sidepanel
      states:
        - { name: input, waitFor: "[data-testid=chip]" }
        - { name: hover, actions: [{ hover: "[data-testid=chip]" }, { moveAway: true }] }
        - { name: broken, actions: [{ click: "[data-testid=nope]", nth: 2 }] }
report: { dir: out }
history: { path: out/history.json }
baseline: { dir: out/baselines }
${extra}`,
  );
  return { dir, cfg: parseConfig(readFileSync(join(dir, "audit.yaml"), "utf8"), join(dir, "audit.yaml")) };
}

describe("harness config", () => {
  it("reads the driver, harness command, flag steps, routes and C7 mappings", () => {
    const { dir, cfg } = setup();
    expect(cfg.runtime.driver).toBe("harness");
    expect(cfg.runtime.harness).toMatchObject({ cwd: join(dir, "product"), spec: "the-spec.test.ts", flags: [{ effort_model: false }, { effort_model: true }], viewport: { width: 604, height: 900 }, timeoutMs: 600000 });
    expect(cfg.runtime.harness!.routes[0]).toEqual({ url: "**/available-models**", json: undefined, file: join(dir, "models.json") });
    expect(cfg.runtime.surfaces[0]!.url).toBe("");
    expect(cfg.figmaComponents[0]!.variants).toEqual({ "Property 1=Default": { state: "input" }, "Property 1=Hover": { state: "hover" } });
    expect(cfg.reference.components).toEqual([join(dir, "components.json")]);
  });

  it("explains broken harness and mapping config", () => {
    const base = "target: {repo: r, themeEntry: t}\ncontexts: [{name: l}]\n";
    expect(() => parseConfig(`${base}runtime: { driver: docker }`, "/a.yaml")).toThrow(/launch or harness/);
    expect(() => parseConfig(`${base}runtime: { driver: harness }`, "/a.yaml")).toThrow(/runtime.harness/);
    expect(() => parseConfig(`${base}runtime: { driver: harness, harness: { cwd: x, spec: s, command: [] } }`, "/a.yaml")).toThrow(/command/);
    expect(() => parseConfig(`${base}runtime: { harness: { cwd: x, spec: s, command: [a], routes: [{ url: u }] } }`, "/a.yaml")).toThrow(/json or file/);
    expect(() => parseConfig(`${base}runtime: { surfaces: [{ name: s }] }`, "/a.yaml")).toThrow(/url/);
    expect(() => parseConfig(`${base}figmaComponents: [{ figma: X }]`, "/a.yaml")).toThrow(/element/);
    expect(() => parseConfig(`${base}figmaComponents: [{ figma: X, element: "", variants: {} }]`, "/a.yaml")).toThrow(ConfigError);
    expect(parseConfig(`${base}figmaComponents: [{ figma: X, element: ".contextmenu", variants: {} }]`, "/a.yaml").figmaComponents[0]!.element).toBe(".contextmenu");
    expect(() => parseConfig(`${base}figmaComponents: [{ figma: X, element: "[data-testid=x]", variants: { a: 3 } }]`, "/a.yaml")).toThrow(/state name/);
    expect(() => parseConfig(`${base}figmaComponents: [{ figma: X, element: "[data-testid=x]", variants: {}, properties: [colour] }]`, "/a.yaml")).toThrow(/unknown "colour"/);
    const ok = parseConfig(`${base}figmaComponents: [{ figma: X, element: "[data-testid=x]", variants: { a: null, b: { state: s, nth: 2 } }, properties: [radius] }]`, "/a.yaml");
    expect(ok.figmaComponents[0]).toMatchObject({ variants: { a: null, b: { state: "s", nth: 2 } }, properties: ["radius"] });
    expect(parseConfig(`${base}runtime: { harness: { cwd: x, spec: s, command: [a], flags: { f: true } } }`, "/a.yaml").runtime.harness!.flags).toEqual([{ f: true }]);
  });
});

describe("harness capture", () => {
  it("builds the capture spec from the config", () => {
    const { cfg } = setup();
    const spec = buildCaptureSpec(cfg, ["--a"], ["color"]);
    expect(spec).toMatchObject({
      surface: "sidepanel",
      flagSteps: [{ effort_model: false }, { effort_model: true }],
      actionTimeoutMs: 4000,
      routes: [{ url: "**/available-models**", json: [{ id: "gpt", model_group: "gpt" }] }, { url: "**/inline**", json: { ok: true } }],
      tokens: ["--a"],
      props: ["color"],
      selector: "[data-ds-component],[data-testid]",
      contexts: [{ name: "light", colorScheme: "light" }, { name: "dark", colorScheme: "dark" }],
    });
    expect(spec.states[2]).toEqual({ name: "broken", actions: [{ click: "[data-testid=nope]", nth: 2 }], waitFor: undefined });
  });

  it("substitutes the spec and environment in the command", () => {
    process.env.DA_HARNESS_PROJECT = "Opera Neon";
    expect(harnessCommand(["npx", "playwright", "test", "{spec}", "--project", "${DA_HARNESS_PROJECT}"], "a.test.ts")).toEqual(["npx", "playwright", "test", "a.test.ts", "--project", "Opera Neon"]);
    expect(() => harnessCommand(["${DA_HARNESS_UNSET}"], "a")).toThrow(/DA_HARNESS_UNSET/);
  });

  it("runs the harness and reads cells in context and state order, with one warning per failed state", async () => {
    const { dir, cfg } = setup();
    const out = join(dir, "run");
    const res = await runHarness(cfg, ["--color-level-5"], out, { probePath: PROBE_PATH, props: PROBE_PROPS });
    expect(res.cells.map((c) => `${c.state}/${c.context}`)).toEqual(["input/light", "hover/light", "input/dark", "hover/dark"]);
    expect(res.browser).toBe("Fake Neon probe");
    const first = res.cells[0] as unknown as Record<string, unknown>;
    expect(first.flags).toEqual([{ effort_model: false }, { effort_model: true }]);
    expect(first.routes).toBe(2);
    expect(first.timeout).toBe(4000);
    expect(first.env).toBe("from-config");
    expect(res.warnings).toEqual([
      "sidepanel/broken/dark: locator.click: Timeout 10000ms exceeded.",
      "sidepanel/broken/light: locator.click: Timeout 10000ms exceeded.",
    ]);
  });

  it("reports a crashed harness and a missing spec file", async () => {
    const { dir, cfg } = setup();
    process.env.FAKE_HARNESS_FAIL = "1";
    try {
      const res = await runHarness(cfg, [], join(dir, "run2"), { probePath: PROBE_PATH, props: PROBE_PROPS });
      expect(res.cells).toEqual([]);
      expect(res.warnings.join("\n")).toMatch(/exited with code 1: .*browser crashed/);
      expect(res.warnings.join("\n")).toMatch(/no cells \(is the product.s mock backend running/);
    } finally {
      delete process.env.FAKE_HARNESS_FAIL;
    }
    cfg.runtime.harness!.spec = "missing.test.ts";
    await expect(runHarness(cfg, [], join(dir, "run3"), { probePath: PROBE_PATH, props: PROBE_PROPS })).rejects.toThrow(/capture spec there/);
  });

  it("reads an empty or missing capture folder without throwing", () => {
    expect(readCaptureDir("/nonexistent/da").warnings[0]).toMatch(/does not exist/);
  });

  it("feeds C7 through the pipeline: states per theme, coverage and differences", async () => {
    const { cfg } = setup();
    const { report } = await runAudit(cfg, { checks: ["c7"], runtime: true, history: false, now: new Date("2026-11-19T10:00:00Z") });
    expect(report.meta.checks).toEqual(["C7"]);
    const c7 = report.findings.filter((f) => f.check === "C7");
    // dark hover is red where Figma has no dark value for the variable: not compared, listed in the notes
    expect(report.notes.join("\n")).toMatch(/C7: no Figma value for var\(--color-neutral-92-60\) \(dark\)/);
    // dark default: red background where Figma has none
    expect(c7.map((f) => `${f.component}|${f.context}|${f.category}`)).toContain("Model / Property 1=Default|dark|figma-state-background");
    // light hover: transparent where Figma paints neutral-92-60
    const missing = c7.find((f) => f.component === "Model / Property 1=Hover" && f.context === "light")!;
    expect(missing.title).toContain("background is missing");
    expect(report.notes.join("\n")).toMatch(/Runtime warning: sidepanel\/broken\/light/);
    expect(report.groups.some((g) => g.key.startsWith("C7|"))).toBe(true);
  });

  it("captures every state per viewport; the first viewport keeps the plain cell key", async () => {
    const { dir, cfg } = setup("", "  viewports:\n    - { name: narrow, width: 604, height: 900 }\n    - { name: wide, width: 755, height: 900 }");
    expect(cfg.runtime.viewports.map((v) => v.name)).toEqual(["narrow", "wide"]);
    const spec = buildCaptureSpec(cfg, [], []);
    expect(spec.viewports).toEqual([{ name: "narrow", width: 604, height: 900 }, { name: "wide", width: 755, height: 900 }]);
    const res = await runHarness(cfg, [], join(dir, "vp"), { probePath: PROBE_PATH, props: PROBE_PROPS });
    expect(res.cells.map((c) => `${c.state}/${c.context}${c.viewport ? "@" + c.viewport : ""}`)).toEqual([
      "input/light", "input/light@wide", "hover/light", "hover/light@wide", "input/dark", "input/dark@wide", "hover/dark", "hover/dark@wide",
    ]);
    expect(cellKey(res.cells[1]!)).toBe("sidepanel__input__light__wide");
    expect(res.warnings).toContain("sidepanel/broken/light/wide: locator.click: Timeout 10000ms exceeded.");

    // C7 compares every viewport; identical findings merge into one with occurrences.
    const { report } = await runAudit(cfg, { checks: ["c7", "c8"], runtime: true, history: false, write: false });
    const darkDefault = report.findings.find((f) => f.component === "Model / Property 1=Default" && f.context === "dark" && f.category === "figma-state-background")!;
    expect(darkDefault.occurrences).toBe(2);
    // C8 reads the texts of any cell, whatever the driver
    const c8 = report.findings.filter((f) => f.check === "C8");
    expect(c8.map((f) => f.context).sort()).toEqual(["dark", "light"]);
    expect(c8[0]!.occurrences).toBe(4); // 2 states × 2 viewports
    expect(report.notes.join("\n")).toMatch(/C8: 8 texts checked/);
  });

  it("uses harness.viewport as the single default viewport and validates viewport lists", () => {
    const { cfg } = setup();
    expect(cfg.runtime.viewports).toEqual([{ name: "default", width: 604, height: 900 }]);
    const base = "target: {repo: r, themeEntry: t}\ncontexts: [{name: l}]\n";
    expect(() => parseConfig(`${base}runtime: { viewports: [{ name: a, width: 0, height: 10 }] }`, "/a.yaml")).toThrow(/name, width and height/);
    expect(() => parseConfig(`${base}runtime: { viewports: [{ name: a, width: 1, height: 1 }, { name: a, width: 2, height: 2 }] }`, "/a.yaml")).toThrow(/unique/);
  });
});
