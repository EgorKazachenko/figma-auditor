// Seeded-defect evaluation: plant known defects in a throw-away copy, run the audit clean and seeded, score.
import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.js";
import { makeFinding } from "../src/findings.js";
import { applySourceSeeds, loadEvalSpec, parseEvalSpec, type Seed } from "../src/eval/seeds.js";
import { matches, renderScore, scoreEval } from "../src/eval/score.js";
import { runEval } from "../src/eval/run.js";
import type { Finding } from "../src/types.js";

const fixtures = join(import.meta.dirname, "fixtures");

const f = (check: Finding["check"], category: string, title: string, extra: Partial<Finding> = {}): Finding =>
  makeFinding({ check, category, gap: "B", severity: "medium", title, links: {}, ...extra }, [check, category, title]);

describe("scoring", () => {
  const seeds: Seed[] = [
    { id: "hex", kind: "source", expect: { check: "C1", category: "hex-in-source", contains: ["Button.tsx"] } },
    { id: "gap", kind: "source", expect: { check: "C1", category: "/spacing/", contains: ["5px"] } },
    { id: "control", kind: "source", expect: "none", near: ["Card.tsx"] },
  ];
  const old = f("C1", "hex-in-source", "Hard-coded colour #111111", { links: { source: "Old.tsx:1" } });

  it("matches on check, exact or /regex/ category, and text in title, source, token or values", () => {
    const hit = f("C1", "off-scale-spacing", "Off-scale spacing 5px", { actual: { value: "gap-[5px]", source: "x" } });
    expect(matches(hit, { check: "C1", category: "/spacing/", contains: ["gap-[5px]"] })).toBe(true);
    expect(matches(hit, { check: "C1", category: "off-scale" })).toBe(false);
    expect(matches(hit, { check: "C2" })).toBe(false);
  });

  it("counts only new findings, credits seeds and charges unexplained ones to precision and nearby controls", () => {
    const seeded = [
      old,
      f("C1", "hex-in-source", "Hard-coded colour #d0d4d8", { links: { source: "src/Button.tsx:3" } }),
      f("C1", "hex-in-source", "Hard-coded colour #eeeeee", { links: { source: "src/Card.tsx:9" } }),
    ];
    const s = scoreEval(seeds, [old], seeded);
    expect(s.seeds.map((r) => `${r.id}:${r.ok}`)).toEqual(["hex:true", "gap:false", "control:false"]);
    expect(s.recall).toBe(0.5);
    expect(s.precision).toBe(0.5);
    expect(s.unexplained.map((u) => u.title)).toEqual(["Hard-coded colour #eeeeee"]);
    expect(s.byCheck.C1).toMatchObject({ seeds: 2, found: 1, newFindings: 2, explained: 1 });
    expect(s.negativesClean).toBe(0);
    const md = renderScore(s);
    expect(md).toContain("Recall 50% · precision 50% · negative controls clean 0/1");
    expect(md).toContain("| gap | **missed** |");
    expect(md).toContain("| control (control) | **false alarm** |");
  });

  it("scores each expectation of a seed that should cause several findings", () => {
    const multi: Seed = { id: "pale", kind: "css", css: "x", expect: [{ check: "C8" }, { check: "C3" }] };
    const s = scoreEval([multi], [], [f("C8", "text-contrast", "low contrast")]);
    expect(s.seeds.map((r) => `${r.id}:${r.ok}`)).toEqual(["pale · C8:true", "pale · C3:false"]);
    expect(s.precision).toBe(1);
  });

  it("is perfect when nothing new appears and no seed expects anything", () => {
    const s = scoreEval([{ id: "c", kind: "source", expect: "none" }], [old], [old]);
    expect([s.recall, s.precision, s.negativesClean]).toEqual([1, 1, 1]);
  });
});

describe("seed specs", () => {
  it("validates seeds and resolves the audit config path", () => {
    const spec = parseEvalSpec("config: ../audit.yaml\nseeds:\n  - { id: a, file: x.tsx, find: a, replace: b, expect: { check: C1 } }", "/w/eval/s.yaml");
    expect(spec).toMatchObject({ configPath: "/w/audit.yaml", checks: ["c1", "c2"], runtime: false, copy: ["src"] });
    const bad = (body: string) => () => parseEvalSpec(`config: a.yaml\n${body}`, "/s.yaml");
    expect(bad("seeds: []")).toThrow(/at least one seed/);
    expect(bad("seeds:\n  - { id: a, expect: none }")).toThrow(/file, find and replace/);
    expect(bad("seeds:\n  - { id: a, kind: css, expect: none }")).toThrow(/needs css/);
    expect(bad("seeds:\n  - { id: a, kind: css, css: x, expect: {} }")).toThrow(/needs a check/);
    expect(bad("seeds:\n  - { id: a, kind: css, css: x, expect: [{ check: C3 }, {}] }")).toThrow(/needs a check/);
    expect(bad("seeds:\n  - { id: a, kind: css, css: x, expect: none }\n  - { id: a, kind: css, css: x, expect: none }")).toThrow(/duplicate/);
    expect(() => parseEvalSpec("seeds: []", "/s.yaml")).toThrow(ConfigError);
  });

  it("refuses a seed whose text is missing or ambiguous, so it never lands somewhere else", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-seed-"));
    writeFileSync(join(dir, "a.css"), "a { padding: 4px; }\nb { padding: 4px; }\n");
    const seed = (find: string): Seed => ({ id: "s", kind: "source", file: "a.css", find, replace: "x", expect: "none" });
    expect(() => applySourceSeeds(dir, [seed("padding: 4px")])).toThrow(/occurs 2 times/);
    expect(() => applySourceSeeds(dir, [seed("margin")])).toThrow(/occurs 0 times/);
    expect(() => applySourceSeeds(dir, [{ ...seed("a"), file: "missing.css" }])).toThrow(/not in the workspace/);
    applySourceSeeds(dir, [seed("a {")]);
    expect(readFileSync(join(dir, "a.css"), "utf8").startsWith("x padding")).toBe(true);
  });
});

describe("runEval end to end on the fixture product", async () => {
  const dir = mkdtempSync(join(tmpdir(), "da-evalrun-"));
  cpSync(join(fixtures, "repo"), join(dir, "repo"), { recursive: true });
  cpSync(join(fixtures, "figma"), join(dir, "figma"), { recursive: true });
  writeFileSync(
    join(dir, "audit.yaml"),
    `
target: { repo: repo, themeEntry: src/root/themes/themes.css, tailwindConfig: tailwind.config.ts, scan: { include: [src], exclude: [src/tests, src/root/themes] } }
contexts:
  - { name: neon-light, html: { data-theme: opera, data-product: Neon }, colorScheme: light, figmaMode: light }
  - { name: neon-dark, html: { data-theme: opera-dark, data-product: Neon }, colorScheme: dark, figmaMode: dark }
reference:
  sources:
    - { type: figma-variable-defs, path: figma/light.json }
    - { type: figma-variable-defs, path: figma/dark.json }
scales: { spacing: { tailwindPrefix: aria- }, radius: [4, 8] }
`,
  );
  writeFileSync(
    join(dir, "seeds.yaml"),
    `
config: audit.yaml
copy: [src, tailwind.config.ts]
seeds:
  - id: arbitrary-rem
    file: src/components/Button.tsx
    find: 'w-[300px]'
    replace: 'w-[300px] gap-[0.3125rem]'
    expect: { check: C1, category: off-scale-spacing, contains: ["gap-[0.3125rem]"] }
  - id: accent-drift
    file: src/root/themes/base.css
    find: '--color-accent-60: #599de2;'
    replace: '--color-accent-60: #62a6ec;'
    expect: { check: C2, category: token-parity, contains: ["--color-accent-60"] }
  - id: missed-on-purpose
    file: src/components/Button.tsx
    find: 'Go</span>'
    replace: 'Go!</span>'
    expect: { check: C1, category: hex-in-source }
`,
  );
  const before = readFileSync(join(dir, "repo", "src/components/Button.tsx"), "utf8");
  const run = await runEval(loadEvalSpec(join(dir, "seeds.yaml")));

  it("keeps findings on an edited line the same (their fingerprints do not use the line text)", () => {
    expect(run.score.unexplained).toEqual([]);
  });

  it("finds the planted defects, reports the one nothing can find, and never touches the product", () => {
    expect(run.score.seeds.map((r) => `${r.id}:${r.ok}`)).toEqual(["arbitrary-rem:true", "accent-drift:true", "missed-on-purpose:false"]);
    expect(run.score.precision).toBe(1);
    expect(readFileSync(join(dir, "repo", "src/components/Button.tsx"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "repo", ".eval-reports"))).toBe(false);
  });
});
