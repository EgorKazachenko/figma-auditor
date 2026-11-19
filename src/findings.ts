import { createHash } from "node:crypto";
import type { CellRef, Finding } from "./types.js";

/** The cell reference a finding carries; the viewport only when the capture has one. */
export function cellWhere(c: CellRef): CellRef {
  return c.viewport ? { surface: c.surface, state: c.state, context: c.context, viewport: c.viewport } : { surface: c.surface, state: c.state, context: c.context };
}

/** "surface/state/context" plus "@viewport" when set: stable across runs, used by history and notes. */
export const cellName = (c: CellRef) => `${c.surface}/${c.state}/${c.context}${c.viewport ? `@${c.viewport}` : ""}`;

/**
 * Fingerprint = what the finding is about, not where it currently sits: line numbers and pixel
 * positions are left out so a finding keeps its identity when unrelated code moves around it.
 */
export function fingerprintOf(parts: (string | number | undefined | null)[]): string {
  return createHash("sha1").update(JSON.stringify(parts.map((p) => p ?? ""))).digest("hex");
}

export function makeFinding(f: Omit<Finding, "id" | "fingerprint">, identity: (string | number | undefined | null)[]): Finding {
  const fingerprint = fingerprintOf([f.check, f.category, ...identity]);
  return { id: `f-${fingerprint.slice(0, 8)}`, fingerprint, ...f };
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.check.localeCompare(b.check) ||
      a.title.localeCompare(b.title),
  );
}
