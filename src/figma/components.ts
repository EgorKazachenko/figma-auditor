import { toHex } from "../color.js";
import type { FigmaComponentSet, FigmaLayer, FigmaVariant } from "../reference/components.js";
import type { VariableGraph } from "./variables.js";

/**
 * Component sets from the Figma REST API (GET /v1/files/:key/nodes?ids=…), turned into the same reference
 * format scripts/figma-extract-components.js produces through the plugin API, so C7 reads either.
 * Colours keep the bound variable: `v` is its WEB code syntax (what code uses), `var` its Figma identity,
 * so two Figma variables that export the same CSS name stay apart.
 */

interface RestNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: RestNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  layoutMode?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  cornerRadius?: number;
  fills?: any[];
  strokes?: any[];
  strokeWeight?: number;
  effects?: any[];
  styles?: Record<string, string>;
  style?: { fontFamily?: string; fontWeight?: number; fontSize?: number; lineHeightPx?: number; lineHeightUnit?: string; lineHeightPercentFontSize?: number };
  characters?: string;
  componentId?: string;
  componentPropertyDefinitions?: Record<string, { type: string; variantOptions?: string[] }>;
}

interface NodesEntry {
  document: RestNode;
  components?: Record<string, { name: string; componentSetId?: string }>;
  componentSets?: Record<string, { name: string }>;
  styles?: Record<string, { name: string; styleType: string }>;
}

const hex = (c: { r: number; g: number; b: number; a?: number }, opacity = 1) =>
  toHex({ r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a: (c.a ?? 1) * opacity });

export function extractSetsFromNodes(
  entries: NodesEntry[],
  graph: VariableGraph | null,
  opts: { fileKey: string; fileName?: string; page?: string; iconPrefixes?: string[] },
): FigmaComponentSet[] {
  const iconPrefixes = opts.iconPrefixes ?? ["Icons/", "Neon/"];
  const tracked = new Set(entries.map((e) => e.document.name));
  const varRef = (id: string | undefined) => {
    if (!id) return {};
    const v = graph?.variables.get(id);
    return { v: v?.codeSyntax?.WEB ?? v?.name, var: { id, name: v?.name } };
  };
  const paint = (list: any[] | undefined) => {
    const p = (list ?? []).find((x) => x.visible !== false && x.type === "SOLID" && x.color);
    return p ? { c: hex(p.color, p.opacity ?? 1), ...varRef(p.boundVariables?.color?.id) } : undefined;
  };

  return entries.map((entry) => {
    const set = entry.document;
    const props: Record<string, string[]> = {};
    for (const [k, d] of Object.entries(set.componentPropertyDefinitions ?? {})) if (d.type === "VARIANT") props[k] = d.variantOptions ?? [];
    const styleName = (id: string | undefined) => (id ? entry.styles?.[id]?.name : undefined);

    const walk = (n: RestNode, root: RestNode, path: string, out: FigmaLayer[]) => {
      if (n.visible === false) return;
      const bb = n.absoluteBoundingBox;
      const rb = root.absoluteBoundingBox;
      const L: FigmaLayer & Record<string, unknown> = {
        path,
        type: n.type,
        box: bb && rb ? [Math.round(bb.x - rb.x), Math.round(bb.y - rb.y), Math.round(bb.width), Math.round(bb.height)] : [0, 0, 0, 0],
      };
      if (n.layoutMode && n.layoutMode !== "NONE") {
        L.pad = [n.paddingTop ?? 0, n.paddingRight ?? 0, n.paddingBottom ?? 0, n.paddingLeft ?? 0];
        L.gap = n.itemSpacing ?? 0;
        L.align = [n.primaryAxisAlignItems ?? "MIN", n.counterAxisAlignItems ?? "MIN"];
        L.mode = n.layoutMode;
      }
      if (n.layoutSizingHorizontal || n.layoutSizingVertical) L.sizing = [n.layoutSizingHorizontal ?? "FIXED", n.layoutSizingVertical ?? "FIXED"];
      if (typeof n.cornerRadius === "number" && n.cornerRadius) L.radius = n.cornerRadius;
      if (n.type !== "TEXT") {
        const f = paint(n.fills);
        if (f) L.fill = f;
      }
      const s = paint(n.strokes);
      if (s) L.stroke = { ...s, w: n.strokeWeight ?? 1 };
      const e = (n.effects ?? []).find((x) => x.visible !== false && x.type === "DROP_SHADOW");
      if (e) L.shadow = { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0, blur: e.radius ?? 0, spread: e.spread ?? 0, c: hex(e.color), style: styleName(n.styles?.effect) };
      if (n.type === "TEXT" && n.style) {
        const st = n.style;
        const lh = st.lineHeightUnit === "PIXELS" ? `${st.lineHeightPx}px` : st.lineHeightUnit === "FONT_SIZE_%" ? `${st.lineHeightPercentFontSize}%` : "auto";
        L.text = { chars: (n.characters ?? "").slice(0, 30), size: st.fontSize ?? 0, weight: st.fontWeight ?? 400, font: st.fontFamily ?? "", lh, color: paint(n.fills), style: styleName(n.styles?.text) };
      }
      if (n.type === "INSTANCE" && n.componentId) {
        const comp = entry.components?.[n.componentId];
        const setName = comp?.componentSetId ? entry.componentSets?.[comp.componentSetId]?.name : comp?.name;
        L.instanceOf = comp?.componentSetId ? `${setName} / ${comp.name}` : (setName ?? "?");
        if (setName && tracked.has(setName)) return void out.push(L);
        if (setName && iconPrefixes.some((p) => setName.startsWith(p))) {
          const vec = findFirst(n, (x) => x.visible !== false && Array.isArray(x.strokes) && x.strokes.length > 0);
          const ic = vec ? paint(vec.strokes) : undefined;
          if (ic) L.iconColor = ic;
          return void out.push(L);
        }
      }
      out.push(L);
      for (const c of n.children ?? []) walk(c, root, `${path}/${c.name}`, out);
    };

    const variants: FigmaVariant[] = (set.children ?? [])
      .filter((v) => v.type === "COMPONENT")
      .map((v) => {
        const layers: FigmaLayer[] = [];
        walk(v, v, "", layers);
        if (layers[0]) layers[0].path = ".";
        return { id: v.id, name: v.name, layers };
      });
    return { id: set.id, name: set.name, page: opts.page ?? "", variantProps: props, variants, fileKey: opts.fileKey, fileName: opts.fileName };
  });
}

function findFirst(n: RestNode, pred: (x: RestNode) => boolean): RestNode | undefined {
  for (const c of n.children ?? []) {
    if (pred(c)) return c;
    const deep = findFirst(c, pred);
    if (deep) return deep;
  }
  return undefined;
}
