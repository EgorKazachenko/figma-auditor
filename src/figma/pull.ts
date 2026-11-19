import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditConfig } from "../config.js";
import { ConfigError } from "../config.js";
import { cachedFigma, figmaClient, type FigmaClient } from "./rest.js";
import { buildVariableGraph, type VariableGraph } from "./variables.js";
import { extractSetsFromNodes } from "./components.js";

/**
 * `design-auditor figma pull`: refreshes the Figma cache (variables of every figma-rest source) and writes
 * the component references listed under reference.componentSources, finding sets by name. Files are only
 * downloaded again when their Figma version changed.
 */
export async function pullFigma(cfg: AuditConfig, opts: { refresh?: boolean; client?: FigmaClient | null; now?: Date } = {}): Promise<string[]> {
  const client = opts.client !== undefined ? opts.client : figmaClient();
  if (!client) throw new ConfigError("figma pull needs FIGMA_TOKEN in the environment.");
  const notes: string[] = [];
  const responses: { fileKey: string; json: any; version?: string; name?: string }[] = [];
  const cacheDir = cfg.reference.sources.find((s) => s.type === "figma-rest")?.cacheDir ?? cfg.reference.figmaCacheDir;

  for (const s of cfg.reference.sources.filter((x) => x.type === "figma-rest")) {
    for (const key of s.files ?? []) {
      const f = await cachedFigma<any>(client, s.cacheDir!, key, "variables", `/v1/files/${key}/variables/local`, { refresh: opts.refresh });
      responses.push({ fileKey: key, json: f.json, version: f.version, name: f.name });
      notes.push(`variables ${f.name ?? key}: ${f.from === "network" ? "downloaded" : "unchanged"} (version ${f.version})`);
    }
  }
  let graph: VariableGraph | null = null;
  try {
    graph = responses.length ? buildVariableGraph(responses) : null;
  } catch {
    graph = null;
  }

  for (const src of cfg.reference.componentSources) {
    const sets = await cachedFigma<any>(client, cacheDir, src.file, "component_sets", `/v1/files/${src.file}/component_sets`, { refresh: opts.refresh });
    const all: { name: string; node_id: string; containing_frame?: { pageName?: string } }[] = sets.json?.meta?.component_sets ?? [];
    const picked = src.sets.map((name) => ({ name, hit: all.find((x) => x.name === name) }));
    for (const p of picked.filter((x) => !x.hit)) notes.push(`component set "${p.name}" not found in ${sets.name ?? src.file}`);
    const ids = picked.filter((p) => p.hit).map((p) => p.hit!.node_id);
    if (!ids.length) continue;
    const nodes = await cachedFigma<any>(client, cacheDir, src.file, `nodes-${ids.join("_")}`, `/v1/files/${src.file}/nodes?ids=${encodeURIComponent(ids.join(","))}`, { refresh: opts.refresh });
    const entries = ids.map((id) => nodes.json?.nodes?.[id]).filter(Boolean);
    const extracted = extractSetsFromNodes(entries, graph, { fileKey: src.file, fileName: nodes.name });
    for (const s of extracted) s.page = picked.find((p) => p.hit?.node_id === s.id)?.hit?.containing_frame?.pageName ?? "";
    mkdirSync(dirname(src.out), { recursive: true });
    writeFileSync(
      src.out,
      JSON.stringify(
        {
          source: { fileKey: src.file, fileName: nodes.name, version: nodes.version, lastModified: nodes.lastModified, pulledWith: "design-auditor figma pull (Figma REST)", pulledAt: (opts.now ?? new Date()).toISOString() },
          sets: extracted,
        },
        null,
        1,
      ),
    );
    notes.push(`components ${nodes.name ?? src.file}: ${extracted.length} sets, ${extracted.reduce((n, s) => n + s.variants.length, 0)} variants → ${src.out} (${nodes.from === "network" ? "downloaded" : "unchanged"})`);
  }
  return notes;
}
