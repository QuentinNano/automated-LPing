"use server";

import { revalidatePath } from "next/cache";
import { ConfigValidationError } from "@lping/core";
import { configService } from "@/lib/data";
import { formEntriesToPatch } from "@/lib/formPatch";

export interface SaveResult {
  ok: boolean;
  message: string;
  version?: number;
}

/**
 * Übernimmt Formularwerte als Konfigurations-Patch. Geprüft wird ausschließlich
 * im ConfigService (zod-Schema); schlägt das fehl, bleibt die bisherige Version
 * unverändert gültig.
 */
export async function saveConfig(_prev: SaveResult | null, formData: FormData): Promise<SaveResult> {
  const result = formEntriesToPatch(formData.entries());
  if (!result.ok) return { ok: false, message: result.error };

  try {
    const service = await configService();
    const stored = await service.update(result.patch, { actor: "ui", reason: "Parameter-Editor" });
    revalidatePath("/parameter");
    revalidatePath("/");
    return {
      ok: true,
      message: `Gespeichert als Version ${stored.version}.`,
      version: stored.version,
    };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return { ok: false, message: `Nicht gespeichert — ${error.issues.join("; ")}` };
    }
    return {
      ok: false,
      message: `Nicht gespeichert: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
