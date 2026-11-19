import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AuditConfig } from "./config.js";
import type { Finding, Report, ResolvedTokens, SnapshotCell, StaticHit } from "./types.js";
import { loadThemeCss, readTailwindScale } from "./css/themeCss.js";
import { loadReference, referenceScale, type ReferenceExtras } from "./reference/figma.js";
import { codeSyntaxFindings, resolveVariable } from "./figma/variables.js";
import { tokenKey } from "./names.js";
import type { FigmaClient } from "./figma/rest.js";
import { scanRepo } from "./static/scanner.js";
import { checkStatic } from "./checks/c1Static.js";
import { checkTokenParity, envCoverage } from "./checks/c2Parity.js";
import { checkOffToken } from "./checks/c3OffToken.js";
import { checkSpecs } from "./checks/c4Spec.js";
import { checkLayout } from "./checks/c5Layout.js";
import { compareLayout, layoutEntries, regressionFindings } from "./checks/c6Regression.js";
import { checkFigmaStates, figmaSelfChecks } from "./checks/c7FigmaStates.js";
import { checkContrast, type C8Stats } from "./checks/c8Contrast.js";
import { checkAccessibility, type C9Stats } from "./checks/c9Accessibility.js";
import { loadComponentSets, makeEffectResolver, makeVariableResolver } from "./reference/components.js";
import { diffScreenshots, loadBaseline, saveBaseline } from "./baseline.js";
import { applyHistory, cellId, loadHistory, saveHistory } from "./history.js";
import { groupFindings } from "./triage.js";
import { cellName, sortFindings } from "./findings.js";
import { headCommit } from "./git.js";
import { writeReport } from "./report/render.js";
import { applyAccepted, applySeverityOverrides, applySuppressions, isActive, loadAccepted } from "./noise.js";
import { aggregateIssues, issueCounts, regroupByIssues } from "./issues.js";
import { attachEvidence } from "./report/evidence.js";

export type CheckId = "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "c8" | "c9";
export const ALL_CHECKS: CheckId[] = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];

export interface RunOptions {
  checks: CheckId[];
  /** Open the product in a browser (needed for C3 and for runtime token parity). */
  runtime?: boolean;
  blame?: boolean;
  history?: boolean;
  /** Store this run's layout and screenshots as the C6 baseline. */
  updateBaseline?: boolean;
  write?: boolean;
  now?: Date;
  /** Injected for tests: replaces the plain-Chromium token resolution. */
  resolveCode?: (css: string, names: string[]) => Promise<ResolvedTokens[]>;
  /** Download Figma files again even when their version did not change. */
  refreshFigma?: boolean;
  /** Injected for tests: Figma REST client (null = offline, cache only). */
  figmaClient?: FigmaClient | null;
  /** Injected for tests: replaces the product browser run. */
  probe?: (names: string[], outDir: string) => Promise<{ cells: SnapshotCell[]; browser: string; warnings: string[] }>;
  /** Injected for tests: replaces fetch for Figma image renders. */
  figmaFetch?: typeof fetch;
}

const uniqSorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Exact variable values and code-syntax collisions from figma-rest graphs, for C7. */
function figmaGraphHelpers(extras: ReferenceExtras) {
  if (!extras.graphs.length) return {};
  const collisions = new Map<string, string[]>();
  for (const { graph } of extras.graphs)
    for (const v of graph.variables.values()) {
      const web = v.codeSyntax?.WEB;
      if (!web) continue;
      const k = tokenKey(web);
      const names = collisions.get(k) ?? [];
      if (!names.includes(v.name)) names.push(v.name);
      collisions.set(k, names);
    }
  return {
    resolveVarId: (id: string, mode: string) => {
      for (const { graph, modes } of extras.graphs) {
        if (!graph.variables.has(id) || !modes[mode]) continue;
        const r = resolveVariable(graph, id, modes[mode]!);
        if (r.value !== undefined && r.kind === "color") return r.value;
      }
      return null;
    },
    codeSyntaxCollisions: collisions,
  };
}

export function dedupe(findings: Finding[]): Finding[] {
  const byFp = new Map<string, Finding>();
  for (const f of findings) {
    const prev = byFp.get(f.fingerprint);
    if (prev) prev.occurrences = (prev.occurrences ?? 1) + 1;
    else byFp.set(f.fingerprint, f);
  }
  return [...byFp.values()];
}

export async function runAudit(cfg: AuditConfig, opts: RunOptions): Promise<{ report: Report; paths?: { runDir: string; latest: string } }> {
  const now = opts.now ?? new Date();
  const runId = now.toISOString().replace(/[:.]/g, "-");
  const runDir = join(cfg.report.dir, runId);
  const notes: string[] = [];
  const commit = headCommit(cfg.target.repo);

  const css = loadThemeCss(cfg.target.themeEntry, cfg.target.repo);
  if (css.warnings.length) notes.push(...css.warnings);
  const tokenNames = [...new Set(css.decls.filter((d) => !d.selector.includes("@")).map((d) => d.name))];
  notes.push(`Theme CSS: ${css.files.length} files, ${tokenNames.length} custom properties.`);

  const refWarnings: string[] = [];
  const refExtras: ReferenceExtras = { graphs: [] };
  const reference =
    opts.checks.some((c) => c !== "c1") || cfg.reference.sources.length
      ? await loadReference(cfg.reference.sources, refWarnings, refExtras, { refresh: opts.refreshFigma, client: opts.figmaClient })
      : [];
  notes.push(...refWarnings.map((w) => `Reference warning: ${w}`));
  if (reference.length) {
    const modes = [...new Set(reference.map((t) => t.mode))].join(", ");
    notes.push(`Reference: ${reference.length} Figma values from ${cfg.reference.sources.length} sources (modes: ${modes}).`);
  }

  const spacingScale = uniqSorted([
    0,
    ...cfg.scales.spacing,
    ...(cfg.scales.spacingFromTailwind && cfg.target.tailwindConfig
      ? readTailwindScale(cfg.target.tailwindConfig, cfg.scales.spacingFromTailwind)
      : []),
    ...referenceScale(reference, cfg.reference.scalePrefixes.spacing),
  ]);
  const radiusScale = uniqSorted([0, ...cfg.scales.radius, ...referenceScale(reference, cfg.reference.scalePrefixes.radius)]);

  let findings: Finding[] = [];
  let browser: string | undefined;

  if (opts.checks.includes("c1")) {
    const { hits, files, warnings: scanWarnings } = scanRepo({
      repo: cfg.target.repo,
      ...cfg.target.scan,
      knownVars: tokenNames,
      blame: opts.blame,
    });
    notes.push(`Static scan: ${files} files, ${hits.length} hits.`);
    notes.push(...scanWarnings.map((w) => `Static scan: ${w}`));
    findings.push(...checkStatic(hits as StaticHit[], { spacingScale, radiusScale, px: cfg.thresholds.px }));
  }

  let cells: SnapshotCell[] = [];
  if (opts.runtime) {
    const probe =
      opts.probe ??
      (async (names: string[], outDir: string) => {
        const { probeProduct, PROBE_PATH, PROBE_PROPS } = await import("./runtime/browser.js");
        if (cfg.runtime.driver === "harness") {
          const { runHarness } = await import("./runtime/harness.js");
          return runHarness(cfg, names, outDir, { probePath: PROBE_PATH, props: PROBE_PROPS });
        }
        return probeProduct(cfg, names, outDir);
      });
    const res = await probe(tokenNames, runDir);
    cells = res.cells;
    browser = res.browser;
    notes.push(`Runtime: ${cells.length} cells captured in ${res.browser}.`);
    for (const c of cells) notes.push(`Runtime cell ${cellName(c)}: ${c.nodes.length} elements${c.texts ? `, ${c.texts.length} texts` : ""} collected.`);
    if (opts.write !== false) {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "snapshot.json"), JSON.stringify(cells, null, 2));
    }
    notes.push(...res.warnings.map((w) => `Runtime warning: ${w}`));
  }

  if (opts.checks.includes("c2")) {
    const resolveCode =
      opts.resolveCode ??
      (async (cssText: string, names: string[]) => {
        const { resolveCodeTokens } = await import("./runtime/browser.js");
        return resolveCodeTokens(cssText, names, cfg.contexts);
      });
    const code = await resolveCode(css.css, tokenNames);
    const runtime: ResolvedTokens[] = [];
    for (const ctx of cfg.contexts) {
      const cell = cells.find((c) => c.context === ctx.name);
      if (!cell) continue;
      const resolved: ResolvedTokens = { context: ctx.name, source: "runtime", browser: cell.browser, tokens: cell.tokens };
      runtime.push(resolved);
      const cov = envCoverage(css.decls, resolved, ctx.html);
      if (cov.envTokens > 0 && cov.supplied === 0)
        notes.push(
          `Runtime ${ctx.name}: ${cell.browser} supplied none of the ${cov.envTokens} env() values on ${cell.surface}; runtime colours equal the code fallbacks. Open the surface where the browser injects them.`,
        );
      else if (cov.envTokens > 0) notes.push(`Runtime ${ctx.name}: the browser supplied ${cov.supplied} of ${cov.envTokens} env() values.`);
    }
    findings.push(
      ...checkTokenParity({
        reference,
        decls: css.decls,
        contexts: cfg.contexts,
        code,
        runtime: runtime.length ? runtime : undefined,
        aliases: cfg.reference.aliases,
        colorDeltaE: cfg.thresholds.colorDeltaE,
      }),
    );
    // Gap A inside Figma: code syntax that cannot be implemented as written.
    for (const g of refExtras.graphs)
      findings.push(...codeSyntaxFindings(g.graph, g.modes, (v) => (g.files[0] ? `https://www.figma.com/design/${g.files[0]}/?vars=${encodeURIComponent(v.name)}` : undefined)));
  }

  if (opts.checks.includes("c3")) {
    if (!cells.length) notes.push("C3 skipped: it needs a runtime capture (run with --runtime).");
    else
      findings.push(
        ...checkOffToken(cells, {
          contexts: cfg.contexts,
          spacingScale,
          radiusScale,
          colorDeltaE: cfg.thresholds.colorDeltaE,
          px: cfg.thresholds.px,
          maxCheckedSpacing: cfg.thresholds.maxCheckedSpacing,
        }),
      );
  }

  if (opts.checks.includes("c4")) {
    if (!cells.length) notes.push("C4 skipped: it needs a runtime capture (run with --runtime).");
    else if (!cfg.componentSpecs.length) notes.push("C4 skipped: no componentSpecs in the config.");
    else findings.push(...checkSpecs(cells, cfg.componentSpecs, cfg.thresholds.px));
  }

  if (opts.checks.includes("c5")) {
    if (!cells.length) notes.push("C5 skipped: it needs a runtime capture (run with --runtime).");
    else findings.push(...checkLayout(cells, { minOverlapPx: cfg.thresholds.minOverlapPx }));
  }

  if (opts.checks.includes("c7")) {
    const sets = loadComponentSets(cfg.reference.components);
    if (!cells.length) notes.push("C7 skipped: it needs a runtime capture (run with --runtime).");
    else if (!sets.length || !cfg.figmaComponents.length) notes.push("C7 skipped: add reference.components and figmaComponents to the config.");
    else {
      const defaultMode = cfg.contexts[0]?.figmaMode ?? "light";
      const resolveVar = makeVariableResolver(reference, defaultMode);
      const unresolved = new Set<string>();
      findings.push(
        ...checkFigmaStates(cells, {
          sets,
          mappings: cfg.figmaComponents,
          contexts: cfg.contexts,
          resolveVar,
          resolveEffect: makeEffectResolver(reference),
          colorDeltaE: cfg.thresholds.colorDeltaE,
          px: cfg.thresholds.px,
          unresolved,
          ...figmaGraphHelpers(refExtras),
        }),
        ...figmaSelfChecks(sets, resolveVar, defaultMode),
      );
      const mapped = new Set(cfg.figmaComponents.map((m) => m.figma));
      const unmapped = sets.filter((s) => !mapped.has(s.name)).map((s) => s.name);
      const missing = cfg.figmaComponents.filter((m) => !sets.some((s) => s.name === m.figma)).map((m) => m.figma);
      notes.push(`C7: ${sets.length} Figma component sets, ${sets.reduce((n, s) => n + s.variants.length, 0)} variants, ${cfg.figmaComponents.length} mappings.`);
      if (unmapped.length) notes.push(`C7: Figma sets with no product mapping (not checked): ${unmapped.join(", ")}.`);
      if (missing.length) notes.push(`C7: mapped sets missing from reference.components: ${missing.join(", ")}.`);
      if (unresolved.size) notes.push(`C7: no Figma value for ${[...unresolved].sort().join(", ")}; those were not compared. Capture that mode's variables or effect styles.`);
    }
  }

  if (opts.checks.includes("c8")) {
    if (!cells.length) notes.push("C8 skipped: it needs a runtime capture (run with --runtime).");
    else {
      const stats: C8Stats = { checked: 0, disabled: 0, unknownBackdrop: 0 };
      findings.push(...checkContrast(cells, cfg.thresholds.contrast, stats));
      notes.push(
        `C8: ${stats.checked} texts checked against ${cfg.thresholds.contrast.normal}:1 / ${cfg.thresholds.contrast.large}:1; not judged: ${stats.disabled} disabled, ${stats.unknownBackdrop} over an image, gradient, filter or another element.`,
      );
      if (cells.some((c) => !c.texts)) notes.push("C8: some cells come from an older probe without the page-wide text scan; only collected elements were checked there.");
    }
  }

  if (opts.checks.includes("c9")) {
    if (!cells.length) notes.push("C9 skipped: it needs a runtime capture (run with --runtime).");
    else {
      const stats: C9Stats = { focusChecked: 0, targetsChecked: 0, targetsSpaced: 0, boundariesChecked: 0, iconsChecked: 0 };
      findings.push(...checkAccessibility(cells, {}, stats));
      notes.push(
        `C9: focus checked in ${stats.focusChecked} cells (states captured with keyboard focus); ${stats.targetsChecked} targets measured, ${stats.targetsSpaced} undersized ones pass by spacing; ${stats.boundariesChecked} field borders and ${stats.iconsChecked} icons checked for 3:1.`,
      );
      if (cells.some((c) => !c.targets)) notes.push("C9: some cells come from a probe without target and focus capture; they were not checked.");
    }
  }

  findings = sortFindings(dedupe(findings));
  if (opts.checks.includes("c6")) {
    if (!cells.length) notes.push("C6 skipped: it needs a runtime capture (run with --runtime).");
    for (const cell of cells) {
      const stored = loadBaseline(cfg.baseline.dir, cell);
      if (!stored || opts.updateBaseline) {
        if (opts.write !== false) saveBaseline(cfg.baseline.dir, cell, runDir, { commit, at: now.toISOString() });
        notes.push(`C6 baseline ${stored ? "updated" : "created"} for ${cellName(cell)}.`);
        if (!stored) continue;
      }
      if (!stored) continue;
      if (stored.baseline.browser !== cell.browser)
        notes.push(`C6 ${cellName(cell)}: baseline was taken in ${stored.baseline.browser}, this run in ${cell.browser}; pixel diff skipped, element boxes still compared.`);
      const changes = compareLayout(stored.baseline.entries, layoutEntries(cell), cfg.thresholds.px * 2);
      let diff: { changed: number; ratio: number } | null = null;
      let diffPath: string | undefined;
      if (stored.shot && cell.screenshot && stored.baseline.browser === cell.browser && opts.write !== false) {
        mkdirSync(join(runDir, "diffs"), { recursive: true });
        diffPath = join("diffs", cell.screenshot.split("/").pop()!);
        diff = diffScreenshots(stored.shot, join(runDir, cell.screenshot), join(runDir, diffPath));
        if (!diff) diffPath = undefined;
      }
      findings.push(...regressionFindings(cell, stored.baseline, changes, { diff: diffPath, baselineShot: stored.shot, changedRatio: diff?.ratio }));
    }
  }

  // Severity overrides come before history, so a rule turned off leaves no trace there.
  const overridden = applySeverityOverrides(findings, cfg.severity);
  findings = overridden.findings;
  for (const [k, n] of Object.entries(overridden.dropped)) notes.push(`Severity override: ${n} ${k} findings turned off in the config.`);

  const needsRuntime = (c: CheckId) => c !== "c1" && c !== "c2";
  const checksRan = opts.checks
    .filter((c) => !needsRuntime(c) || cells.length)
    .filter((c) => c !== "c4" || cfg.componentSpecs.length)
    .filter((c) => c !== "c7" || (cfg.figmaComponents.length && cfg.reference.components.length))
    .map((c) => c.toUpperCase());

  let fixed: Report["fixed"] = [];
  if (opts.history !== false) {
    const h = loadHistory(cfg.history.path);
    const applied = applyHistory(h, findings, { id: runId, at: now.toISOString(), commit, checks: checksRan, cells: cells.map(cellId) });
    fixed = applied.fixed;
    if (opts.write !== false) saveHistory(cfg.history.path, applied.history);
  } else {
    for (const f of findings) f.status = "new";
  }

  // After history: suppressed and accepted findings keep their history but stop counting as new.
  notes.push(...applySuppressions(findings, cfg.suppress, now.toISOString().slice(0, 10)).notes);
  const acceptedCount = applyAccepted(findings, loadAccepted(cfg.accepted.path));
  if (acceptedCount) notes.push(`Accepted debt: ${acceptedCount} findings are listed in ${cfg.accepted.path} and do not count.`);

  const issues = aggregateIssues(findings);
  if (opts.write !== false)
    notes.push(
      ...(await attachEvidence(issues, {
        runDir,
        cells,
        crops: cfg.report.crops,
        figmaImages: cfg.report.figmaImages,
        figmaCacheDir: join(dirname(cfg.history.path), "figma-images"),
        token: process.env.FIGMA_TOKEN,
        fetchImpl: opts.figmaFetch,
      })),
    );

  // Severity counts cover what still counts; total keeps every finding.
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byCheck: Record<string, number> = {};
  for (const f of findings) {
    if (isActive(f)) bySeverity[f.severity]++;
    byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
  }

  const report: Report = {
    meta: { id: runId, at: now.toISOString(), repo: cfg.target.repo, commit, configPath: cfg.configPath, checks: checksRan, browser, owners: cfg.owners },
    summary: {
      total: findings.length,
      bySeverity,
      byCheck,
      new: findings.filter((f) => f.status === "new").length,
      fixed: fixed.length,
      ...issueCounts(issues),
      accepted: findings.filter((f) => f.status === "accepted").length,
      suppressed: findings.filter((f) => f.status === "suppressed").length,
    },
    findings,
    fixed,
    issues,
    groups: regroupByIssues(groupFindings(findings), issues),
    notes,
  };

  const paths = opts.write === false ? undefined : writeReport(report, cfg.report.dir, runDir);
  return { report, paths };
}
