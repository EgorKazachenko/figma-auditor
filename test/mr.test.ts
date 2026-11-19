// Merge-request check as CI runs it: merge base vs MR head, exported with git archive, new findings only.
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseConfig } from "../src/config.js";
import { pairMoves, runMrCheck, worstNew } from "../src/ci/mr.js";
import { makeFinding } from "../src/findings.js";
import type { Finding } from "../src/types.js";

const fixtures = join(import.meta.dirname, "fixtures");
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

describe("pairing moved findings", () => {
  const f = (file: string, value: string): Finding =>
    makeFinding({ check: "C1", category: "hex-in-source", gap: "B", severity: "low", title: `Hard-coded colour ${value}`, actual: { value, source: file }, links: { source: `${file}:1` } }, [file, value]);
  it("treats the same finding in another file as moved, not new and fixed", () => {
    const r = pairMoves([f("b.tsx", "#111"), f("b.tsx", "#222")], [f("a.tsx", "#111"), f("a.tsx", "#333")]);
    expect(r.moved.map((m) => `${m.from.links.source}→${m.to.links.source}`)).toEqual(["a.tsx:1→b.tsx:1"]);
    expect(r.added.map((x) => x.actual?.value)).toEqual(["#222"]);
    expect(r.removed.map((x) => x.actual?.value)).toEqual(["#333"]);
    expect(worstNew(r.added)).toBe("low");
    expect(worstNew([])).toBeUndefined();
  });
});

describe("runMrCheck on a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "da-mr-test-"));
  const repo = join(dir, "repo");
  cpSync(join(fixtures, "repo"), repo, { recursive: true });
  cpSync(join(fixtures, "figma"), join(dir, "figma"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "checkout", "-qb", "feature");
  // commit 1: a new arbitrary colour
  const button = join(repo, "src/components/Button.tsx");
  writeFileSync(button, readFileSync(button, "utf8").replace("w-[300px]", "w-[300px] text-[rgb(1,2,3)]"));
  git(repo, "commit", "-qam", "NAI-1: new colour");
  // commit 2: move a file (its findings move with it) and fix the accent token drift
  renameSync(join(repo, "src/components/Button.tsx"), join(repo, "src/components/PrimaryButton.tsx"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "NAI-2: rename button");
  const cfg = parseConfig(
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
    join(dir, "audit.yaml"),
  );
  const statusBefore = git(repo, "status", "--porcelain");
  const r = await runMrCheck(cfg, { base: "main" });

  it("reports only what the MR adds, attributed to the commit that wrote it", () => {
    expect(r.commits.map((c) => c.subject)).toEqual(["NAI-2: rename button", "NAI-1: new colour"]);
    expect(r.added.map((f) => f.title)).toEqual(["Arbitrary colour class text-[rgb(1,2,3)] instead of a token"]);
    const sha = git(repo, "rev-parse", "HEAD~1");
    expect(r.added[0]!.links.commit).toBe(sha);
    expect(r.added[0]!.links.source).toMatch(/^src\/components\/PrimaryButton\.tsx:\d+$/);
  });

  it("does not call findings in a renamed file new or fixed", () => {
    expect(r.removed).toEqual([]);
    expect(r.moved.length).toBeGreaterThan(3);
    expect(r.moved.every((m) => m.to.links.source!.startsWith("src/components/PrimaryButton.tsx"))).toBe(true);
  });

  it("writes an MR comment and leaves the working copy alone", () => {
    expect(r.comment).toContain("**1 new** (0 high, 1 medium, 0 low) · **0 fixed** ·");
    expect(r.comment).toContain("moved with their code");
    expect(r.comment).toContain("NAI-1: new colour");
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  it("says so when an MR adds nothing", async () => {
    const same = await runMrCheck(cfg, { base: "HEAD" });
    expect(same.comment).toContain("No new design-system drift in this MR.");
    await expect(runMrCheck(cfg, { base: "nope" })).rejects.toThrow(/not a commit/);
  });
});
