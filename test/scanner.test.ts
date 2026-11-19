import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { discoverDefinitions, isExcluded, lengthPx, listFiles, scanRepo, scanText } from "../src/static/scanner.js";
import { checkStatic } from "../src/checks/c1Static.js";
import { parseBlamePorcelain } from "../src/git.js";

const repo = join(import.meta.dirname, "fixtures", "repo");

describe("scanText", () => {
  const known = new Set(["--color-level-5", "--local-gap"]);

  it("finds arbitrary colour, spacing, radius and type classes", () => {
    const hits = scanText("a.tsx", `<div className="bg-[#123456] p-[13px] -mt-[8px] rounded-tl-[7px] text-[13px] leading-[18px]" />`, known);
    expect(hits.map((h) => [h.rule, h.match])).toEqual([
      ["tailwind-arbitrary-color", "bg-[#123456]"],
      ["tailwind-arbitrary-spacing", "p-[13px]"],
      ["tailwind-arbitrary-spacing", "-mt-[8px]"],
      ["tailwind-arbitrary-radius", "rounded-tl-[7px]"],
      ["tailwind-arbitrary-type", "text-[13px]"],
      ["tailwind-arbitrary-type", "leading-[18px]"],
    ]);
  });

  it("does not report the hex inside an arbitrary colour class twice", () => {
    const hits = scanText("a.tsx", `className="text-[#f65164]"`, known);
    expect(hits).toHaveLength(1);
  });

  it("ignores layout sizes that are not design tokens", () => {
    expect(scanText("a.tsx", `className="w-[300px] h-[40px] top-[2px] max-w-[640px]"`, known)).toEqual([]);
  });

  it("reports hex colours in components but not in comments or .ts data files", () => {
    expect(scanText("a.tsx", `const c = "#ff0000";`, known).map((h) => h.rule)).toEqual(["hex-in-source"]);
    expect(scanText("a.tsx", `// "#ff0000" in a comment`, known)).toEqual([]);
    expect(scanText("a.ts", `const c = "#ff0000";`, known)).toEqual([]);
    expect(scanText("a.ts", `const c = "#ff0000";`, known, { hexExtensions: [".ts"] })).toHaveLength(1);
  });

  it("does not mistake routes or entities for colours", () => {
    expect(scanText("a.tsx", `url = "aria.html#/main"; s = "&#123;"; id = "#main-panel";`, known)).toEqual([]);
  });

  it("reports hex in CSS declarations but not in token definitions", () => {
    const css = `.a {\n  color: #ff00ff;\n  --tok: #ffffff;\n}`;
    const hits = scanText("a.css", css, known);
    expect(hits).toMatchObject([{ rule: "hex-in-css", line: 2, column: 10, match: "#ff00ff" }]);
  });

  it("reports unknown CSS variables but accepts declared ones and runtime prefixes", () => {
    const line = `style={{ a: "var(--color-level-5)", b: "var(--color-nope)", c: "var(--tw-ring-color)" }}`;
    expect(scanText("a.tsx", line, known).map((h) => h.match)).toEqual(["--color-nope"]);
    expect(scanText("a.tsx", `x = "var(--opera-x)"`, known, { knownVarPrefixes: ["--opera-"] })).toEqual([]);
  });
});

describe("definitions, file listing and exclusions", () => {
  it("discovers variables defined in CSS, TS style objects and setProperty calls", () => {
    const names = discoverDefinitions([
      { file: "a.css", text: ".x { --a: 1px; }" },
      { file: "b.tsx", text: `style={{ "--b": "2px" }}; el.style.setProperty("--c", "3px")` },
    ]);
    expect([...names].sort()).toEqual(["--a", "--b", "--c"]);
  });

  it("supports prefixes, directory names and globs", () => {
    expect(isExcluded("src/tests/a.ts", ["src/tests"])).toBe(true);
    expect(isExcluded("src/x/__tests__/a.ts", ["__tests__"])).toBe(true);
    expect(isExcluded("src/a/icons/b.tsx", ["**/icons/**"])).toBe(true);
    expect(isExcluded("src/a/icon.tsx", ["**/icons/**"])).toBe(false);
    expect(isExcluded("src/a/b.stories.tsx", ["**/*.stories.tsx"])).toBe(true);
  });

  it("lists matching files and skips excluded folders", () => {
    const files = listFiles({ repo, include: ["src"], extensions: [".tsx", ".css"], exclude: ["src/tests", "src/root/themes"] });
    expect(files).toEqual(["src/components/Button.tsx", "src/styles/app.css"]);
  });
});

describe("scanRepo", () => {
  const { hits, files } = scanRepo({
    repo,
    include: ["src"],
    extensions: [".ts", ".tsx", ".css"],
    exclude: ["src/tests", "src/root/themes"],
    knownVars: ["--color-level-5"],
  });

  it("scans the fixture and finds every planted issue", () => {
    expect(files).toBe(3);
    const summary = hits.map((h) => `${h.file}:${h.line} ${h.rule} ${h.match}`);
    expect(summary).toEqual([
      "src/components/Button.tsx:3 tailwind-arbitrary-color bg-[#123456]",
      "src/components/Button.tsx:3 tailwind-arbitrary-spacing p-[13px]",
      "src/components/Button.tsx:3 tailwind-arbitrary-spacing px-[8px]",
      "src/components/Button.tsx:3 tailwind-arbitrary-radius rounded-[7px]",
      "src/components/Button.tsx:3 tailwind-arbitrary-type text-[13px]",
      "src/components/Button.tsx:4 hex-in-source #ff0000",
      "src/components/Button.tsx:7 unknown-css-var --color-unknown-x",
      "src/components/Button.tsx:8 tailwind-arbitrary-spacing p-[13px]",
      "src/components/Button.tsx:8 tailwind-arbitrary-spacing p-[13px]",
      "src/styles/app.css:2 hex-in-css #ff00ff",
      "src/styles/app.css:5 unknown-css-var --color-missing-token",
    ]);
  });

  it("treats variables defined in excluded theme folders as known", () => {
    expect(hits.some((h) => h.match === "--color-model-selector-bg")).toBe(false);
  });
});

describe("parseBlamePorcelain", () => {
  it("maps final line numbers to commits, authors and times", () => {
    const sha = "a".repeat(40);
    const text = [
      `${sha} 1 1 2`,
      "author Jane",
      "author-time 1700000000",
      "\tline one",
      `${sha} 2 2`,
      "\tline two",
      `${"0".repeat(40)} 3 3 1`,
      "author Not Committed Yet",
      "\tline three",
    ].join("\n");
    const map = parseBlamePorcelain(text);
    expect(map.get(1)).toEqual({ commit: sha, author: "Jane", time: 1700000000 });
    expect(map.get(2)?.commit).toBe(sha);
    expect(map.get(3)?.commit).toBe("0000000");
  });
});

describe("other ways to hard-code a value (found by the seeded-defect evaluation)", () => {
  const rules = (file: string, text: string) => scanText(file, text, new Set()).map((h) => `${h.rule}|${h.match}`);

  it("reads arbitrary colours in any colour syntax and arbitrary lengths in rem", () => {
    expect(rules("a.tsx", '<i className="text-[rgb(134,143,152)] bg-[hsl(0,0%,50%)] border-[oklch(0.5_0.1_30)] px-[0.625rem]" />')).toEqual([
      "tailwind-arbitrary-color|text-[rgb(134,143,152)]",
      "tailwind-arbitrary-color|bg-[hsl(0,0%,50%)]",
      "tailwind-arbitrary-color|border-[oklch(0.5_0.1_30)]",
      "tailwind-arbitrary-spacing|px-[0.625rem]",
    ]);
    expect(lengthPx("px-[0.625rem]")).toBe(10);
    expect(lengthPx('gap: "6px"')).toBe(6);
    expect(lengthPx("paddingLeft: 10")).toBe(10);
  });

  it("reads spacing and radius in JSX style objects, also across lines, but not in option objects", () => {
    expect(rules("a.tsx", '<div style={{ paddingLeft: 10, margin: 0, borderRadius: "7px" }} />')).toEqual(["inline-style-spacing|paddingLeft: 10", "inline-style-radius|borderRadius: \"7px\""]);
    expect(rules("a.tsx", '<div\n  style={{\n    marginTop: 12,\n    gap: "6px",\n  }}\n/>')).toEqual(["inline-style-spacing|marginTop: 12", 'inline-style-spacing|gap: "6px"']);
    expect(rules("a.tsx", "const s: React.CSSProperties = {\n  padding: 10,\n};")).toEqual(["inline-style-spacing|padding: 10"]);
    expect(rules("a.tsx", "middleware: [offset(2), flip(), shift({ padding: 8 })],")).toEqual([]);
    expect(rules("a.ts", "<div style={{ paddingLeft: 10 }} />")).toEqual([]); // .ts holds data, not markup
  });

  it("reads lengths in plain CSS declarations, skipping tokens, zero, calc/var and large margins", () => {
    const css = ["  padding: 0 10px;", "  margin: 120px auto;", "  margin: 4px 0 4px;", "  gap: var(--x);", "  border-radius: 5px 5px 0 0;", "  --pad: 10px;", "  padding: calc(4px + 1px);"].join("\n");
    expect(rules("a.css", css)).toEqual(["css-spacing|padding: 10px", "css-spacing|margin: 4px", "unknown-css-var|--x", "css-radius|border-radius: 5px"]);
  });

  it("judges the new rules against the scales like Tailwind lengths", () => {
    const hits = scanText("a.css", "  padding: 10px;\n  gap: 8px;\n  border-radius: 5px;", new Set());
    const f = checkStatic(hits, { spacingScale: [0, 4, 8], radiusScale: [4, 8], px: 1 });
    expect(f.map((x) => `${x.category}/${x.severity}`)).toEqual(["off-scale-spacing/medium", "spacing-class-on-scale/low", "off-scale-radius/low"]);
  });
});
