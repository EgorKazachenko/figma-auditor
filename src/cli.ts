import { loadConfig, ConfigError } from "./config.js";
import { runSubcommand, SUBCOMMAND_HELP } from "./commands.js";
import { ALL_CHECKS, runAudit, type CheckId } from "./pipeline.js";
import type { Severity } from "./types.js";

const HELP = `design-auditor — finds where a product drifts from its Design System

Usage:
  design-auditor run --config <file> [options]

Options:
  --checks c1,…,c9    Checks to run (default: c1,c2; "all" for every check). c3 off-token values,
                      c4 component specs, c5 layout integrity, c6 layout regression,
                      c7 Figma component states, c8 text contrast and c9 accessibility
                      (focus, target size, non-text contrast) need --runtime
  --update-baseline   Store this run's element boxes and screenshots as the c6 baseline
  --runtime           Capture the product with runtime.driver from the config (launch or harness)
  --blame             Attach git blame commits to static findings
  --no-history        Do not read or update the local history file
  --fail-on <level>   Exit with code 1 when a new finding has this severity or higher (high | medium | low)
  --collect <css>     Override runtime.collectSelector, e.g. "body *" to check every visible element
  --states a,b         Capture only these states (a quick run or a demo)
  --viewports a,b      Capture only these runtime.viewports
  --headed             Show the browser window while capturing
  --quiet              Print only the summary, not the progress of the run
  -h, --help          Show this help

Reports are written to <report.dir>/<run id>/ and mirrored to <report.dir>/latest/.

Other commands:${SUBCOMMAND_HELP}`;

function parseArgs(argv: string[]) {
  const args = { cmd: argv[0], config: "", checks: ["c1", "c2"] as CheckId[], runtime: false, blame: false, history: true, failOn: undefined as Severity | undefined, collect: undefined as string | undefined, updateBaseline: false, help: false, quiet: false, states: undefined as string[] | undefined, viewports: undefined as string[] | undefined, headed: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i] ?? "";
    else if (a === "--checks") {
      const list = (argv[++i] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      args.checks = (list.includes("all") ? ALL_CHECKS : list) as CheckId[];
    }
    else if (a === "--runtime") args.runtime = true;
    else if (a === "--blame") args.blame = true;
    else if (a === "--no-history") args.history = false;
    else if (a === "--fail-on") args.failOn = argv[++i] as Severity;
    else if (a === "--collect") args.collect = argv[++i];
    else if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--states") args.states = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--viewports") args.viewports = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--headed") args.headed = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new ConfigError(`Unknown option: ${a}`);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  const sub = await runSubcommand(argv[0]!, argv.slice(1));
  if (sub !== null) return sub;
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.cmd !== "run") throw new ConfigError(`Unknown command: ${args.cmd}. Try "design-auditor run --config <file>", "eval" or "mr".`);
  if (!args.config) throw new ConfigError("Pass the config file with --config <file>.");
  const bad = args.checks.filter((c) => !ALL_CHECKS.includes(c));
  if (bad.length) throw new ConfigError(`Unknown checks: ${bad.join(", ")}. Use c1 to c9 or all.`);

  const cfg = loadConfig(args.config);
  if (args.collect) cfg.runtime.collectSelector = args.collect;
  // A quick run (a demo, a check of one screen) captures a subset of what the config lists.
  if (args.states) {
    const want = new Set(args.states);
    for (const s of cfg.runtime.surfaces) s.states = s.states.filter((st) => want.has(st.name));
    const found = cfg.runtime.surfaces.flatMap((s) => s.states.map((st) => st.name));
    const missing = args.states.filter((n) => !found.includes(n));
    if (missing.length) throw new ConfigError(`--states: no state named ${missing.join(", ")} in the config`);
  }
  if (args.viewports) {
    const keep = cfg.runtime.viewports.filter((v) => args.viewports!.includes(v.name));
    if (!keep.length) throw new ConfigError(`--viewports: none of ${args.viewports.join(", ")} is in runtime.viewports`);
    cfg.runtime.viewports = keep;
  }
  if (args.headed) {
    cfg.runtime.headless = false;
    if (cfg.runtime.harness && !cfg.runtime.harness.command.includes("--headed")) cfg.runtime.harness.command = [...cfg.runtime.harness.command, "--headed"];
  }
  if (!args.quiet) {
    const { setProgress } = await import("./progress.js");
    setProgress((line) => process.stderr.write(`${line}\n`));
  }
  const { report, paths } = await runAudit(cfg, { checks: args.checks, runtime: args.runtime, blame: args.blame, history: args.history, updateBaseline: args.updateBaseline });
  const s = report.summary;
  const quiet = [s.accepted ? `accepted ${s.accepted}` : "", s.suppressed ? `suppressed ${s.suppressed}` : ""].filter(Boolean).join(", ");
  const iss = s.issuesBySeverity;
  console.log(
    s.issues !== undefined && iss
      ? `${s.issues} issues from ${s.total} findings (high ${iss.high}, medium ${iss.medium}, low ${iss.low}; new ${s.new}, fixed ${s.fixed}${quiet ? `; ${quiet}` : ""})`
      : `${s.total} findings (high ${s.bySeverity.high}, medium ${s.bySeverity.medium}, low ${s.bySeverity.low}; new ${s.new}, fixed ${s.fixed})`,
  );
  for (const g of report.groups.slice(0, 10)) console.log(`  · ${g.title}`);
  if (paths) console.log(`Report: ${paths.latest}/report.html`);

  if (args.failOn) {
    const rank = { high: 3, medium: 2, low: 1 } as const;
    const worst = report.findings.filter((f) => f.status === "new").some((f) => rank[f.severity] >= rank[args.failOn!]);
    if (worst) return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ConfigError ? e.message : (e as Error).stack ?? String(e));
    process.exit(2);
  },
);
