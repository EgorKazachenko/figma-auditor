// Noise control and the issue view: aggregation, severity overrides, suppressions, accepted debt,
// element crops, Figma renders and the report built from them.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { makeFinding } from "../src/findings.js";
import type { Finding, Report, SnapshotCell } from "../src/types.js";
import { aggregateIssues, issueCounts, regroupByIssues } from "../src/issues.js";
import { acceptFindings, applyAccepted, applySeverityOverrides, applySuppressions, loadAccepted, saveAccepted } from "../src/noise.js";
import { parseIgnoreDirective, scanText } from "../src/static/scanner.js";
import { checkStatic } from "../src/checks/c1Static.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { cropWithOutline } from "../src/report/crops.js";
import { cacheName, fetchFigmaImages, parseFigmaLink } from "../src/report/figmaImages.js";
import { renderHtml, renderMarkdown } from "../src/report/render.js";
import { renderMrComment } from "../src/ci/mr.js";
import { runAudit } from "../src/pipeline.js";

const fixtures = join(import.meta.dirname, "fixtures");

const cellF = (state: string, context: string, viewport?: string, over: Partial<Finding> = {}): Finding =>
  makeFinding(
    {
      check: "C3",
      category: "off-token-color",
      gap: "B",
      severity: "medium",
      title: "chat-mode-selector-label: color #3a6ea5 matches no token",
      component: "chat-mode-selector-label",
      property: "color",
      actual: { value: "#3a6ea5", source: "computed" },
      cell: { surface: "sidepanel", state, context, ...(viewport ? { viewport } : {}) },
      links: { source: 'span[data-testid="chat-mode-selector-label"]' },
      evidence: { screenshot: `shots/${state}.png`, box: { x: 10, y: 10, width: 20, height: 10 } },
      status: "new",
      ...over,
    },
    [state, context, viewport ?? ""],
  );

const c1 = (line: number, value: string, over: Partial<Finding> = {}): Finding =>
  makeFinding(
    { check: "C1", category: "tailwind-arbitrary-color", gap: "B", severity: "medium", title: `Arbitrary colour class ${value} instead of a token`, actual: { value, source: `src/Login.tsx:${line}` }, links: { source: `src/Login.tsx:${line}` }, status: "open", ...over },
    ["src/Login.tsx", value, line],
  );

describe("issues", () => {
  it("merges one problem seen on many screens into one issue and says where", () => {
    const findings = [cellF("input", "light"), cellF("input", "dark"), cellF("menu", "light"), cellF("menu", "dark", "755")];
    const [issue, ...rest] = aggregateIssues(findings);
    expect(rest).toEqual([]);
    expect(issue!.findingIds).toHaveLength(4);
    expect(issue!.seenText).toBe("seen in 2 states · 2 themes · 2 widths");
    expect(issue!.seen).toMatchObject({ cells: 4, states: ["input", "menu"], contexts: ["dark", "light"], viewports: ["755", "default"] });
    expect(issue!.status).toBe("new");
    expect(issue!.evidence?.screenshot).toBe("shots/input.png");
  });

  it("merges repeats of a value in one file, keeps other values and files apart", () => {
    const issues = aggregateIssues([c1(10, "text-[#171a1c]"), c1(22, "text-[#171a1c]"), c1(30, "bg-[#ffffff]"), c1(5, "text-[#171a1c]", { links: { source: "src/Other.tsx:5" } })]);
    expect(issues.map((i) => i.findingIds.length).sort()).toEqual([1, 1, 2]);
    expect(issues.find((i) => i.findingIds.length === 2)!.seenText).toBe("2 places");
  });

  it("is new while any member counts, and quiet only when all members are", () => {
    const a = cellF("input", "light", undefined, { status: "open" });
    const b = cellF("menu", "light", undefined, { status: "accepted" });
    expect(aggregateIssues([a, b])[0]!.status).toBe("open");
    expect(aggregateIssues([{ ...a, status: "accepted" }, b])[0]!.status).toBe("accepted");
    expect(aggregateIssues([{ ...a, status: "suppressed", suppressed: { reason: "r", source: "config" } }])[0]!.suppressed?.reason).toBe("r");
    expect(issueCounts(aggregateIssues([a, b, c1(1, "x")]))).toEqual({ issues: 2, issuesBySeverity: { high: 0, medium: 2, low: 0 } });
  });

  it("counts issues, not findings, in group titles", () => {
    const fs = [cellF("input", "light"), cellF("menu", "light")];
    const issues = aggregateIssues(fs);
    const [g] = regroupByIssues([{ key: "k", title: "label colour (2)", findingIds: fs.map((f) => f.id) }], issues);
    expect(g).toMatchObject({ title: "label colour · 2 findings", issueIds: [issues[0]!.id] });
  });
});

describe("severity overrides", () => {
  it("re-rates by check or check/category (category wins) and drops 'off' rules", () => {
    const fs = [c1(1, "a"), c1(2, "b", { category: "tailwind-arbitrary-type", severity: "low" }), cellF("x", "light")];
    const r = applySeverityOverrides(fs, { C1: "high", "C1/tailwind-arbitrary-type": "off", C3: "low" });
    expect(r.findings.map((f) => `${f.check}/${f.severity}`)).toEqual(["C1/high", "C3/low"]);
    expect(r.dropped).toEqual({ "C1/tailwind-arbitrary-type": 1 });
  });

  it("is validated in the config", () => {
    const base = "target: {repo: r, themeEntry: t}\ncontexts: [{name: l}]\n";
    expect(parseConfig(`${base}severity: { c8: medium, "C1/hex-in-source": off }`, "/a.yaml").severity).toEqual({ C8: "medium", "C1/hex-in-source": "off" });
    expect(() => parseConfig(`${base}severity: { C8: urgent }`, "/a.yaml")).toThrow(/high, medium, low or off/);
    expect(() => parseConfig(`${base}severity: { colour: low }`, "/a.yaml")).toThrow(/check/);
  });
});

describe("suppressions", () => {
  it("needs a reason and a target, and a valid date", () => {
    const base = "target: {repo: r, themeEntry: t}\ncontexts: [{name: l}]\n";
    expect(() => parseConfig(`${base}suppress: [{ check: C1 }]`, "/a.yaml")).toThrow(/needs a reason/);
    expect(() => parseConfig(`${base}suppress: [{ reason: why }]`, "/a.yaml")).toThrow(/hide everything/);
    expect(() => parseConfig(`${base}suppress: [{ check: C1, reason: why, until: tomorrow }]`, "/a.yaml")).toThrow(ConfigError);
    expect(parseConfig(`${base}suppress: [{ check: c3, contains: [label], reason: " brand blue ", until: 2027-01-31 }]`, "/a.yaml").suppress).toEqual([
      { check: "C3", category: undefined, contains: ["label"], reason: "brand blue", until: "2027-01-31" },
    ]);
  });

  it("marks matching findings, reports expired rules and counts by reason", () => {
    const fs = [cellF("input", "light"), c1(3, "text-[#171a1c]"), c1(4, "bg-[#000]")];
    const { notes } = applySuppressions(
      fs,
      [
        { check: "C3", contains: ["#3a6ea5"], reason: "campaign colour" },
        { category: "tailwind-arbitrary-color", contains: ["#000"], reason: "old", until: "2026-01-01" },
      ],
      "2026-11-19",
    );
    expect(fs.map((f) => f.status)).toEqual(["suppressed", "open", "open"]);
    expect(fs[0]!.suppressed).toEqual({ reason: "campaign colour", source: "config", until: undefined });
    expect(notes[0]).toMatch(/Suppression expired on 2026-01-01.*"old"/);
    expect(notes[1]).toBe("Suppressed 1 findings: 1 × config: campaign colour.");
  });

  it("reads inline directives in //, /* */ and {/* */} comments, for the line or the next one", () => {
    expect(parseIgnoreDirective('<i className="p-[13px]" /> // design-auditor-ignore off-scale-spacing -- matches the native control')).toEqual({ nextLine: false, category: "off-scale-spacing", reason: "matches the native control" });
    expect(parseIgnoreDirective("{/* design-auditor-ignore-next-line -- illustration */}")).toEqual({ nextLine: true, category: "*", reason: "illustration" });
    expect(parseIgnoreDirective("  /* design-auditor-ignore hex-in-css -- print stylesheet */")).toEqual({ nextLine: false, category: "hex-in-css", reason: "print stylesheet" });
    expect(parseIgnoreDirective("// design-auditor-ignore hex-in-source")).toEqual({ nextLine: false, category: "hex-in-source", reason: undefined });
    expect(parseIgnoreDirective("const a = 1;")).toBeNull();
  });

  it("suppresses C1 hits whose rule or verdict category the directive names; no reason, no suppression", () => {
    const text = [
      '<a className="text-[#171a1c]" /> // design-auditor-ignore tailwind-arbitrary-color -- logo colour from the brand book',
      "// design-auditor-ignore-next-line off-scale-spacing -- aligns with the OS title bar",
      '<b className="p-[13px] bg-[#222222]" />',
      '<c className="text-[#333333]" /> // design-auditor-ignore hex-in-source',
    ].join("\n");
    const warnings: string[] = [];
    const hits = scanText("src/a.tsx", text, new Set(), { warnings });
    const f = checkStatic(hits, { spacingScale: [0, 4, 8, 12], radiusScale: [4], px: 1 });
    const state = (needle: string) => f.filter((x) => x.actual?.value.includes(needle)).map((x) => x.suppressed?.reason ?? "-");
    expect(state("#171a1c")).toEqual(["logo colour from the brand book"]);
    expect(state("p-[13px]")).toEqual(["aligns with the OS title bar"]); // verdict category off-scale-spacing
    expect(state("#222222")).toEqual(["-"]); // same line, other category
    expect(state("#333333")).toEqual(["-"]);
    expect(warnings).toEqual(['src/a.tsx:4: design-auditor-ignore without a reason is not applied (write "-- <why>")']);
  });
});

describe("accepted debt", () => {
  it("accepts once, skips suppressed findings, and lets suppression win", () => {
    const a = c1(1, "a");
    const s = { ...c1(2, "b"), status: "suppressed" as const, suppressed: { reason: "r", source: "inline" as const } };
    const first = acceptFindings({ version: 1, entries: {} }, [a, s], { reason: "baseline 2026-11", at: "2026-11-19T00:00:00Z", commit: "abc" });
    expect(first.added).toBe(1);
    expect(acceptFindings(first.list, [a], { at: "x" }).added).toBe(0);
    const later = [c1(1, "a"), { ...c1(2, "b"), status: "suppressed" as const }];
    expect(applyAccepted(later, first.list)).toBe(1);
    expect(later.map((f) => f.status)).toEqual(["accepted", "suppressed"]);
    expect(later[0]!.accepted).toEqual({ reason: "baseline 2026-11", at: "2026-11-19T00:00:00Z" });
  });

  it("round-trips through the file and survives a broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-acc-"));
    const p = join(dir, "x", "accepted.json");
    saveAccepted(p, acceptFindings({ version: 1, entries: {} }, [c1(1, "a")], { at: "t" }).list);
    expect(Object.keys(loadAccepted(p).entries)).toHaveLength(1);
    writeFileSync(p, "{nope");
    expect(loadAccepted(p).entries).toEqual({});
  });
});

describe("element crops", () => {
  const shot = (w: number, h: number) => {
    const png = new PNG({ width: w, height: h });
    png.data.fill(255);
    const p = join(mkdtempSync(join(tmpdir(), "da-crop-")), "shot.png");
    writeFileSync(p, PNG.sync.write(png));
    return p;
  };
  const px = (png: PNG, x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];

  it("cuts the element with context and outlines its box", () => {
    const src = shot(100, 80);
    const out = join(src, "..", "crop.png");
    expect(cropWithOutline(src, { x: 30, y: 30, width: 20, height: 10 }, out, { pad: 5 })).toBe(true);
    const png = PNG.sync.read(readFileSync(out));
    expect([png.width, png.height]).toEqual([30, 20]);
    expect(px(png, 4, 7)).toEqual([229, 32, 122, 255]); // outline just left of the box (box starts at 5)
    expect(px(png, 10, 10)).toEqual([255, 255, 255, 255]); // inside the element: untouched
    expect(px(png, 0, 0)).toEqual([255, 255, 255, 255]); // context corner: untouched
  });

  it("maps CSS px to screenshot pixels and refuses boxes off the image", () => {
    const src = shot(200, 160);
    const out = join(src, "..", "crop2.png");
    expect(cropWithOutline(src, { x: 10, y: 10, width: 10, height: 10 }, out, { pad: 0, viewportWidth: 100 })).toBe(true);
    expect(PNG.sync.read(readFileSync(out)).width).toBe(20);
    expect(cropWithOutline(src, { x: 500, y: 500, width: 10, height: 10 }, out)).toBe(false);
  });
});

describe("Figma renders", () => {
  it("parses design, file and branch links", () => {
    expect(parseFigmaLink("https://www.figma.com/design/ws7K/AI?node-id=1816-1910&m=dev")).toEqual({ fileKey: "ws7K", nodeId: "1816:1910" });
    expect(parseFigmaLink("https://www.figma.com/design/MAIN/branch/BR1/x?node-id=1-3")).toEqual({ fileKey: "BR1", nodeId: "1:3" });
    expect(parseFigmaLink("https://www.figma.com/design/K/?node-id=1-3")).toEqual({ fileKey: "K", nodeId: "1:3" });
    expect(parseFigmaLink("https://example.com/design/K?node-id=1-3")).toBeNull();
    expect(parseFigmaLink("https://www.figma.com/design/K/x")).toBeNull();
    expect(parseFigmaLink(undefined)).toBeNull();
  });

  const fakeFetch = (calls: string[], opts: { fail?: boolean } = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://api.figma.com/")) {
        expect((init?.headers as Record<string, string>)["X-Figma-Token"]).toBe("tok");
        if (opts.fail) return new Response("no", { status: 403 });
        const ids = decodeURIComponent(new URL(u).searchParams.get("ids")!).split(",");
        return Response.json({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://s3.example/${id}.png`])) });
      }
      return new Response(new Uint8Array([137, 80, 78, 71]));
    }) as typeof fetch;

  it("renders in batches per file, caches by node and skips the API for cached nodes", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "da-fig-"));
    const refs = Array.from({ length: 51 }, (_, i) => ({ fileKey: "K", nodeId: `1:${i}` })).concat([{ fileKey: "L", nodeId: "2:1" }]);
    const calls: string[] = [];
    const r = await fetchFigmaImages(refs, { token: "tok", cacheDir, fetchImpl: fakeFetch(calls), maxNodes: 100 });
    expect(r.note).toBeUndefined();
    expect(r.images.size).toBe(52);
    expect(calls.filter((c) => c.startsWith("https://api.figma.com/")).length).toBe(3); // 50 + 1 for K, 1 for L
    expect(existsSync(join(cacheDir, cacheName({ fileKey: "K", nodeId: "1:7" })))).toBe(true);
    const again: string[] = [];
    expect((await fetchFigmaImages(refs, { token: "tok", cacheDir, fetchImpl: fakeFetch(again), maxNodes: 100 })).images.size).toBe(52);
    expect(again).toEqual([]);
  });

  it("explains in one note when there is no token or the API refuses", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "da-fig2-"));
    expect((await fetchFigmaImages([{ fileKey: "K", nodeId: "1:1" }], { cacheDir })).note).toMatch(/FIGMA_TOKEN is not set/);
    const r = await fetchFigmaImages([{ fileKey: "K", nodeId: "1:1" }], { token: "tok", cacheDir, fetchImpl: fakeFetch([], { fail: true }) });
    expect(r.images.size).toBe(0);
    expect(r.note).toMatch(/K: HTTP 403/);
  });
});

describe("report and MR comment", () => {
  const findings = [
    cellF("input", "light"),
    cellF("menu", "dark", "755"),
    { ...c1(3, "text-[#171a1c]"), status: "accepted" as const, accepted: { at: "2026-11-19T00:00:00Z", reason: "baseline" } },
  ];
  const issues = aggregateIssues(findings);
  issues[0]!.evidence = { ...issues[0]!.evidence, crop: "crops/x.png", figmaImage: "figma/K_1-3.png" };
  const report: Report = {
    meta: { id: "r", at: "2026-11-19T10:00:00Z", repo: "/x/opera-chat", configPath: "c", checks: ["C1", "C3"] },
    summary: { total: 3, bySeverity: { high: 0, medium: 2, low: 0 }, byCheck: { C1: 1, C3: 2 }, new: 2, fixed: 0, ...issueCounts(issues), accepted: 1, suppressed: 0 },
    issues,
    findings,
    fixed: [],
    groups: [],
    notes: [],
  };

  it("shows issues with where they were seen, filters, crops and Figma renders", () => {
    const html = renderHtml(report);
    expect(html).toContain("<b>1 issues</b> from 3 findings");
    expect(html).toContain('id="f-status"');
    expect(html).toContain('data-status="accepted"');
    expect(html).toContain('<img src="crops/x.png"');
    expect(html).toContain('<img src="figma/K_1-3.png"');
    expect(html).toContain("seen in 2 states · 2 themes · 2 widths");
    expect(html).toContain("1 accepted or suppressed issues are hidden by default.");
    const md = renderMarkdown(report);
    expect(md).toContain("**1 issues** to look at (3 findings)");
    expect(md).toContain("- Seen: seen in 2 states · 2 themes · 2 widths (2 findings)");
    expect(md).toContain("- 1 × accepted: baseline");
  });

  it("puts one row per issue in the MR comment and keeps quiet findings out of the count", () => {
    const md = renderMrComment(
      { base: "a".repeat(40), head: "b".repeat(40), changed: ["src/Login.tsx"], commits: [], added: [c1(10, "text-[#111]"), c1(20, "text-[#111]")], removed: [], moved: [], quiet: [cellF("x", "light")] },
      ["c1"],
    );
    expect(md).toContain("**1 new** (0 high, 2 medium, 0 low) from 2 findings · **0 fixed** · 1 suppressed or accepted");
    expect(md).toContain("src/Login.tsx:10 (+1 more)");
  });
});

describe("pipeline", async () => {
  // C1 only (no browser): suppression from the config, an accepted finding, a rule turned off.
  const dir = mkdtempSync(join(tmpdir(), "da-noise-"));
  cpSync(join(fixtures, "repo"), join(dir, "repo"), { recursive: true });
  const yaml = (extra: string, report = "report: { dir: out }") => `
target: { repo: repo, themeEntry: src/root/themes/themes.css, scan: { include: [src], exclude: [src/tests, src/root/themes] } }
contexts: [{ name: light, colorScheme: light }]
scales: { radius: [4, 8] }
${report}
history: { path: out/history.json }
accepted: { path: out/accepted.json }
${extra}`;
  const first = (await runAudit(parseConfig(yaml(""), join(dir, "a.yaml")), { checks: ["c1"], history: false, write: false })).report;

  it("reports issues next to findings", () => {
    expect(first.issues!.length).toBeGreaterThan(0);
    expect(first.issues!.length).toBeLessThanOrEqual(first.findings.length);
    expect(first.summary.issues).toBe(first.issues!.filter((i) => i.status === "new").length);
  });

  it("applies severity overrides, config suppressions and the accepted list", async () => {
    const hex = first.findings.find((f) => f.category === "hex-in-source")!;
    saveAccepted(join(dir, "out", "accepted.json"), acceptFindings({ version: 1, entries: {} }, [hex], { at: "2026-11-19T00:00:00Z", reason: "baseline" }).list);
    const cfg = parseConfig(
      yaml(`severity: { "C1/tailwind-arbitrary-type": off }\nsuppress: [{ check: C1, category: tailwind-arbitrary-color, reason: "brand book colours" }]`),
      join(dir, "a.yaml"),
    );
    const r = (await runAudit(cfg, { checks: ["c1"], history: false, write: false })).report;
    expect(r.findings.some((f) => f.category === "tailwind-arbitrary-type")).toBe(false);
    expect(r.findings.find((f) => f.category === "tailwind-arbitrary-color")!.status).toBe("suppressed");
    expect(r.findings.find((f) => f.fingerprint === hex.fingerprint)!.status).toBe("accepted");
    expect(r.summary.accepted).toBe(1);
    expect(r.summary.suppressed).toBeGreaterThan(0);
    expect(r.summary.new).toBe(r.findings.filter((f) => f.status === "new").length);
    expect(r.notes.join("\n")).toMatch(/Severity override: \d+ C1\/tailwind-arbitrary-type findings turned off/);
    expect(r.notes.join("\n")).toMatch(/Accepted debt: 1 findings/);
    expect(r.notes.join("\n")).toMatch(/Suppressed \d+ findings: \d+ × config: brand book colours/);
  });

  it("crops runtime issues from the cell screenshot when the report is written", async () => {
    const png = new PNG({ width: 120, height: 80 });
    png.data.fill(255);
    const probe = async (_names: string[], outDir: string) => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(outDir, "shots"), { recursive: true });
      writeFileSync(join(outDir, "shots", "s.png"), PNG.sync.write(png));
      const cell: SnapshotCell = {
        surface: "p",
        state: "s",
        context: "light",
        url: "x",
        browser: "test",
        tokens: { "--color-level-5": { raw: "#f7f7f8", color: "rgb(247, 247, 248)" } },
        nodes: [{ component: null, testId: "odd", path: "div", box: { x: 20, y: 20, width: 30, height: 20 }, hasText: true, text: "x", css: { color: "rgb(255, 0, 170)" } }],
        page: { scrollWidth: 120, innerWidth: 120, scrollHeight: 80, innerHeight: 80 },
        screenshot: "shots/s.png",
      };
      return { cells: [cell], browser: "test", warnings: [] };
    };
    const cfg = parseConfig(yaml("", "report: { dir: out2, figmaImages: false }"), join(dir, "b.yaml"));
    const { report, paths } = await runAudit(cfg, { checks: ["c3"], runtime: true, history: false, probe, now: new Date("2026-11-19T10:00:00Z") });
    const issue = report.issues!.find((i) => i.check === "C3")!;
    expect(issue.evidence?.crop).toMatch(/^crops\/i-[0-9a-f]{8}\.png$/);
    expect(existsSync(join(paths!.latest, issue.evidence!.crop!))).toBe(true);
    expect(readFileSync(join(paths!.latest, "report.html"), "utf8")).toContain(issue.evidence!.crop!);
  });
});

describe("accept command", () => {
  it("accepts the latest report's findings with a reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-acc-cli-"));
    writeFileSync(join(dir, "c.yaml"), `target: { repo: ., themeEntry: t.css }\ncontexts: [{ name: l }]\nreport: { dir: out }\naccepted: { path: acc/accepted.json }\n`);
    const report = { meta: { commit: "abc" }, findings: [c1(1, "a"), cellF("s", "l")] };
    writeFileSync(join(dir, "findings.json"), JSON.stringify(report));
    const bin = join(import.meta.dirname, "..", "bin", "design-auditor.mjs");
    const r = spawnSync(process.execPath, [bin, "accept", "--config", join(dir, "c.yaml"), "--from", join(dir, "findings.json"), "--reason", "baseline", "--checks", "C1"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("Accepted 1 findings as existing debt (1 in total)");
    const saved = JSON.parse(readFileSync(join(dir, "acc", "accepted.json"), "utf8"));
    expect(Object.values(saved.entries)).toEqual([{ title: "Arbitrary colour class a instead of a token", check: "C1", reason: "baseline", at: expect.any(String), commit: "abc" }]);
    const missing = spawnSync(process.execPath, [bin, "accept", "--config", join(dir, "c.yaml")], { encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/run an audit first/);
  });
});
