import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, type AuditConfig } from "../config.js";
import type { SnapshotCell } from "../types.js";
import { validateCell } from "../contract.js";
import { collectPlan } from "./collect.js";

/**
 * Runtime driver that captures states through the product's own Playwright suite, so the product's
 * fixtures (mock server, logged-in identity, remote-config flags, routed API responses) set the scene.
 * The product's harness spec (template: examples/harness/capture.spec.ts) reads a capture spec written here and
 * writes one `<surface>__<state>__<context>.cell.json` per cell plus screenshots into the run folder.
 */

export interface CaptureSpec {
  surface: string;
  /** Selector that marks the page as ready (after a reload for a language variant). */
  ready?: string;
  flagSteps: Record<string, boolean>[];
  actionTimeoutMs: number;
  routes: { url: string; json: unknown }[];
  tokens: string[];
  props: string[];
  selector: string;
  /** Named selectors the probe tags collected elements with (C7 mappings without a test id). */
  match: Record<string, string>;
  insideSvg: boolean;
  /**
   * Renderings: first = default (cells without a viewport name); others may set zoom (browser zoom),
   * locale (UI language) and limit themselves to some states. Empty = keep the harness's own size.
   */
  viewports: { name: string; width: number; height: number; zoom?: number; locale?: string; states?: string[] }[];
  contexts: { name: string; colorScheme: "light" | "dark" }[];
  states: { name: string; actions?: unknown[]; waitFor?: string; cleanup?: unknown[]; retries?: number }[];
  /** Stylesheet the harness adds to the page before the first state (seeded-defect evaluation). */
  injectCss?: string;
}

export function buildCaptureSpec(cfg: AuditConfig, tokenNames: string[], props: string[]): CaptureSpec {
  const h = cfg.runtime.harness;
  if (!h) throw new ConfigError("runtime.driver is harness but runtime.harness is missing");
  const surface = cfg.runtime.surfaces[0];
  if (!surface) throw new ConfigError("runtime.surfaces is empty: list the states to capture.");
  return {
    surface: surface.name,
    ...(surface.waitFor ? { ready: surface.waitFor } : {}),
    flagSteps: h.flags,
    actionTimeoutMs: cfg.runtime.actionTimeoutMs,
    injectCss: cfg.runtime.injectCss,
    routes: h.routes.map((r) => ({ url: r.url, json: r.json ?? JSON.parse(readFileSync(r.file!, "utf8")) })),
    tokens: tokenNames,
    props,
    ...collectPlan(cfg),
    insideSvg: cfg.runtime.includeSvgContent,
    viewports: cfg.runtime.viewports,
    contexts: cfg.contexts.map((c) => ({ name: c.name, colorScheme: c.colorScheme })),
    states: surface.states.map((s) => ({ name: s.name, actions: s.actions, waitFor: s.waitFor, ...(s.cleanup ? { cleanup: s.cleanup } : {}), ...(s.retries ? { retries: s.retries } : {}) })),
  };
}

/** Reads what the harness wrote: cells in a stable order, and one warning per state that failed. */
export function readCaptureDir(
  dir: string,
  order?: { states: string[]; contexts: string[]; viewports?: string[] },
): { cells: SnapshotCell[]; warnings: string[] } {
  if (!existsSync(dir)) return { cells: [], warnings: [`capture folder ${dir} does not exist`] };
  const files = readdirSync(dir);
  const warnings: string[] = [];
  const cells: SnapshotCell[] = [];
  // Cells come from another program (the product's own test suite, or a native driver): check them against
  // the capture contract and drop the ones checks cannot read, saying why.
  for (const f of files.filter((x) => x.endsWith(".cell.json")).sort()) {
    let cell: unknown;
    try {
      cell = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      warnings.push(`${f}: not valid JSON (${(e as Error).message})`);
      continue;
    }
    const problems = validateCell(cell, f);
    if (problems.some((p) => /"(nodes|surface|state|context|browser|tokens)"/.test(p))) {
      warnings.push(`${f}: dropped, it does not follow the capture contract: ${problems.join("; ")}`);
      continue;
    }
    warnings.push(...problems.map((p) => `capture contract: ${p}`));
    cells.push(cell as SnapshotCell);
  }
  warnings.push(
    ...files
      .filter((f) => f.endsWith(".error.txt"))
      .sort()
      .map((f) => `${f.replace(/\.error\.txt$/, "").replace(/__/g, "/")}: ${readFileSync(join(dir, f), "utf8").split("\n")[0]}`),
  );
  const rank = (xs: string[] | undefined, x: string) => (xs && xs.includes(x) ? xs.indexOf(x) : Number.MAX_SAFE_INTEGER);
  cells.sort(
    (a, b) =>
      rank(order?.contexts, a.context) - rank(order?.contexts, b.context) ||
      rank(order?.states, a.state) - rank(order?.states, b.state) ||
      rank(order?.viewports, a.viewport ?? "") - rank(order?.viewports, b.viewport ?? "") ||
      `${a.surface}/${a.state}/${a.context}`.localeCompare(`${b.surface}/${b.state}/${b.context}`),
  );
  return { cells, warnings };
}

/** Replaces {spec} in the command and expands ${VAR} from the environment. */
export function harnessCommand(command: string[], spec: string): string[] {
  return command.map((part) =>
    part.replace(/\{spec\}/g, spec).replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => {
      const v = process.env[name];
      if (v === undefined) throw new ConfigError(`runtime.harness.command uses \${${name}}, which is not set`);
      return v;
    }),
  );
}

export async function runHarness(
  cfg: AuditConfig,
  tokenNames: string[],
  outDir: string,
  deps: { probePath: string; props: string[] },
): Promise<{ cells: SnapshotCell[]; browser: string; warnings: string[] }> {
  const h = cfg.runtime.harness;
  if (!h) throw new ConfigError("runtime.driver is harness but runtime.harness is missing");
  const specFile = resolve(h.cwd, h.spec);
  if (!existsSync(specFile))
    throw new ConfigError(
      `Harness spec ${specFile} is missing. Copy the product's capture spec there (see harness/; it is skipped in normal test runs).`,
    );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(h.env)) {
    const m = /\$\{([A-Z0-9_]+)\}/.exec(v);
    if (m && process.env[m[1]!] === undefined) throw new ConfigError(`runtime.harness.env.${k} uses \${${m[1]}}, which is not set`);
    env[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n: string) => process.env[n]!);
  }

  mkdirSync(outDir, { recursive: true });
  const specPath = join(outDir, "capture-spec.json");
  const spec = buildCaptureSpec(cfg, tokenNames, deps.props);
  writeFileSync(specPath, JSON.stringify(spec));

  const [cmd, ...args] = harnessCommand(h.command, h.spec);
  const output: string[] = [];
  const code = await new Promise<number | null>((done, fail) => {
    const child = spawn(cmd!, args, {
      cwd: h.cwd,
      env: { ...process.env, ...env, DESIGN_AUDITOR_OUT: outDir, DESIGN_AUDITOR_PROBE: deps.probePath, DESIGN_AUDITOR_SPEC: specPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (b: Buffer) => {
      output.push(b.toString());
      if (output.length > 400) output.splice(0, output.length - 400);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), h.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      done(c);
    });
  });

  const read = readCaptureDir(outDir, {
    states: spec.states.map((s) => s.name),
    contexts: spec.contexts.map((c) => c.name),
    viewports: ["", ...spec.viewports.slice(1).map((v) => v.name)],
  });
  const warnings = [...read.warnings];
  const tail = output.join("").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").slice(-6).join(" | ");
  if (code !== 0) warnings.push(`harness exited with code ${code}: ${tail}`);
  if (!read.cells.length)
    warnings.push(`harness produced no cells (is the product's mock backend running in ${h.cwd}?): ${tail}`);
  const browser = read.cells[0]?.browser ?? "harness";
  return { cells: read.cells, browser, warnings };
}
