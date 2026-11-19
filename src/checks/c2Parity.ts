import type { CodeTokenDecl, Context, Finding, ReferenceToken, ResolvedTokens } from "../types.js";
import { colorDistance, normalizeColor } from "../color.js";
import { buildNameIndex } from "../names.js";
import { winningDecl } from "../css/themeCss.js";
import { makeFinding } from "../findings.js";

export interface C2Input {
  reference: ReferenceToken[];
  decls: CodeTokenDecl[];
  contexts: Context[];
  /** Values resolved by plain Chromium (code fallbacks), one entry per context. */
  code: ResolvedTokens[];
  /** Values resolved inside the product browser, one entry per context, when a runtime run happened. */
  runtime?: ResolvedTokens[];
  aliases: Record<string, string>;
  colorDeltaE: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Tokens declared under a product-specific selector whose value already equals the Figma value.
 * They are the usual workaround when a base token drifts ("pin the Neon value in neon.css").
 */
function workarounds(input: C2Input, ctx: Context, expected: string, exclude: string, resolved: ResolvedTokens): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(resolved.tokens)) {
    if (name === exclude || !v.color) continue;
    const d = colorDistance(expected, v.color, ctx.backdrop);
    if (d === null || d > 1) continue;
    const decl = winningDecl(input.decls, name, ctx.html);
    if (decl && /data-product/.test(decl.selector)) out.push(`${name} (${decl.file}:${decl.line})`);
  }
  return out;
}

/** C2 · token parity (gap A): Figma value vs the value the code resolves to, per context and per source. */
export function checkTokenParity(input: C2Input): Finding[] {
  const findings: Finding[] = [];
  const declNames = [...new Set(input.decls.map((d) => d.name))];
  const toCode = buildNameIndex(declNames, input.aliases);
  const reportedMissing = new Set<string>();

  for (const ref of input.reference) {
    if (ref.kind !== "color" || !ref.name.startsWith("--")) continue;
    const codeName = toCode(ref.figmaName);
    const figmaLink = ref.source.url;

    if (!codeName) {
      if (reportedMissing.has(ref.name)) continue;
      reportedMissing.add(ref.name);
      findings.push(
        makeFinding(
          {
            check: "C2",
            category: "token-missing-in-code",
            gap: "A",
            severity: "medium",
            title: `Figma variable ${ref.figmaName} has no CSS token`,
            token: ref.name,
            expected: { value: ref.value, source: `Figma · ${ref.source.fileName ?? ref.source.type}`, token: ref.figmaName },
            links: { figma: figmaLink },
          },
          [ref.name],
        ),
      );
      continue;
    }

    for (const ctx of input.contexts.filter((c) => c.figmaMode === ref.mode)) {
      const sources: { kind: "code" | "runtime"; resolved?: ResolvedTokens }[] = [
        { kind: "code", resolved: input.code.find((r) => r.context === ctx.name) },
        { kind: "runtime", resolved: input.runtime?.find((r) => r.context === ctx.name) },
      ];
      let codeFinding: Finding | undefined;
      for (const { kind, resolved } of sources) {
        if (!resolved) continue;
        const v = resolved.tokens[codeName];
        // The browser resolved the same colour as the code: one finding, confirmed at runtime, not two.
        if (kind === "runtime") {
          const codeColor = sources[0]!.resolved?.tokens[codeName]?.color;
          if (v?.color && codeColor && normalizeColor(v.color) === normalizeColor(codeColor)) {
            if (codeFinding?.actual) codeFinding.actual.source += `; same value in ${resolved.browser}`;
            continue;
          }
        }
        const decl = winningDecl(input.decls, codeName, ctx.html);
        const where = decl ? `${decl.file}:${decl.line}` : undefined;
        const how =
          kind === "runtime"
            ? `resolved in ${resolved.browser}`
            : decl?.envName
              ? `code fallback of env(${decl.envName})`
              : "code value";

        if (!v || !v.color) {
          findings.push(
            makeFinding(
              {
                check: "C2",
                category: kind === "runtime" ? "token-unresolved-runtime" : "token-unresolved",
                gap: "A",
                severity: "medium",
                title: `${codeName} does not resolve to a colour in ${ctx.name}`,
                token: codeName,
                context: ctx.name,
                expected: { value: ref.value, source: `Figma · ${ref.source.fileName ?? ref.source.type}`, token: ref.figmaName },
                actual: { value: v?.raw || "(not set)", source: how },
                links: { figma: figmaLink, source: where },
              },
              [codeName, ctx.name, kind],
            ),
          );
          continue;
        }

        const d = colorDistance(ref.value, v.color, ctx.backdrop);
        if (d === null || d <= input.colorDeltaE) continue;
        const actualHex = normalizeColor(v.color) ?? v.color;
        const related = workarounds(input, ctx, ref.value, codeName, resolved);
        const finding = makeFinding(
            {
              check: "C2",
              category: kind === "runtime" ? "token-parity-runtime" : "token-parity",
              gap: "A",
              severity: "high",
              title: `${codeName} differs from Figma in ${ctx.name} (ΔE ${round(d)})`,
              token: codeName,
              context: ctx.name,
              expected: { value: ref.value, source: `Figma · ${ref.source.fileName ?? ref.source.type}`, token: ref.figmaName },
              actual: { value: actualHex, source: how },
              deltaE: round(d),
              related: related.length ? related : undefined,
              links: { figma: figmaLink, source: where },
              evidence: { swatches: [ref.value, actualHex] },
            },
            [codeName, ctx.name, kind],
          );
        findings.push(finding);
        if (kind === "code") codeFinding = finding;
      }
    }
  }
  return findings;
}

/**
 * Detects a runtime capture where the browser supplied none of the env() values the theme reads,
 * so runtime colours are just the code fallbacks (e.g. the page was opened outside the panel that receives them).
 */
export function envCoverage(
  decls: CodeTokenDecl[],
  runtime: ResolvedTokens,
  html: Record<string, string> = {},
): { envTokens: number; supplied: number } {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  let envTokens = 0;
  let supplied = 0;
  for (const name of new Set(decls.map((d) => d.name))) {
    // Only the declaration that wins in this context matters: product overrides are not browser values.
    const d = winningDecl(decls, name, html);
    if (!d?.envName || d.fallback === undefined) continue;
    const v = runtime.tokens[name];
    if (!v?.raw) continue;
    envTokens++;
    if (norm(v.raw) !== norm(d.fallback)) supplied++;
  }
  return { envTokens, supplied };
}
