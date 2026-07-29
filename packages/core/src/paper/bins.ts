import type { PresetConfig } from "../config/schema";
import type { SimBin } from "./types";

/**
 * DLMM-Bin-Mathematik für die Paper-Simulation.
 *
 * Modellgrundlagen (bewusst dokumentiert, weil jede Vereinfachung die
 * Ergebnisse beeinflusst):
 * - Bin-Preis: p(i) = (1 + binStep/10000)^i — die DLMM-Definition.
 * - Bins **unterhalb** des aktuellen Preises halten Quote (SOL), Bins
 *   **oberhalb** halten Base (Token). Das ist die Kernmechanik: fällt der
 *   Preis in einen SOL-Bin, kauft dessen SOL den Token ("Buy the dip");
 *   steigt er über einen Token-Bin, wird dessen Token in SOL verkauft.
 * - Gehandelt wird beim Überqueren zum Bin-Preis; Slippage innerhalb eines
 *   Bins wird vernachlässigt (bei üblichen Bin-Steps unter 1 % pro Bin).
 */

export function binPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

/**
 * Kleinste Bin-ID, deren Preis >= dem gegebenen Preis liegt.
 * Liegt der Preis (bis auf Gleitkomma-Rauschen) exakt auf einer Bin-Grenze,
 * wird diese Bin-ID zurückgegeben statt der nächsthöheren.
 */
export function binIdFromPrice(price: number, binStep: number): number {
  const raw = Math.log(price) / Math.log(1 + binStep / 10_000);
  const nearest = Math.round(raw);
  return Math.abs(raw - nearest) < 1e-9 ? nearest : Math.ceil(raw);
}

/**
 * Liquiditätsgewichte je Bin gemäß DLMM-Strategie.
 * Spot = gleichmäßig, Curve = Dreieck mit Spitze am aktiven Bin,
 * BidAsk = V-Form mit Schwerpunkt an den Rändern.
 */
export function strategyWeights(count: number, strategy: PresetConfig["strategy"]["type"]): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];

  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    const rel = i / (count - 1); // 0..1
    switch (strategy) {
      case "Spot":
        raw.push(1);
        break;
      case "Curve":
        // Dreieck: Maximum in der Mitte, Ränder bei 10 % Restgewicht.
        raw.push(0.1 + 0.9 * (1 - Math.abs(rel - 0.5) * 2));
        break;
      case "BidAsk":
        // V-Form: Ränder voll, Mitte 10 %.
        raw.push(0.1 + 0.9 * (Math.abs(rel - 0.5) * 2));
        break;
    }
  }
  const sum = raw.reduce((acc, v) => acc + v, 0);
  return raw.map((v) => v / sum);
}

export interface OpenPositionParams {
  /** Aktueller Token-Preis in SOL. */
  price: number;
  binStep: number;
  /** Anzahl Bins der Position. */
  binCount: number;
  strategy: PresetConfig["strategy"]["type"];
  /** balanced = 50/50 um den Preis, quote_only = nur SOL unterhalb. */
  sided: PresetConfig["strategy"]["sided"];
  /** Einsatz in SOL. */
  depositSol: number;
}

export interface OpenedBins {
  bins: SimBin[];
  minBinId: number;
  maxBinId: number;
  /** SOL-Betrag, der beim Eröffnen in Token getauscht werden musste. */
  swappedSol: number;
}

/**
 * Legt die Bins einer neuen Position an.
 * - quote_only: alle Bins unterhalb des aktiven Preises, komplett SOL
 *   (gestaffelte Kauforders — kein sofortiger Token-Kauf, kein Swap).
 * - balanced: Bins um den aktiven Preis; die Hälfte des Einsatzes wird in
 *   Token getauscht (der Swap verursacht Kosten, siehe engine.ts).
 */
export function openBins(params: OpenPositionParams): OpenedBins {
  const { price, binStep, binCount, strategy, sided, depositSol } = params;
  const activeBinId = binIdFromPrice(price, binStep);

  const minBinId = sided === "quote_only" ? activeBinId - binCount : activeBinId - Math.floor(binCount / 2);
  const maxBinId = sided === "quote_only" ? activeBinId - 1 : minBinId + binCount - 1;

  const ids: number[] = [];
  for (let id = minBinId; id <= maxBinId; id++) ids.push(id);
  const weights = strategyWeights(ids.length, strategy);

  // Nur Bins unterhalb des aktuellen Preises halten SOL, der Rest Token.
  const solIdx: number[] = [];
  const tokenIdx: number[] = [];
  ids.forEach((id, index) => {
    if (binPrice(id, binStep) < price) solIdx.push(index);
    else tokenIdx.push(index);
  });

  const solWeight = solIdx.reduce((sum, i) => sum + (weights[i] ?? 0), 0);
  const tokenWeight = tokenIdx.reduce((sum, i) => sum + (weights[i] ?? 0), 0);

  // Aufteilung des Einsatzes entspricht der Gewichtsverteilung; bei
  // quote_only ist tokenWeight = 0, es wird also nichts geswappt.
  const solPortion = depositSol * solWeight;
  const tokenPortionSol = depositSol * tokenWeight;

  const bins: SimBin[] = ids.map((id, index) => {
    const w = weights[index] ?? 0;
    const price_i = binPrice(id, binStep);
    if (price_i < price) {
      return { id, price: price_i, sol: solWeight > 0 ? (solPortion * w) / solWeight : 0, token: 0 };
    }
    // Token-Bins: der zugeteilte SOL-Anteil wird zum aktuellen Preis in Token
    // umgerechnet (der Swap-Kostenabzug passiert in der Engine).
    const solShare = tokenWeight > 0 ? (tokenPortionSol * w) / tokenWeight : 0;
    return { id, price: price_i, sol: 0, token: solShare / price };
  });

  return { bins, minBinId, maxBinId, swappedSol: tokenPortionSol };
}

/**
 * Verarbeitet eine Preisbewegung: Bins, die der Preis überquert hat, wechseln
 * ihre Zusammensetzung (SOL→Token beim Fallen, Token→SOL beim Steigen).
 * Gibt die neuen Bins zurück; die Eingabe bleibt unverändert.
 */
export function applyPriceMove(bins: SimBin[], newPrice: number): SimBin[] {
  return bins.map((bin) => {
    if (bin.price < newPrice && bin.token > 0) {
      // Preis über dem Bin: Token wurde zum Bin-Preis verkauft.
      return { ...bin, sol: bin.sol + bin.token * bin.price, token: 0 };
    }
    if (bin.price >= newPrice && bin.sol > 0) {
      // Preis unter dem Bin: SOL hat zum Bin-Preis Token gekauft.
      return { ...bin, token: bin.token + bin.sol / bin.price, sol: 0 };
    }
    return bin;
  });
}

export interface BinTotals {
  tokenAmount: number;
  solAmount: number;
  valueSol: number;
}

export function totalsOf(bins: SimBin[], price: number): BinTotals {
  let tokenAmount = 0;
  let solAmount = 0;
  for (const bin of bins) {
    tokenAmount += bin.token;
    solAmount += bin.sol;
  }
  return { tokenAmount, solAmount, valueSol: solAmount + tokenAmount * price };
}

export function isInRange(bins: SimBin[], price: number): boolean {
  if (bins.length === 0) return false;
  const first = bins[0];
  const last = bins[bins.length - 1];
  if (first === undefined || last === undefined) return false;
  return price >= first.price && price <= last.price;
}
