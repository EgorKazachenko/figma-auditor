import { ConfigError, loadConfig } from "../config.js";
import { runAudit, type RunOptions } from "../pipeline.js";
import type { Finding } from "../types.js";
import { applySourceSeeds, makeWorkspace, type EvalSpec } from "./seeds.js";
import { scoreEval, type EvalScore } from "./score.js";

export interface EvalRun {
  score: EvalScore;
  clean: Finding[];
  seeded: Finding[];
  notes: string[];
}

/**
 * Runs the audit twice on a throw-away copy of the product: clean, then with every seed applied.
 * Source seeds edit the copy; css seeds are injected into each captured state by the runtime driver.
 * C6 is left out: it compares with a stored baseline, which a throw-away copy does not have.
 */
export async function runEval(spec: EvalSpec, inject: Partial<RunOptions> = {}): Promise<EvalRun> {
  const cfg = loadConfig(spec.configPath);
  const checks = spec.checks.filter((c) => c !== "c6");
  const css = spec.seeds.filter((s) => s.kind === "css");
  if (css.length && !spec.runtime) throw new ConfigError(`css seeds (${css.map((s) => s.id).join(", ")}) need runtime: true in the eval spec`);
  const ws = makeWorkspace(cfg, spec.copy);
  const opts: RunOptions = { checks, runtime: spec.runtime, history: false, write: false, ...inject };
  try {
    const clean = await runAudit(ws.cfg, opts);
    applySourceSeeds(ws.dir, spec.seeds);
    if (css.length) {
      const injected = css.map((s) => `/* seed ${s.id} */\n${s.css}`).join("\n");
      ws.cfg.runtime.injectCss = injected;
    }
    const seeded = await runAudit(ws.cfg, opts);
    return {
      score: scoreEval(spec.seeds, clean.report.findings, seeded.report.findings),
      clean: clean.report.findings,
      seeded: seeded.report.findings,
      notes: [...new Set([...clean.report.notes, ...seeded.report.notes])].filter((n) => /warning|skipped/i.test(n)),
    };
  } finally {
    ws.cleanup();
  }
}
