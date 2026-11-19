import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Outline colour: a magenta that stands out on both themes and is in no design system palette we check. */
const OUTLINE: [number, number, number, number] = [229, 32, 122, 255];

/**
 * Cuts the element plus `pad` px of context out of a screenshot and outlines the element box (2 px).
 * `scale` = screenshot pixels per CSS px (device pixel ratio). Returns false when the box is off the image.
 */
export function cropWithOutline(shotPath: string, box: Box, outPath: string, opts: { pad?: number; scale?: number; viewportWidth?: number } = {}): boolean {
  const pad = opts.pad ?? 24;
  const src = PNG.sync.read(readFileSync(shotPath));
  // A screenshot of a 604px viewport at device scale 2 is 1208px wide: boxes are in CSS px.
  const k = opts.scale ?? (opts.viewportWidth ? src.width / opts.viewportWidth : 1);
  const x0 = Math.max(0, Math.floor((box.x - pad) * k));
  const y0 = Math.max(0, Math.floor((box.y - pad) * k));
  const x1 = Math.min(src.width, Math.ceil((box.x + box.width + pad) * k));
  const y1 = Math.min(src.height, Math.ceil((box.y + box.height + pad) * k));
  if (x1 - x0 < 2 || y1 - y0 < 2) return false;
  const out = new PNG({ width: x1 - x0, height: y1 - y0 });
  PNG.bitblt(src, out, x0, y0, out.width, out.height, 0, 0);

  // Element box inside the crop, clamped to it.
  const bx0 = Math.max(0, Math.round(box.x * k) - x0);
  const by0 = Math.max(0, Math.round(box.y * k) - y0);
  const bx1 = Math.min(out.width - 1, Math.round((box.x + box.width) * k) - x0 - 1);
  const by1 = Math.min(out.height - 1, Math.round((box.y + box.height) * k) - y0 - 1);
  const t = Math.max(1, Math.round(2 * k));
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const i = (y * out.width + x) * 4;
    out.data[i] = OUTLINE[0];
    out.data[i + 1] = OUTLINE[1];
    out.data[i + 2] = OUTLINE[2];
    out.data[i + 3] = OUTLINE[3];
  };
  if (bx1 >= bx0 && by1 >= by0) {
    for (let x = bx0 - t; x <= bx1 + t; x++)
      for (let d = 1; d <= t; d++) {
        paint(x, by0 - d);
        paint(x, by1 + d);
      }
    for (let y = by0 - t; y <= by1 + t; y++)
      for (let d = 1; d <= t; d++) {
        paint(bx0 - d, y);
        paint(bx1 + d, y);
      }
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(out));
  return true;
}
