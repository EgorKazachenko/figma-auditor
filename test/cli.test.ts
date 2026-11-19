// Runs the real CLI in a child process: exit codes, messages and the report it writes.
import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "design-auditor.mjs");
const run = (args: string[], cwd = root) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });

describe("design-auditor CLI", () => {
  it("prints help", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("design-auditor run --config <file>");
    expect(r.stdout).toContain("c7 Figma component states");
  });

  it.each([
    [["run"], "Pass the config file with --config <file>."],
    [["audit", "--config", "x.yaml"], "Unknown command: audit"],
    [["run", "--config", "x.yaml", "--checks", "c10"], "Unknown checks: c10. Use c1 to c9 or all."],
    [["run", "--wat"], "Unknown option: --wat"],
    [["run", "--config", "design-auditor.example.yaml", "--states", "nope"], "--states: no state named nope in the config"],
    [["run", "--config", "design-auditor.example.yaml", "--viewports", "nope"], "--viewports: none of nope is in runtime.viewports"],
  ])("explains bad input %j with exit code 2", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });

  it("runs an audit, writes the report and fails on new high findings when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "da-cli-"));
    cpSync(join(root, "test", "fixtures", "repo"), join(dir, "repo"), { recursive: true });
    cpSync(join(root, "test", "fixtures", "figma"), join(dir, "figma"), { recursive: true });
    writeFileSync(
      join(dir, "audit.yaml"),
      `target: { repo: repo, themeEntry: src/root/themes/themes.css, scan: { include: [src], exclude: [src/tests, src/root/themes] } }
contexts:
  - { name: dark, html: { data-product: Neon }, colorScheme: dark }
reference:
  sources: [{ type: figma-variable-defs, path: figma/dark.json }]
report: { dir: out }
`,
    );
    const ok = run(["run", "--config", join(dir, "audit.yaml"), "--no-history"], dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/findings \(high 2,/);
    expect(existsSync(join(dir, "out", "latest", "report.html"))).toBe(true);

    const strict = run(["run", "--config", join(dir, "audit.yaml"), "--no-history", "--fail-on", "high"], dir);
    expect(strict.status).toBe(1);
  });
});
