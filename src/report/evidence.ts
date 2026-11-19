import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Issue, SnapshotCell } from "../types.js";
import { cropWithOutline } from "./crops.js";
import { cacheName, fetchFigmaImages, parseFigmaLink } from "./figmaImages.js";

export interface EvidenceOptions {
  runDir: string;
  cells: SnapshotCell[];
  crops: boolean;
  figmaImages: boolean;
  /** Where rendered Figma nodes are cached between runs. */
  figmaCacheDir: string;
  token?: string;
  fetchImpl?: typeof fetch;
  maxCrops?: number;
}

/**
 * Adds what a reviewer looks at first: the element cut from the screenshot with its box outlined
 * (crops/<issue>.png) and the Figma node it should look like (figma/<file>_<node>.png), both inside the run folder.
 */
export async function attachEvidence(issues: Issue[], o: EvidenceOptions): Promise<string[]> {
  const notes: string[] = [];
  const active = (i: Issue) => i.status !== "accepted" && i.status !== "suppressed";
  const ordered = [...issues.filter(active), ...issues.filter((i) => !active(i))];

  if (o.crops) {
    const widthOf = new Map(o.cells.filter((c) => c.screenshot).map((c) => [c.screenshot!, c.page?.innerWidth]));
    let made = 0;
    for (const i of ordered) {
      if (made >= (o.maxCrops ?? 300)) break;
      const shot = i.evidence?.screenshot;
      const box = i.evidence?.box;
      if (!shot || !box) continue;
      const src = join(o.runDir, shot);
      if (!existsSync(src)) continue;
      const rel = join("crops", `${i.id}.png`);
      try {
        if (cropWithOutline(src, box, join(o.runDir, rel), { viewportWidth: widthOf.get(shot) })) {
          i.evidence = { ...i.evidence, crop: rel };
          made++;
        }
      } catch {
        // A broken screenshot only costs this crop.
      }
    }
  }

  if (o.figmaImages) {
    const refs = ordered.map((i) => parseFigmaLink(i.links.figma)).filter((r): r is NonNullable<typeof r> => r !== null);
    if (refs.length) {
      const { images, note } = await fetchFigmaImages(refs, { token: o.token, cacheDir: o.figmaCacheDir, fetchImpl: o.fetchImpl });
      if (note) notes.push(note);
      if (images.size) mkdirSync(join(o.runDir, "figma"), { recursive: true });
      for (const i of issues) {
        const r = parseFigmaLink(i.links.figma);
        const cached = r ? images.get(`${r.fileKey}:${r.nodeId}`) : undefined;
        if (!r || !cached) continue;
        const rel = join("figma", cacheName(r));
        if (!existsSync(join(o.runDir, rel))) copyFileSync(cached, join(o.runDir, rel));
        i.evidence = { ...i.evidence, figmaImage: rel };
      }
    }
  }
  return notes;
}
