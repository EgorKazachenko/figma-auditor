import { spawnSync } from "node:child_process";

function git(repo: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function headCommit(repo: string): string | undefined {
  return git(repo, ["rev-parse", "HEAD"])?.trim() || undefined;
}

export interface BlameLine {
  commit: string;
  author?: string;
  time?: number;
}

/** Parses `git blame --porcelain` into final line number → commit. Uncommitted lines get commit "0000000". */
export function parseBlamePorcelain(text: string): Map<number, BlameLine> {
  const out = new Map<number, BlameLine>();
  const meta = new Map<string, { author?: string; time?: number }>();
  let current: { commit: string; line: number } | null = null;
  for (const raw of text.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (head) {
      current = { commit: head[1]!, line: Number(head[2]) };
      if (!meta.has(current.commit)) meta.set(current.commit, {});
      continue;
    }
    if (!current) continue;
    const m = meta.get(current.commit)!;
    if (raw.startsWith("author ")) m.author = raw.slice(7);
    else if (raw.startsWith("author-time ")) m.time = Number(raw.slice(12));
    else if (raw.startsWith("\t")) {
      const isUncommitted = /^0{40}$/.test(current.commit);
      out.set(current.line, { commit: isUncommitted ? "0000000" : current.commit, ...m });
      current = null;
    }
  }
  return out;
}

export function blameFile(repo: string, file: string, rev?: string): Map<number, BlameLine> {
  const text = git(repo, ["blame", "--porcelain", ...(rev ? [rev] : []), "--", file]);
  return text ? parseBlamePorcelain(text) : new Map();
}

export function resolveRev(repo: string, rev: string): string | undefined {
  return git(repo, ["rev-parse", "--verify", `${rev}^{commit}`])?.trim() || undefined;
}

/** Files changed between the merge base of base and head, and head (what an MR shows). */
export function changedFiles(repo: string, base: string, head: string): string[] {
  return (git(repo, ["diff", "--name-only", `${base}...${head}`]) ?? "").split("\n").filter(Boolean);
}

export function commitsBetween(repo: string, base: string, head: string): { sha: string; subject: string }[] {
  return (git(repo, ["log", "--format=%H%x09%s", `${base}..${head}`]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
}

/** Writes the tree of a revision (only the listed paths) into dir without touching the repository. */
export function exportTree(repo: string, rev: string, paths: string[], dir: string): void {
  const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", rev, "--", ...paths], { maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${rev} failed: ${archive.stderr?.toString().trim()}`);
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout, maxBuffer: 1024 * 1024 * 1024 });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr?.toString().trim()}`);
}
