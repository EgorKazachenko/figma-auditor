import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AuditConfig } from "../config.js";
import { ConfigError } from "../config.js";

/**
 * Machine memory in git. The run history and the C6 layout baselines live on a separate branch
 * (default `design-audit/state`) of a repository the team already has, one folder per product, so every
 * laptop and CI job starts from the same memory and the memory has its own reviewable history.
 * Decisions people make (config, mappings, suppressions, accepted debt) stay on the main branch and go
 * through merge requests; caches (Figma, triage) stay in the CI cache because they can be rebuilt.
 *
 * The work happens in a private clone under the state folder; the team's working copy is never touched.
 */

export interface StateOptions {
  remote: string;
  branch?: string;
  /** Folder on the branch; default: the config's project name. */
  folder?: string;
  /** Private clone; default `<history dir>/.state-clone`. */
  cloneDir?: string;
  message?: string;
  author?: { name: string; email: string };
}

const git = (cwd: string, args: string[], author?: StateOptions["author"]) => {
  const id = author ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`] : [];
  const r = spawnSync("git", [...id, ...args], { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

/** Local paths ↔ paths on the state branch. */
export function stateItems(cfg: AuditConfig, folder = cfg.project): { local: string; repo: string; dir: boolean }[] {
  return [
    { local: cfg.history.path, repo: join(folder, "history.json"), dir: false },
    { local: cfg.baseline.dir, repo: join(folder, "baselines"), dir: true },
  ];
}

function cloneDirOf(cfg: AuditConfig, o: StateOptions) {
  return o.cloneDir ?? join(dirname(cfg.history.path), ".state-clone");
}

/** Brings the private clone to the branch tip. Returns false when the branch does not exist yet. */
function syncClone(dir: string, o: StateOptions): boolean {
  const branch = o.branch ?? "design-audit/state";
  if (existsSync(join(dir, ".git"))) {
    if (!git(dir, ["fetch", "--depth", "50", "origin", branch]).ok) return false;
    return git(dir, ["reset", "--hard", "FETCH_HEAD"]).ok;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  const r = spawnSync("git", ["clone", "--quiet", "--depth", "50", "--branch", branch, "--single-branch", o.remote, dir], { encoding: "utf8" });
  if (r.status === 0) return true;
  if (/not found|Remote branch .* not found|couldn't find remote ref/i.test(r.stderr ?? "")) return false;
  throw new ConfigError(`state: cannot clone ${o.remote}: ${(r.stderr ?? "").trim().split("\n").pop()}`);
}

function copy(from: string, to: string, dir: boolean) {
  if (!existsSync(from)) return false;
  if (dir) rmSync(to, { recursive: true, force: true });
  mkdirSync(dir ? to : dirname(to), { recursive: true });
  cpSync(from, to, { recursive: dir });
  return true;
}

/** Copies history and baselines from the state branch into the local paths. */
export function statePull(cfg: AuditConfig, o: StateOptions): { found: boolean; restored: string[]; commit?: string } {
  const dir = cloneDirOf(cfg, o);
  if (!syncClone(dir, o)) return { found: false, restored: [] };
  const restored = stateItems(cfg, o.folder)
    .filter((i) => copy(join(dir, i.repo), i.local, i.dir))
    .map((i) => i.repo);
  return { found: true, restored, commit: git(dir, ["rev-parse", "HEAD"]).out || undefined };
}

/** Commits the local history and baselines to the state branch and pushes it; creates the branch if needed. */
export function statePush(cfg: AuditConfig, o: StateOptions): { pushed: boolean; commit?: string; files: number } {
  const dir = cloneDirOf(cfg, o);
  const branch = o.branch ?? "design-audit/state";
  const author = o.author ?? { name: "design-auditor", email: "design-auditor@localhost" };
  if (!syncClone(dir, o)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const args of [["init", "--quiet"], ["checkout", "--quiet", "--orphan", branch], ["remote", "add", "origin", o.remote]]) {
      const r = git(dir, args);
      if (!r.ok) throw new ConfigError(`state: git ${args[0]} failed: ${r.err}`);
    }
  }
  for (const i of stateItems(cfg, o.folder)) copy(i.local, join(dir, i.repo), i.dir);
  git(dir, ["add", "-A"]);
  if (!git(dir, ["status", "--porcelain"]).out) return { pushed: false, files: 0, commit: git(dir, ["rev-parse", "HEAD"]).out || undefined };
  const files = git(dir, ["diff", "--cached", "--name-only"]).out.split("\n").filter(Boolean).length;
  const c = git(dir, ["commit", "--quiet", "-m", o.message ?? `design-auditor: state of ${cfg.project}`], author);
  if (!c.ok) throw new ConfigError(`state: commit failed: ${c.err}`);
  const p = git(dir, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  if (!p.ok) throw new ConfigError(`state: push to ${o.remote} failed: ${p.err.split("\n").pop()}`);
  return { pushed: true, commit: git(dir, ["rev-parse", "HEAD"]).out, files };
}
