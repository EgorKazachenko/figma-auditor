import type { AuditConfig } from "../config.js";
import { extraSelectors } from "../checks/c7FigmaStates.js";

/**
 * What every driver asks the probe to collect: the configured selector plus mapping selectors the
 * snapshot cannot match by itself (anything but test ids and DS component names). The probe tags each
 * collected element with the named selectors it matches.
 */
export function collectPlan(cfg: AuditConfig): { selector: string; match: Record<string, string> } {
  const extra = extraSelectors(cfg.figmaComponents);
  return {
    selector: [cfg.runtime.collectSelector, ...extra].join(","),
    match: Object.fromEntries(extra.map((s) => [s, s])),
  };
}
