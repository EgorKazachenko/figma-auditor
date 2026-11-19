import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Figma renders of the nodes findings link to, shown beside the product crop. Uses the REST images endpoint
 * (GET /v1/images/:fileKey?ids=…) with FIGMA_TOKEN, batched per file, cached by node id so a node is rendered once.
 */

export interface FigmaNodeRef {
  fileKey: string;
  nodeId: string;
}

/** https://www.figma.com/design/<key>/<name>?node-id=1-3 → { fileKey, nodeId: "1:3" }. Branch links use the branch key. */
export function parseFigmaLink(url: string | undefined): FigmaNodeRef | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const kind = parts[0];
    if (kind !== "design" && kind !== "file") return null;
    const fileKey = parts[2] === "branch" && parts[3] ? parts[3] : parts[1];
    const node = u.searchParams.get("node-id");
    if (!fileKey || !node) return null;
    return { fileKey, nodeId: node.replace(/-/g, ":") };
  } catch {
    return null;
  }
}

export const cacheName = (r: FigmaNodeRef) => `${r.fileKey}_${r.nodeId.replace(/[^\w]/g, "-")}.png`;

export interface FigmaImageOptions {
  token?: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  scale?: number;
  /** Upper bound of nodes rendered per run (renders of big frames are slow and large). */
  maxNodes?: number;
}

/**
 * Returns cache paths of rendered nodes (key "fileKey:nodeId"). Never throws: with no token or on an API error
 * it renders what it can and returns one note saying what was skipped.
 */
export async function fetchFigmaImages(refs: FigmaNodeRef[], opts: FigmaImageOptions): Promise<{ images: Map<string, string>; note?: string }> {
  const images = new Map<string, string>();
  const uniq = new Map(refs.map((r) => [`${r.fileKey}:${r.nodeId}`, r]));
  const limited = [...uniq.values()].slice(0, opts.maxNodes ?? 60);
  const missing: FigmaNodeRef[] = [];
  for (const r of limited) {
    const p = join(opts.cacheDir, cacheName(r));
    if (existsSync(p)) images.set(`${r.fileKey}:${r.nodeId}`, p);
    else missing.push(r);
  }
  if (!missing.length) return { images };
  if (!opts.token) return { images, note: `Figma images: ${missing.length} nodes not rendered because FIGMA_TOKEN is not set.` };

  const f = opts.fetchImpl ?? fetch;
  const failures: string[] = [];
  const byFile = new Map<string, FigmaNodeRef[]>();
  for (const r of missing) byFile.set(r.fileKey, [...(byFile.get(r.fileKey) ?? []), r]);
  mkdirSync(opts.cacheDir, { recursive: true });
  for (const [fileKey, list] of byFile) {
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(batch.map((b) => b.nodeId).join(","))}&format=png&scale=${opts.scale ?? 2}`;
      try {
        const res = await f(url, { headers: { "X-Figma-Token": opts.token } });
        if (!res.ok) {
          failures.push(`${fileKey}: HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { err?: string | null; images?: Record<string, string | null> };
        if (body.err) failures.push(`${fileKey}: ${body.err}`);
        for (const r of batch) {
          const src = body.images?.[r.nodeId];
          if (!src) continue;
          const img = await f(src);
          if (!img.ok) {
            failures.push(`${fileKey} ${r.nodeId}: image HTTP ${img.status}`);
            continue;
          }
          const p = join(opts.cacheDir, cacheName(r));
          writeFileSync(p, Buffer.from(await img.arrayBuffer()));
          images.set(`${r.fileKey}:${r.nodeId}`, p);
        }
      } catch (e) {
        failures.push(`${fileKey}: ${(e as Error).message}`);
      }
    }
  }
  return failures.length ? { images, note: `Figma images: some nodes were not rendered (${failures.slice(0, 3).join("; ")}).` } : { images };
}
