import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Figma REST access with a cache keyed by file version: a run re-downloads a file's variables or nodes
 * only when the file changed since the last pull, and works offline from the cache when there is no token.
 * The token is read from FIGMA_TOKEN and is never written anywhere.
 */

export interface FigmaClient {
  get(path: string): Promise<any>;
}

export function figmaClient(token = process.env.FIGMA_TOKEN, fetchImpl: typeof fetch = fetch): FigmaClient | null {
  if (!token) return null;
  return {
    async get(path: string) {
      const res = await fetchImpl(`https://api.figma.com${path}`, { headers: { "X-Figma-Token": token } });
      if (!res.ok) {
        const hint = res.status === 403 ? " (token lacks access or scope; variables need Enterprise and file_variables:read)" : res.status === 404 ? " (file not found)" : "";
        throw new Error(`Figma ${path.split("?")[0]}: HTTP ${res.status}${hint}`);
      }
      return res.json();
    },
  };
}

export interface CachedFile<T> {
  fileKey: string;
  name?: string;
  version?: string;
  lastModified?: string;
  json: T;
  /** "cache" when the file had not changed (or there was no token), "network" when it was downloaded. */
  from: "cache" | "network";
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");

/**
 * Loads `kind` (e.g. "variables") of a file: asks Figma for the file's current version (cheap), reuses the
 * cache when it matches, downloads otherwise. Without a client, returns the cache or throws.
 */
export async function cachedFigma<T>(
  client: FigmaClient | null,
  cacheDir: string,
  fileKey: string,
  kind: string,
  path: string,
  opts: { refresh?: boolean } = {},
): Promise<CachedFile<T>> {
  const file = join(cacheDir, safe(fileKey), `${safe(kind)}.json`);
  const cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Omit<CachedFile<T>, "from">) : null;
  if (!client) {
    if (cached) return { ...cached, from: "cache" };
    throw new Error(`No FIGMA_TOKEN and no cached ${kind} for file ${fileKey}; export FIGMA_TOKEN once to fill the cache`);
  }
  const meta = await client.get(`/v1/files/${fileKey}?depth=1`);
  if (cached && !opts.refresh && cached.version && cached.version === meta.version) return { ...cached, from: "cache" };
  const json = (await client.get(path)) as T;
  const entry = { fileKey, name: meta.name as string | undefined, version: meta.version as string | undefined, lastModified: meta.lastModified as string | undefined, json };
  mkdirSync(join(cacheDir, safe(fileKey)), { recursive: true });
  writeFileSync(file, JSON.stringify(entry));
  return { ...entry, from: "network" };
}
