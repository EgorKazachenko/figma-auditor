import { describe, expect, it } from "vitest";
import { checkStatic } from "../src/checks/c1Static.js";
import { checkTokenParity, envCoverage, type C2Input } from "../src/checks/c2Parity.js";
import { checkOffToken, nearestToken, paletteOf, px } from "../src/checks/c3OffToken.js";
import type { CodeTokenDecl, Context, ReferenceToken, SnapshotCell, StaticHit } from "../src/types.js";

const hit = (over: Partial<StaticHit>): StaticHit => ({
  rule: "hex-in-source",
  file: "src/a.tsx",
  line: 1,
  column: 1,
  match: "#fff",
  snippet: `color: "#fff"`,
  ...over,
});

describe("C1 · static rules", () => {
  const opts = { spacingScale: [0, 2, 4, 8, 12], radiusScale: [0, 6, 8], px: 1 };

  it("grades lengths against their scale", () => {
    const [onScale, nearScale, offScale, radius] = checkStatic(
      [
        hit({ rule: "tailwind-arbitrary-spacing", match: "p-[8px]" }),
        hit({ rule: "tailwind-arbitrary-spacing", match: "p-[9px]" }),
        hit({ rule: "tailwind-arbitrary-spacing", match: "p-[10px]" }),
        hit({ rule: "tailwind-arbitrary-radius", match: "rounded-[16px]" }),
      ],
      opts,
    );
    expect([onScale!.category, onScale!.severity]).toEqual(["spacing-class-on-scale", "low"]);
    expect([nearScale!.category, nearScale!.severity]).toEqual(["off-scale-spacing", "low"]);
    expect([offScale!.category, offScale!.severity]).toEqual(["off-scale-spacing", "medium"]);
    expect([radius!.category, radius!.severity]).toEqual(["off-scale-radius", "medium"]);
  });

  it("rates unknown variables and arbitrary colour classes as medium", () => {
    const [unknown, color, type] = checkStatic(
      [
        hit({ rule: "unknown-css-var", match: "--spacing_4" }),
        hit({ rule: "tailwind-arbitrary-color", match: "text-[#171a1c]" }),
        hit({ rule: "tailwind-arbitrary-type", match: "text-[13px]" }),
      ],
      opts,
    );
    expect(unknown!.severity).toBe("medium");
    expect(unknown!.title).toContain("--spacing_4");
    expect(color!.severity).toBe("medium");
    expect(type!.severity).toBe("low");
  });

  it("keeps fingerprints stable when the line moves and unique for repeated matches", () => {
    const a = checkStatic([hit({ line: 10 })], opts)[0]!;
    const b = checkStatic([hit({ line: 99 })], opts)[0]!;
    expect(a.fingerprint).toBe(b.fingerprint);
    const twice = checkStatic([hit({}), hit({})], opts);
    expect(twice[0]!.fingerprint).not.toBe(twice[1]!.fingerprint);
  });

  it("carries the blame commit into the finding", () => {
    const f = checkStatic([hit({ blame: { commit: "abc123" } })], opts)[0]!;
    expect(f.links).toEqual({ source: "src/a.tsx:1", commit: "abc123" });
  });
});

const contexts: Context[] = [
  { name: "neon-light", html: { "data-product": "Neon" }, colorScheme: "light", figmaMode: "light", backdrop: "#ffffff" },
  { name: "neon-dark", html: { "data-product": "Neon" }, colorScheme: "dark", figmaMode: "dark", backdrop: "#000000" },
];

const decl = (name: string, over: Partial<CodeTokenDecl> = {}): CodeTokenDecl => ({
  name,
  key: name.replace(/-0(\d)$/, "-$1"),
  selector: "html",
  file: "base.css",
  line: 1,
  value: "x",
  ...over,
});

const ref = (name: string, mode: string, value: string): ReferenceToken => ({
  name: name.replace(/^var\((.*)\)$/, "$1"),
  figmaName: name,
  kind: "color",
  mode,
  value,
  source: { type: "figma-variable-defs", fileName: "Chat Sidepanel", url: "https://figma/x" },
});

const resolved = (context: string, tokens: Record<string, string | null>, source: "code" | "runtime" = "code") => ({
  context,
  source,
  browser: source === "code" ? "chromium" : "Opera Neon",
  tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, { raw: v ?? "", color: v }])),
});

describe("C2 · token parity", () => {
  const base: C2Input = {
    reference: [
      ref("var(--color-level-5)", "light", "#f7f7f8"),
      ref("var(--color-level-5)", "dark", "#101213"),
      ref("var(--color-text-2)", "dark", "#9ca3ab"),
      ref("var(--color-accent-60)", "dark", "#599de2"),
      ref("var(--color-not-in-code)", "light", "#123123"),
      ref("var(--color-not-in-code)", "dark", "#123123"),
    ],
    decls: [
      decl("--color-level-5", { envName: "-neon-color-elevation-5", line: 3 }),
      decl("--color-text-02", { envName: "-neon-color-text-02" }),
      decl("--color-accent-60"),
      decl("--color-model-selector-bg", { selector: 'html[data-product="Neon"]', file: "neon.css", line: 12 }),
    ],
    contexts,
    code: [
      resolved("neon-light", { "--color-level-5": "rgb(247, 247, 248)", "--color-model-selector-bg": "rgb(247, 247, 248)" }),
      resolved("neon-dark", {
        "--color-level-5": "rgb(23, 26, 28)",
        "--color-text-02": "rgb(117, 128, 138)",
        "--color-accent-60": "rgb(89, 157, 226)",
        "--color-model-selector-bg": "rgb(16, 18, 19)",
      }),
    ],
    aliases: {},
    colorDeltaE: 2,
  };
  const findings = checkTokenParity(base);
  const parity = findings.filter((f) => f.category === "token-parity");

  it("flags only colours beyond the threshold, per context", () => {
    expect(parity.map((f) => `${f.token}@${f.context}`).sort()).toEqual(["--color-level-5@neon-dark", "--color-text-02@neon-dark"]);
    const level5 = parity.find((f) => f.token === "--color-level-5")!;
    expect(level5).toMatchObject({
      severity: "high",
      gap: "A",
      deltaE: 2.5,
      expected: { value: "#101213", token: "var(--color-level-5)" },
      actual: { value: "#171a1c", source: "code fallback of env(-neon-color-elevation-5)" },
      links: { figma: "https://figma/x", source: "base.css:3" },
    });
  });

  it("names the product-level token that already patches the drift", () => {
    const level5 = parity.find((f) => f.token === "--color-level-5")!;
    expect(level5.related).toEqual(["--color-model-selector-bg (neon.css:12)"]);
  });

  it("matches Figma's text-2 to the code's text-02", () => {
    expect(parity.find((f) => f.token === "--color-text-02")?.expected?.token).toBe("var(--color-text-2)");
  });

  it("reports a Figma variable without a CSS token once", () => {
    const missing = findings.filter((f) => f.category === "token-missing-in-code");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.title).toContain("--color-not-in-code");
  });

  it("reports tokens that do not resolve to a colour", () => {
    const f = checkTokenParity({ ...base, code: [resolved("neon-dark", { "--color-level-5": null })], reference: [ref("var(--color-level-5)", "dark", "#101213")] });
    expect(f.map((x) => x.category)).toEqual(["token-unresolved"]);
  });

  it("checks runtime values separately from code fallbacks", () => {
    const f = checkTokenParity({
      ...base,
      reference: [ref("var(--color-text-2)", "dark", "#9ca3ab")],
      runtime: [resolved("neon-dark", { "--color-text-02": "rgb(156, 163, 171)" }, "runtime")],
    });
    expect(f.map((x) => x.category)).toEqual(["token-parity"]);
    const g = checkTokenParity({
      ...base,
      reference: [ref("var(--color-level-5)", "dark", "#101213")],
      runtime: [resolved("neon-dark", { "--color-level-5": "rgb(23, 26, 28)" }, "runtime")],
    });
    // Same colour at runtime as in code: one finding, confirmed in the browser.
    expect(g.map((x) => x.category)).toEqual(["token-parity"]);
    expect(g[0]!.actual?.source).toBe("code fallback of env(-neon-color-elevation-5); same value in Opera Neon");

    const h = checkTokenParity({
      ...base,
      reference: [ref("var(--color-level-5)", "dark", "#101213")],
      runtime: [resolved("neon-dark", { "--color-level-5": "rgb(40, 40, 40)" }, "runtime")],
    });
    expect(h.map((x) => x.category).sort()).toEqual(["token-parity", "token-parity-runtime"]);
    expect(h.find((x) => x.category === "token-parity-runtime")?.actual?.source).toBe("resolved in Opera Neon");
  });

  it("measures how many env() values the browser supplied", () => {
    const decls = [
      decl("--a", { envName: "-x-a", fallback: "light-dark(#fff, #000)" }),
      decl("--b", { envName: "-x-b", fallback: "#111" }),
      decl("--c"),
    ];
    const fallbackOnly = { context: "c", source: "runtime" as const, browser: "b", tokens: { "--a": { raw: "light-dark(#fff,  #000)", color: "x" }, "--b": { raw: "#111", color: "x" } } };
    expect(envCoverage(decls, fallbackOnly)).toEqual({ envTokens: 2, supplied: 0 });
    const supplied = { ...fallbackOnly, tokens: { ...fallbackOnly.tokens, "--b": { raw: "#222", color: "x" } } };
    expect(envCoverage(decls, supplied)).toEqual({ envTokens: 2, supplied: 1 });
  });

  it("ignores product overrides when measuring env() coverage", () => {
    const decls = [
      decl("--n", { envName: "-x-n", fallback: "#111" }),
      decl("--n", { selector: 'html[data-product="Neon"]', value: "#222" }),
    ];
    const tokens = { "--n": { raw: "#222", color: "x" } };
    const runtime = { context: "c", source: "runtime" as const, browser: "b", tokens };
    // In Neon the override wins, so this token is not read from env() at all.
    expect(envCoverage(decls, runtime, { "data-product": "Neon" })).toEqual({ envTokens: 0, supplied: 0 });
    // Without the product attribute the env() declaration wins and #222 counts as a browser-supplied value.
    expect(envCoverage(decls, runtime, {})).toEqual({ envTokens: 1, supplied: 1 });
  });

  it("honours aliases and the threshold boundary", () => {
    const f = checkTokenParity({
      ...base,
      reference: [ref("var(--brand)", "dark", "#101213")],
      aliases: { "var(--brand)": "--color-level-5" },
      colorDeltaE: 2.6,
    });
    expect(f).toEqual([]);
  });
});

describe("C3 · off-token values", () => {
  const tokens = {
    "--a": { raw: "#ffffff", color: "rgb(255, 255, 255)" },
    "--b": { raw: "#101213", color: "rgb(16, 18, 19)" },
    "--clear": { raw: "transparent", color: "rgba(0, 0, 0, 0)" },
    "--size": { raw: "4px", color: null },
  };
  const node = (over: Partial<SnapshotCell["nodes"][number]> & { css?: Record<string, string> }) => ({
    component: null,
    testId: "t",
    path: 'div[data-testid="t"]',
    box: { x: 0, y: 0, width: 100, height: 40 },
    hasText: true,
    text: "x",
    ...over,
    css: { "background-color": "rgba(0, 0, 0, 0)", color: "rgb(16, 18, 19)", ...over.css },
  });
  const cell = (nodes: SnapshotCell["nodes"]): SnapshotCell => ({
    surface: "s",
    state: "default",
    context: "neon-light",
    url: "x",
    browser: "chromium",
    tokens,
    nodes,
    screenshot: "shots/s.png",
  });
  const opts = { contexts, spacingScale: [0, 2, 4, 8], radiusScale: [0, 8], colorDeltaE: 2, px: 1 };

  it("builds the palette from colour tokens only and finds the nearest one", () => {
    expect(paletteOf(tokens).map((p) => p.name)).toEqual(["--a", "--b"]);
    expect(nearestToken("#111314", paletteOf(tokens), "#ffffff")?.token.name).toBe("--b");
    expect(px("8px")).toBe(8);
    expect(px("50%")).toBeNull();
    expect(px(undefined)).toBeNull();
  });

  it("reports background and text colours that match no token", () => {
    const f = checkOffToken([cell([node({ css: { "background-color": "rgb(255, 0, 170)", color: "rgb(0, 0, 255)" } })])], opts);
    expect(f.map((x) => x.property)).toEqual(["background-color", "color"]);
    expect(f[0]).toMatchObject({ check: "C3", severity: "medium", actual: { value: "#ff00aa" }, evidence: { screenshot: "shots/s.png" } });
  });

  it("skips text colour without own text and borders without width", () => {
    const f = checkOffToken(
      [cell([node({ hasText: false, css: { color: "rgb(0, 0, 255)", "border-top-color": "rgb(0, 255, 0)", "border-top-width": "0px" } })])],
      opts,
    );
    expect(f).toEqual([]);
    const g = checkOffToken([cell([node({ css: { "border-top-color": "rgb(0, 255, 0)", "border-top-width": "1px" } })])], opts);
    expect(g.map((x) => x.property)).toEqual(["border-top-color"]);
  });

  it("checks spacing and radius against scales with tolerance and exempts pills", () => {
    const f = checkOffToken(
      [
        cell([
          // 8.4px is sub-pixel rounding of 8 (tolerated); 10px and a whole pixel off (5px between 4 and 6) are not
          node({ css: { "padding-top": "10px", "padding-left": "10px", "padding-right": "8.4px", gap: "normal" } }),
          node({ path: "btn", css: { "padding-top": "5px" } }),
          // sr-only pattern: 1×1 px, margin -1px; nobody sees it, so it is not checked
          node({ path: "sr-only", css: { "margin-top": "-1px", color: "rgb(255, 0, 170)" }, box: { x: 0, y: 0, width: 1, height: 1 } }),
          node({ path: "pill", css: { "border-top-left-radius": "20px" }, box: { x: 0, y: 0, width: 80, height: 40 } }),
          node({ path: "card", css: { "border-top-left-radius": "12px" } }),
        ]),
      ],
      opts,
    );
    expect(f.map((x) => `${x.category} ${x.actual?.value}`)).toEqual(["off-scale-spacing 10px", "off-scale-spacing 5px", "off-scale-radius 12px"]);
    expect(f[0]!.expected?.value).toBe("8px");
  });
});
