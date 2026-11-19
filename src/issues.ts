import { createHash } from "node:crypto";
import type { Finding, Issue, Severity } from "./types.js";

/**
 * The issue view: one row per thing to fix. Findings that share check, category, element, property and value
 * merge, wherever they were seen (states, themes, widths) or how often (several lines of one file).
 * Findings and their fingerprints are not touched; history and C6 keep working on findings.
 */

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function sourceFile(f: Finding): string {
  return (f.links.source ?? "").replace(/:\d+(:\d+)?$/, "");
}

/** What makes two findings the same issue. Cells, lines and per-cell titles are left out on purpose. */
export function issueKey(f: Finding): string {
  const element = f.component ?? (f.check === "C1" ? sourceFile(f) : f.links.source) ?? "";
  const parts = [f.check, f.category, element, f.token ?? "", f.property ?? "", f.actual?.value ?? "", f.expected?.value ?? ""];
  // Findings with neither value nor element (e.g. coverage notes) keep their title apart.
  if (!f.actual && !f.expected && !element) parts.push(f.title);
  // Layout findings carry the other element (what covers or overlaps it) instead of values.
  if (f.related?.length) parts.push([...f.related].sort().join(","));
  return parts.join("|");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function seenText(seen: Issue["seen"]): string {
  if (!seen.cells) return seen.places.length > 1 ? `${seen.places.length} places` : "";
  const parts = [plural(seen.states.length, "state"), plural(seen.contexts.length, "theme")];
  if (seen.viewports.length > 1) parts.push(plural(seen.viewports.length, "width"));
  if (seen.surfaces.length > 1) parts.push(plural(seen.surfaces.length, "surface"));
  return `seen in ${parts.join(" · ")}`;
}

function statusOf(members: Finding[]): NonNullable<Finding["status"]> {
  const active = members.filter((f) => f.status !== "accepted" && f.status !== "suppressed");
  if (active.length) return active.some((f) => (f.status ?? "new") === "new") ? "new" : "open";
  return members.every((f) => f.status === "suppressed") ? "suppressed" : "accepted";
}

export function aggregateIssues(findings: Finding[]): Issue[] {
  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = issueKey(f);
    byKey.set(k, [...(byKey.get(k) ?? []), f]);
  }
  const issues: Issue[] = [];
  for (const [key, members] of byKey) {
    const worst = members.reduce((a, b) => (RANK[b.severity] < RANK[a.severity] ? b : a));
    // Representative: the worst member that has a screenshot box, so the crop shows the problem.
    const rep = members.find((m) => m.severity === worst.severity && m.evidence?.screenshot && m.evidence.box) ?? worst;
    const cells = members.filter((m) => m.cell).map((m) => m.cell!);
    const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort();
    const seen: Issue["seen"] = {
      cells: new Set(cells.map((c) => `${c.surface}/${c.state}/${c.context}/${c.viewport ?? ""}`)).size,
      states: uniq(cells.map((c) => c.state)),
      contexts: uniq([...cells.map((c) => c.context), ...(cells.length ? [] : members.map((m) => m.context))]),
      viewports: uniq(cells.map((c) => c.viewport ?? "default")),
      surfaces: uniq(cells.map((c) => c.surface)),
      places: uniq(members.map((m) => m.links.source)),
    };
    const status = statusOf(members);
    issues.push({
      id: `i-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`,
      key,
      check: rep.check,
      category: rep.category,
      gap: rep.gap,
      severity: worst.severity,
      status,
      title: rep.title,
      component: rep.component,
      token: rep.token,
      property: rep.property,
      expected: rep.expected,
      actual: rep.actual,
      deltaE: rep.deltaE,
      related: rep.related,
      links: { ...rep.links, commit: rep.links.commit ?? members.find((m) => m.links.commit)?.links.commit },
      findingIds: members.map((m) => m.id),
      seen,
      seenText: seenText(seen),
      evidence: rep.evidence ? { screenshot: rep.evidence.screenshot, box: rep.evidence.box, swatches: rep.evidence.swatches, diff: rep.evidence.diff } : undefined,
      suppressed: status === "suppressed" ? members[0]!.suppressed : undefined,
      accepted: status === "accepted" ? members.find((m) => m.accepted)?.accepted : undefined,
    });
  }
  return issues.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.check.localeCompare(b.check) || b.findingIds.length - a.findingIds.length || a.title.localeCompare(b.title));
}

export function issueCounts(issues: Issue[]) {
  const active = issues.filter((i) => i.status !== "accepted" && i.status !== "suppressed");
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const i of active) bySeverity[i.severity]++;
  return { issues: active.length, issuesBySeverity: bySeverity };
}

/** Adds issue ids to finding groups and counts issues, not findings, in their titles. */
export function regroupByIssues(groups: { key: string; title: string; findingIds: string[] }[], issues: Issue[]) {
  const issueOf = new Map<string, string>();
  for (const i of issues) for (const id of i.findingIds) issueOf.set(id, i.id);
  return groups.map((g) => {
    const ids = [...new Set(g.findingIds.map((f) => issueOf.get(f)).filter((x): x is string => Boolean(x)))];
    const base = g.title.replace(/ \(\d+\)$/, "");
    const counts = ids.length > 1 ? ` (${ids.length})` : "";
    const extra = g.findingIds.length > ids.length ? ` · ${g.findingIds.length} findings` : "";
    return { ...g, title: `${base}${counts}${extra}`, issueIds: ids };
  });
}
