import { describe, expect, it } from "vitest";
import { colorDistance, composite, deltaE2000, isTransparent, normalizeColor, parseColor, rgbToLab, toHex } from "../src/color.js";

describe("parseColor", () => {
  it.each([
    ["#fff", { r: 255, g: 255, b: 255, a: 1 }],
    ["#ffff", { r: 255, g: 255, b: 255, a: 1 }],
    ["#101213", { r: 16, g: 18, b: 19, a: 1 }],
    ["rgb(16, 18, 19)", { r: 16, g: 18, b: 19, a: 1 }],
    ["rgb(16 18 19 / 50%)", { r: 16, g: 18, b: 19, a: 0.5 }],
    ["rgba(1, 2, 3, 0.25)", { r: 1, g: 2, b: 3, a: 0.25 }],
    ["transparent", { r: 0, g: 0, b: 0, a: 0 }],
    ["  RGB(255,0,0)  ", { r: 255, g: 0, b: 0, a: 1 }],
  ])("parses %s", (input, expected) => {
    expect(parseColor(input)).toEqual(expected);
  });

  it("parses 8-digit hex alpha", () => {
    const c = parseColor("#e9ebec99")!;
    expect(c.r).toBe(233);
    expect(c.a).toBeCloseTo(0x99 / 255, 5);
  });

  it("parses color(srgb …) with alpha", () => {
    const c = parseColor("color(srgb 1 0.5 0 / 0.4)")!;
    expect(c).toMatchObject({ r: 255, g: 127.5, b: 0 });
    expect(c.a).toBeCloseTo(0.4);
  });

  it.each(["#12", "#1234567", "hsl(10 20% 30%)", "light-dark(#fff, #000)", "", "rgb(1, 2)"])("rejects %s", (input) => {
    expect(parseColor(input)).toBeNull();
  });
});

describe("hex, compositing and helpers", () => {
  it("round-trips through hex and keeps alpha only when translucent", () => {
    expect(toHex({ r: 16, g: 18, b: 19, a: 1 })).toBe("#101213");
    expect(toHex({ r: 233, g: 235, b: 236, a: 0x99 / 255 })).toBe("#e9ebec99");
    expect(normalizeColor("rgb(16, 18, 19)")).toBe("#101213");
    expect(normalizeColor("nope")).toBeNull();
  });

  it("composites source-over onto the backdrop", () => {
    const out = composite({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 255, a: 1 });
    expect(out).toEqual({ r: 127.5, g: 0, b: 127.5, a: 1 });
  });

  it("detects transparency", () => {
    expect(isTransparent("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparent("transparent")).toBe(true);
    expect(isTransparent("#000")).toBe(false);
    expect(isTransparent("garbage")).toBe(false);
  });
});

describe("deltaE2000", () => {
  // Reference pairs from Sharma, Wu, Dalal (2005), "The CIEDE2000 Color-Difference Formula".
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ])("matches the published value for %j vs %j", (a, b, expected) => {
    expect(deltaE2000(a as never, b as never)).toBeCloseTo(expected, 4);
  });

  it("is zero for identical colours and symmetric", () => {
    const lab = rgbToLab({ r: 24, g: 119, b: 215, a: 1 });
    expect(deltaE2000(lab, lab)).toBe(0);
    const other = rgbToLab({ r: 89, g: 157, b: 226, a: 1 });
    expect(deltaE2000(lab, other)).toBeCloseTo(deltaE2000(other, lab), 10);
  });

  it("maps white to L=100 and black to L=0", () => {
    expect(rgbToLab({ r: 255, g: 255, b: 255, a: 1 })[0]).toBeCloseTo(100, 2);
    expect(rgbToLab({ r: 0, g: 0, b: 0, a: 1 })[0]).toBeCloseTo(0, 5);
  });
});

describe("colorDistance", () => {
  it("measures the Neon model-selector case at about 2.5", () => {
    expect(colorDistance("#101213", "#171a1c", "#000000")).toBeCloseTo(2.5, 1);
  });

  it("compares translucent colours as rendered on the backdrop", () => {
    // Same rgb, different alpha: different on white, so the distance is non-zero.
    expect(colorDistance("#e9ebec99", "#e9ebec", "#ffffff")!).toBeGreaterThan(0.5);
    // Identical colours are identical regardless of alpha handling.
    expect(colorDistance("#e9ebec99", "rgba(233, 235, 236, 0.6)", "#ffffff")!).toBeLessThan(0.1);
  });

  it("returns null for unparseable input", () => {
    expect(colorDistance("#fff", "light-dark(#fff, #000)")).toBeNull();
  });
});
