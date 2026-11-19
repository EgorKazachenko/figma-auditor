import type { Finding, Report } from "./types.js";

/**
 * Deterministic grouping: findings that share one cause become one group, so a reviewer reads
 * "--color-level-5 differs in 2 contexts" once instead of two separate items.
 * An LLM triage step can later relabel groups (intended vs regression); it never creates or drops findings.
 */
export function groupFindings(findings: Finding[]): Report["groups"] {
  const groups = new Map<string, { title: string; ids: string[] }>();
  const keyOf = (f: Finding): [string, string] => {
    switch (f.check) {
      case "C1": {
        const file = (f.links.source ?? "").split(":")[0] ?? "";
        return [`C1|${f.category}|${file}`, `${f.title} · ${file}`];
      }
      case "C2":
        return [`C2|${f.category}|${f.token}`, `${f.token}: ${f.category.replace(/-/g, " ")}`];
      case "C3": {
        const target = f.expected?.token ?? f.expected?.value ?? "";
        return [`C3|${f.category}|${f.property}|${f.actual?.value}|${target}`, `${f.property} ${f.actual?.value} (nearest ${target})`];
      }
      case "C4":
      case "C5":
      case "C6":
        return [`${f.check}|${f.category}|${f.component ?? f.links.source}`, f.title];
      case "C9":
        // One group per element, kind of problem and theme.
        return [`C9|${f.category}|${f.component}|${f.context}`, `${f.component}: ${f.category.replace(/-/g, " ")} in ${f.context}`];
      case "C8":
        // One group per element anchor and theme: a low-contrast label repeated in a list is one fix.
        return [`C8|${f.component}|${f.context}`, `${f.component}: text contrast in ${f.context}`];
      case "C7":
        // One group per Figma variant and property, across themes.
        return [`C7|${f.category}|${f.component}|${f.property ?? ""}`, `${f.component}: ${(f.property ?? f.category).replace(/-/g, " ")}`];
    }
  };
  for (const f of findings) {
    const [key, title] = keyOf(f);
    const g = groups.get(key) ?? { title, ids: [] };
    g.ids.push(f.id);
    groups.set(key, g);
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const severityOf = new Map(findings.map((f) => [f.id, rank[f.severity]]));
  const worst = (ids: string[]) => Math.min(...ids.map((id) => severityOf.get(id) ?? 2));
  return [...groups.entries()]
    .map(([key, g]) => ({ key, title: g.ids.length > 1 ? `${g.title} (${g.ids.length})` : g.title, findingIds: g.ids }))
    .sort((a, b) => worst(a.findingIds) - worst(b.findingIds) || b.findingIds.length - a.findingIds.length || a.key.localeCompare(b.key));
}
