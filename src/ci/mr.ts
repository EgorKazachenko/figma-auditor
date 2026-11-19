import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditConfig } from "../config.js";
import { ConfigError } from "../config.js";
import { runAudit, type CheckId, type RunOptions } from "../pipeline.js";
import type { Finding, Severity } from "../types.js";
import { blameFile, changedFiles, commitsBetween, exportTree, resolveRev } from "../git.js";
import { auditedPaths, retargetConfig } from "../eval/seeds.js";
import { isActive } from "../noise.js";
import { aggregateIssues } from "../issues.js";

/**
 * Merge-request check, the way CI runs it: audit the merge base and the MR head (exported with
 * `git archive`, so the working copy is never touched), and report only what the MR adds or removes.
 * Static and token checks need no browser; runtime checks need a build of the head and run nightly.
 */

export interface MrOptions {
  base: string;
  head?: string;
  checks?: CheckId[];
  /** Injected for tests. */
  run?: Partial<RunOptions>;
}

export interface MrResult {
  base: string;
  head: string;
  changed: string[];
  commits: { sha: string; subject: string }[];
  added: Finding[];
  removed: Finding[];
  /** Same finding in another file: code moved or renamed, not new drift. */
  moved: { from: Finding; to: Finding }[];
  /** New in the MR but suppressed with a reason or listed as accepted debt: shown, never failing. */
  quiet: Finding[];
  comment: string;
}

/** What a finding is, ignoring where it is: used to pair findings that moved between files. */
const what = (f: Finding) => `${f.check}|${f.category}|${f.actual?.value ?? f.token ?? f.title}|${f.context ?? ""}`;

export function pairMoves(added: Finding[], removed: Finding[]) {
  const pool = new Map<string, Finding[]>();
  for (const f of removed) pool.set(what(f), [...(pool.get(what(f)) ?? []), f]);
  const moved: { from: Finding; to: Finding }[] = [];
  const stillAdded: Finding[] = [];
  for (const f of added) {
    const from = pool.get(what(f))?.shift();
    if (from) moved.push({ from, to: f });
    else stillAdded.push(f);
  }
  const used = new Set(moved.map((m) => m.from));
  return { added: stillAdded, removed: removed.filter((f) => !used.has(f)), moved };
}

const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export async function runMrCheck(cfg: AuditConfig, opts: MrOptions): Promise<MrResult> {
  const repo = cfg.target.repo;
  const headRev = opts.head ?? "HEAD";
  const head = resolveRev(repo, headRev);
  const baseTip = resolveRev(repo, opts.base);
  if (!head) throw new ConfigError(`${headRev} is not a commit in ${repo}`);
  if (!baseTip) throw new ConfigError(`${opts.base} is not a commit in ${repo}`);
  // An MR is compared with where it branched off, not with the current tip of the target branch.
  const { spawnSync } = await import("node:child_process");
  const mergeBase = spawnSync("git", ["-C", repo, "merge-base", baseTip, head], { encoding: "utf8" }).stdout.trim() || baseTip;

  const checks = (opts.checks ?? ["c1", "c2"]).filter((c) => c === "c1" || c === "c2");
  const paths = auditedPaths(cfg);
  const dirs: string[] = [];
  const audit = async (rev: string) => {
    const dir = mkdtempSync(join(tmpdir(), "da-mr-"));
    dirs.push(dir);
    exportTree(repo, rev, paths, dir);
    const { report } = await runAudit(retargetConfig(cfg, dir), { checks, history: false, write: false, ...opts.run });
    return report.findings;
  };

  try {
    const before = await audit(mergeBase);
    const after = await audit(head);
    const was = new Set(before.map((f) => f.fingerprint));
    const now = new Set(after.map((f) => f.fingerprint));
    const paired = pairMoves(
      after.filter((f) => !was.has(f.fingerprint)),
      before.filter((f) => !now.has(f.fingerprint)),
    );
    const { removed, moved } = paired;
    const added = paired.added.filter(isActive);
    const quiet = paired.added.filter((f) => !isActive(f));

    // Which commit of the MR wrote each new static finding.
    const blameCache = new Map<string, ReturnType<typeof blameFile>>();
    for (const f of added) {
      if (f.check !== "C1" || !f.links.source) continue;
      const [file, line] = f.links.source.split(":");
      if (!file || !line) continue;
      if (!blameCache.has(file)) blameCache.set(file, blameFile(repo, file, head));
      const b = blameCache.get(file)!.get(Number(line));
      if (b) f.links.commit = b.commit;
    }

    const commits = commitsBetween(repo, mergeBase, head);
    const changed = changedFiles(repo, mergeBase, head);
    const result = { base: mergeBase, head, changed, commits, added, removed, moved, quiet, comment: "" };
    result.comment = renderMrComment(result, checks);
    return result;
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

export function worstNew(added: Finding[]): Severity | undefined {
  return added.reduce<Severity | undefined>((w, f) => (!w || rank[f.severity] > rank[w] ? f.severity : w), undefined);
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMrComment(r: Omit<MrResult, "comment">, checks: string[]): string {
  const sev = (list: Finding[]) => (["high", "medium", "low"] as const).map((s) => `${list.filter((f) => f.severity === s).length} ${s}`).join(", ");
  const subject = new Map(r.commits.map((c) => [c.sha, c.subject]));
  const lines = [
    `### Design drift check`,
    "",
    `\`${r.head.slice(0, 9)}\` against merge base \`${r.base.slice(0, 9)}\` · ${r.commits.length} commits · ${r.changed.length} files changed · checks ${checks.map((c) => c.toUpperCase()).join(", ")}`,
    "",
  ];
  const quiet = r.quiet ?? [];
  const quietNote = quiet.length ? ` · ${quiet.length} suppressed or accepted` : "";
  if (!r.added.length && !r.removed.length) {
    lines.push(`No new design-system drift in this MR.${r.moved.length ? ` ${r.moved.length} existing findings moved with their code.` : ""}${quiet.length ? ` ${quiet.length} new findings are suppressed or accepted.` : ""}`);
    return lines.join("\n");
  }
  // One row per issue: the same value repeated in a file or on many screens is one thing to fix.
  const issues = aggregateIssues(r.added);
  const findingsNote = issues.length !== r.added.length ? ` from ${r.added.length} findings` : "";
  lines.push(
    `**${issues.length} new** (${sev(r.added)})${findingsNote} · **${r.removed.length} fixed**${r.moved.length ? ` · ${r.moved.length} moved with their code` : ""}${quietNote}`,
    "",
  );
  if (issues.length) {
    lines.push("| Severity | Check | Issue | Where | Commit |", "| --- | --- | --- | --- | --- |");
    const byId = new Map(r.added.map((f) => [f.id, f]));
    for (const i of issues.slice(0, 40)) {
      const members = i.findingIds.map((id) => byId.get(id)!).filter(Boolean);
      const first = members[0]!;
      const where = (i.links.source ?? first.context ?? "") + (members.length > 1 ? ` (+${members.length - 1} more)` : "") + (i.seenText && i.seen.cells ? ` · ${i.seenText}` : "");
      const c = i.links.commit;
      const commit = c ? `\`${c.slice(0, 9)}\` ${esc((subject.get(c) ?? "").slice(0, 50))}` : "";
      const figma = i.links.figma ? ` · [Figma](${i.links.figma})` : "";
      lines.push(`| ${i.severity} | ${i.check} | ${esc(i.title)}${figma} | ${esc(where)} | ${commit} |`);
    }
    if (issues.length > 40) lines.push("", `…and ${issues.length - 40} more in the full report.`);
  }
  if (r.removed.length) {
    lines.push("", `<details><summary>Fixed by this MR (${r.removed.length})</summary>`, "");
    for (const f of r.removed.slice(0, 40)) lines.push(`- ${f.check} ${esc(f.title)} (${esc(f.links.source ?? f.context ?? "")})`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}
