import { describe, expect, it } from "vitest";
import { buildNameIndex, cssVarName, tokenKey } from "../src/names.js";

describe("cssVarName", () => {
  it("unwraps Figma's var() code syntax", () => {
    expect(cssVarName("var(--color-text-2)")).toBe("--color-text-2");
    expect(cssVarName("var( --Color-Level-5 )")).toBe("--color-level-5");
    expect(cssVarName("--color-x")).toBe("--color-x");
  });

  it("returns null for non-CSS names", () => {
    expect(cssVarName("spacing_2")).toBeNull();
    expect(cssVarName("MacOS/Body/M")).toBeNull();
  });
});

describe("tokenKey", () => {
  it("drops leading zeros in numeric segments", () => {
    expect(tokenKey("--color-text-02")).toBe("--color-text-2");
    expect(tokenKey("var(--color-text-2)")).toBe("--color-text-2");
    expect(tokenKey("--color-text-00")).toBe("--color-text-0");
  });

  it("keeps non-numeric segments and numbers with letters intact", () => {
    expect(tokenKey("--color-neutral-92-60")).toBe("--color-neutral-92-60");
    expect(tokenKey("--color-level-1a")).toBe("--color-level-1a");
  });
});

describe("buildNameIndex", () => {
  const index = buildNameIndex(["--color-text-02", "--color-level-5", "--brand"], { "var(--color-primary)": "--brand" });

  it("matches Figma names to code names through the key", () => {
    expect(index("var(--color-text-2)")).toBe("--color-text-02");
    expect(index("var(--color-level-5)")).toBe("--color-level-5");
  });

  it("prefers explicit aliases", () => {
    expect(index("var(--color-primary)")).toBe("--brand");
  });

  it("returns null when nothing matches", () => {
    expect(index("var(--color-nope)")).toBeNull();
  });
});
