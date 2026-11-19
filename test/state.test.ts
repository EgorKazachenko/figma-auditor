// Machine memory on a git branch: push after a run, pull before the next one, on any machine.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseConfig } from "../src/config.js";
import { statePull, statePush, stateItems } from "../src/state/sync.js";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

function machine(remote: string) {
  const dir = mkdtempSync(join(tmpdir(), "da-state-"));
  const cfg = parseConfig(`project: neon\ntarget: { repo: ., themeEntry: t.css }\ncontexts: [{ name: light }]\nstate: { remote: "${remote}" }\n`, join(dir, "audit.yaml"));
  return { dir, cfg };
}

describe("state on a git branch", () => {
  const remote = join(mkdtempSync(join(tmpdir(), "da-remote-")), "state.git");
  spawnSync("git", ["init", "--bare", "--quiet", remote]);

  it("starts fresh when the branch does not exist", () => {
    const { cfg } = machine(remote);
    expect(statePull(cfg, { remote })).toEqual({ found: false, restored: [] });
  });

  it("pushes history and baselines into a per-product folder, creating the branch", () => {
    const { cfg } = machine(remote);
    mkdirSync(join(cfg.baseline.dir), { recursive: true });
    writeFileSync(cfg.history.path, JSON.stringify({ version: 1, runs: [{ id: "r1" }] }));
    writeFileSync(join(cfg.baseline.dir, "sidepanel__input__light.json"), "{}");
    const r = statePush(cfg, { remote, message: "nightly 1" });
    expect(r).toMatchObject({ pushed: true, files: 2 });
    expect(git(remote, "ls-tree", "-r", "--name-only", "design-audit/state").split("\n")).toEqual(["neon/baselines/sidepanel__input__light.json", "neon/history.json"]);
    expect(git(remote, "log", "-1", "--format=%s %an", "design-audit/state")).toBe("nightly 1 design-auditor");
    expect(statePush(cfg, { remote }).pushed).toBe(false); // nothing changed
  });

  it("restores the memory on another machine and keeps it in sync", () => {
    const other = machine(remote);
    const r = statePull(other.cfg, { remote });
    expect(r.found).toBe(true);
    expect(r.restored).toEqual(["neon/history.json", "neon/baselines"]);
    expect(JSON.parse(readFileSync(other.cfg.history.path, "utf8")).runs[0].id).toBe("r1");
    expect(existsSync(join(other.cfg.baseline.dir, "sidepanel__input__light.json"))).toBe(true);
    // the second machine runs, pushes; the first pulls the update (baselines replaced, not merged)
    writeFileSync(other.cfg.history.path, JSON.stringify({ version: 1, runs: [{ id: "r1" }, { id: "r2" }] }));
    writeFileSync(join(other.cfg.baseline.dir, "sidepanel__menu__light.json"), "{}");
    expect(statePush(other.cfg, { remote }).pushed).toBe(true);
    const first = machine(remote);
    statePull(first.cfg, { remote });
    statePull(first.cfg, { remote }); // a second pull fetches into the existing clone
    expect(JSON.parse(readFileSync(first.cfg.history.path, "utf8")).runs).toHaveLength(2);
  });

  it("maps local paths to the branch layout and reads the config", () => {
    const { cfg } = machine(remote);
    expect(cfg.state).toEqual({ remote, branch: "design-audit/state", folder: undefined });
    expect(stateItems(cfg).map((i) => i.repo)).toEqual(["neon/history.json", "neon/baselines"]);
    expect(stateItems(cfg, "other").map((i) => i.repo)[0]).toBe("other/history.json");
  });

  it("explains an unreachable remote", () => {
    const { cfg } = machine("/nonexistent/repo.git");
    expect(() => statePull(cfg, { remote: "/nonexistent/repo.git" })).toThrow(/cannot clone/);
  });
});
