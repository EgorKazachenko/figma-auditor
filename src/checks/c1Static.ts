import type { Finding, StaticHit } from "../types.js";
import { makeFinding } from "../findings.js";
import { lengthPx } from "../static/scanner.js";

export interface C1Options {
  spacingScale: number[];
  radiusScale: number[];
  px: number;
}

const pxOf = (match: string) => lengthPx(match);

interface Verdict {
  category: string;
  severity: Finding["severity"];
  title: string;
}

/** Arbitrary lengths are judged against their scale: on the scale is a style nit, off it is drift. */
function judgeLength(h: StaticHit, scale: number[], tol: number, kind: "spacing" | "radius"): Verdict {
  const v = pxOf(h.match);
  if (scale.some((s) => Math.abs(s - v) < 0.01))
    return { category: `${kind}-class-on-scale`, severity: "low", title: `Arbitrary ${v}px ${kind} where a scale step exists` };
  const near = scale.some((s) => Math.abs(s - v) <= tol);
  return {
    category: `off-scale-${kind}`,
    severity: near ? "low" : "medium",
    title: `Off-scale ${kind} ${v}px`,
  };
}

function verdictOf(h: StaticHit, opts: C1Options): Verdict {
  switch (h.rule) {
    case "unknown-css-var":
      return { category: h.rule, severity: "medium", title: `CSS variable ${h.match} is not defined anywhere` };
    case "tailwind-arbitrary-color":
      return { category: h.rule, severity: "medium", title: `Arbitrary colour class ${h.match} instead of a token` };
    case "hex-in-source":
      return { category: h.rule, severity: "low", title: `Hard-coded colour ${h.match} in a component` };
    case "hex-in-css":
      return { category: h.rule, severity: "low", title: `Hard-coded colour ${h.match} in CSS` };
    case "tailwind-arbitrary-spacing":
    case "inline-style-spacing":
    case "css-spacing":
      return judgeLength(h, opts.spacingScale, opts.px, "spacing");
    case "tailwind-arbitrary-radius":
    case "inline-style-radius":
    case "css-radius":
      return judgeLength(h, opts.radiusScale, opts.px, "radius");
    case "tailwind-arbitrary-type":
      return { category: h.rule, severity: "low", title: `Arbitrary type size ${pxOf(h.match)}px instead of a text style` };
  }
}

/** C1 · static rules. Every hit becomes a finding in gap B. */
export function checkStatic(hits: StaticHit[], opts: C1Options): Finding[] {
  // Identity = file, rule, value and which occurrence of that value in the file it is. No line numbers and no
  // line text: editing a line (or code above it) must not turn an old finding into a "new" one.
  const seen = new Map<string, number>();
  return hits.map((h) => {
    const identity = `${h.file}|${h.rule}|${h.match}`;
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    const v = verdictOf(h, opts);
    // An inline directive applies when it names this rule, this verdict category, or everything ("*").
    const ignore = h.suppress && h.suppress.category.split(" ").some((c) => c === "*" || c === h.rule || c === v.category) ? h.suppress : undefined;
    return makeFinding(
      {
        check: "C1",
        category: v.category,
        gap: "B",
        severity: v.severity,
        title: v.title,
        actual: { value: h.match, source: `${h.file}:${h.line}` },
        links: { source: `${h.file}:${h.line}`, commit: h.blame?.commit },
        ...(ignore ? { suppressed: { reason: ignore.reason, source: "inline" as const } } : {}),
      },
      [h.file, h.rule, h.match, occurrence],
    );
  });
}
