import type { TrackPoint } from "./outcomes";

/**
 * Realisierte Volatilität — die Größe, die der Auswahl bislang fehlte.
 *
 * **Warum sie zählt.** Der Gebührenertrag einer LP-Position wächst linear mit
 * dem Umschlag, der Impermanent Loss aber **quadratisch** mit der Volatilität.
 * Eine hohe Fee/TVL-Rate ist deshalb kein Gütesiegel: Sie entsteht regelmäßig
 * gerade dort, wo die Position sie nicht behalten kann. Gemessen kippt der
 * Ertrag zwischen 20 % und 40 % Tagesvolatilität — und bis hierher enthielt
 * weder Filter noch Score einen einzigen Volatilitätsterm (ANALYSE.md 3.2).
 *
 * Zwei Wege hierher, beide in dieser Datei, damit sie nicht auseinanderlaufen:
 * die genaue Rechnung auf der aufgezeichneten Zeitreihe und die grobe Schätzung
 * aus den Preisänderungen, die im Scan-Pfad schon vorliegen.
 */

/** Standardabweichung der log-Renditen, auf einen Tag normiert, in Prozent. */
export function realizedVolatilityPctDaily(points: TrackPoint[]): number | null {
  const usable = points
    .filter((p) => p.priceNative !== null && Number.isFinite(p.priceNative) && p.priceNative > 0)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (usable.length < 3) return null;

  const returns: { value: number; days: number }[] = [];
  for (let i = 1; i < usable.length; i++) {
    const prev = usable[i - 1]!;
    const current = usable[i]!;
    const days = (current.ts.getTime() - prev.ts.getTime()) / 86_400_000;
    if (days <= 0) continue;
    returns.push({ value: Math.log(current.priceNative! / prev.priceNative!), days });
  }
  if (returns.length < 2) return null;

  // Auf einen Tag normierte Einzelrenditen: Ein ungleichmäßiges Raster — dicht
  // in der Frühphase, später gröber — würde sonst eine Volatilitätsänderung
  // vortäuschen, die nur eine Abtastungsänderung ist.
  const scaled = returns.map((r) => r.value / Math.sqrt(r.days));
  const mean = scaled.reduce((sum, v) => sum + v, 0) / scaled.length;
  const variance =
    scaled.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (scaled.length - 1);
  return Math.sqrt(variance) * 100;
}

/**
 * Volatilitätsschätzung aus den Preisänderungen, die DexScreener je Kandidat
 * liefert (h1/h6/h24).
 *
 * Weniger genau als die Zeitreihe — eine Preisänderung ist eine Realisierung,
 * keine Streuung —, aber im Scan-Pfad die **einzige** Quelle: Ein frisch
 * entdeckter Pool hat noch keine eigene Aufzeichnung, und genau dort fällt die
 * Auswahlentscheidung. |r| eines Zeitraums ist ein erwartungstreuer, wenn auch
 * verrauschter Schätzer für σ·√T bis auf den Faktor √(2/π).
 */
export function estimateVolatilityPctDaily(changes: {
  h1?: number | null;
  h6?: number | null;
  h24?: number | null;
}): number | null {
  const samples: number[] = [];
  const add = (changePct: number | null | undefined, hours: number): void => {
    if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) return;
    // Log-Rendite statt Prozentänderung: −50 % und +100 % sind dieselbe Bewegung.
    if (changePct <= -100) return;
    const logReturn = Math.abs(Math.log(1 + changePct / 100));
    samples.push((logReturn / Math.sqrt(hours / 24)) * Math.sqrt(Math.PI / 2));
  };
  add(changes.h1, 1);
  add(changes.h6, 6);
  add(changes.h24, 24);

  if (samples.length === 0) return null;
  return (samples.reduce((sum, v) => sum + v, 0) / samples.length) * 100;
}

/**
 * Gebührenertrag je Einheit Varianz — das Rangsignal, das Fee/TVL ersetzen
 * sollte.
 *
 * Die Bedingung dafür, dass LPing sich lohnt, ist nicht „viel Gebühr", sondern
 * „mehr Gebühr als Varianzverlust". Der Verlust einer Position gegenüber
 * schlichtem Halten wächst näherungsweise mit σ²/8 je Zeiteinheit; der Ertrag
 * mit der Gebührenrate. Das Verhältnis beider ist deshalb die Größe, nach der
 * sortiert gehört — und der Grund, warum ein ruhiger Pool mit hohem Umschlag
 * einen wilden mit derselben Fee/TVL-Rate schlägt.
 *
 * `null`, wenn die Volatilität unbekannt ist: Ein geschätzter Nenner wäre
 * schlimmer als kein Signal.
 */
export function feeYieldPerVariance(
  feeRatePctPerDay: number,
  volatilityPctDaily: number | null,
): number | null {
  if (volatilityPctDaily === null || volatilityPctDaily <= 0) return null;
  const sigma = volatilityPctDaily / 100;
  const lvrPctPerDay = ((sigma * sigma) / 8) * 100;
  if (lvrPctPerDay <= 0) return null;
  return feeRatePctPerDay / lvrPctPerDay;
}
