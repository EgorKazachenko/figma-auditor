import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AuditConfig } from "../config.js";
import { ConfigError, loadConfig } from "../config.js";
import type { CheckId } from "../pipeline.js";
import type { Finding } from "../types.js";

/**
 * Seeded-defect evaluation: plant known defects into a throw-away copy of the product, run the audit
 * on the clean copy and on the seeded copy, and score which defects were found (recall) and how many
 * new findings no defect explains (precision). The product repository itself is never modified.
 *
 * Seed kinds:
 * - source: replace `find` with `replace` in a file of the copy (static checks C1, token checks C2)
 * - css:    inject a stylesheet into every captured state (rendered-output checks C3–C8; needs a driver
 *           that supports `injectCss`)
 * A seed with `expect: none` is a negative control: an edit that must not produce findings.
 */

export interface SeedExpectation {
  check: Finding["check"];
  /** Exact category or /regex/. */
  category?: string;
  /** Every string must appear in the finding's title, source link, token, component or context. */
  contains?: string[];
}

export interface Seed {
  id: string;
  kind: "source" | "css";
  description?: string;
  file?: string;
  find?: string;
  replace?: string;
  css?: string;
  /** One finding this seed must cause, several (each scored on its own), or "none" for a negative control. */
  expect: SeedExpectation | SeedExpectation[] | "none";
  /** For negative controls: strings that tie a stray finding to this seed. */
  near?: string[];
}

export interface EvalSpec {
  specPath: string;
  configPath: string;
  checks: CheckId[];
  runtime: boolean;
  /** Paths (relative to the product repo) copied into the throw-away workspace. */
  copy: string[];
  seeds: Seed[];
}

export function parseEvalSpec(text: string, specPath: string): EvalSpec {
  const raw = (parseYaml(text) ?? {}) as Record<string, any>;
  const base = dirname(resolve(specPath));
  if (!raw.config) throw new ConfigError(`${specPath}: "config" (the audit config to evaluate) is required`);
  const seeds = (Array.isArray(raw.seeds) ? raw.seeds : []) as any[];
  if (!seeds.length) throw new ConfigError(`${specPath}: list at least one seed`);
  const ids = new Set<string>();
  const parsed: Seed[] = seeds.map((s, i) => {
    const where = `${specPath}: seeds[${i}]`;
    if (!s?.id) throw new ConfigError(`${where} needs an id`);
    if (ids.has(s.id)) throw new ConfigError(`${where}: duplicate id ${s.id}`);
    ids.add(s.id);
    const kind = s.kind ?? "source";
    if (kind === "source" && (!s.file || typeof s.find !== "string" || typeof s.replace !== "string"))
      throw new ConfigError(`${where}: a source seed needs file, find and replace`);
    if (kind === "css" && !s.css) throw new ConfigError(`${where}: a css seed needs css`);
    if (kind !== "source" && kind !== "css") throw new ConfigError(`${where}: kind must be source or css`);
    const list = s.expect === "none" ? [] : Array.isArray(s.expect) ? s.expect : [s.expect];
    if (s.expect !== "none" && (!list.length || list.some((e: any) => !e?.check)))
      throw new ConfigError(`${where}: expect needs a check (or a list of them), or "none" for a negative control`);
    return { id: s.id, kind, description: s.description, file: s.file, find: s.find, replace: s.replace, css: s.css, expect: s.expect, near: s.near };
  });
  return {
    specPath: resolve(specPath),
    configPath: isAbsolute(raw.config) ? raw.config : resolve(base, raw.config),
    checks: (raw.checks ?? ["c1", "c2"]) as CheckId[],
    runtime: Boolean(raw.runtime),
    copy: raw.copy ?? ["src"],
    seeds: parsed,
  };
}

export function loadEvalSpec(path: string): EvalSpec {
  return parseEvalSpec(readFileSync(path, "utf8"), path);
}

/** Copies the listed product paths into a temp folder and points a clone of the config at it. */
export function makeWorkspace(cfg: AuditConfig, copy: string[]): { dir: string; cfg: AuditConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "da-eval-"));
  for (const p of copy) {
    const from = join(cfg.target.repo, p);
    if (!existsSync(from)) throw new ConfigError(`eval copy: ${from} does not exist`);
    cpSync(from, join(dir, p), { recursive: true, filter: (src) => !/\/node_modules(\/|$)/.test(src) });
  }
  return { dir, cfg: retargetConfig(cfg, dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A copy of the config that reads the product from another folder and writes nothing next to the real one. */
export function retargetConfig(cfg: AuditConfig, dir: string): AuditConfig {
  const move = (p: string | undefined) => (p ? join(dir, relative(cfg.target.repo, p)) : p);
  const clone: AuditConfig = structuredClone(cfg);
  clone.target.repo = dir;
  clone.target.themeEntry = move(cfg.target.themeEntry)!;
  clone.target.tailwindConfig = move(cfg.target.tailwindConfig);
  clone.report.dir = join(dir, ".eval-reports");
  clone.history.path = join(dir, ".eval-history.json");
  clone.baseline.dir = join(dir, ".eval-baselines");
  return clone;
}

/** Product paths an audit reads: scanned folders, theme entry and Tailwind config, relative to the repo. */
export function auditedPaths(cfg: AuditConfig): string[] {
  const rel = (p: string | undefined) => (p ? relative(cfg.target.repo, p) : undefined);
  const all = [...cfg.target.scan.include, rel(cfg.target.themeEntry), rel(cfg.target.tailwindConfig)].filter((p): p is string => Boolean(p));
  // Drop paths inside another listed path.
  return [...new Set(all)].filter((p, _, list) => !list.some((q) => q !== p && (p + "/").startsWith(q.replace(/\/$/, "") + "/")));
}

/** Applies source seeds to the workspace. Each `find` must occur exactly once, so a seed never lands somewhere unintended. */
export function applySourceSeeds(dir: string, seeds: Seed[]): void {
  for (const s of seeds) {
    if (s.kind !== "source") continue;
    const file = join(dir, s.file!);
    if (!existsSync(file)) throw new ConfigError(`seed ${s.id}: ${s.file} is not in the workspace (add it to "copy")`);
    const text = readFileSync(file, "utf8");
    const count = text.split(s.find!).length - 1;
    if (count !== 1) throw new ConfigError(`seed ${s.id}: "${s.find}" occurs ${count} times in ${s.file}; it must occur once`);
    writeFileSync(file, text.replace(s.find!, s.replace!));
  }
}

export function loadAuditConfig(spec: EvalSpec): AuditConfig {
  return loadConfig(spec.configPath);
}
