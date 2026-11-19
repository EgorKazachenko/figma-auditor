import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Issue } from "../types.js";

/**
 * LLM triage. Deterministic checks create every finding; the model only labels issues and writes a short
 * summary for the people who read the report or the MR comment. It never adds, drops or edits findings.
 * Verdicts are cached by issue key + context, so an unchanged issue is not sent twice.
 */

export const TRIAGE_LABELS = ["regression", "intended", "existing-debt", "figma-side", "likely-false-positive"] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];

export interface TriageVerdict {
  label: TriageLabel;
  reason: string;
}

export interface TriageResult {
  summary: string;
  verdicts: Record<string, TriageVerdict>;
  /** Issues answered from the cache, without a model call. */
  cached: number;
  model?: string;
  notes: string[];
}

export const TRIAGE_MODEL = "claude-opus-5-5";

const SYSTEM = `You triage findings of a design-system drift audit for a product team.
Each issue was produced by a deterministic check that compares Figma (variables, component variants) with the product's code and rendered UI. Never question that the measured values are what they are; judge what they mean.
Label every issue with exactly one of:
- regression: the product drifted from the design system, and the change context does not explain it.
- intended: the change context (merge request, commits, ticket) says this difference was wanted.
- existing-debt: drift that predates this change (status "open", or in code the change does not touch).
- figma-side: the design source is inconsistent (code syntax collisions, Figma layers that disagree with their own variables, gap A findings where Figma is the odd one out).
- likely-false-positive: the check probably misread the situation (visually hidden elements, third-party widgets, illustrations, values that only differ by rounding); say what makes you think so.
Give a reason of at most 25 words that a developer can act on. Then write a summary of at most 120 words: what to fix first and why. Use the issue ids exactly as given.`;

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string", enum: [...TRIAGE_LABELS] },
          reason: { type: "string" },
        },
        required: ["id", "label", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "items"],
  additionalProperties: false,
} as const;

/** What the model sees per issue: measured facts only, no screenshots. */
export function issueBrief(i: Issue) {
  return {
    id: i.id,
    check: i.check,
    gap: i.gap,
    severity: i.severity,
    status: i.status,
    category: i.category,
    title: i.title,
    expected: i.expected?.value,
    actual: i.actual?.value,
    where: i.links.source ?? i.component ?? undefined,
    seen: i.seenText,
  };
}

type Cache = Record<string, TriageVerdict>;
const cacheKey = (i: Issue, contextHash: string) => createHash("sha1").update(`${i.key}|${i.status}|${contextHash}`).digest("hex");

function loadCache(path: string | undefined): Cache {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cache;
  } catch {
    return {};
  }
}

/** The narrow part of the SDK client triage uses, so tests can inject a fake. */
export interface TriageClient {
  beta: { messages: { create(body: any): Promise<any> } };
}

export function hasClaudeCredentials(env = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || env.ANTHROPIC_FEDERATION_RULE_ID);
}

export async function triageIssues(
  issues: Issue[],
  opts: { context?: string; client?: TriageClient; cachePath?: string; maxIssues?: number; model?: string; batchSize?: number } = {},
): Promise<TriageResult> {
  const notes: string[] = [];
  const contextHash = createHash("sha1").update(opts.context ?? "").digest("hex").slice(0, 12);
  const cache = loadCache(opts.cachePath);
  const active = issues.filter((i) => i.status !== "accepted" && i.status !== "suppressed");
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const picked = [...active].sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, opts.maxIssues ?? 120);
  if (picked.length < active.length) notes.push(`Triage: ${active.length - picked.length} lower-severity issues were not sent to the model.`);

  const verdicts: Record<string, TriageVerdict> = {};
  const todo: Issue[] = [];
  for (const i of picked) {
    const hit = cache[cacheKey(i, contextHash)];
    if (hit) verdicts[i.id] = hit;
    else todo.push(i);
  }
  const cached = picked.length - todo.length;
  if (!todo.length) return { summary: "", verdicts, cached, notes };

  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? TRIAGE_MODEL;
  const known = new Map(todo.map((i) => [i.id, i]));
  const summaries: string[] = [];
  let usedModel: string | undefined;
  // Batches keep each answer short enough to come back whole, even through gateways with response limits.
  const batchSize = opts.batchSize ?? 30;
  for (let start = 0; start < todo.length; start += batchSize) {
    const batch = todo.slice(start, start + batchSize);
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // Classification: low effort is enough and keeps the run cheap.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      // On a policy decline, Anthropic's recommended fallback model answers instead of an empty result.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Change context:\n${opts.context?.trim() || "(none: a scheduled run of the whole product)"}\n\nIssues (JSON):\n${JSON.stringify(batch.map(issueBrief))}`,
        },
      ],
    });
    usedModel = response.model ?? usedModel;
    if (response.stop_reason === "refusal") {
      notes.push(`Triage: the model declined a batch (${response.stop_details?.category ?? "no category"}); its issues stay unlabelled.`);
      continue;
    }
    if (response.stop_reason === "max_tokens") notes.push("Triage: an answer was cut off at max_tokens; some issues may be unlabelled.");
    const text = (response.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    let parsed: { summary?: unknown; items?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      notes.push(`Triage: an answer was not valid JSON (stop reason ${response.stop_reason}, ${text.length} characters); its issues stay unlabelled.`);
      continue;
    }
    if (typeof parsed.summary === "string" && parsed.summary) summaries.push(parsed.summary);
    for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
      const { id, label, reason } = item as { id?: string; label?: string; reason?: string };
      const issue = id ? known.get(id) : undefined;
      if (!issue || !TRIAGE_LABELS.includes(label as TriageLabel) || typeof reason !== "string") continue;
      const v = { label: label as TriageLabel, reason: reason.slice(0, 300) };
      verdicts[issue.id] = v;
      cache[cacheKey(issue, contextHash)] = v;
    }
  }
  const missing = todo.filter((i) => !verdicts[i.id]).length;
  if (missing) notes.push(`Triage: ${missing} issues came back without a usable label.`);
  if (opts.cachePath) {
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    writeFileSync(opts.cachePath, JSON.stringify(cache, null, 1));
  }
  // The first batch holds the most severe issues, so its summary leads.
  return { summary: summaries[0] ?? "", verdicts, cached, model: usedModel, notes };
}

export function renderTriage(issues: Issue[], t: TriageResult): string {
  const lines = ["## Triage", ""];
  if (t.summary) lines.push(t.summary, "");
  const counts = new Map<TriageLabel, number>();
  for (const v of Object.values(t.verdicts)) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
  lines.push(TRIAGE_LABELS.map((l) => `${l} ${counts.get(l) ?? 0}`).join(" · "), "");
  lines.push("| Label | Severity | Issue | Why |", "| --- | --- | --- | --- |");
  const order = new Map(TRIAGE_LABELS.map((l, i) => [l, i]));
  const rows = issues.filter((i) => t.verdicts[i.id]).sort((a, b) => order.get(t.verdicts[a.id]!.label)! - order.get(t.verdicts[b.id]!.label)!);
  for (const i of rows) {
    const v = t.verdicts[i.id]!;
    lines.push(`| ${v.label} | ${i.severity} | ${i.title.replace(/\|/g, "\\|")} | ${v.reason.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", `_Labels by ${t.model ?? TRIAGE_MODEL}; ${t.cached} from cache. Findings themselves come from deterministic checks._`);
  return lines.join("\n");
}
