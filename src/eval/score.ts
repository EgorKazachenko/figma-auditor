import type { Finding } from "../types.js";
import type { Seed, SeedExpectation } from "./seeds.js";

export interface SeedResult {
  id: string;
  check?: string;
  negative: boolean;
  /** Positive seed: found by a new finding. Negative control: no stray finding near it. */
  ok: boolean;
  findings: { id: string; title: string }[];
}

export interface EvalScore {
  seeds: SeedResult[];
  /** New findings that no seed explains: false alarms. */
  unexplained: { id: string; check: string; title: string }[];
  byCheck: Record<string, { seeds: number; found: number; recall: number; newFindings: number; explained: number; precision: number }>;
  recall: number;
  precision: number;
  negativesClean: number;
  negatives: number;
}

function haystack(f: Finding): string {
  return [f.title, f.links.source, f.token, f.component, f.context, f.property, f.actual?.value, f.expected?.value].filter(Boolean).join(" \u0001 ");
}

export function matches(f: Finding, e: SeedExpectation): boolean {
  if (f.check !== e.check) return false;
  if (e.category) {
    const re = /^\/(.*)\/([a-z]*)$/.exec(e.category);
    if (re ? !new RegExp(re[1]!, re[2]).test(f.category) : f.category !== e.category) return false;
  }
  const h = haystack(f);
  return (e.contains ?? []).every((c) => h.includes(c));
}

/**
 * Scores a seeded run against the clean run of the same workspace. A finding is new when its fingerprint
 * is not in the clean run. Each new finding is explained by every positive seed it matches; new findings
 * nobody explains count against precision, and against a negative control when they mention its `near` strings.
 */
export function scoreEval(seeds: Seed[], clean: Finding[], seeded: Finding[]): EvalScore {
  const before = new Set(clean.map((f) => f.fingerprint));
  const fresh = seeded.filter((f) => !before.has(f.fingerprint));
  const explained = new Set<string>();

  const results: SeedResult[] = seeds.flatMap((s): SeedResult[] => {
    if (s.expect === "none") return [{ id: s.id, negative: true, ok: true, findings: [] }];
    const list = Array.isArray(s.expect) ? s.expect : [s.expect];
    return list.map((e, i) => {
      const hits = fresh.filter((f) => matches(f, e));
      hits.forEach((f) => explained.add(f.id));
      return { id: list.length > 1 ? `${s.id} · ${e.check}` : s.id, check: e.check, negative: false, ok: hits.length > 0, findings: hits.map((f) => ({ id: f.id, title: f.title })) };
    });
  });

  const unexplained = fresh.filter((f) => !explained.has(f.id));
  for (const r of results) {
    if (!r.negative) continue;
    const seed = seeds.find((s) => s.id === r.id)!; // negative controls keep their plain id
    const near = seed.near ?? [];
    const stray = near.length ? unexplained.filter((f) => near.some((n) => haystack(f).includes(n))) : [];
    r.findings = stray.map((f) => ({ id: f.id, title: f.title }));
    r.ok = stray.length === 0;
  }

  const byCheck: EvalScore["byCheck"] = {};
  const bucket = (c: string) => (byCheck[c] ??= { seeds: 0, found: 0, recall: 0, newFindings: 0, explained: 0, precision: 0 });
  for (const r of results) {
    if (r.negative || !r.check) continue;
    const b = bucket(r.check);
    b.seeds++;
    if (r.ok) b.found++;
  }
  for (const f of fresh) {
    const b = bucket(f.check);
    b.newFindings++;
    if (explained.has(f.id)) b.explained++;
  }
  for (const b of Object.values(byCheck)) {
    b.recall = b.seeds ? b.found / b.seeds : 1;
    b.precision = b.newFindings ? b.explained / b.newFindings : 1;
  }

  const positives = results.filter((r) => !r.negative);
  const negatives = results.filter((r) => r.negative);
  return {
    seeds: results,
    unexplained: unexplained.map((f) => ({ id: f.id, check: f.check, title: f.title })),
    byCheck,
    recall: positives.length ? positives.filter((r) => r.ok).length / positives.length : 1,
    precision: fresh.length ? explained.size / fresh.length : 1,
    negativesClean: negatives.filter((r) => r.ok).length,
    negatives: negatives.length,
  };
}

export function renderScore(s: EvalScore): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `Recall ${pct(s.recall)} · precision ${pct(s.precision)} · negative controls clean ${s.negativesClean}/${s.negatives}`,
    "",
    "| Check | Seeds found | Recall | New findings explained | Precision |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(s.byCheck)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([c, b]) => `| ${c} | ${b.found}/${b.seeds} | ${pct(b.recall)} | ${b.explained}/${b.newFindings} | ${pct(b.precision)} |`),
    "",
    "| Seed | Result | Findings |",
    "| --- | --- | --- |",
    ...s.seeds.map((r) => `| ${r.id}${r.negative ? " (control)" : ""} | ${r.ok ? (r.negative ? "clean" : "found") : r.negative ? "**false alarm**" : "**missed**"} | ${r.findings.map((f) => f.title.replace(/\|/g, "\\|")).join("<br>") || "—"} |`),
  ];
  if (s.unexplained.length) lines.push("", "Unexplained new findings (false alarms):", ...s.unexplained.map((f) => `- ${f.check} ${f.title}`));
  return lines.join("\n");
}
