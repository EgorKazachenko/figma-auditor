import { readFileSync } from "node:fs";
import type { ReferenceToken } from "../types.js";
import { tokenKey } from "../names.js";
import { parseColor, toHex } from "../color.js";

/** One layer of a Figma component variant, as captured by scripts/figma-extract-components.js. */
export interface FigmaLayer {
  path: string;
  type: string;
  box: [number, number, number, number];
  pad?: [number, number, number, number];
  gap?: number;
  align?: [string, string];
  mode?: string;
  sizing?: [string, string];
  radius?: number;
  /** `v`: the variable's WEB code syntax; `var`: its Figma identity (REST pulls), which tells apart two variables exporting one CSS name. */
  fill?: PaintSpec;
  stroke?: PaintSpec & { w: number };
  shadow?: { x: number; y: number; blur: number; spread: number; c: string; style?: string };
  text?: { chars: string; size: number; weight: number; font: string; lh: string; color?: PaintSpec; style?: string };
  instanceOf?: string;
  iconColor?: PaintSpec;
}

export interface PaintSpec {
  c: string;
  v?: string;
  var?: { id: string; name?: string };
}

export interface FigmaVariant {
  id: string;
  name: string;
  layers: FigmaLayer[];
}

export interface FigmaComponentSet {
  id: string;
  name: string;
  page: string;
  variantProps: Record<string, string[]>;
  variants: FigmaVariant[];
  fileKey?: string;
  fileName?: string;
}

export function loadComponentSets(paths: string[]): FigmaComponentSet[] {
  const out: FigmaComponentSet[] = [];
  for (const p of paths) {
    const json = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(json?.sets)) throw new Error(`${p}: expected a "sets" list (see scripts/figma-extract-components.js)`);
    for (const s of json.sets as FigmaComponentSet[]) out.push({ ...s, fileKey: json.source?.fileKey, fileName: json.source?.fileName });
  }
  return out;
}

/** "State=Hover, Size=M" → { State: "Hover", Size: "M" } */
export function variantProps(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}

export function findVariant(set: FigmaComponentSet, name: string): FigmaVariant | undefined {
  const want = variantProps(name);
  return set.variants.find((v) => {
    const have = variantProps(v.name);
    return Object.entries(want).every(([k, val]) => have[k] === val);
  });
}

export function variantUrl(set: FigmaComponentSet, variant: FigmaVariant): string | undefined {
  return set.fileKey ? `https://www.figma.com/design/${set.fileKey}/?node-id=${variant.id.replace(/:/g, "-")}` : undefined;
}

export interface ResolvedVar {
  value: string;
  from: "tokens" | "component";
  /** The layer paints the variable at its own opacity (Figma keeps that override in every mode). */
  opacityOverride?: { layer: number; variable: number };
}

/**
 * Value of a Figma variable in a mode. Token captures (per mode) come first; the component file's own
 * colour is the library's default mode and is only used for that mode. When the layer's paint has a
 * different opacity than the variable (Figma stores the variable's alpha as paint opacity, and a designer
 * can change it), the mode's colour is scaled by the same ratio, as Figma renders it.
 */
export function makeVariableResolver(tokens: ReferenceToken[], defaultMode = "light") {
  const byKey = new Map<string, Map<string, string>>();
  for (const t of tokens) {
    if (t.kind !== "color") continue;
    const k = tokenKey(t.figmaName);
    const modes = byKey.get(k) ?? new Map<string, string>();
    modes.set(t.mode, t.value);
    byKey.set(k, modes);
  }
  return (variable: string | undefined, mode: string, layerColor?: string): ResolvedVar | null => {
    const modes = variable ? byKey.get(tokenKey(variable)) : undefined;
    const own = modes?.get(mode);
    if (own) {
      const def = parseColor(modes?.get(defaultMode) ?? "");
      const layer = layerColor ? parseColor(layerColor) : null;
      const value = parseColor(own);
      if (def && layer && value && Math.abs(def.a - layer.a) > 0.02) {
        const a = Math.min(1, def.a > 0 ? value.a * (layer.a / def.a) : layer.a);
        return { value: toHex({ ...value, a }), from: "tokens", opacityOverride: { layer: layer.a, variable: def.a } };
      }
      return { value: own, from: "tokens" };
    }
    if (layerColor && mode === defaultMode) return { value: layerColor, from: "component" };
    return null;
  };
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  c: string;
  style?: string;
}

/** "Effect(type: DROP_SHADOW, color: #0000004D, offset: (0, 6), radius: 20, spread: 0)" → shadow */
export function parseFigmaEffect(value: string): Shadow | null {
  const color = /color:\s*(#[0-9a-f]{6,8})/i.exec(value)?.[1];
  const off = /offset:\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i.exec(value);
  const blur = /radius:\s*([\d.]+)/i.exec(value)?.[1];
  const spread = /spread:\s*(-?[\d.]+)/i.exec(value)?.[1];
  if (!/DROP_SHADOW/i.test(value) || !color || !off) return null;
  return { x: Number(off[1]), y: Number(off[2]), blur: Number(blur ?? 0), spread: Number(spread ?? 0), c: color.toLowerCase() };
}

/**
 * Shadow a layer should have in a context. Effect styles are not mode-aware in Figma, so libraries keep
 * pairs such as ElevationShadow/Light/E5 and ElevationShadow/Dark/E5; the pair member for the context's
 * colour scheme is looked up in the reference captures. Returns null when that member was not captured.
 */
export function makeEffectResolver(tokens: ReferenceToken[]) {
  const effects = new Map<string, string>();
  for (const t of tokens) if (t.kind === "effect") effects.set(t.figmaName, t.value);
  return (layer: Shadow, colorScheme: "light" | "dark"): Shadow | null => {
    if (!layer.style) return layer;
    const want = colorScheme === "dark" ? layer.style.replace(/\/Light\//, "/Dark/") : layer.style.replace(/\/Dark\//, "/Light/");
    const captured = effects.get(want);
    if (captured) {
      const s = parseFigmaEffect(captured);
      return s ? { ...s, style: want } : null;
    }
    return want === layer.style ? layer : null;
  };
}
