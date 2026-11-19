import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "./types.js";
import { cellName } from "./findings.js";

export interface HistoryRun {
  id: string;
  at: string;
  commit?: string;
  /** Checks that ran; a finding can only be "fixed" by a later run that executed its check. */
  checks: string[];
  fingerprints: string[];
}

export interface History {
  version: 1;
  runs: HistoryRun[];
  firstSeen: Record<string, { commit?: string; at: string }>;
  /** cell = "surface/state/context" for findings seen in a runtime capture. */
  info: Record<string, { title: string; check: string; cell?: string }>;
}

export const emptyHistory = (): History => ({ version: 1, runs: [], firstSeen: {}, info: {} });

export function loadHistory(path: string): History {
  if (!existsSync(path)) return emptyHistory();
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as History;
    return h.version === 1 && h.info ? h : emptyHistory();
  } catch {
    return emptyHistory();
  }
}

export function saveHistory(path: string, h: History, keepRuns = 50) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...h, runs: h.runs.slice(-keepRuns) }, null, 2));
}

export { cellName as cellId } from "./findings.js";

/**
 * - new: the fingerprint was never seen before; open: seen in an earlier run.
 * - firstSeen keeps the commit of the first sighting (or the blame commit for static hits).
 * - fixed: present in the latest earlier run that executed the same check, absent now. A finding tied to
 *   a captured cell is fixed only if this run captured that cell again (a screen that was not opened
 *   proves nothing).
 * Mutates the findings' status, firstSeen and links.commit; returns the next history and the fixed list.
 */
export function applyHistory(
  history: History,
  findings: Finding[],
  run: { id: string; at: string; commit?: string; checks: string[]; cells?: string[] },
): { history: History; fixed: { fingerprint: string; title: string }[] } {
  const firstSeen = { ...history.firstSeen };
  const info = { ...history.info };
  const current = new Set(findings.map((f) => f.fingerprint));

  for (const f of findings) {
    const known = firstSeen[f.fingerprint];
    f.status = known ? "open" : "new";
    if (!known) firstSeen[f.fingerprint] = { commit: f.links.commit ?? run.commit, at: run.at };
    f.firstSeen = firstSeen[f.fingerprint];
    if (!f.links.commit && f.firstSeen?.commit) f.links.commit = f.firstSeen.commit;
    info[f.fingerprint] = { title: f.title, check: f.check, ...(f.cell ? { cell: cellName(f.cell) } : {}) };
  }

  const fixed: { fingerprint: string; title: string }[] = [];
  for (const check of run.checks) {
    const prev = [...history.runs].reverse().find((r) => r.checks.includes(check));
    if (!prev) continue;
    for (const fp of prev.fingerprints) {
      if (current.has(fp) || info[fp]?.check !== check) continue;
      const cell = info[fp]?.cell;
      if (cell && run.cells && !run.cells.includes(cell)) continue;
      fixed.push({ fingerprint: fp, title: info[fp]?.title ?? fp });
    }
  }

  return {
    history: { version: 1, runs: [...history.runs, { id: run.id, at: run.at, commit: run.commit, checks: run.checks, fingerprints: [...current] }], firstSeen, info },
    fixed,
  };
}
