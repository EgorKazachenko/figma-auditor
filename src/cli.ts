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
  -h, --help          Show this help

Reports are written to <report.dir>/<run id>/ and mirrored to <report.dir>/latest/.

Other commands:${SUBCOMMAND_HELP}`;

function parseArgs(argv: string[]) {
  const args = { cmd: argv[0], config: "", checks: ["c1", "c2"] as CheckId[], runtime: false, blame: false, history: true, failOn: undefined as Severity | undefined, collect: undefined as string | undefined, updateBaseline: false, help: false };
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
