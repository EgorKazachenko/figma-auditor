import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfig } from "../src/config.js";
import { runAudit } from "../src/pipeline.js";
import { compareLayout, type LayoutEntry } from "../src/checks/c6Regression.js";

const e = (key: string, x: number, y: number, w = 100, h = 20, ancestors: string[] = []): LayoutEntry => ({
  key,
  label: key.split("#")[0]!,
  box: { x, y, width: w, height: h },
  ancestors,
  text: "",
});

describe("compareLayout", () => {
  it("names the outermost element of a shift, not everything that moved with it", () => {
    const before = [e("card#0", 0, 0, 200, 100), e("title#0", 10, 10, 100, 20, ["card#0"]), e("icon#0", 150, 10, 20, 20, ["card#0"])];
    const after = [e("card#0", 0, 12, 200, 100), e("title#0", 10, 22, 100, 20, ["card#0"]), e("icon#0", 160, 22, 20, 20, ["card#0"])];
    const changes = compareLayout(before, after, 2).map((c) => `${c.kind}:${c.entry.key}:${c.dx},${c.dy}`);
    // The card moved down 12px; the title moved with it; the icon also moved 10px right inside it.
    expect(changes).toEqual(["moved:card#0:0,12", "moved:icon#0:10,12"]);
  });

  it("reports size changes, and additions or removals only at their top level", () => {
    const before = [e("list#0", 0, 0, 100, 60), e("item#0", 0, 0, 100, 20, ["list#0"]), e("panel#0", 0, 80), e("row#0", 0, 80, 100, 20, ["panel#0"])];
    const after = [e("list#0", 0, 0, 100, 80), e("item#0", 0, 0, 100, 20, ["list#0"]), e("toast#0", 0, 200), e("toast-text#0", 0, 200, 50, 20, ["toast#0"])];
    expect(compareLayout(before, after, 2).map((c) => `${c.kind}:${c.entry.key}`)).toEqual(["resized:list#0", "added:toast#0", "missing:panel#0"]);
  });

  it("ignores sub-tolerance jitter", () => {
    expect(compareLayout([e("a#0", 0, 0)], [e("a#0", 1, 2, 101, 20)], 2)).toEqual([]);
  });
});

describe("C6 in Chromium: baseline, unchanged run, changed build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "da-c6-"));
  const page = (name: string) => pathToFileURL(join(import.meta.dirname, "fixtures", "pages", name)).href;
  const config = (file: string) =>
    parseConfig(
      `
target: { repo: ${dir}, themeEntry: none.css }
contexts: [{ name: light }]
runtime:
  forceContextAttributes: false
  collectSelector: "[data-testid]"
  surfaces: [{ name: home, url: "${page(file)}", mask: ["[data-testid=clock]"] }]
report: { dir: ${join(dir, "out")} }
history: { path: ${join(dir, "h.json")} }
baseline: { dir: ${join(dir, "baselines")} }
`,
      join(dir, "c.yaml"),
    );
  const opts = { checks: ["c6" as const], runtime: true, history: false };
  const first = await runAudit(config("regression-a.html"), { ...opts, now: new Date("2026-11-19T10:00:00Z") });
  const same = await runAudit(config("regression-a.html"), { ...opts, now: new Date("2026-11-19T10:01:00Z") });
  const changed = await runAudit(config("regression-b.html"), { ...opts, now: new Date("2026-11-19T10:02:00Z") });

  it("creates the baseline on the first run", () => {
    expect(first.report.findings).toEqual([]);
    expect(first.report.notes).toContain("C6 baseline created for home/default/light.");
    expect(existsSync(join(dir, "baselines", "home__default__light.png"))).toBe(true);
  });

  it("stays silent when the same build runs again, despite a ticking clock and an animation", () => {
    expect(same.report.findings).toEqual([]);
  });

  it("names what moved, appeared and disappeared, with a pixel diff as evidence", () => {
    const titles = changed.report.findings.map((f) => `${f.category}: ${f.title.split(" since")[0]}`);
    // The second list item was removed, so "Three" now holds key item#1 and the last item key is gone.
    expect(titles).toEqual(["layout-moved: cta moved +12px horizontally, 0px vertically", "layout-added: badge appeared", "layout-missing: item is gone"]);
    expect(titles.some((t) => t.startsWith("layout-moved: cta-label"))).toBe(false); // moved with its parent
    const diff = changed.report.findings.find((f) => f.evidence?.diff)!.evidence!.diff!;
    expect(existsSync(join(changed.paths!.runDir, diff))).toBe(true);
  });
});

describe("C6 per viewport", () => {
  it("keeps findings of different viewports apart and names the viewport", async () => {
    const { regressionFindings } = await import("../src/checks/c6Regression.js");
    const base = { surface: "p", state: "s", context: "light", url: "", browser: "b", tokens: {}, nodes: [] };
    const baseline = { cell: { surface: "p", state: "s", context: "light" }, browser: "b", at: "t", entries: [] };
    const change = { kind: "moved" as const, entry: { key: "a#0", label: "a", box: { x: 0, y: 10, width: 10, height: 10 }, ancestors: [], text: "" }, before: { x: 0, y: 0, width: 10, height: 10 }, dx: 0, dy: 10 };
    const plain = regressionFindings(base, baseline, [change], {});
    const wide = regressionFindings({ ...base, viewport: "wide" }, baseline, [change], {});
    expect(plain[0]!.fingerprint).not.toBe(wide[0]!.fingerprint);
    expect(wide[0]!.cell).toEqual({ surface: "p", state: "s", context: "light", viewport: "wide" });
    expect(plain[0]!.cell).toEqual({ surface: "p", state: "s", context: "light" });
  });
});
