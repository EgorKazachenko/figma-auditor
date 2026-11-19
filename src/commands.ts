import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import type { CheckId } from "./pipeline.js";
import type { Severity } from "./types.js";

/** `eval` and `mr` subcommands. They have their own options, so they are parsed here, not by `run`. */

export const SUBCOMMAND_HELP = `
  design-auditor accept --config <file> [--reason "<why>"] [--from <findings.json>] [--checks C1,C3]
      Accept the findings of the latest report as existing debt (accepted.path, default
      .design-auditor/accepted.json): they stay visible but never count as new or fail a run or an MR.

  design-auditor eval --spec <seeds.yaml> [--out <file.md>]
      Plant the seeded defects into a throw-away copy of the product, audit clean and seeded,
      print recall and precision per check. The product repository is not modified.

  design-auditor figma pull --config <file> [--refresh]
      Download Figma variables (all figma-rest files) and the component sets listed under
      reference.componentSources (found by name). Unchanged files come from the cache. Needs FIGMA_TOKEN.

  design-auditor figma suggest --config <file> [--snapshot <snapshot.json>] [--out <file.md>]
      Propose figmaComponents mappings from a captured run: for each Figma component set, the
      elements that look like it and the state that shows each variant, as YAML to confirm.

  design-auditor compare --a <run dir|snapshot.json> --b <run dir|snapshot.json> [--a-label X] [--b-label Y] [--out <file.md>]
      Parity of two captures (React vs Svelte build, Neon vs Opera One, before vs after): styles,
      geometry and text per element, matched by test id and order; the same difference across cells once.

  design-auditor triage --config <file> [--run <run dir>] [--context <file>] [--out <file.md>]
      Ask Claude to label the run's issues (regression, intended, existing-debt, figma-side,
      likely-false-positive) with a reason and a summary. Needs Claude API credentials
      (ANTHROPIC_API_KEY or an \`ant auth login\` profile); verdicts are cached per issue.

  design-auditor state pull|push --config <file> [--remote <git url|path>] [--branch <name>] [--message <text>]
      Keep machine memory (run history, C6 baselines) on a git branch (default design-audit/state),
      one folder per product. pull restores it before a run, push commits and pushes it after one.

  design-auditor mr --config <file> --base <ref> [--head <ref>] [--checks c1,c2] [--comment <file.md>] [--fail-on <level>]
      Merge-request check as CI runs it: audits the merge base and the head (git archive, the
      working copy is untouched) and reports only what the MR adds, with the commit that wrote it.`;

function options(argv: string[], allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--") || !allowed.includes(a.slice(2))) throw new ConfigError(`Unknown option: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ConfigError(`${a} needs a value`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const rank = { high: 3, medium: 2, low: 1 } as const;

export async function runSubcommand(cmd: string, argv: string[]): Promise<number | null> {
  if (cmd === "accept") {
    const o = options(argv, ["config", "reason", "from", "checks"]);
    if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
    const cfg = loadConfig(o.config);
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const from = o.from ?? join(cfg.report.dir, "latest", "findings.json");
    if (!existsSync(from)) throw new ConfigError(`${from} does not exist: run an audit first, or pass --from <findings.json>.`);
    const report = JSON.parse(readFileSync(from, "utf8")) as import("./types.js").Report;
    const checks = o.checks ? o.checks.split(",").map((c) => c.trim().toUpperCase()) : undefined;
    const chosen = report.findings.filter((f) => !checks || checks.includes(f.check));
    const { acceptFindings, loadAccepted, saveAccepted } = await import("./noise.js");
    const { list, added } = acceptFindings(loadAccepted(cfg.accepted.path), chosen, { reason: o.reason, at: new Date().toISOString(), commit: report.meta.commit });
    saveAccepted(cfg.accepted.path, list);
    console.log(`Accepted ${added} findings as existing debt (${Object.keys(list.entries).length} in total) → ${cfg.accepted.path}`);
    return 0;
  }
  if (cmd === "eval") {
    const o = options(argv, ["spec", "out"]);
    if (!o.spec) throw new ConfigError("Pass the seed spec with --spec <file>.");
    const { loadEvalSpec } = await import("./eval/seeds.js");
    const { runEval } = await import("./eval/run.js");
    const { renderScore } = await import("./eval/score.js");
    const r = await runEval(loadEvalSpec(o.spec));
    const md = renderScore(r.score);
    console.log(md);
    for (const n of r.notes) console.log(`note: ${n}`);
    if (o.out) write(o.out, `${md}\n`);
    return 0;
  }
  if (cmd === "figma") {
    if (argv[0] === "suggest") {
      const o = options(argv.slice(1), ["config", "snapshot", "out"]);
      if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
      const { renderSuggestions } = await import("./figma/suggestCli.js");
      const md = await renderSuggestions(loadConfig(o.config), o.snapshot);
      console.log(md);
      if (o.out) write(o.out, `${md}\n`);
      return 0;
    }
    if (argv[0] !== "pull") throw new ConfigError('Use "design-auditor figma pull" or "design-auditor figma suggest".');
    const rest = argv.slice(1);
    const refresh = rest.includes("--refresh");
    const o = options(rest.filter((a) => a !== "--refresh"), ["config"]);
    if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
    const { pullFigma } = await import("./figma/pull.js");
    for (const n of await pullFigma(loadConfig(o.config), { refresh })) console.log(n);
    return 0;
  }
  if (cmd === "compare") {
    const o = options(argv, ["a", "b", "a-label", "b-label", "out", "config"]);
    if (!o.a || !o.b) throw new ConfigError("Pass both captures: --a <run dir|snapshot.json> --b <run dir|snapshot.json>.");
    const { compareCaptures, loadCapture, renderCompare } = await import("./compare/builds.js");
    const cfg = o.config ? loadConfig(o.config) : undefined;
    const r = compareCaptures(loadCapture(o.a), loadCapture(o.b), {
      labels: [o["a-label"] ?? o.a, o["b-label"] ?? o.b],
      colorDeltaE: cfg?.thresholds.colorDeltaE,
      px: cfg?.thresholds.px,
      backdrop: cfg ? (name) => cfg.contexts.find((c) => c.name === name)?.backdrop ?? "#ffffff" : undefined,
    });
    const md = renderCompare(r);
    console.log(md);
    if (o.out) write(o.out, `${md}\n`);
    return r.grouped.length || r.cells.some((c) => c.layout.length || c.text.length) ? 1 : 0;
  }
  if (cmd === "triage") {
    const o = options(argv, ["config", "run", "context", "out"]);
    if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
    const cfg = loadConfig(o.config);
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const file = join(o.run ?? join(cfg.report.dir, "latest"), "findings.json");
    if (!existsSync(file)) throw new ConfigError(`${file} not found: run the audit first or pass --run <run dir>.`);
    const report = JSON.parse(readFileSync(file, "utf8"));
    const { aggregateIssues } = await import("./issues.js");
    const issues = report.issues ?? aggregateIssues(report.findings ?? []);
    const { triageIssues, renderTriage, hasClaudeCredentials } = await import("./triage/llm.js");
    if (!hasClaudeCredentials()) console.error("note: no ANTHROPIC_API_KEY in the environment; the SDK will try an `ant auth login` profile.");
    const t = await triageIssues(issues, {
      context: o.context ? readFileSync(o.context, "utf8") : undefined,
      cachePath: join(dirname(cfg.history.path), "triage-cache.json"),
    });
    const md = renderTriage(issues, t);
    console.log(md);
    for (const n of t.notes) console.error(`note: ${n}`);
    if (o.out) write(o.out, `${md}\n`);
    return 0;
  }
  if (cmd === "state") {
    const action = argv[0];
    if (action !== "pull" && action !== "push") throw new ConfigError('Use "design-auditor state pull" or "design-auditor state push".');
    const o = options(argv.slice(1), ["config", "remote", "branch", "message"]);
    if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
    const cfg = loadConfig(o.config);
    const remote = o.remote ?? cfg.state.remote;
    if (!remote || /\$\{/.test(remote)) throw new ConfigError("Pass --remote or set state.remote in the config (a git URL or path).");
    const { statePull, statePush } = await import("./state/sync.js");
    const opts = { remote, branch: o.branch ?? cfg.state.branch, folder: cfg.state.folder, message: o.message };
    if (action === "pull") {
      const r = statePull(cfg, opts);
      console.log(r.found ? `state: restored ${r.restored.join(", ") || "nothing"} from ${opts.branch} (${r.commit?.slice(0, 9)})` : `state: branch ${opts.branch} does not exist yet; starting fresh`);
    } else {
      const r = statePush(cfg, opts);
      console.log(r.pushed ? `state: pushed ${r.files} changed files to ${opts.branch} (${r.commit?.slice(0, 9)})` : "state: nothing changed, nothing pushed");
    }
    return 0;
  }
  if (cmd === "mr") {
    const o = options(argv, ["config", "base", "head", "checks", "comment", "fail-on"]);
    if (!o.config) throw new ConfigError("Pass the config file with --config <file>.");
    if (!o.base) throw new ConfigError("Pass the target branch or commit with --base <ref>.");
    const failOn = o["fail-on"] as Severity | undefined;
    if (failOn && !(failOn in rank)) throw new ConfigError("--fail-on must be high, medium or low");
    const { runMrCheck } = await import("./ci/mr.js");
    const r = await runMrCheck(loadConfig(o.config), {
      base: o.base,
      head: o.head,
      checks: o.checks ? (o.checks.split(",").map((s) => s.trim().toLowerCase()) as CheckId[]) : undefined,
    });
    console.log(r.comment);
    if (o.comment) write(o.comment, `${r.comment}\n`);
    if (failOn && r.added.some((f) => rank[f.severity] >= rank[failOn])) return 1;
    return 0;
  }
  return null;
}
