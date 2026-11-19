// Live progress: silent for library use, timestamped lines when the CLI turns it on.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { progress, progressEnabled, setProgress } from "../src/progress.js";

describe("progress", () => {
  it("prints nothing until a sink is set, then timestamped lines", () => {
    const lines: string[] = [];
    progress("ignored");
    expect(progressEnabled()).toBe(false);
    setProgress((l) => lines.push(l));
    progress("Figma: 4 files");
    setProgress(null);
    progress("ignored again");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\s*\d+\.\ds\] Figma: 4 files$/);
  });

  it("shows the stages of a CLI run on stderr, and hides them with --quiet", () => {
    const root = join(import.meta.dirname, "..");
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, [join(root, "bin", "design-auditor.mjs"), "run", "--config", "design-auditor.example.yaml", "--no-history", ...extra], { cwd: root, encoding: "utf8" });
    const loud = run();
    expect(loud.stderr).toMatch(/Code: theme CSS from \d+ files/);
    expect(loud.stderr).toMatch(/Source code: scanned \d+ files/);
    expect(loud.stderr).toMatch(/Checks: C1 \d+ · C2 \d+ findings/);
    expect(loud.stdout).toMatch(/issues from \d+ findings/);
    expect(run("--quiet").stderr).toBe("");
  });
});
