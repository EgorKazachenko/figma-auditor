// W3C DTCG 2025.10 tokens as a design source: the adapter that lets non-Figma or non-CSS products feed the checks.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dtcgColor, dtcgDimension, fromDtcg } from "../src/reference/dtcg.js";
import { loadReference, referenceScale } from "../src/reference/figma.js";
import { makeEffectResolver, makeVariableResolver } from "../src/reference/components.js";
import { parseConfig } from "../src/config.js";

const dark = {
  color: {
    $type: "color",
    base: {
      gray900: { $value: { colorSpace: "srgb", components: [0.0627, 0.0706, 0.0745], hex: "#101213" } },
      gray300: { $value: "#9CA3AB" },
      p3: { $value: { colorSpace: "display-p3", components: [1, 0, 0], hex: "#ff0000" } },
      oklch: { $value: { colorSpace: "oklch", components: [0.5, 0.1, 30] } },
    },
    level: { "5": { $value: "{color.base.gray900}" } },
    text: { "2": { $value: "{color.base.gray300}" } },
    overlay: { $value: { colorSpace: "srgb", components: [0.247, 0.271, 0.29], alpha: 0.6 } },
    loopA: { $value: "{color.loopB}" },
    loopB: { $value: "{color.loopA}" },
    missing: { $value: "{color.nope}" },
    viaRef: { $ref: "#/color/base/gray300" },
  },
  spacing: {
    $type: "dimension",
    "2": { $value: { value: 4, unit: "px" } },
    "4": { $value: "0.5rem" },
  },
  radius: { "3": { $type: "dimension", $value: 8 } },
  shadow: {
    e5: {
      $type: "shadow",
      $value: { color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.3 }, offsetX: { value: 0, unit: "px" }, offsetY: { value: 6, unit: "px" }, blur: { value: 20, unit: "px" }, spread: { value: 0, unit: "px" } },
    },
  },
  type: {
    body: { $type: "typography", $value: { fontFamily: ["SF Pro", "system-ui"], fontSize: { value: 14, unit: "px" }, fontWeight: 400, lineHeight: 1.2, letterSpacing: { value: 0, unit: "px" } } },
  },
  motion: { fast: { $type: "duration", $value: { value: 100, unit: "ms" } } },
};

describe("DTCG values", () => {
  it("reads colours in sRGB objects, hex strings and hex fallbacks of other spaces", () => {
    expect(dtcgColor({ colorSpace: "srgb", components: [1, 1, 1] })).toBe("#ffffff");
    expect(dtcgColor({ colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 })).toBe("#00000080");
    expect(dtcgColor("#ABCDEF")).toBe("#abcdef");
    expect(dtcgColor({ colorSpace: "display-p3", components: [1, 0, 0], hex: "#ff0000", alpha: 0.5 })).toBe("#ff000080");
    expect(dtcgColor({ colorSpace: "oklch", components: [0.5, 0.1, 30] })).toBeNull();
    expect(dtcgColor("red")).toBeNull();
  });

  it("reads dimensions in px and rem, objects and strings", () => {
    expect(dtcgDimension({ value: 4, unit: "px" })).toBe(4);
    expect(dtcgDimension({ value: 0.5, unit: "rem" })).toBe(8);
    expect(dtcgDimension("0.5rem", 10)).toBe(5);
    expect(dtcgDimension("12px")).toBe(12);
    expect(dtcgDimension(6)).toBe(6);
    expect(dtcgDimension({ value: 1, unit: "em" })).toBeNull();
  });
});

describe("DTCG adapter", () => {
  const { tokens, warnings } = fromDtcg(dark, { mode: "dark", origin: "dark.tokens.json" });
  const byName = Object.fromEntries(tokens.map((t) => [t.name, t]));

  it("names tokens like CSS custom properties, resolves aliases and inherits $type", () => {
    expect(byName["--color-level-5"]).toMatchObject({ kind: "color", value: "#101213", mode: "dark", figmaName: "var(--color-level-5)" });
    expect(byName["--color-text-2"]!.value).toBe("#9ca3ab");
    expect(byName["--color-viaref"]!.value).toBe("#9ca3ab");
    expect(byName["--color-overlay"]!.value).toBe("#3f454a99");
    expect(byName["--spacing-2"]).toMatchObject({ kind: "number", value: "4" });
    expect(byName["--spacing-4"]!.value).toBe("8");
    expect(byName["--radius-3"]!.value).toBe("8");
  });

  it("turns shadows and typography into the same text as the Figma capture", () => {
    expect(byName["--shadow-e5"]).toMatchObject({ kind: "effect", value: "Effect(type: DROP_SHADOW, color: #0000004D, offset: (0, 6), radius: 20, spread: 0)" });
    expect(byName["--type-body"]!.value).toBe('Font(family: "SF Pro", size: 14, weight: 400, lineHeight: 120, letterSpacing: 0)');
  });

  it("reports what it cannot use instead of guessing", () => {
    expect(warnings).toEqual(
      expect.arrayContaining([
        "dark.tokens.json: alias cycle at color.loopA",
        "dark.tokens.json: alias cycle at color.loopB",
        "dark.tokens.json: color.missing points to missing color.nope",
        "dark.tokens.json: skipped color.base.oklch (color value not supported)",
        "dark.tokens.json: skipped motion.fast (duration value not supported)",
      ]),
    );
    expect(byName["--color-base-p3"]!.value).toBe("#ff0000");
  });

  it("supports other naming conventions", () => {
    const res = fromDtcg({ color: { text: { primary: { $type: "color", $value: "#000000" } } } }, { mode: "light", nameTemplate: "{path}", separator: "." });
    expect(res.tokens[0]).toMatchObject({ name: "color.text.primary", figmaName: "color.text.primary" });
    expect(() => fromDtcg(null, { mode: "x" })).toThrow(/DTCG/);
  });

  it("feeds C7's variable and effect resolvers like Figma captures do", () => {
    const light = fromDtcg({ color: { level: { "5": { $type: "color", $value: "#f7f7f8" } } }, shadow: { e5: { $type: "shadow", $value: { color: "#171a1c1f", offsetX: 0, offsetY: 6, blur: 16, spread: 0 } } } }, { mode: "light" }).tokens;
    const all = [...tokens, ...light];
    const r = makeVariableResolver(all, "light");
    expect(r("var(--color-level-5)", "dark")!.value).toBe("#101213");
    expect(r("var(--color-level-5)", "light")!.value).toBe("#f7f7f8");
    // a pair named by mode in the style; DTCG files usually name it by path, so a plain style works per mode file
    const e = makeEffectResolver(all);
    expect(e({ x: 0, y: 6, blur: 16, spread: 0, c: "#171a1c1f", style: "--shadow-e5" }, "dark")).toMatchObject({ x: 0, y: 6, blur: 16 });
  });
});

describe("DTCG through config and loader", () => {
  it("loads per-mode files, keeps warnings and builds scales from configured prefixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "da-dtcg-"));
    writeFileSync(join(dir, "dark.json"), JSON.stringify(dark));
    writeFileSync(join(dir, "audit.yaml"), `
target: { repo: ., themeEntry: t.css }
contexts: [{ name: dark, colorScheme: dark }]
reference:
  sources:
    - { type: dtcg, path: dark.json, mode: dark }
  scalePrefixes: { spacing: ["--spacing-"], radius: ["--radius-"] }
`);
    const { readFileSync } = await import("node:fs");
    const cfg = parseConfig(readFileSync(join(dir, "audit.yaml"), "utf8"), join(dir, "audit.yaml"));
    expect(cfg.reference.sources[0]).toMatchObject({ type: "dtcg", mode: "dark", path: join(dir, "dark.json") });
    const warnings: string[] = [];
    const ref = await loadReference(cfg.reference.sources, warnings);
    expect(ref.find((t) => t.name === "--color-level-5")!.value).toBe("#101213");
    expect(warnings.length).toBeGreaterThan(0);
    expect(referenceScale(ref, cfg.reference.scalePrefixes.spacing)).toEqual([4, 8]);
    expect(referenceScale(ref, cfg.reference.scalePrefixes.radius)).toEqual([8]);
    expect(() => parseConfig(`target: { repo: ., themeEntry: t.css }\ncontexts: [{ name: d }]\nreference:\n  sources: [{ type: dtcg, path: x.json }]`, "/a.yaml")).toThrow(/path and mode/);
  });
});
