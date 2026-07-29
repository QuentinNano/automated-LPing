/**
 * Wandelt Formularfelder in einen Konfigurations-Patch.
 *
 * Jedes Feld trägt seinen Pfad und Typ im name-Attribut, z. B.
 * "presets.degen.stopLossPct|number". Dadurch muss die Feldliste nicht
 * doppelt gepflegt werden — das Formular ist die einzige Quelle.
 *
 * Bewusst ohne eigene Wertebereichsprüfung: dafür ist ausschließlich das
 * zod-Schema im ConfigService zuständig. Eine zweite Validierung in der UI
 * würde unweigerlich von der echten abweichen.
 */
export type PatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: string };

export function formEntriesToPatch(entries: Iterable<[string, FormDataEntryValue]>): PatchResult {
  const patch: Record<string, unknown> = {};

  for (const [key, raw] of entries) {
    if (typeof raw !== "string") continue;
    // Next.js schleust interne Felder für Server Actions ein ($ACTION_*).
    if (key.startsWith("$")) continue;

    const separator = key.lastIndexOf("|");
    if (separator === -1) continue;
    const path = key.slice(0, separator);
    const kind = key.slice(separator + 1);
    if (path === "") continue;

    let value: unknown;
    switch (kind) {
      case "number": {
        if (raw.trim() === "") continue;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          return { ok: false, error: `"${raw}" ist keine gültige Zahl (${path})` };
        }
        value = parsed;
        break;
      }
      case "bool":
        value = raw === "true";
        break;
      case "string":
        value = raw;
        break;
      default:
        continue;
    }
    setPath(patch, path.split("."), value);
  }

  return { ok: true, patch };
}

function setPath(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}
