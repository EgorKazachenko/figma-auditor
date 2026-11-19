// LLM triage: labels and a summary on top of deterministic issues, with a fake Claude client.
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasClaudeCredentials, issueBrief, renderTriage, triageIssues, TRIAGE_MODEL, type TriageClient } from "../src/triage/llm.js";
import type { Issue } from "../src/types.js";

const issue = (id: string, severity: Issue["severity"], status: Issue["status"] = "new", extra: Partial<Issue> = {}): Issue => ({
  id,
  key: `k-${id}`,
  check: "C7",
  category: "figma-state-radius",
  gap: "A",
  severity,
  status,
  title: `Toggle radius 6px, Figma 4px (${id})`,
  links: { source: "Toggle.tsx" },
  findingIds: [id],
  seen: { cells: 2, states: ["input"], contexts: ["light", "dark"], viewports: [], surfaces: ["panel"], places: [] },
  seenText: "seen in 1 state · 2 themes",
  expected: { value: "4px", source: "Figma" },
  actual: { value: "6px", source: "Opera" },
  ...extra,
});

function fakeClient(reply: (body: any) => any) {
  const calls: any[] = [];
  const client: TriageClient = { beta: { messages: { create: async (body: any) => (calls.push(body), reply(body)) } } };
  return { client, calls };
}
const answer = (items: unknown[], summary = "Fix the toggle radius first.") => ({
  model: TRIAGE_MODEL,
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify({ summary, items }) }],
});

describe("LLM triage", () => {
  const issues = [issue("a", "high"), issue("b", "low", "open"), issue("c", "medium", "accepted")];

  it("sends measured facts only, at low effort with structured output and the default fallback", async () => {
    const { client, calls } = fakeClient(() => answer([{ id: "a", label: "regression", reason: "New in this MR." }, { id: "b", label: "existing-debt", reason: "Open since last week." }]));
    const t = await triageIssues(issues, { client, context: "NAI-1: rework toggle" });
    const body = calls[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(body).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    const sent = JSON.parse(body.messages[0].content.split("Issues (JSON):\n")[1]);
    expect(sent.map((x: any) => x.id)).toEqual(["a", "b"]); // accepted issues are not sent; high first
    expect(Object.keys(sent[0])).not.toContain("evidence");
    expect(body.messages[0].content).toContain("NAI-1: rework toggle");
    expect(t.verdicts).toEqual({ a: { label: "regression", reason: "New in this MR." }, b: { label: "existing-debt", reason: "Open since last week." } });
    expect(t.summary).toBe("Fix the toggle radius first.");
  });

  it("ignores unknown ids and labels instead of inventing verdicts", async () => {
    const { client } = fakeClient(() => answer([{ id: "zzz", label: "regression", reason: "x" }, { id: "a", label: "urgent", reason: "x" }]));
    const t = await triageIssues(issues, { client });
    expect(t.verdicts).toEqual({});
    expect(t.notes).toContain("Triage: 2 issues came back without a usable label.");
  });

  it("sends issues in batches and merges the answers", async () => {
    const many = Array.from({ length: 5 }, (_, n) => issue(`m${n}`, "medium"));
    const { client, calls } = fakeClient((body) => {
      const sent = JSON.parse(body.messages[0].content.split("Issues (JSON):\n")[1]);
      return answer(sent.map((x: any) => ({ id: x.id, label: "regression", reason: "r" })), `batch of ${sent.length}`);
    });
    const t = await triageIssues(many, { client, batchSize: 2 });
    expect(calls).toHaveLength(3);
    expect(Object.keys(t.verdicts)).toHaveLength(5);
    expect(t.summary).toBe("batch of 2");
  });

  it("caches verdicts per issue and context, so an unchanged issue is not sent again", async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), "da-triage-")), "cache.json");
    const first = fakeClient(() => answer([{ id: "a", label: "figma-side", reason: "Figma has two radii." }, { id: "b", label: "existing-debt", reason: "Old." }]));
    await triageIssues(issues, { client: first.client, cachePath });
    const second = fakeClient(() => {
      throw new Error("must not be called");
    });
    const t = await triageIssues(issues, { client: second.client, cachePath });
    expect(t.cached).toBe(2);
    expect(t.verdicts.a?.label).toBe("figma-side");
    const other = fakeClient(() => answer([]));
    await triageIssues(issues, { client: other.client, cachePath, context: "a different MR" });
    expect(other.calls).toHaveLength(1);
  });

  it("handles a refusal and a non-JSON answer without failing the run", async () => {
    const refused = fakeClient(() => ({ model: TRIAGE_MODEL, stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }));
    expect((await triageIssues(issues, { client: refused.client })).notes[0]).toContain("declined a batch (cyber)");
    const garbled = fakeClient(() => ({ model: TRIAGE_MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "sure!" }] }));
    expect((await triageIssues(issues, { client: garbled.client })).notes[0]).toContain("not valid JSON (stop reason end_turn, 5 characters)");
  });

  it("renders labels, reasons and the summary", async () => {
    const { client } = fakeClient(() => answer([{ id: "a", label: "regression", reason: "New." }]));
    const md = renderTriage(issues, await triageIssues(issues, { client }));
    expect(md).toContain("Fix the toggle radius first.");
    expect(md).toContain("regression 1 · intended 0");
    expect(md).toContain("| regression | high | Toggle radius 6px, Figma 4px (a) | New. |");
  });

  it("knows when credentials are present and keeps briefs small", () => {
    expect(hasClaudeCredentials({})).toBe(false);
    expect(hasClaudeCredentials({ ANTHROPIC_API_KEY: "x" })).toBe(true);
    expect(issueBrief(issues[0]!)).toEqual({ id: "a", check: "C7", gap: "A", severity: "high", status: "new", category: "figma-state-radius", title: "Toggle radius 6px, Figma 4px (a)", expected: "4px", actual: "6px", where: "Toggle.tsx", seen: "seen in 1 state · 2 themes" });
  });
});
