import type { Context, Finding, SnapshotCell, SnapshotNode } from "../types.js";
import { colorDistance, isTransparent, normalizeColor, parseColor, toHex } from "../color.js";
import { makeFinding, cellWhere } from "../findings.js";
import { tokenKey } from "../names.js";
import {
  findVariant,
  variantUrl,
  type FigmaComponentSet,
  type FigmaLayer,
  type FigmaVariant,
  type makeEffectResolver,
  type makeVariableResolver,
} from "../reference/components.js";

/** Where a Figma component lives in the product and which captured state shows each variant. */
export interface ComponentMapping {
  figma: string;
  /** `[data-testid=…]` or `[data-ds-component=…]` */
  element: string;
  /** Compare against this layer of the variant instead of its root, e.g. "/Menu". */
  layer?: string;
  /** Figma variant name → captured state (and which match, 0-based), or null when the product cannot show it. */
  variants: Record<string, { state: string; nth?: number } | null>;
  /** Figma text layer name → element inside the component. Unlisted text layers are paired by position. */
  text?: Record<string, string>;
  /** Compare only these: background, border, radius, padding, gap, width, height, shadow, text. Default: all. */
  properties?: C7Property[];
}

export const C7_PROPERTIES = ["background", "border", "radius", "padding", "gap", "width", "height", "shadow", "text"] as const;
export type C7Property = (typeof C7_PROPERTIES)[number];

export interface C7Options {
  sets: FigmaComponentSet[];
  mappings: ComponentMapping[];
  contexts: Context[];
  resolveVar: ReturnType<typeof makeVariableResolver>;
  /** Shadow per colour scheme (Light/Dark effect style pairs). Without it the layer's shadow is used as is. */
  resolveEffect?: ReturnType<typeof makeEffectResolver>;
  colorDeltaE: number;
  px: number;
  /** Filled with "variable (mode)" for colours the reference has no value for; those are not compared. */
  unresolved?: Set<string>;
  /** Exact value of a Figma variable (by id) in a mode, from a figma-rest graph; null when it cannot be resolved. */
  resolveVarId?: (id: string, mode: string) => string | null;
  /** CSS names exported by more than one Figma variable: code syntax → variable names. */
  codeSyntaxCollisions?: Map<string, string[]>;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pxOf = (v: string | undefined) => (v && /^-?\d+(\.\d+)?px$/.test(v.trim()) ? parseFloat(v) : null);
// Figma's "SF Pro" is what these resolve to on macOS.
const SYSTEM_FONT_ALIASES = ["sf pro", "-apple-system", "system-ui", "blinkmacsystemfont", "ui-sans-serif"];

export function parseSelector(sel: string): { attr: "testId" | "component"; value: string } | null {
  const m = /^\[\s*data-(testid|ds-component)\s*=\s*["']?([^"'\]]+)["']?\s*\]$/.exec(sel.trim());
  if (!m) return null;
  return { attr: m[1] === "testid" ? "testId" : "component", value: m[2]! };
}

/**
 * Elements a mapping selector points at. `[data-testid=…]` and `[data-ds-component=…]` are matched on the
 * snapshot; any other CSS selector is matched in the page by the probe (see `extraSelectors`).
 */
export function matchNodes(nodes: SnapshotNode[], sel: string): SnapshotNode[] {
  const p = parseSelector(sel);
  if (!p) return nodes.filter((n) => n.matches?.includes(sel));
  return nodes.filter((n) => (p.attr === "testId" ? n.testId : n.component) === p.value);
}

/** Mapping selectors the probe has to collect and tag itself, because the snapshot cannot match them. */
export function extraSelectors(mappings: { element: string; text?: Record<string, string> }[]): string[] {
  const all = mappings.flatMap((m) => [m.element, ...Object.values(m.text ?? {})]);
  return [...new Set(all.filter((s) => !parseSelector(s)))];
}

/** Parses the first layer of a computed box-shadow: "rgba(23, 26, 28, 0.12) 0px 6px 16px 0px". */
export function parseShadow(css: string | undefined): { x: number; y: number; blur: number; spread: number; color: string } | null {
  if (!css || css === "none") return null;
  // Tailwind composes ring and shadow layers; transparent ones paint nothing.
  for (const part of css.split(/,(?![^(]*\))/)) {
    const layer = part.trim();
    if (/\binset\b/.test(layer)) continue;
    const color = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(layer)?.[1];
    const nums = layer.replace(color ?? "", "").trim().split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
    if (!color || nums.length < 2 || isTransparent(color)) continue;
    return { x: nums[0]!, y: nums[1]!, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color };
  }
  return null;
}

function descendantsWithText(nodes: SnapshotNode[], root: SnapshotNode): SnapshotNode[] {
  const id = root.layout?.id;
  const inside = nodes.filter((n) => n !== root && id !== undefined && n.layout?.ancestors.includes(id) && n.hasText);
  const list = inside.length ? inside : root.hasText ? [root] : [];
  return [...list].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/**
 * Code tokens whose value in this cell matches a colour, to say which token the product probably used.
 * Tokens named after the element (e.g. --color-model-selector-bg for model-selector-menu) come first.
 */
export function tokensFor(cell: SnapshotCell, color: string, backdrop: string, hint = ""): string[] {
  const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const scored: { name: string; d: number; score: number }[] = [];
  for (const [name, v] of Object.entries(cell.tokens)) {
    if (!v.color) continue;
    const d = colorDistance(v.color, color, backdrop);
    if (d === null || d > 1) continue;
    const score = words.filter((w) => name.toLowerCase().includes(w)).length;
    scored.push({ name, d, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((t) => t.name);
}

export function checkFigmaStates(cells: SnapshotCell[], opts: C7Options): Finding[] {
  const findings: Finding[] = [];
  const setByName = new Map(opts.sets.map((s) => [s.name, s]));

  for (const m of opts.mappings) {
    const set = setByName.get(m.figma);
    if (!set) continue;

    for (const ctx of opts.contexts) {
      for (const variant of set.variants) {
        const target = Object.entries(m.variants).find(([name]) => findVariant(set, name)?.id === variant.id);
        const base = {
          check: "C7" as const,
          gap: "A" as const,
          component: `${set.name} / ${variant.name}`,
          context: ctx.name,
          links: { figma: variantUrl(set, variant), source: m.element },
        };

        if (!target || target[1] === null) {
          findings.push(
            makeFinding(
              {
                ...base,
                category: "state-not-verified",
                severity: "low",
                title: `${set.name} / ${variant.name} is not checked in ${ctx.name}: ${target ? "the product state is not reachable in the capture" : "no captured state is mapped to it"}`,
              },
              [set.name, variant.name, ctx.name, "coverage"],
            ),
          );
          continue;
        }

        const { state, nth = 0 } = target[1];
        // Every viewport that captured this state is compared; identical findings merge by fingerprint.
        const stateCells = cells.filter((c) => c.state === state && c.context === ctx.name);
        const layer = (m.layer ? variant.layers.find((l) => l.path === m.layer) : variant.layers[0]) ?? variant.layers[0]!;
        const unreachable = (cell: SnapshotCell | undefined) =>
          findings.push(
            makeFinding(
              {
                ...base,
                category: "state-unreachable",
                severity: "medium",
                title: `${set.name} / ${variant.name}: ${cell ? `${m.element} #${nth} not found` : `state "${state}" was not captured`} in ${ctx.name}${cell?.viewport ? ` @${cell.viewport}` : ""}`,
                cell: cell ? cellWhere(cell) : { surface: "?", state, context: ctx.name },
              },
              [set.name, variant.name, ctx.name, "reach", cell?.viewport],
            ),
          );
        if (!stateCells.length) {
          unreachable(undefined);
          continue;
        }
        for (const cell of stateCells) {
          const node = matchNodes(cell.nodes, m.element)[nth];
          if (!node) unreachable(cell);
          else findings.push(...compareNode(cell, node, layer, variant, set, ctx, m, opts));
        }
      }
    }
  }
  return findings;
}

function compareNode(
  cell: SnapshotCell,
  node: SnapshotNode,
  layer: FigmaLayer,
  variant: FigmaVariant,
  set: FigmaComponentSet,
  ctx: Context,
  m: ComponentMapping,
  opts: C7Options,
): Finding[] {
  const out: Finding[] = [];
  const where = cellWhere(cell);
  const label = `${set.name} / ${variant.name}${m.layer ? ` ${m.layer}` : ""}`;
  const figmaSource = `Figma ${set.fileName ?? ""} ${label}`.trim();
  const add = (property: string, severity: Finding["severity"], title: string, expected: Finding["expected"], actual: Finding["actual"], extra: Partial<Finding> = {}) =>
    out.push(
      makeFinding(
        {
          check: "C7",
          category: `figma-state-${property.replace(/\s+/g, "-")}`,
          gap: "A",
          severity,
          title: `${label} in ${ctx.name}: ${title}`,
          component: `${set.name} / ${variant.name}`,
          context: ctx.name,
          cell: where,
          property,
          expected,
          actual,
          links: { figma: variantUrl(set, variant), source: node.path },
          evidence: { screenshot: cell.screenshot, box: node.box },
          ...extra,
        },
        [set.name, variant.name, ctx.name, m.layer ?? ".", property, extra.related?.[0] ?? ""],
      ),
    );

  const colorCheck = (property: string, spec: { c: string; v?: string; var?: { id: string; name?: string } } | undefined, actualCss: string | undefined, allowNone: boolean) => {
    const actualTransparent = !actualCss || isTransparent(actualCss);
    if (!spec) {
      if (!allowNone && !actualTransparent) {
        const hex = normalizeColor(actualCss!) ?? actualCss!;
        add(property, "low", `${property} is ${hex}, Figma has none`, { value: "none", source: figmaSource }, { value: hex, source: cell.browser });
      }
      return;
    }
    // The layer's own variable (REST pulls know it) beats a lookup by code syntax, which two variables may share.
    const exact = spec.var?.id && opts.resolveVarId ? opts.resolveVarId(spec.var.id, ctx.figmaMode) : null;
    const resolved = exact ? { value: exact, from: "tokens" as const } : opts.resolveVar(spec.v, ctx.figmaMode, spec.c);
    if (!resolved) {
      opts.unresolved?.add(`${spec.v ?? spec.c} (${ctx.figmaMode})`);
      return;
    }
    const sharing = spec.v ? opts.codeSyntaxCollisions?.get(tokenKey(spec.v)) : undefined;
    const opacityNote =
      spec.var?.name && sharing && sharing.length > 1
        ? `; Figma uses ${spec.var.name}, but ${sharing.filter((n) => n !== spec.var!.name).join(", ")} also exports ${spec.v}`
        : "opacityOverride" in resolved && resolved.opacityOverride
          ? `; Figma paints it at ${Math.round(resolved.opacityOverride.layer * 100)}% instead of the variable's ${Math.round(resolved.opacityOverride.variable * 100)}%`
          : "";
    if (actualTransparent) {
      add(property, "medium", `${property} is missing, Figma ${spec.v ?? ""} = ${resolved.value}`, { value: resolved.value, source: figmaSource, token: spec.v }, { value: "transparent", source: cell.browser });
      return;
    }
    const d = colorDistance(resolved.value, actualCss!, ctx.backdrop);
    if (d === null) return;
    const hex = normalizeColor(actualCss!) ?? actualCss!;
    const used = tokensFor(cell, actualCss!, ctx.backdrop, `${node.testId ?? ""} ${node.component ?? ""} ${set.name}`);
    if (d <= opts.colorDeltaE) {
      // Looks right, but is it painted with Figma's token? If that token resolves to another colour here,
      // the element uses a different token that happens to be close today and will drift apart later.
      const codeName = spec.v ? Object.keys(cell.tokens).find((n) => tokenKey(n) === tokenKey(spec.v!)) : undefined;
      const codeColor = codeName ? cell.tokens[codeName]?.color : undefined;
      const dd = codeColor ? colorDistance(codeColor, actualCss!, ctx.backdrop) : null;
      if (codeName && dd !== null && dd > 1 && !resolved.opacityOverride)
        add(
          `${property} token`,
          "low",
          `${property} ${hex}${used.length ? ` (= ${used.join(", ")})` : ""} looks like Figma's ${spec.v} (ΔE ${round(d)}) but is not that token: ${codeName} is ${normalizeColor(codeColor!) ?? codeColor} here`,
          { value: resolved.value, source: figmaSource, token: spec.v },
          { value: hex, source: used.length ? `${cell.browser} · ${used.join(", ")}` : cell.browser },
          { deltaE: round(d), evidence: { swatches: [resolved.value, hex], screenshot: cell.screenshot, box: node.box } },
        );
      return;
    }
    const sameToken = spec.v && used.some((u) => tokenKey(u) === tokenKey(spec.v!));
    add(
      property,
      "medium",
      `${property} ${hex}${used.length ? ` (= ${used.join(", ")})` : ""}, Figma ${spec.v ?? "colour"} = ${resolved.value} (ΔE ${round(d)})${sameToken ? "; same token name, different value" : ""}${opacityNote}`,
      { value: resolved.value, source: figmaSource, token: spec.v },
      { value: hex, source: used.length ? `${cell.browser} · ${used.join(", ")}` : cell.browser },
      { deltaE: round(d), evidence: { swatches: [resolved.value, hex], screenshot: cell.screenshot, box: node.box } },
    );
  };

  const want = (p: C7Property) => !m.properties || m.properties.includes(p);

  // Fill and stroke
  if (want("background")) colorCheck("background", layer.fill, node.css["background-color"], false);
  if (layer.stroke && want("border")) {
    const w = pxOf(node.css["border-top-width"]) ?? 0;
    if (Math.abs(w - layer.stroke.w) > 0.5)
      add("border width", "medium", `border ${w}px, Figma stroke ${layer.stroke.w}px`, { value: `${layer.stroke.w}px`, source: figmaSource }, { value: `${w}px`, source: cell.browser });
    else colorCheck("border colour", layer.stroke, node.css["border-top-color"], true);
  }

  // Radius
  if (layer.radius !== undefined && want("radius")) {
    const r = pxOf(node.css["border-top-left-radius"]);
    if (r !== null && Math.abs(r - layer.radius) > opts.px)
      add("radius", "medium", `radius ${r}px, Figma ${layer.radius}px`, { value: `${layer.radius}px`, source: figmaSource }, { value: `${r}px`, source: cell.browser });
  }

  // Padding: designed spacing (padding + child margin) per side
  if (layer.pad && want("padding")) {
    const sides = ["top", "right", "bottom", "left"] as const;
    const off: string[] = [];
    const looksRight: string[] = [];
    sides.forEach((s, i) => {
      const want = layer.pad![i]!;
      const seen = node.layout?.insets?.[s] ?? pxOf(node.css[`padding-${s}`]) ?? 0;
      if (Math.abs(seen - want) <= opts.px) return;
      // Same distance on screen, made by something else (the child's own box, free space)?
      const visual = node.layout?.visualInsets?.[s];
      if (visual !== undefined && Math.abs(visual - want) <= opts.px) looksRight.push(`${s} ${visual}px on screen but padding + child margin = ${seen}px`);
      else off.push(`${s} ${seen}px (Figma ${want}px)`);
    });
    const built = sides.map((s) => `${node.layout?.insets?.[s] ?? pxOf(node.css[`padding-${s}`]) ?? 0}px`).join(" ");
    if (off.length)
      add("padding", "medium", `inner spacing ${off.join(", ")}`, { value: layer.pad.map((v) => `${v}px`).join(" "), source: figmaSource }, { value: built, source: cell.browser });
    else if (looksRight.length)
      add("padding mechanism", "low", `inner spacing looks like Figma's but is built differently: ${looksRight.join(", ")}`, { value: layer.pad.map((v) => `${v}px`).join(" "), source: `${figmaSource} (auto-layout padding)` }, { value: built, source: `${cell.browser} (padding + child margin)` });
  }

  // Gap between children (not meaningful when Figma spreads them with space-between)
  if (want("gap") && layer.gap !== undefined && layer.align?.[0] !== "SPACE_BETWEEN" && node.layout?.childGaps.length) {
    const g = node.layout.childGaps[0]!;
    if (Math.abs(g.gap - layer.gap) > opts.px)
      add("gap", "medium", `${g.gap}px between children, Figma ${layer.gap}px`, { value: `${layer.gap}px`, source: figmaSource }, { value: `${g.gap}px`, source: `gap ${g.fromGap} + margins ${g.marginA}+${g.marginB}` });
  }

  // Fixed sizes
  if (want("height") && layer.sizing?.[1] === "FIXED" && Math.abs(node.box.height - layer.box[3]) > opts.px)
    add("height", "medium", `height ${node.box.height}px, Figma ${layer.box[3]}px`, { value: `${layer.box[3]}px`, source: figmaSource }, { value: `${node.box.height}px`, source: cell.browser });
  if (want("width") && layer.sizing?.[0] === "FIXED" && Math.abs(node.box.width - layer.box[2]) > opts.px)
    add("width", "medium", `width ${node.box.width}px, Figma ${layer.box[2]}px`, { value: `${layer.box[2]}px`, source: figmaSource }, { value: `${node.box.width}px`, source: cell.browser });

  // Shadow
  if (layer.shadow && want("shadow")) {
    const expected = opts.resolveEffect ? opts.resolveEffect(layer.shadow, ctx.colorScheme) : layer.shadow;
    const s = parseShadow(node.css["box-shadow"]);
    const fmt = (x: { x: number; y: number; blur: number }, c: string) => `${x.x} ${x.y} ${x.blur} ${c}`;
    if (!expected) opts.unresolved?.add(`${layer.shadow.style ?? "shadow"} (${ctx.colorScheme} pair)`);
    else if (!s)
      add("shadow", "medium", `no shadow, Figma ${expected.style ?? "drop shadow"}`, { value: fmt(expected, expected.c), source: figmaSource, token: expected.style }, { value: "none", source: cell.browser });
    else {
      const geo = Math.abs(s.x - expected.x) > 1 || Math.abs(s.y - expected.y) > 1 || Math.abs(s.blur - expected.blur) > 2;
      const cd = colorDistance(expected.c, s.color, ctx.backdrop) ?? 0;
      if (geo || cd > opts.colorDeltaE) {
        const actual = fmt(s, normalizeColor(s.color) ?? s.color);
        add("shadow", "low", `shadow ${actual}, Figma ${expected.style ?? ""} ${fmt(expected, expected.c)}`.replace(/\s+/g, " "), { value: fmt(expected, expected.c), source: figmaSource, token: expected.style }, { value: actual, source: cell.browser });
      }
    }
  }

  // Text layers (only for root comparisons; a sub-layer mapping compares that layer's box)
  const textLayers = variant.layers.filter((l) => l.text && (!m.layer || l.path.startsWith(m.layer)));
  if (textLayers.length && want("text")) {
    const domTexts = descendantsWithText(cell.nodes, node);
    const used = new Set<SnapshotNode>();
    textLayers
      .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
      .forEach((tl, i) => {
        const name = tl.path.split("/").pop()!;
        const mapped = m.text?.[name] ? matchNodes(cell.nodes, m.text[name]!).find((n) => n.layout?.ancestors.includes(node.layout?.id ?? -1) || n === node) : undefined;
        const dom = mapped ?? domTexts.filter((d) => !used.has(d))[m.text ? 0 : i];
        if (!dom) return;
        used.add(dom);
        const t = tl.text!;
        const textLabel = `text "${name}"`;
        colorCheck(`${textLabel} colour`, t.color, dom.css["color"], false);
        const size = pxOf(dom.css["font-size"]);
        if (size !== null && Math.abs(size - t.size) > 0.5)
          add(`${textLabel} size`, "medium", `${textLabel} ${size}px, Figma ${t.size}px (${t.style ?? "text style"})`, { value: `${t.size}px`, source: figmaSource, token: t.style }, { value: `${size}px`, source: cell.browser });
        const weight = parseFloat(dom.css["font-weight"] ?? "");
        if (!Number.isNaN(weight) && Math.abs(weight - t.weight) > 50)
          add(`${textLabel} weight`, "medium", `${textLabel} weight ${weight}, Figma ${t.weight}`, { value: String(t.weight), source: figmaSource, token: t.style }, { value: String(weight), source: cell.browser });
        if (/px$/.test(t.lh)) {
          const lh = pxOf(dom.css["line-height"]);
          if (lh !== null && Math.abs(lh - parseFloat(t.lh)) > 0.5)
            add(`${textLabel} line-height`, "low", `${textLabel} line-height ${lh}px, Figma ${t.lh}`, { value: t.lh, source: figmaSource }, { value: `${lh}px`, source: cell.browser });
        }
        const family = (dom.css["font-family"] ?? "").toLowerCase();
        const wanted = t.font.toLowerCase();
        const ok = family.includes(wanted) || (SYSTEM_FONT_ALIASES.includes(wanted) && SYSTEM_FONT_ALIASES.some((a) => family.includes(a)));
        if (family && !ok)
          add(`${textLabel} font`, "low", `${textLabel} font "${dom.css["font-family"]}", Figma ${t.font}`, { value: t.font, source: figmaSource }, { value: dom.css["font-family"] ?? "", source: cell.browser });
      });
  }
  return out;
}

/** Figma-internal inconsistency: a layer's colour does not equal its own variable's value (paint opacity override). */
export function figmaSelfChecks(sets: FigmaComponentSet[], resolveVar: C7Options["resolveVar"], mode = "light"): Finding[] {
  const out: Finding[] = [];
  for (const set of sets)
    for (const v of set.variants)
      for (const l of v.layers) {
        for (const [prop, spec] of [["fill", l.fill], ["stroke", l.stroke], ["text colour", l.text?.color]] as const) {
          // With the variable's identity known (REST pulls), a different alpha means a different variable, which
          // C2 reports as a code-syntax collision; the opacity heuristic is only for plugin captures.
          if (!spec?.v || (spec as { var?: unknown }).var) continue;
          const ref = resolveVar(spec.v, mode);
          if (!ref || ref.from !== "tokens") continue;
          const a = parseColor(spec.c);
          const b = parseColor(ref.value);
          if (!a || !b || Math.abs(a.a - b.a) < 0.05) continue;
          out.push(
            makeFinding(
              {
                check: "C7",
                category: "figma-paint-overrides-variable",
                gap: "A",
                severity: "low",
                title: `In Figma, ${set.name} / ${v.name} ${l.path} ${prop} is ${spec.c} although ${spec.v} is ${ref.value}: the layer overrides the variable's opacity`,
                component: `${set.name} / ${v.name}`,
                expected: { value: ref.value, source: "variable value", token: spec.v },
                actual: { value: toHex(a), source: "Figma layer paint" },
                links: { figma: variantUrl(set, v) },
              },
              [set.name, v.name, l.path, prop],
            ),
          );
        }
      }
  return out;
}
