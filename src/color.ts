/** Colour parsing, compositing and CIEDE2000 distance. Pure functions, no dependencies. */

export interface RGBA {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Parses hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba() in comma or space syntax, color(srgb …) and "transparent". */
export function parseColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("").map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }

  const rgb = /^rgba?\(\s*([^)]+)\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = (p: string | undefined) =>
      p === undefined ? 1 : p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const a = alpha(parts[3]);
    if ([r, g, b, a].some((v) => v === undefined || Number.isNaN(v))) return null;
    return { r: clamp(r!, 0, 255), g: clamp(g!, 0, 255), b: clamp(b!, 0, 255), a: clamp(a, 0, 1) };
  }

  const srgb = /^color\(\s*srgb\s+([^)]+)\)$/.exec(s);
  if (srgb) {
    const [chan, alphaPart] = srgb[1]!.split("/").map((x) => x.trim());
    const vals = chan!.split(/\s+/).map(parseFloat);
    if (vals.length !== 3 || vals.some(Number.isNaN)) return null;
    const a = alphaPart === undefined ? 1 : parseFloat(alphaPart);
    return { r: clamp(vals[0]! * 255, 0, 255), g: clamp(vals[1]! * 255, 0, 255), b: clamp(vals[2]! * 255, 0, 255), a: clamp(a, 0, 1) };
  }

  return null;
}

export function toHex(c: RGBA): string {
  const h = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a >= 0.999 ? base : base + h(c.a * 255);
}

/** Source-over compositing of a translucent colour onto an opaque backdrop. */
export function composite(top: RGBA, backdrop: RGBA): RGBA {
  const a = top.a;
  return {
    r: top.r * a + backdrop.r * (1 - a),
    g: top.g * a + backdrop.g * (1 - a),
    b: top.b * a + backdrop.b * (1 - a),
    a: 1,
  };
}

export type Lab = [number, number, number];

export function rgbToLab(c: RGBA): Lab {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  // sRGB D65 -> XYZ, normalised by the D65 white point
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (b: number, ap: number) => {
    if (b === 0 && ap === 0) return 0;
    const h = deg(Math.atan2(b, ap));
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/**
 * Perceptual distance between two CSS colours as seen on `backdrop`.
 * Translucent colours are composited first, so "#e9ebec99" is compared as it would render.
 */
export function colorDistance(a: string, b: string, backdrop = "#ffffff"): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const bd = parseColor(backdrop);
  if (!ca || !cb || !bd) return null;
  const pa = composite(ca, bd);
  const pb = composite(cb, bd);
  return deltaE2000(rgbToLab(pa), rgbToLab(pb));
}

export function isTransparent(value: string): boolean {
  const c = parseColor(value);
  return c !== null && c.a === 0;
}

/** Normalises any parseable colour to lowercase hex (with alpha when translucent). */
export function normalizeColor(value: string): string | null {
  const c = parseColor(value);
  return c ? toHex(c) : null;
}
