import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SuppressRule } from "./config.js";
import type { Finding, Severity } from "./types.js";

/**
 * Noise control. None of it changes what a finding is (fingerprints stay); it changes how a finding counts:
 * - severity overrides re-rate or drop whole rules,
 * - suppressions hide findings someone explained (inline next to the code, or in the config, optionally until a date),
 * - the accepted list freezes existing debt so only new drift fails a run.
 */

/** Applies `severity` overrides; check/category beats check. Returns the kept findings and how many "off" dropped. */
export function applySeverityOverrides(findings: Finding[], overrides: Record<string, Severity | "off">): { findings: Finding[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  if (!Object.keys(overrides).length) return { findings, dropped };
  const kept: Finding[] = [];
  for (const f of findings) {
    const rule = overrides[`${f.check}/${f.category}`] ?? overrides[f.check];
    if (rule === "off") {
      const key = overrides[`${f.check}/${f.category}`] ? `${f.check}/${f.category}` : f.check;
      dropped[key] = (dropped[key] ?? 0) + 1;
      continue;
    }
    if (rule) f.severity = rule;
    kept.push(f);
  }
  return { findings: kept, dropped };
}

const haystack = (f: Finding) =>
  [f.title, f.links.source, f.component, f.token, f.property, f.context, f.actual?.value, f.expected?.value, f.expected?.token].filter(Boolean).join(" \u0001 ");

export function ruleMatches(f: Finding, r: SuppressRule): boolean {
  if (r.check && r.check !== f.check) return false;
  if (r.category && r.category !== f.category) return false;
  const h = haystack(f);
  return (r.contains ?? []).every((c) => h.includes(c));
}

/**
 * Marks suppressed findings. Inline directives arrive on C1 findings already (see the scanner); config rules apply
 * to any check. Expired rules are not applied and are reported, so a forgotten "until" turns back into findings.
 */
export function applySuppressions(findings: Finding[], rules: SuppressRule[], today: string): { notes: string[] } {
  const notes: string[] = [];
  const active = rules.filter((r) => !r.until || r.until >= today);
  for (const r of rules.filter((x) => x.until && x.until < today))
    notes.push(`Suppression expired on ${r.until} and no longer applies: "${r.reason}" (${[r.check, r.category, ...(r.contains ?? [])].filter(Boolean).join(", ")}).`);
  const byReason = new Map<string, number>();
  for (const f of findings) {
    if (!f.suppressed) {
      const r = active.find((x) => ruleMatches(f, x));
      if (r) f.suppressed = { reason: r.reason, source: "config", until: r.until };
    }
    if (f.suppressed) {
      f.status = "suppressed";
      const k = `${f.suppressed.source}: ${f.suppressed.reason}`;
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
  }
  if (byReason.size)
    notes.push(
      `Suppressed ${[...byReason.values()].reduce((a, b) => a + b, 0)} findings: ${[...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} × ${k}`)
        .join("; ")}.`,
    );
  return { notes };
}

export interface AcceptedEntry {
  title: string;
  check: string;
  reason?: string;
  at: string;
  commit?: string;
}

export interface AcceptedList {
  version: 1;
  entries: Record<string, AcceptedEntry>;
}

export function loadAccepted(path: string): AcceptedList {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as AcceptedList;
    return j?.version === 1 && j.entries ? j : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveAccepted(path: string, list: AcceptedList) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2));
}

/** Adds findings to the accepted list (suppressed ones are already explained and are skipped). */
export function acceptFindings(list: AcceptedList, findings: Finding[], meta: { reason?: string; at: string; commit?: string }): { list: AcceptedList; added: number } {
  const entries = { ...list.entries };
  let added = 0;
  for (const f of findings) {
    if (f.status === "suppressed" || entries[f.fingerprint]) continue;
    entries[f.fingerprint] = { title: f.title, check: f.check, reason: meta.reason, at: meta.at, commit: f.links.commit ?? meta.commit };
    added++;
  }
  return { list: { version: 1, entries }, added };
}

/** Marks accepted findings. Suppression wins: an explained finding stays "suppressed". */
export function applyAccepted(findings: Finding[], list: AcceptedList): number {
  let n = 0;
  for (const f of findings) {
    const e = list.entries[f.fingerprint];
    if (!e || f.status === "suppressed") continue;
    f.status = "accepted";
    f.accepted = { reason: e.reason, at: e.at };
    n++;
  }
  return n;
}

/** Findings that count: not accepted and not suppressed. */
export const isActive = (f: { status?: Finding["status"] }) => f.status !== "accepted" && f.status !== "suppressed";
