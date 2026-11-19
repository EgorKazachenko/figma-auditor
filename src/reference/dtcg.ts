import type { ReferenceToken } from "../types.js";
import { toHex } from "../color.js";

/**
 * Design Tokens Format Module 2025.10 (W3C DTCG): the tool-neutral token format that Tokens Studio,
 * Style Dictionary v4, Figma variable exports, Penpot and others read or write. With this adapter a
 * product whose design source is not Figma, or whose tokens ship as JSON (web, iOS, Android, Flutter),
 * feeds the same checks.
 *
 * One file holds one mode (DTCG resolver contexts such as light/dark are exported as separate files).
 * Supported: nested groups, inherited `$type`, `{group.token}` aliases and `$ref` JSON pointers, colour
 * objects (sRGB) and legacy hex strings, dimensions as `{ value, unit }` or "8px"/"0.5rem", numbers,
 * shadows (first layer) and typography. Tokens of other types or colour spaces are skipped with a warning.
 */

export interface DtcgOptions {
  mode: string;
  origin?: string;
  /**
   * How a token path becomes a name the code uses. `{path}` is the path joined with `separator`.
   * Default "--{path}" with "-": color.text.2 → --color-text-2, matching CSS custom properties.
   */
  nameTemplate?: string;
  separator?: string;
  /** Root font size for rem dimensions. */
  remPx?: number;
  url?: string;
}

interface Found {
  path: string[];
  type?: string;
  value: unknown;
}

const isGroupKey = (k: string) => !k.startsWith("$");

function walk(node: any, path: string[], inheritedType: string | undefined, out: Found[]) {
  if (!node || typeof node !== "object") return;
  const type = typeof node.$type === "string" ? node.$type : inheritedType;
  if ("$value" in node || "$ref" in node) {
    out.push({ path, type, value: "$value" in node ? node.$value : { $ref: node.$ref } });
    return;
  }
  for (const [k, child] of Object.entries(node)) if (isGroupKey(k)) walk(child, [...path, k], type, out);
}

function pointer(root: any, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

const n = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)) ? Number(x) : null);

export function dtcgColor(v: unknown): string | null {
  if (typeof v === "string") return /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim().toLowerCase() : null;
  if (!v || typeof v !== "object") return null;
  const c = v as { colorSpace?: string; components?: unknown[]; alpha?: number; hex?: string };
  const alpha = typeof c.alpha === "number" ? c.alpha : 1;
  if ((c.colorSpace ?? "srgb") === "srgb" && Array.isArray(c.components) && c.components.length === 3) {
    const [r, g, b] = c.components.map((x) => (x === "none" ? 0 : n(x)));
    if (r === null || g === null || b === null || r === undefined || g === undefined || b === undefined) return null;
    return toHex({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: alpha });
  }
  // Other colour spaces: use the sRGB hex fallback the spec allows next to them.
  if (typeof c.hex === "string" && /^#[0-9a-f]{6}$/i.test(c.hex)) {
    const hex = c.hex.toLowerCase();
    return alpha < 1 ? `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : hex;
  }
  return null;
}

export function dtcgDimension(v: unknown, remPx = 16): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = /^(-?\d*\.?\d+)\s*(px|rem)?$/.exec(v.trim());
    if (!m) return null;
    return m[2] === "rem" ? Number(m[1]) * remPx : Number(m[1]);
  }
  if (v && typeof v === "object") {
    const d = v as { value?: unknown; unit?: string };
    const value = n(d.value);
    if (value === null) return null;
    if (!d.unit || d.unit === "px") return value;
    if (d.unit === "rem") return value * remPx;
  }
  return null;
}

/** Same text the Figma MCP capture uses, so the C7 effect resolver reads both. */
function effectText(v: unknown, remPx: number): string | null {
  const layer = Array.isArray(v) ? v[0] : v;
  if (!layer || typeof layer !== "object") return null;
  const s = layer as Record<string, unknown>;
  if (s.inset === true) return null;
  const color = dtcgColor(s.color);
  const x = dtcgDimension(s.offsetX, remPx);
  const y = dtcgDimension(s.offsetY, remPx);
  if (!color || x === null || y === null) return null;
  const hex = color.length === 7 ? `${color}ff` : color;
  return `Effect(type: DROP_SHADOW, color: ${hex.toUpperCase()}, offset: (${x}, ${y}), radius: ${dtcgDimension(s.blur, remPx) ?? 0}, spread: ${dtcgDimension(s.spread, remPx) ?? 0})`;
}

function fontText(v: unknown, remPx: number): string | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const family = Array.isArray(t.fontFamily) ? t.fontFamily[0] : t.fontFamily;
  const size = dtcgDimension(t.fontSize, remPx);
  if (typeof family !== "string" || size === null) return null;
  const lh = typeof t.lineHeight === "number" ? Math.round(t.lineHeight * 100) : 100;
  return `Font(family: "${family}", size: ${size}, weight: ${n(t.fontWeight) ?? 400}, lineHeight: ${lh}, letterSpacing: ${dtcgDimension(t.letterSpacing, remPx) ?? 0})`;
}

export function fromDtcg(json: unknown, opts: DtcgOptions): { tokens: ReferenceToken[]; warnings: string[] } {
  const origin = opts.origin ?? "dtcg";
  if (!json || typeof json !== "object") throw new Error(`${origin}: expected a DTCG token object`);
  const remPx = opts.remPx ?? 16;
  const sep = opts.separator ?? "-";
  const template = opts.nameTemplate ?? "--{path}";
  const found: Found[] = [];
  walk(json, [], undefined, found);
  const byPath = new Map(found.map((f) => [f.path.join("."), f]));
  const warnings: string[] = [];

  const resolve = (f: Found, seen: Set<string>): { value: unknown; type?: string } | null => {
    let v = f.value;
    let type = f.type;
    for (;;) {
      if (typeof v === "string" && /^\{[^{}]+\}$/.test(v)) {
        const target = v.slice(1, -1);
        if (seen.has(target)) {
          warnings.push(`${origin}: alias cycle at ${f.path.join(".")}`);
          return null;
        }
        seen.add(target);
        const next = byPath.get(target);
        if (!next) {
          warnings.push(`${origin}: ${f.path.join(".")} points to missing ${target}`);
          return null;
        }
        v = next.value;
        type = type ?? next.type;
        continue;
      }
      if (v && typeof v === "object" && "$ref" in (v as object)) {
        const ref = String((v as { $ref: unknown }).$ref);
        if (seen.has(ref)) {
          warnings.push(`${origin}: $ref cycle at ${f.path.join(".")}`);
          return null;
        }
        seen.add(ref);
        const target = pointer(json, ref);
        if (target === undefined) {
          warnings.push(`${origin}: ${f.path.join(".")} has a broken $ref ${ref}`);
          return null;
        }
        if (target && typeof target === "object" && "$value" in (target as object)) {
          type = type ?? (target as { $type?: string }).$type;
          v = (target as { $value: unknown }).$value;
        } else v = target;
        continue;
      }
      return { value: v, type };
    }
  };

  const tokens: ReferenceToken[] = [];
  for (const f of found) {
    const r = resolve(f, new Set([f.path.join(".")]));
    if (!r) continue;
    const path = f.path.join(sep);
    const name = template.replace("{path}", path);
    let kind: ReferenceToken["kind"];
    let value: string | null;
    switch (r.type) {
      case "color":
        kind = "color";
        value = dtcgColor(r.value);
        break;
      case "dimension":
      case "number":
      case "fontWeight":
      case "duration":
        kind = "number";
        value = r.type === "duration" ? null : String(r.type === "dimension" ? dtcgDimension(r.value, remPx) : n(r.value));
        if (value === "null") value = null;
        break;
      case "shadow":
        kind = "effect";
        value = effectText(r.value, remPx);
        break;
      case "typography":
        kind = "font";
        value = fontText(r.value, remPx);
        break;
      default:
        kind = "other";
        value = typeof r.value === "string" ? r.value : null;
    }
    if (value === null) {
      warnings.push(`${origin}: skipped ${f.path.join(".")} (${r.type ?? "no $type"} value not supported)`);
      continue;
    }
    tokens.push({
      name: name.startsWith("--") ? name.toLowerCase() : name,
      figmaName: name.startsWith("--") ? `var(${name.toLowerCase()})` : f.path.join("."),
      kind,
      mode: opts.mode,
      value,
      source: { type: "dtcg", fileName: origin, url: opts.url },
    });
  }
  return { tokens, warnings };
}
