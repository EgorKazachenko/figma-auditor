import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHistory, emptyHistory, loadHistory, saveHistory } from "../src/history.js";
import { renderHtml, renderMarkdown, writeReport } from "../src/report/render.js";
import { groupFindings } from "../src/triage.js";
import { dedupe } from "../src/pipeline.js";
import { makeFinding } from "../src/findings.js";
import { assertRuntimeReady, ConfigError, parseConfig } from "../src/config.js";
import type { Finding, Report } from "../src/types.js";

const f = (check: Finding["check"], key: string, over: Partial<Finding> = {}): Finding =>
  makeFinding(
    { check, category: "cat", gap: "B", severity: "medium", title: `title ${key}`, links: {}, ...over },
    [key],
  );

describe("history", () => {
  it("marks new findings, then open ones, then lists what was fixed", () => {
    const a = f("C1", "a");
    const b = f("C2", "b");
    const run1 = applyHistory(emptyHistory(), [a, b], { id: "r1", at: "t1", commit: "c1", checks: ["C1", "C2"] });
    expect([a.status, b.status]).toEqual(["new", "new"]);
    expect(a.firstSeen).toEqual({ commit: "c1", at: "t1" });
    expect(a.links.commit).toBe("c1");

    const a2 = f("C1", "a");
    const run2 = applyHistory(run1.history, [a2], { id: "r2", at: "t2", commit: "c2", checks: ["C1", "C2"] });
    expect(a2.status).toBe("open");
    expect(a2.firstSeen).toEqual({ commit: "c1", at: "t1" });
    expect(run2.fixed).toEqual([{ fingerprint: b.fingerprint, title: "title b" }]);
  });

  it("does not call a finding fixed when its check did not run", () => {
    const b = f("C2", "b");
    const run1 = applyHistory(emptyHistory(), [b], { id: "r1", at: "t1", checks: ["C1", "C2"] });
    const run2 = applyHistory(run1.history, [], { id: "r2", at: "t2", checks: ["C1"] });
    expect(run2.fixed).toEqual([]);
  });

  it("calls a runtime finding fixed only when its screen was captured again", () => {
    const shot = f("C3", "dots", { title: "dots off-token", cell: { surface: "login", state: "default", context: "light" } });
    const run1 = applyHistory(emptyHistory(), [shot], { id: "r1", at: "t1", checks: ["C3"], cells: ["login/default/light"] });
    const other = applyHistory(run1.history, [], { id: "r2", at: "t2", checks: ["C3"], cells: ["panel/menu/light"] });
    expect(other.fixed).toEqual([]);
    const again = applyHistory(run1.history, [], { id: "r3", at: "t3", checks: ["C3"], cells: ["login/default/light"] });
    expect(again.fixed.map((f) => f.title)).toEqual(["dots off-token"]);
  });

  it("keeps the blame commit as the first-seen commit for static findings", () => {
    const s = f("C1", "s", { links: { commit: "blamed" } });
    applyHistory(emptyHistory(), [s], { id: "r", at: "t", commit: "head", checks: ["C1"] });
    expect(s.firstSeen?.commit).toBe("blamed");
  });

  it("saves, trims and reloads; a broken file starts fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-hist-"));
    const path = join(dir, "h", "history.json");
    let h = emptyHistory();
    for (let i = 0; i < 5; i++) h = applyHistory(h, [], { id: `r${i}`, at: "t", checks: ["C1"] }).history;
    saveHistory(path, h, 3);
    expect(loadHistory(path).runs.map((r) => r.id)).toEqual(["r2", "r3", "r4"]);
    writeFileSync(path, "{nope");
    expect(loadHistory(path)).toEqual(emptyHistory());
  });
});

describe("grouping and dedupe", () => {
  it("groups C2 findings by token and C1 by rule and file", () => {
    const g = groupFindings([
      f("C2", "x", { token: "--a", category: "token-parity" }),
      f("C2", "y", { token: "--a", category: "token-parity" }),
      f("C1", "z", { category: "hex-in-source", title: "Hard-coded colour", links: { source: "src/a.tsx:3" } }),
    ]);
    expect(g[0]).toMatchObject({ title: "--a: token parity (2)" });
    expect(g[1]!.title).toBe("Hard-coded colour · src/a.tsx");
  });

  it("merges identical fingerprints and counts occurrences", () => {
    const out = dedupe([f("C3", "same"), f("C3", "same"), f("C3", "other")]);
    expect(out).toHaveLength(2);
    expect(out[0]!.occurrences).toBe(2);
  });
});

const report = (): Report => {
  const finding = f("C2", "r", {
    severity: "high",
    gap: "A",
    title: "--color-level-5 differs <b>",
    expected: { value: "#101213", source: "Figma · Chat Sidepanel", token: "var(--color-level-5)" },
    actual: { value: "#171a1c", source: "code fallback" },
    related: ["--color-model-selector-bg (neon.css:12)"],
    links: { figma: "https://figma/x", source: "base.css:3", commit: "0123456789abcdef" },
    status: "new",
  });
  return {
    meta: { id: "run1", at: "2026-11-19T10:00:00.000Z", repo: "/x/opera-chat", commit: "0123456789abcdef", configPath: "c.yaml", checks: ["C1", "C2"] },
    summary: { total: 1, bySeverity: { high: 1, medium: 0, low: 0 }, byCheck: { C2: 1 }, new: 1, fixed: 1 },
    findings: [finding],
    fixed: [{ fingerprint: "old", title: "old finding" }],
    groups: groupFindings([finding]),
    notes: ["Theme CSS: 1 files"],
  };
};

describe("report rendering", () => {
  it("writes a readable markdown summary with expected, actual and links", () => {
    const md = renderMarkdown(report());
    expect(md).toContain("**1 issues** to look at (1 findings) · high 1");
    expect(md).toContain("- Expected: `#101213` (Figma · Chat Sidepanel, var(--color-level-5))");
    expect(md).toContain("- Already patched by: --color-model-selector-bg (neon.css:12)");
    expect(md).toContain("## Fixed since the previous run");
    expect(md).toContain("## For Design system team · gap A: Figma ↔ design-system code");
  });

  it("names the owners in the report and lets the HTML filter by them", () => {
    const r = report();
    r.meta.owners = { A: "DS", B: "Neon" };
    expect(renderMarkdown(r)).toContain("## For DS · gap A");
    const html = renderHtml(r);
    expect(html).toContain('<option value="A">DS (gap A)</option>');
    expect(html).toContain('data-gap="A"');
  });

  it("escapes HTML and shows swatches", () => {
    const html = renderHtml(report());
    expect(html).toContain("--color-level-5 differs &lt;b&gt;");
    expect(html).not.toContain("differs <b>");
    expect(html).toContain('style="background:#101213"');
    expect(html).toContain('href="https://figma/x"');
  });

  it("writes the run folder and mirrors it to latest", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-rep-"));
    const paths = writeReport(report(), dir, join(dir, "run1"));
    for (const p of [paths.runDir, paths.latest]) {
      expect(existsSync(join(p, "report.html"))).toBe(true);
      expect(JSON.parse(readFileSync(join(p, "findings.json"), "utf8")).meta.id).toBe("run1");
    }
  });
});

describe("config", () => {
  const minimal = `
target:
  repo: ../repo
  themeEntry: src/themes.css
contexts:
  - name: light
`;

  it("reads who owns each gap, with neutral defaults", () => {
    expect(parseConfig(minimal, "/a.yaml").owners).toEqual({ A: "Design system team", B: "Product team" });
    expect(parseConfig(`${minimal}owners: { A: DS, B: Neon }`, "/a.yaml").owners).toEqual({ A: "DS", B: "Neon" });
  });

  it("applies defaults and resolves paths relative to the config file", () => {
    const c = parseConfig(minimal, "/cfg/dir/audit.yaml");
    expect(c.target.repo).toBe("/cfg/repo");
    expect(c.target.themeEntry).toBe("/cfg/repo/src/themes.css");
    expect(c.contexts[0]).toEqual({ name: "light", html: {}, colorScheme: "light", figmaMode: "light", backdrop: "#ffffff" });
    expect(c.thresholds).toEqual({ colorDeltaE: 2, px: 1, maxCheckedSpacing: 64, minOverlapPx: 16, contrast: { normal: 4.5, large: 3 } });
    expect(c.componentSpecs).toEqual([]);
    expect(c.target.scan.hexExtensions).toEqual([".tsx"]);
    expect(c.report.dir).toBe("/cfg/dir/reports");
  });

  it("explains what is missing or wrong", () => {
    expect(() => parseConfig("contexts: []", "/a.yaml")).toThrow(ConfigError);
    expect(() => parseConfig("target: {repo: x, themeEntry: y}\ncontexts: []", "/a.yaml")).toThrow(/at least one/);
    expect(() => parseConfig(`${minimal}    colorScheme: dusk`, "/a.yaml")).toThrow(/light or dark/);
    expect(() => parseConfig(`${minimal}reference:\n  sources:\n    - type: sketch`, "/a.yaml")).toThrow(/figma-variable-defs/);
    expect(() => parseConfig(`${minimal}componentSpecs:\n  - { name: x, match: {} }`, "/a.yaml")).toThrow(/testId or component/);
    expect(() => parseConfig(`${minimal}componentSpecs:\n  - { match: { testId: x }, padding: [8, 12] }`, "/a.yaml")).toThrow(/4 values/);
  });

  it("reads component specs with skipped sides", () => {
    const c = parseConfig(`${minimal}componentSpecs:\n  - { name: Option, match: { testId: "model-option*" }, padding: [null, 12, null, 12], gap: 4 }`, "/a.yaml");
    expect(c.componentSpecs).toEqual([{ name: "Option", match: { testId: "model-option*" }, padding: [null, 12, null, 12], gap: 4, figma: undefined }]);
  });

  it("expands environment variables and defers missing runtime ones", () => {
    process.env.DA_TEST_REPO = "/env/repo";
    const c = parseConfig(minimal.replace("../repo", "${DA_TEST_REPO}"), "/a.yaml");
    expect(c.target.repo).toBe("/env/repo");
    expect(() => parseConfig(minimal.replace("../repo", "${DA_UNSET_VAR}"), "/a.yaml")).toThrow(/DA_UNSET_VAR/);

    const rt = parseConfig(`${minimal}runtime:\n  executablePath: \${DA_UNSET_BROWSER}\n  surfaces:\n    - {name: s, url: "x"}`, "/a.yaml");
    expect(() => assertRuntimeReady(rt)).toThrow(/DA_UNSET_BROWSER/);
  });
});
