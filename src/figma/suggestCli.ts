import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AuditConfig } from "../config.js";
import { ConfigError } from "../config.js";
import type { SnapshotCell } from "../types.js";
import { loadComponentSets, makeVariableResolver } from "../reference/components.js";
import { loadReference } from "../reference/figma.js";
import { suggestMappings, suggestionYaml } from "./suggest.js";

/** Newest snapshot.json under the report folder: suggestions need a run with --runtime. */
export function latestSnapshot(reportDir: string): string | null {
  if (!existsSync(reportDir)) return null;
  const runs = readdirSync(reportDir)
    .map((d) => join(reportDir, d, "snapshot.json"))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return runs[0] ?? null;
}

export async function renderSuggestions(cfg: AuditConfig, snapshot?: string): Promise<string> {
  const file = snapshot ?? latestSnapshot(cfg.report.dir);
  if (!file) throw new ConfigError("No snapshot.json found; run the audit with --runtime first, or pass --snapshot.");
  const cells = JSON.parse(readFileSync(file, "utf8")) as SnapshotCell[];
  const reference = await loadReference(cfg.reference.sources, [], { graphs: [] }, { client: null }).catch(() => []);
  const sets = loadComponentSets(cfg.reference.components);
  const mapped = new Map<string, string>();
  for (const m of cfg.figmaComponents) if (!mapped.has(m.figma)) mapped.set(m.figma, m.element);
  const res = suggestMappings(sets, cells, { contexts: cfg.contexts, resolveVar: makeVariableResolver(reference, cfg.contexts[0]?.figmaMode ?? "light"), mapped });
  const lines = [`# Mapping suggestions`, "", `From ${file} (${cells.length} cells) and ${sets.length} Figma component sets.`, ""];
  lines.push("| Figma set | Mapped now | Best candidates (score) |", "| --- | --- | --- |");
  for (const s of res) lines.push(`| ${s.figma} | ${s.mapped ?? "—"} | ${s.candidates.map((c) => `${c.element} (${c.score.toFixed(2)})`).join(", ") || "—"} |`);
  const unmapped = res.filter((s) => !s.mapped);
  if (unmapped.length) lines.push("", "Proposed for sets without a mapping (check before pasting into figmaComponents):", "", "```yaml", ...unmapped.map(suggestionYaml), "```");
  const disagree = res.filter((s) => s.mapped && s.candidates[0] && s.candidates[0].element.replace(/["'\s]/g, "") !== s.mapped.replace(/["'\s]/g, ""));
  if (disagree.length) lines.push("", "Mapped sets where another element scores higher (worth a look):", ...disagree.map((s) => `- ${s.figma}: mapped ${s.mapped}, best ${s.candidates[0]!.element} (${s.candidates[0]!.score.toFixed(2)}: ${s.candidates[0]!.why.join(", ")})`));
  return lines.join("\n");
}
