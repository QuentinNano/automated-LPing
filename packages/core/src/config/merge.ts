/**
 * Deep-Merge für Konfigurations-Patches:
 * - Plain Objects werden rekursiv gemerged
 * - Arrays und Primitive ersetzen den bisherigen Wert
 * - `undefined` im Patch lässt den bisherigen Wert unberührt
 * - `null` setzt den Wert explizit auf null (Feld leeren)
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
