// End-to-end: config file → static scan → Chromium token resolution → runtime capture → checks → history → report files.
import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { runAudit } from "../src/pipeline.js";

const fixtures = join(import.meta.dirname, "fixtures");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "da-e2e-"));
  cpSync(join(fixtures, "repo"), join(dir, "repo"), { recursive: true });
  cpSync(join(fixtures, "figma"), join(dir, "figma"), { recursive: true });
  const page = pathToFileURL(join(fixtures, "pages", "product.html")).href;
  writeFileSync(
    join(dir, "audit.yaml"),
    `
project: fixture
target:
  repo: repo
  themeEntry: src/root/themes/themes.css
  tailwindConfig: tailwind.config.ts
  scan:
    include: [src]
    exclude: [src/tests, src/root/themes]
contexts:
  - { name: neon-light, html: { data-theme: opera, data-product: Neon }, colorScheme: light, figmaMode: light }
  - { name: neon-dark, html: { data-theme: opera-dark, data-product: Neon }, colorScheme: dark, figmaMode: dark }
reference:
  sources:
    - { type: figma-variable-defs, path: figma/light.json }
    - { type: figma-variable-defs, path: figma/dark.json }
scales:
  spacing: { tailwindPrefix: aria- }
  radius: [4, 8]
runtime:
  surfaces:
    - { name: product, url: "${page}", waitFor: "[data-ds-component]" }
report: { dir: out }
history: { path: out/history.json }
`,
  );
  spawnSync("git", ["init", "-q"], { cwd: join(dir, "repo") });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: join(dir, "repo") });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: join(dir, "repo") });
  return dir;
}

describe("runAudit end to end", async () => {
  const dir = workspace();
  const cfg = loadConfig(join(dir, "audit.yaml"));
  const first = await runAudit(cfg, { checks: ["c1", "c2", "c3"], runtime: true, blame: true, now: new Date("2026-11-19T10:00:00Z") });
  const r = first.report;
  const titles = r.findings.map((f) => f.title);

  it("finds the planted token drift with its workaround and Figma link", () => {
    const level5 = r.findings.find((f) => f.category === "token-parity" && f.token === "--color-level-5")!;
    expect(level5).toMatchObject({ context: "neon-dark", severity: "high", related: ["--color-model-selector-bg (src/root/themes/neon.css:3)"] });
    expect(level5.links.figma).toBe("https://www.figma.com/design/FILEKEY123/?node-id=1-3");
    expect(r.findings.some((f) => f.category === "token-parity" && f.token === "--color-text-02")).toBe(true);
    expect(r.findings.some((f) => f.category === "token-missing-in-code")).toBe(true);
  });

  it("uses runtime values: level-5 drifts the same way in the product, text-02 is corrected there", () => {
    expect(r.findings.some((f) => f.category === "token-parity-runtime")).toBe(false);
    const level5 = r.findings.find((f) => f.category === "token-parity" && f.token === "--color-level-5")!;
    expect(level5.actual?.source).toMatch(/; same value in chromium/);
    const text02 = r.findings.find((f) => f.category === "token-parity" && f.token === "--color-text-02")!;
    expect(text02.actual?.source).not.toMatch(/same value/);
  });

  it("reports off-token colours and off-scale spacing from the live page", () => {
    expect(titles.some((t) => t.startsWith("title: color #ff00aa"))).toBe(true);
    expect(titles.some((t) => t.startsWith("in-shadow: background-color #abcdef"))).toBe(true);
    expect(titles.some((t) => t.startsWith("bordered: border-top-color #00ff00"))).toBe(true);
    expect(titles.some((t) => t.startsWith("title: padding-top 10px is off the scale"))).toBe(true);
    expect(titles.some((t) => t.startsWith("container: color"))).toBe(false);
    // Pills use a huge radius on purpose; only their colours are checked.
    expect(titles.some((t) => t.startsWith("pill:") && t.includes("radius"))).toBe(false);
    // White text exists as a token in light mode only, so the dark pill is flagged and the light one is not.
    const pillColor = r.findings.filter((f) => f.title.startsWith("pill: color")).map((f) => f.context);
    expect(pillColor).toEqual(["neon-dark"]);
  });

  it("includes static findings with blame commits", () => {
    const hex = r.findings.find((f) => f.category === "hex-in-source")!;
    expect(hex.links.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.findings.some((f) => f.category === "unknown-css-var" && f.title.includes("--color-unknown-x"))).toBe(true);
  });

  it("summarises, groups and writes the report files", () => {
    expect(r.summary.total).toBe(r.findings.length);
    expect(r.summary.new).toBe(r.findings.length);
    expect(r.summary.bySeverity.high).toBe(2); // level-5 and text-02 in dark mode
    expect(r.meta.checks).toEqual(["C1", "C2", "C3"]);
    expect(r.groups.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "out", "latest", "report.html"))).toBe(true);
    expect(readFileSync(join(dir, "out", "latest", "report.md"), "utf8")).toContain("--color-level-5");
  });

  it("marks findings open on the next run and lists fixes after the code changes", async () => {
    const again = await runAudit(cfg, { checks: ["c1", "c2"], now: new Date("2026-11-19T11:00:00Z") });
    expect(again.report.summary.new).toBe(0);
    expect(again.report.findings.every((f) => f.status === "open")).toBe(true);

    const neon = join(dir, "repo", "src/root/themes/base.css");
    writeFileSync(neon, readFileSync(neon, "utf8").replace("light-dark(#ffffff, #171a1c)", "light-dark(#f7f7f8, #101213)"));
    const fixed = await runAudit(cfg, { checks: ["c1", "c2"], now: new Date("2026-11-19T12:00:00Z") });
    expect(fixed.report.fixed.map((f) => f.title).some((t) => t.startsWith("--color-level-5 differs from Figma in neon-dark"))).toBe(true);
    expect(fixed.report.findings.some((f) => f.token === "--color-level-5" && f.category === "token-parity")).toBe(false);
  });
});
