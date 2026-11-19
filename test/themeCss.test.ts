import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadThemeCss, parseEnv, readTailwindScale, splitTopLevel, winningDecl } from "../src/css/themeCss.js";

const repo = join(import.meta.dirname, "fixtures", "repo");
const entry = join(repo, "src/root/themes/themes.css");

describe("splitTopLevel and parseEnv", () => {
  it("splits only at top-level commas", () => {
    expect(splitTopLevel("a, light-dark(#fff, #000), b")).toEqual(["a", "light-dark(#fff, #000)", "b"]);
  });

  it("reads env() name and fallback, including nested functions", () => {
    expect(parseEnv("env(-neon-color-elevation-5, light-dark(#ffffff, #171a1c))")).toEqual({
      envName: "-neon-color-elevation-5",
      fallback: "light-dark(#ffffff, #171a1c)",
    });
    expect(parseEnv("env(-opera-x)")).toEqual({ envName: "-opera-x" });
  });

  it("ignores values that are not a single env() call", () => {
    expect(parseEnv("#fff")).toBeNull();
    expect(parseEnv("env(-a) env(-b)")).toBeNull();
    expect(parseEnv("calc(env(-a) + 1px)")).toBeNull();
  });
});

describe("loadThemeCss", () => {
  const loaded = loadThemeCss(entry, repo);

  it("follows relative @import rules in order and warns about the rest", () => {
    expect(loaded.files).toEqual(["src/root/themes/base.css", "src/root/themes/neon.css", "src/root/themes/themes.css"]);
    expect(loaded.warnings.some((w) => w.includes("@/root/themes/alias-import.css"))).toBe(true);
    expect(loaded.css).not.toContain("@import");
    expect(loaded.css.indexOf("--color-level-5")).toBeLessThan(loaded.css.indexOf("--color-model-selector-bg"));
  });

  it("records each custom property with file, line, selector and env parts", () => {
    const d = loaded.decls.find((x) => x.name === "--color-level-5" && x.selector === "html")!;
    expect(d).toMatchObject({
      file: "src/root/themes/base.css",
      line: 3,
      envName: "-neon-color-elevation-5",
      fallback: "light-dark(#ffffff, #171a1c)",
      key: "--color-level-5",
    });
    const plain = loaded.decls.find((x) => x.name === "--color-accent-60")!;
    expect(plain.envName).toBeUndefined();
    expect(loaded.decls.find((x) => x.name === "--color-text-02")!.key).toBe("--color-text-2");
  });

  it("keeps the at-rule context in the selector", () => {
    const inMedia = loaded.decls.find((x) => x.name === "--color-level-5" && x.selector.startsWith("@media"));
    expect(inMedia?.selector).toBe("@media (min-width: 9999px) > html");
  });
});

describe("winningDecl", () => {
  const { decls } = loadThemeCss(entry, repo);

  it("picks the product override over the base html rule by attribute specificity", () => {
    const neon = { "data-theme": "opera", "data-product": "Neon" };
    expect(winningDecl(decls, "--color-model-selector-bg", neon)?.file).toBe("src/root/themes/neon.css");
    expect(winningDecl(decls, "--color-model-selector-bg", { "data-theme": "opera" })).toBeUndefined();
  });

  it("ignores declarations inside at-rules and matches theme attributes", () => {
    expect(winningDecl(decls, "--color-level-5", {})?.selector).toBe("html");
    expect(winningDecl(decls, "--color-only-dark", { "data-theme": "opera-dark" })?.value).toBe("#222222");
    expect(winningDecl(decls, "--color-only-dark", { "data-theme": "opera" })).toBeUndefined();
  });

  it("lets a later declaration with equal specificity win", () => {
    const later = [
      ...decls,
      { ...decls.find((d) => d.name === "--color-accent-60")!, value: "#000000", file: "later.css" },
    ];
    expect(winningDecl(later, "--color-accent-60", {})?.file).toBe("later.css");
  });
});

describe("readTailwindScale", () => {
  it("reads px values for a key prefix without executing the config", () => {
    expect(readTailwindScale(join(repo, "tailwind.config.ts"), "aria-")).toEqual([2, 4, 8, 12]);
  });

  it("returns an empty scale for a missing file", () => {
    expect(readTailwindScale(join(repo, "nope.ts"), "aria-")).toEqual([]);
  });
});
