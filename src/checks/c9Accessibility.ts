import type { Finding, FocusLook, FocusSample, SnapshotCell, TargetSample } from "../types.js";
import { composite, parseColor, toHex } from "../color.js";
import { cellWhere, makeFinding } from "../findings.js";
import { contrastRatio } from "./c8Contrast.js";

/**
 * C9 · accessibility checks that need the rendered page, from captured cells only (any driver):
 * - focus visible (WCAG 2.4.7) and its contrast (1.4.11 for state indicators): the keyboard-focused element
 *   is compared with itself after blur (or the active option with a sibling option); no change = not
 *   visible, a change below 3:1 = too weak; a focused element fully covered by other content fails 2.4.11;
 * - target size (2.5.8): interactive targets at least 24×24 CSS px, unless a 24 px circle around each
 *   undersized target touches no other target (the spacing exception); inline links, disabled and visually
 *   hidden controls are exempt;
 * - non-text contrast (1.4.11): a text field's border, when it is what marks the field, and the icon of a
 *   control without text, at least 3:1 against what is behind them. Disabled controls are exempt;
 * - keyboard (2.1.1): buttons and links taken out of the Tab order (tabindex="-1") outside composite widgets
 *   that move focus with arrow keys, and not inside another reachable control.
 */

export interface C9Options {
  /** Minimum target size in CSS px (WCAG 2.5.8 AA: 24). */
  minTarget?: number;
  /** Minimum contrast for boundaries, icons and focus indicators (WCAG 1.4.11: 3). */
  nonText?: number;
}

export interface C9Stats {
  focusChecked: number;
  targetsChecked: number;
  targetsSpaced: number;
  boundariesChecked: number;
  iconsChecked: number;
  /** Controls found out of the Tab order. */
  notTabbable?: number;
}

const fmt = (r: number) => `${Math.floor(r * 100) / 100}:1`;

/** First visible layer of a box-shadow, inset or not (focus rings are often inset). */
export function shadowLayer(css: string): { blur: number; spread: number; color: string; inset: boolean } | null {
  for (const part of css.split(/,(?![^(]*\))/)) {
    const layer = part.trim();
    const color = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(layer)?.[1];
    const nums = layer.replace(color ?? "", "").replace(/\binset\b/, "").trim().split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
    const c = color ? parseColor(color) : null;
    if (!c || c.a === 0 || nums.length < 2) continue;
    const blur = nums[2] ?? 0;
    const spread = nums[3] ?? 0;
    if (blur < 1 && spread < 1 && nums[0] === 0 && nums[1] === 0) continue;
    return { blur, spread, color: color!, inset: /\binset\b/.test(layer) };
  }
  return null;
}

/** Colour of an outline or shadow as painted on the backdrop, or null when it paints nothing. */
function painted(color: string | undefined, backdrop: string): string | null {
  const c = color ? parseColor(color) : null;
  const b = parseColor(backdrop);
  if (!c || !b || c.a === 0) return null;
  return toHex(composite(c, b));
}

export interface IndicatorVerdict {
  /** none: nothing changes on focus; weak: a change below the ratio; ok: at least one change reaches it. */
  kind: "none" | "weak" | "ok";
  ratio: number;
  what: string;
}

/** What changes when the element gets keyboard focus, and how strongly it stands out. */
export function focusIndicator(f: { focused: FocusLook; rest: FocusLook | null }, need = 3): IndicatorVerdict {
  const F = f.focused;
  const R = f.rest;
  const changes: { what: string; ratio: number }[] = [];

  const outlineOn = F.outlineStyle !== "none" && F.outlineWidth >= 1;
  const outlineWasSame = R && R.outlineStyle === F.outlineStyle && R.outlineWidth === F.outlineWidth && R.outlineColor === F.outlineColor;
  if (outlineOn && !outlineWasSame) {
    // An outline drawn inside the box (negative offset) sits on the element's fill, otherwise on the backdrop.
    const under = F.outlineOffset < 0 ? F.fill : F.backdrop;
    const c = painted(F.outlineColor, under);
    if (c) changes.push({ what: `outline ${F.outlineWidth}px ${c}`, ratio: contrastRatio(c, under) ?? 1 });
  }

  if (F.boxShadow && F.boxShadow !== "none" && (!R || R.boxShadow !== F.boxShadow)) {
    const s = shadowLayer(F.boxShadow);
    if (s && (s.spread >= 1 || s.blur >= 1)) {
      const under = s.inset ? F.fill : F.backdrop;
      const c = painted(s.color, under);
      if (c) changes.push({ what: `shadow ${c}`, ratio: contrastRatio(c, under) ?? 1 });
    }
  }

  if (F.border && (!R?.border || R.border.color !== F.border.color || R.border.width !== F.border.width)) {
    const before = R?.border?.color ?? R?.fill ?? F.backdrop;
    changes.push({ what: `border ${F.border.width}px ${F.border.color}`, ratio: contrastRatio(F.border.color, before) ?? 1 });
  }

  if (R && R.fill !== F.fill) changes.push({ what: `background ${R.fill} → ${F.fill}`, ratio: contrastRatio(F.fill, R.fill) ?? 1 });
  if (R && R.color !== F.color) {
    const a = painted(F.color, F.fill);
    const b = painted(R.color, R.fill);
    if (a && b && a !== b) changes.push({ what: `text colour ${b} → ${a}`, ratio: contrastRatio(a, b) ?? 1 });
  }

  if (!changes.length) return { kind: "none", ratio: 1, what: "nothing changes" };
  const best = changes.reduce((x, y) => (y.ratio > x.ratio ? y : x));
  return { kind: best.ratio >= need ? "ok" : "weak", ratio: best.ratio, what: changes.map((c) => `${c.what} (${fmt(c.ratio)})`).join(", ") };
}

/** Distance from a point to a box (0 inside). */
function distToBox(x: number, y: number, b: TargetSample["box"]): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

const centre = (b: TargetSample["box"]) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/**
 * WCAG 2.5.8 for one cell: undersized targets that a 24 px circle cannot separate from their neighbours.
 * Returns the offending target with the neighbour that crowds it.
 */
export function crowdedTargets(targets: TargetSample[], min = 24, stats?: C9Stats): { t: TargetSample; near: TargetSample }[] {
  const live = targets.map((t, i) => ({ t, i })).filter(({ t }) => !t.hidden && t.viewFraction > 0 && t.box.width > 0 && t.box.height > 0);
  const related = (a: number, b: number) => targets[a]!.ancestorOf.includes(b) || targets[b]!.ancestorOf.includes(a);
  const small = (t: TargetSample) => t.box.width < min - 0.5 || t.box.height < min - 0.5;
  const out: { t: TargetSample; near: TargetSample }[] = [];
  for (const { t, i } of live) {
    if (t.inline || t.disabled) continue;
    if (stats) stats.targetsChecked++;
    if (!small(t)) continue;
    const c = centre(t.box);
    let near: TargetSample | undefined;
    for (const { t: u, i: j } of live) {
      if (j === i || related(i, j)) continue;
      const hitsBox = distToBox(c.x, c.y, u.box) < min / 2 - 0.01;
      const cu = centre(u.box);
      const hitsCircle = small(u) && !u.inline && Math.hypot(c.x - cu.x, c.y - cu.y) < min - 0.01;
      if (hitsBox || hitsCircle) {
        near = u;
        break;
      }
    }
    if (near) out.push({ t, near });
    else if (stats) stats.targetsSpaced++;
  }
  return out;
}

export function checkAccessibility(cells: SnapshotCell[], opts: C9Options = {}, stats?: C9Stats): Finding[] {
  const min = opts.minTarget ?? 24;
  const need = opts.nonText ?? 3;
  const out: Finding[] = [];
  const base = (cell: SnapshotCell) => ({ check: "C9" as const, gap: "B" as const, context: cell.context, cell: cellWhere(cell) });

  for (const cell of cells) {
    // --- focus
    const f: FocusSample | null | undefined = cell.focus;
    if (f) {
      if (stats) stats.focusChecked++;
      const v = focusIndicator(f, need);
      const where = f.via === "activedescendant" ? "active option" : f.via === "label" ? "label of the focused control" : f.via === "hidden" ? "visually hidden control" : "focused element";
      if (v.kind !== "ok") {
        out.push(
          makeFinding(
            {
              ...base(cell),
              category: v.kind === "none" ? "focus-not-visible" : "focus-indicator-contrast",
              severity: v.kind === "none" ? "high" : "medium",
              title:
                v.kind === "none"
                  ? f.via === "hidden"
                    ? `${f.label}: keyboard focus lands on a visually hidden control that shows no focus anywhere`
                    : `${f.label}: keyboard focus is not visible, nothing changes when it is focused`
                  : `${f.label}: focus indicator ${fmt(v.ratio)}, needs ${need}:1 (${v.what})`,
              component: f.label,
              property: "focus",
              expected: { value: v.kind === "none" ? "a visible focus indicator" : `${need}:1`, source: v.kind === "none" ? "WCAG 2.2 AA 2.4.7" : "WCAG 2.2 AA 1.4.11 (state indicator)" },
              actual: { value: v.kind === "none" ? "no change" : fmt(v.ratio), source: `${where}: ${v.what}` },
              links: { source: f.path },
              evidence: { screenshot: cell.screenshot, box: f.box },
            },
            [f.path, cell.context],
          ),
        );
      }
      const o = f.obscured;
      if (o.samples > 0 && o.covered === o.samples) {
        out.push(
          makeFinding(
            {
              ...base(cell),
              category: "focus-obscured",
              severity: "high",
              title: `${f.label}: the focused element is hidden by ${o.by.join(", ") || "other content"}`,
              component: f.label,
              property: "focus",
              expected: { value: "focused element at least partly visible", source: "WCAG 2.2 AA 2.4.11" },
              actual: { value: `covered at ${o.covered} of ${o.samples} points`, source: o.by.join(", ") },
              links: { source: f.path },
              evidence: { screenshot: cell.screenshot, box: f.box },
            },
            [f.path, cell.context],
          ),
        );
      }
    }

    const targets = cell.targets ?? [];

    // --- target size
    for (const { t, near } of crowdedTargets(targets, min, stats)) {
      out.push(
        makeFinding(
          {
            ...base(cell),
            category: "target-size",
            severity: "medium",
            title: `${t.label}: target ${t.box.width}×${t.box.height} px is under ${min}×${min} and too close to ${near.label}`,
            component: t.label,
            property: "target size",
            expected: { value: `${min}×${min} px, or a ${min} px circle clear of other targets`, source: "WCAG 2.2 AA 2.5.8" },
            actual: { value: `${t.box.width}×${t.box.height} px`, source: `nearest target ${near.label}` },
            links: { source: t.path },
            evidence: { screenshot: cell.screenshot, box: t.box },
          },
          [t.path, cell.context],
        ),
      );
    }

    // --- keyboard reachability
    for (const [i, t] of targets.entries()) {
      if (t.tabbable !== false || t.inWidget || t.hidden || t.disabled || t.textEntry || t.viewFraction === 0) continue;
      if (!/^(button|a|link|menuitem|tab|switch|checkbox|radio)$/.test(t.role)) continue;
      // A control inside another control that Tab reaches is operated through that one.
      if (targets.some((u, j) => j !== i && u.ancestorOf.includes(i) && u.tabbable)) continue;
      if (stats) stats.notTabbable = (stats.notTabbable ?? 0) + 1;
      out.push(
        makeFinding(
          {
            ...base(cell),
            category: "not-keyboard-reachable",
            severity: "medium",
            title: `${t.label}: ${t.role} is out of the Tab order (tabindex="-1"); keyboard users need another way to reach it`,
            component: t.label,
            property: "keyboard",
            expected: { value: "reachable with Tab, or part of a widget with arrow-key focus", source: "WCAG 2.2 A 2.1.1" },
            actual: { value: 'tabindex="-1"', source: t.path },
            links: { source: t.path },
            evidence: { screenshot: cell.screenshot, box: t.box },
          },
          [t.path, cell.context, "keyboard"],
        ),
      );
    }

    // --- non-text contrast
    for (const t of targets) {
      if (t.hidden || t.disabled || t.viewFraction === 0) continue;
      if (t.textEntry && t.border) {
        const fillStandsOut = (contrastRatio(t.fill, t.backdrop) ?? 1) >= need;
        if (fillStandsOut) continue;
        if (stats) stats.boundariesChecked++;
        const r = Math.max(contrastRatio(t.border.color, t.backdrop) ?? 1, contrastRatio(t.border.color, t.fill) ?? 1);
        if (r >= need) continue;
        out.push(
          makeFinding(
            {
              ...base(cell),
              category: "field-boundary-contrast",
              severity: "medium",
              title: `${t.label}: field border ${t.border.color} is ${fmt(r)} against ${t.backdrop}, needs ${need}:1`,
              component: t.label,
              property: "border",
              expected: { value: `${need}:1`, source: "WCAG 2.2 AA 1.4.11" },
              actual: { value: fmt(r), source: `${t.border.color} on ${t.backdrop}` },
              links: { source: t.path },
              evidence: { swatches: [t.border.color, t.backdrop], screenshot: cell.screenshot, box: t.box },
            },
            [t.path, cell.context, "border"],
          ),
        );
      } else if (!t.hasText && !t.textEntry && t.icon) {
        if (stats) stats.iconsChecked++;
        const r = contrastRatio(t.icon, t.fill) ?? 21;
        if (r >= need) continue;
        out.push(
          makeFinding(
            {
              ...base(cell),
              category: "icon-contrast",
              severity: "medium",
              title: `${t.label}: icon ${t.icon} is ${fmt(r)} against ${t.fill}, needs ${need}:1`,
              component: t.label,
              property: "icon",
              expected: { value: `${need}:1`, source: "WCAG 2.2 AA 1.4.11" },
              actual: { value: fmt(r), source: `${t.icon} on ${t.fill}` },
              links: { source: t.path },
              evidence: { swatches: [t.icon, t.fill], screenshot: cell.screenshot, box: t.box },
            },
            [t.path, cell.context, "icon"],
          ),
        );
      }
    }
  }
  return out;
}
