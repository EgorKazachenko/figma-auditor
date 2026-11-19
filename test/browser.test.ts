// Integration tests with a real Chromium (the one Playwright already cached on this machine).
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadThemeCss } from "../src/css/themeCss.js";
import { probeProduct, resolveCodeTokens } from "../src/runtime/browser.js";
import { parseConfig } from "../src/config.js";
import type { Context } from "../src/types.js";

const fixtures = join(import.meta.dirname, "fixtures");
const repo = join(fixtures, "repo");

const contexts: Context[] = [
  { name: "neon-light", html: { "data-theme": "opera", "data-product": "Neon" }, colorScheme: "light", figmaMode: "light", backdrop: "#fff" },
  { name: "neon-dark", html: { "data-theme": "opera-dark", "data-product": "Neon" }, colorScheme: "dark", figmaMode: "dark", backdrop: "#000" },
  { name: "plain-light", html: {}, colorScheme: "light", figmaMode: "light", backdrop: "#fff" },
];

describe("resolveCodeTokens (plain Chromium)", async () => {
  const css = loadThemeCss(join(repo, "src/root/themes/themes.css"), repo);
  const names = [...new Set(css.decls.map((d) => d.name))];
  const resolved = await resolveCodeTokens(css.css, names, contexts);
  const byCtx = Object.fromEntries(resolved.map((r) => [r.context, r.tokens]));

  it("uses env() fallbacks and picks the light-dark() branch per colour scheme", () => {
    expect(byCtx["neon-light"]!["--color-level-5"]!.color).toBe("rgb(255, 255, 255)");
    expect(byCtx["neon-dark"]!["--color-level-5"]!.color).toBe("rgb(23, 26, 28)");
    expect(byCtx["neon-dark"]!["--color-text-02"]!.color).toBe("rgb(117, 128, 138)");
  });

  it("applies product and theme selectors from the html attributes", () => {
    expect(byCtx["neon-dark"]!["--color-model-selector-bg"]!.color).toBe("rgb(16, 18, 19)");
    expect(byCtx["plain-light"]!["--color-model-selector-bg"]!.raw).toBe("");
    expect(byCtx["neon-dark"]!["--color-only-dark"]!.color).toBe("rgb(34, 34, 34)");
    expect(byCtx["neon-light"]!["--color-only-dark"]!.raw).toBe("");
  });

  it("keeps translucency and leaves non-colour tokens without a colour", () => {
    expect(byCtx["neon-light"]!["--color-neutral-92-60"]!.color).toBe("rgba(233, 235, 236, 0.6)");
    expect(byCtx["neon-light"]!["--space-unit"]).toEqual({ raw: "4px", color: null });
  });
});

describe("probeProduct (fixture page)", async () => {
  const out = mkdtempSync(join(tmpdir(), "da-probe-"));
  const url = pathToFileURL(join(fixtures, "pages", "product.html")).href;
  const cfg = parseConfig(
    `
target: { repo: ${repo}, themeEntry: src/root/themes/themes.css }
contexts:
  - { name: light, colorScheme: light, html: { data-product: Neon } }
  - { name: dark, colorScheme: dark, html: { data-product: Neon } }
runtime:
  actionTimeoutMs: 1500
  surfaces:
    - name: product
      url: "${url}"
      waitFor: "[data-ds-component]"
      states:
        - name: default
        - name: missing
          waitFor: "[data-testid=does-not-exist]"
`,
    join(out, "c.yaml"),
  );
  cfg.runtime.surfaces[0]!.states[1] = { name: "missing", actions: [{ click: "[data-testid=does-not-exist]" }] };
  const res = await probeProduct(cfg, ["--color-level-5", "--color-text-02", "--space-unit"], out);
  const light = res.cells.find((c) => c.context === "light")!;
  const dark = res.cells.find((c) => c.context === "dark")!;

  it("captures one cell per surface, state and context and reports failing states", () => {
    expect(res.cells.map((c) => `${c.surface}/${c.state}/${c.context}`)).toEqual(["product/default/light", "product/default/dark"]);
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toMatch(/product\/missing\/light/);
  });

  it("resolves tokens as the page sees them in each colour scheme", () => {
    expect(light.tokens["--color-level-5"]!.color).toBe("rgb(255, 255, 255)");
    expect(dark.tokens["--color-text-02"]!.color).toBe("rgb(156, 163, 171)");
    expect(dark.tokens["--space-unit"]!.color).toBeNull();
  });

  it("collects visible marked elements, including inside open shadow roots, and skips hidden ones", () => {
    const ids = light.nodes.map((n) => n.component ?? n.testId);
    // The <svg> root is kept; its illustration content is skipped by default.
    expect(ids).toEqual(["ModelSelector", "title", "pill", "bordered", "container", "illustration", "in-shadow"]);
    const shadow = light.nodes.find((n) => n.testId === "in-shadow")!;
    expect(shadow.path).toBe('div[data-testid="in-shadow"]');
    expect(shadow.css["background-color"]).toBe("rgb(171, 205, 239)");
    expect(light.nodes.find((n) => n.testId === "container")!.hasText).toBe(false);
    expect(light.nodes.find((n) => n.testId === "title")!.css["padding-top"]).toBe("10px");
  });

  it("runs the setup module before surfaces open", async () => {
    const withSetup = parseConfig(
      `
target: { repo: ${repo}, themeEntry: src/root/themes/themes.css }
contexts:
  - { name: light, colorScheme: light }
runtime:
  setup: ${join(fixtures, "setup", "inject.mjs")}
  surfaces:
    - { name: product, url: "${url}" }
`,
      join(out, "c2.yaml"),
    );
    const r = await probeProduct(withSetup, [], out);
    const marker = r.cells[0]!.nodes.find((n) => n.testId === "setup-marker");
    expect(marker?.text).toBe("light/light");
  });

  it("explains a setup module without a default export", async () => {
    const bad = parseConfig(
      `
target: { repo: ${repo}, themeEntry: x.css }
contexts: [{ name: light }]
runtime:
  setup: ${join(fixtures, "figma", "light.json")}
  surfaces: [{ name: p, url: "${url}" }]
`,
      join(out, "c3.yaml"),
    );
    await expect(probeProduct(bad, [], out)).rejects.toThrow();
  });

  it("forces the context attributes onto <html> and saves a screenshot per cell", () => {
    expect(light.screenshot).toBe("shots/product-default-light.png");
    expect(existsSync(join(out, light.screenshot!))).toBe(true);
  });
});
