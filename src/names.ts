/**
 * Token names differ slightly between Figma and code: Figma shows "var(--color-text-2)"
 * while the CSS declares "--color-text-02". Both normalise to the same key.
 */

/** Strips a var() wrapper and returns the bare custom property name, or null when the name is not a CSS variable. */
export function cssVarName(figmaName: string): string | null {
  const s = figmaName.trim();
  const wrapped = /^var\(\s*(--[a-z0-9-_]+)\s*\)$/i.exec(s);
  if (wrapped) return wrapped[1]!.toLowerCase();
  if (/^--[a-z0-9-_]+$/i.test(s)) return s.toLowerCase();
  return null;
}

/** Comparison key: lowercase, numeric segments without leading zeros ("text-02" → "text-2"). */
export function tokenKey(name: string): string {
  const bare = cssVarName(name) ?? name.trim().toLowerCase();
  return bare
    .split("-")
    .map((seg) => (/^\d+$/.test(seg) ? String(Number(seg)) : seg))
    .join("-");
}

/** Builds a lookup from key to the code names that share it, honouring explicit aliases (Figma name → code name). */
export function buildNameIndex(codeNames: Iterable<string>, aliases: Record<string, string> = {}) {
  const byKey = new Map<string, string[]>();
  for (const n of codeNames) {
    const k = tokenKey(n);
    const list = byKey.get(k) ?? [];
    if (!list.includes(n)) list.push(n);
    byKey.set(k, list);
  }
  const aliasKeys = new Map<string, string>();
  for (const [from, to] of Object.entries(aliases)) aliasKeys.set(tokenKey(from), to);

  return (figmaName: string): string | null => {
    const k = tokenKey(figmaName);
    const alias = aliasKeys.get(k);
    if (alias) return alias;
    const hits = byKey.get(k);
    return hits && hits.length > 0 ? hits[0]! : null;
  };
}
