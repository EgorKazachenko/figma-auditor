import type { Finding, SnapshotCell, TextSample } from "../types.js";
import { parseColor, type RGBA } from "../color.js";
import { cellWhere, makeFinding } from "../findings.js";

/**
 * C8 · text contrast, WCAG 2.2 success criterion 1.4.3 (AA): 4.5:1 for normal text, 3:1 for large text
 * (at least 24 px, or 18.66 px and bold). Reads only the captured cells: every text the probe found, with
 * the colours as painted (ancestors' backgrounds and opacity composited).
 *
 * Not judged, by design: disabled controls (exempt in WCAG), text whose backdrop cannot be known from
 * styles (image, gradient, filter, another element under it), text scrolled out of view. The counts go
 * to the notes so "no findings" never hides "not checked".
 */

export interface C8Options {
  /** Ratio below which normal text fails; WCAG AA = 4.5. */
  normal?: number;
  /** Ratio below which large text fails; WCAG AA = 3. */
  large?: number;
}

export interface C8Stats {
  checked: number;
  disabled: number;
  unknownBackdrop: number;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque sRGB colour. */
export function luminance(c: RGBA): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio of two colours (1..21). Translucent colours must be composited first. */
export function contrastRatio(a: string | RGBA, b: string | RGBA): number | null {
  const x = typeof a === "string" ? parseColor(a) : a;
  const y = typeof b === "string" ? parseColor(b) : b;
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG large text: 18 pt (24 px) regular, or 14 pt (18.66 px) bold. */
export function isLargeText(fontSizePx: number, weight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && weight >= 700);
}

const fmt = (r: number) => `${Math.floor(r * 100) / 100}:1`;

export function checkContrast(cells: SnapshotCell[], opts: C8Options = {}, stats?: C8Stats): Finding[] {
  const normal = opts.normal ?? 4.5;
  const large = opts.large ?? 3;
  const out: Finding[] = [];
  for (const cell of cells) {
    for (const t of samplesOf(cell)) {
      if (t.viewFraction === 0) continue;
      if (t.disabled) {
        if (stats) stats.disabled++;
        continue;
      }
      if (t.bgUnknown) {
        if (stats) stats.unknownBackdrop++;
        continue;
      }
      const ratio = contrastRatio(t.fg, t.bg);
      if (ratio === null) continue;
      if (stats) stats.checked++;
      const big = isLargeText(t.fontSize, t.fontWeight);
      const need = big ? large : normal;
      if (ratio >= need) continue;
      const severity: Finding["severity"] = !big && ratio < 3 ? "high" : "medium";
      out.push(
        makeFinding(
          {
            check: "C8",
            category: "text-contrast",
            gap: "B",
            severity,
            title: `${t.anchor} "${t.text.slice(0, 40)}": contrast ${fmt(ratio)} (${t.fg} on ${t.bg}), needs ${need}:1 for ${big ? "large" : "normal"} text`,
            component: t.anchor,
            context: cell.context,
            cell: cellWhere(cell),
            property: "contrast",
            expected: { value: `${need}:1`, source: `WCAG 2.2 AA 1.4.3, ${big ? "large" : "normal"} text (${t.fontSize}px, ${t.fontWeight})` },
            actual: { value: fmt(ratio), source: `${t.fg} on ${t.bg}` },
            links: { source: t.path },
            evidence: { swatches: [t.fg, t.bg], screenshot: cell.screenshot, box: t.box },
          },
          // The same text in the same theme is one finding across states and viewports.
          [t.path, t.text.slice(0, 40), cell.context],
        ),
      );
    }
  }
  return out;
}

/** Texts from the page-wide text scan; captures without it fall back to collected elements with own text. */
export function samplesOf(cell: SnapshotCell): TextSample[] {
  if (cell.texts) return cell.texts;
  const out: TextSample[] = [];
  for (const n of cell.nodes) {
    const c = n.layout?.contrast;
    if (!n.hasText || !c) continue;
    out.push({
      ...c,
      path: n.path,
      anchor: n.testId ? `[data-testid="${n.testId}"]` : n.component ? `[data-ds-component="${n.component}"]` : n.path,
      text: n.text,
      box: n.box,
      fontSize: parseFloat(n.css["font-size"] ?? "16") || 16,
      fontWeight: Number(n.css["font-weight"] ?? 400) || 400,
      disabled: false,
      viewFraction: n.layout?.viewFraction ?? 1,
    });
  }
  return out;
}
