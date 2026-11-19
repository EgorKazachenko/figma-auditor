import type { SnapshotCell } from "./types.js";
import { parseColor } from "./color.js";

/**
 * The capture contract: what any driver (web, Storybook, Android, iOS, Flutter) must write so that the
 * checks can run on it. Checks read only SnapshotCell; they never see the driver.
 *
 * Style vocabulary = CSS property names with computed-value syntax, because they are a published standard
 * and cover what design tools describe. Lengths are layout units in px (CSS px, Android dp and iOS pt are
 * all equal to Figma units); colours are rgb()/rgba() or hex. A native driver maps its own properties onto
 * these names (UIView.backgroundColor → background-color, layer.cornerRadius → border-*-radius,
 * TextView maxLines + ellipsize → -webkit-line-clamp + text-overflow, …).
 *
 * Optional cell sections, each read by one check and skipped when absent:
 * - texts (C8): every text with its painted colour and backdrop;
 * - targets (C9): every interactive element with box, inline/disabled/hidden flags, fill, backdrop, border
 *   and icon colour (opaque hex as painted) — native drivers map accessibility nodes (Android clickable /
 *   focusable views, iOS accessibility elements with button traits) to the same fields;
 * - focus (C9): the keyboard-focused element as it looks focused and unfocused (FocusSample);
 * - zoom, locale: the matrix variant the cell was rendered in (informational; `viewport` names the variant).
 */
export const CELL_CONTRACT_VERSION = 1;

type Kind = "color" | "length" | "lengths" | "number" | "keyword" | "shadow" | "font-family";
interface StyleProp {
  kind: Kind;
  /** Checks that read it. A driver that cannot provide a property simply omits it; those checks skip it. */
  usedBy: string[];
}

export const STYLE_PROPERTIES: Record<string, StyleProp> = {
  color: { kind: "color", usedBy: ["C3", "C7", "C8"] },
  "background-color": { kind: "color", usedBy: ["C3", "C7"] },
  "border-top-color": { kind: "color", usedBy: ["C3", "C7"] },
  "border-right-color": { kind: "color", usedBy: ["C3"] },
  "border-bottom-color": { kind: "color", usedBy: ["C3"] },
  "border-left-color": { kind: "color", usedBy: ["C3"] },
  "border-top-width": { kind: "length", usedBy: ["C3", "C7"] },
  "border-right-width": { kind: "length", usedBy: ["C3"] },
  "border-bottom-width": { kind: "length", usedBy: ["C3"] },
  "border-left-width": { kind: "length", usedBy: ["C3"] },
  "padding-top": { kind: "length", usedBy: ["C3", "C4", "C7"] },
  "padding-right": { kind: "length", usedBy: ["C3", "C4", "C7"] },
  "padding-bottom": { kind: "length", usedBy: ["C3", "C4", "C7"] },
  "padding-left": { kind: "length", usedBy: ["C3", "C4", "C7"] },
  "margin-top": { kind: "length", usedBy: ["C3", "C4"] },
  "margin-right": { kind: "length", usedBy: ["C3", "C4"] },
  "margin-bottom": { kind: "length", usedBy: ["C3", "C4"] },
  "margin-left": { kind: "length", usedBy: ["C3", "C4"] },
  gap: { kind: "lengths", usedBy: ["C3", "C4", "C7"] },
  "row-gap": { kind: "length", usedBy: ["C3"] },
  "column-gap": { kind: "length", usedBy: ["C3"] },
  "border-top-left-radius": { kind: "length", usedBy: ["C3", "C7"] },
  "border-top-right-radius": { kind: "length", usedBy: ["C3"] },
  "border-bottom-right-radius": { kind: "length", usedBy: ["C3"] },
  "border-bottom-left-radius": { kind: "length", usedBy: ["C3"] },
  "font-family": { kind: "font-family", usedBy: ["C7"] },
  "font-size": { kind: "length", usedBy: ["C3", "C7", "C8"] },
  "font-weight": { kind: "number", usedBy: ["C7", "C8"] },
  "line-height": { kind: "length", usedBy: ["C7"] },
  "letter-spacing": { kind: "length", usedBy: [] },
  "box-shadow": { kind: "shadow", usedBy: ["C7"] },
  opacity: { kind: "number", usedBy: ["C8"] },
  "overflow-x": { kind: "keyword", usedBy: ["C5"] },
  "overflow-y": { kind: "keyword", usedBy: ["C5"] },
  "text-overflow": { kind: "keyword", usedBy: ["C5"] },
  "white-space": { kind: "keyword", usedBy: ["C5"] },
  "-webkit-line-clamp": { kind: "keyword", usedBy: ["C5"] },
  display: { kind: "keyword", usedBy: [] },
  position: { kind: "keyword", usedBy: [] },
  "z-index": { kind: "keyword", usedBy: [] },
  "flex-direction": { kind: "keyword", usedBy: ["C4"] },
  "align-items": { kind: "keyword", usedBy: [] },
  "justify-content": { kind: "keyword", usedBy: [] },
};

const LENGTH = /^-?\d*\.?\d+px$/;
const isLength = (v: string) => LENGTH.test(v) || v === "0" || v === "normal" || v === "auto";

function valueProblem(kind: Kind, v: string): string | null {
  switch (kind) {
    case "color":
      return parseColor(v) ? null : "expected rgb(), rgba() or hex";
    case "length":
      return isLength(v) || /^\d*\.?\d+%$/.test(v) || v === "none" ? null : "expected a length in px";
    case "lengths":
      return v.split(/\s+/).every(isLength) ? null : "expected one or two lengths in px";
    case "number":
      return /^-?\d*\.?\d+$/.test(v) || v === "normal" ? null : "expected a number";
    case "shadow":
      return v === "none" || /\d+px/.test(v) ? null : "expected none or CSS box-shadow syntax";
    default:
      return null;
  }
}

/**
 * Problems in a cell written by a driver, so a new driver learns what is wrong before checks quietly skip
 * its data. Unknown style properties are allowed (drivers may add their own); known ones must parse.
 */
export function validateCell(cell: unknown, where = "cell"): string[] {
  const out: string[] = [];
  const c = cell as Partial<SnapshotCell> | null;
  if (!c || typeof c !== "object") return [`${where}: not an object`];
  for (const k of ["surface", "state", "context", "browser"] as const)
    if (typeof c[k] !== "string" || !c[k]) out.push(`${where}: "${k}" must be a non-empty string`);
  if (!c.tokens || typeof c.tokens !== "object") out.push(`${where}: "tokens" must map token names to { raw, color }`);
  if (!Array.isArray(c.nodes)) return [...out, `${where}: "nodes" must be a list`];
  c.nodes.forEach((n, i) => {
    const at = `${where}: nodes[${i}]`;
    if (!n || typeof n !== "object") return void out.push(`${at}: not an object`);
    if (!n.testId && !n.component && !n.path) out.push(`${at}: needs testId, component or path to be identified`);
    const b = n.box;
    if (!b || ![b.x, b.y, b.width, b.height].every((x) => typeof x === "number" && Number.isFinite(x))) out.push(`${at}: "box" needs numeric x, y, width, height`);
    if (!n.css || typeof n.css !== "object") return void out.push(`${at}: "css" (style record) is missing`);
    for (const [prop, value] of Object.entries(n.css)) {
      const spec = STYLE_PROPERTIES[prop];
      if (!spec || value === "" || value === undefined) continue;
      const problem = valueProblem(spec.kind, String(value));
      if (problem) out.push(`${at}: ${prop} "${value}": ${problem}`);
    }
  });
  if (c.targets !== undefined) {
    if (!Array.isArray(c.targets)) out.push(`${where}: "targets" must be a list`);
    else
      c.targets.forEach((t, i) => {
        const b = t?.box;
        if (!b || ![b.x, b.y, b.width, b.height].every((x) => typeof x === "number" && Number.isFinite(x))) out.push(`${where}: targets[${i}]: "box" needs numeric x, y, width, height`);
        for (const k of ["fill", "backdrop"] as const) if (t && typeof t[k] === "string" && !parseColor(t[k])) out.push(`${where}: targets[${i}]: ${k} "${t[k]}": expected rgb(), rgba() or hex`);
      });
  }
  if (c.focus !== undefined && c.focus !== null && (typeof c.focus !== "object" || !c.focus.focused)) out.push(`${where}: "focus" must be null or { focused, rest, … }`);
  if (out.length > 20) return [...out.slice(0, 20), `${where}: …and ${out.length - 20} more`];
  return out;
}
