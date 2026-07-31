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
 *
 * Maßgeblich ist der **Abstand zum aktiven Preis**, nicht die Position im
 * Index. Bei einer zweiseitigen Position ist das dasselbe — der Preis liegt in
 * der Mitte der Bins. Bei einer einseitigen ist es das nicht, und der
 * Unterschied war ein Fehler: `quote_only` legt alle Bins **unterhalb** des
 * Preises (siehe `openBins`), der „Rand" der Indexskala liegt dort also einmal
 * direkt am Preis und einmal am unteren Ende der Leiter. Eine über den Index
 * gerechnete V-Form (BidAsk) erzeugte damit **zwei** Schwerpunkte und hungerte
 * die mittlere Tiefe aus — eine Form, die keine der drei DLMM-Strategien meint.
 *
 * Über den Abstand gerechnet behält jede Strategie ihre Bedeutung, gleich ob
 * ein- oder zweiseitig:
 * - Spot   = gleichmäßig,
 * - Curve  = Schwerpunkt **am** Preis (konzentriert, hohe Kapitaleffizienz),
 * - BidAsk = Schwerpunkt **fern** des Preises (fängt große Bewegungen ab; bei
 *   `quote_only` die gestaffelte Kauforder, die mit der Tiefe schwerer wird).
 */
export function strategyWeights(
  count: number,
  strategy: PresetConfig["strategy"]["type"],
  sided: PresetConfig["strategy"]["sided"] = "balanced",
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];

  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    const rel = i / (count - 1); // 0..1, aufsteigend nach Bin-Preis
    // Abstand zum aktiven Preis, 0 = am Preis, 1 = am fernsten Rand.
    // quote_only: der Preis liegt über dem obersten Bin, also ist rel = 1 nah.
    // balanced: der Preis liegt in der Mitte, beide Ränder sind gleich fern.
    const distance = sided === "quote_only" ? 1 - rel : Math.abs(rel - 0.5) * 2;
    switch (strategy) {
      case "Spot":
        raw.push(1);
        break;
      case "Curve":
        // Spitze am Preis, fernster Rand bei 10 % Restgewicht.
        raw.push(0.1 + 0.9 * (1 - distance));
        break;
      case "BidAsk":
        // Fernster Rand voll, Preis bei 10 % Restgewicht.
        raw.push(0.1 + 0.9 * distance);
        break;
    }
  }
  const sum = raw.reduce((acc, v) => acc + v, 0);
  return raw.map((v) => v / sum);
}

/**
 * Bin-Zahl einer Position: aus der Volatilität hergeleitet, wo möglich.
 *
 * Die Range muss zur Bewegung des Marktes passen, nicht zu einer Zahl in der
 * Konfiguration. Eine Position deckt die Preisbewegung von `coverageSigmas`
 * Standardabweichungen **je Richtung** über `horizonHours` ab.
 *
 * Gerechnet wird durchgehend in **log-Renditen** — dieselbe Einheit, in der
 * `realizedVolatilityPctDaily` misst und in der DLMM seine Bins definiert
 * (`p(i) = (1 + binStep/10000)^i`). Beides ist geometrisch, und ein Wechsel auf
 * einfache Prozente mittendrin verschöbe die Breite systematisch:
 *
 *     Abdeckung je Richtung (log) = coverageSigmas · σ · √(Horizont in Tagen)
 *     Spanne  balanced            = 2 · Abdeckung   (nach oben und unten)
 *     Spanne  quote_only          = 1 · Abdeckung   (nur nach unten)
 *     Bins                        = Spanne / ln(1 + binStep/10000)
 *
 * Die Fallunterscheidung ist keine Feinheit. `quote_only` legt alle Bins unter
 * den Preis; die zweiseitige Spanne dort anzuwenden verdoppelt die Tiefe
 * stillschweigend, und `coverageSigmas` bedeutet dann nicht mehr, was es sagt.
 *
 * Nebenwirkung, die zur Sache gehört: In Preisen ist das Ergebnis asymmetrisch
 * (−37 % / +60 % bei ±0,47 log). Das ist keine Ungenauigkeit, sondern die
 * Geometrie der Bins.
 *
 * `binRange.min`/`max` bleiben als Leitplanken: Sie begrenzen, was Kosten und
 * Kapitalbindung tragen. Ohne `coverageSigmas` oder ohne Volatilitätsschätzung
 * gilt unverändert die Mitte der Spanne — die Herleitung darf nie an einer
 * fehlenden Messung scheitern.
 */
export interface DeriveBinWidthParams {
  binRange: { min: number; max: number; coverageSigmas?: number };
  binStep: number;
  horizonHours: number;
  volatilityPctDaily: number | null | undefined;
  /**
   * Seitigkeit der Position. Entscheidend, weil `coverageSigmas` eine Abdeckung
   * **je Richtung** meint: Eine zweiseitige Position braucht dafür die doppelte
   * Spanne, eine einseitige die einfache — sie deckt nur nach unten ab.
   *
   * Ohne diese Unterscheidung bekam `quote_only` die doppelte Tiefe: 1,25
   * konfigurierte Sigmas wurden zu 2,5 gemessenen, und bei hoher Volatilität
   * reichte die Leiter bis −92 % statt bis −60 %.
   */
  sided?: PresetConfig["strategy"]["sided"];
}

export interface BinWidth {
  /** Verwendete Bin-Zahl — hergeleitet und in die Leitplanken gezwungen. */
  bins: number;
  /** Hergeleitete Bin-Zahl **vor** den Leitplanken; `null` ohne Herleitung. */
  derived: number | null;
  /**
   * An welche Leitplanke die Herleitung gestoßen ist, oder `null`.
   *
   * Der Ausweis ist der Punkt: Eine geklemmte Breite ist **nicht** die Breite,
   * die die Volatilität verlangt — die Position ist dann zu eng (oder zu weit)
   * ausgelegt, und zwar genau dann am stärksten, wenn die Herleitung am meisten
   * gebraucht wird. Ohne dieses Feld passiert das lautlos.
   */
  clamped: "min" | "max" | null;
}

/**
 * Zeithorizont, den die Range einer Position tragen muss.
 *
 * **Die Zeit bis zur nächsten Korrekturmöglichkeit, nicht die Haltedauer.** Eine
 * Position, die rebalanciert, muss ihre Range nur bis zum Ablauf des Cooldowns
 * tragen — danach kann sie nachzentrieren. Eine ohne Rebalancing muss die
 * gesamte Haltedauer überstehen.
 *
 * Eine Funktion, weil Engine und Schema-Prüfung denselben Horizont brauchen:
 * Eine Konfiguration, deren Leitplanken gegen einen anderen Horizont geprüft
 * würden als die Engine rechnet, prüfte die falsche Zahl.
 */
export function coverageHorizonHours(preset: {
  rebalance: { enabled: boolean; cooldownMin: number };
  maxHoldHours: number;
}): number {
  const hours = preset.rebalance.enabled
    ? Math.max(preset.rebalance.cooldownMin / 60, 1)
    : preset.maxHoldHours;
  return Math.min(hours, 24);
}

/**
 * Bin-Zahl, die `sigmas` Standardabweichungen **je Richtung** abdeckt.
 *
 * Umkehrung von `deriveBinWidth` und Grundlage der Schema-Prüfung: Sie
 * beantwortet, ob `binRange.max` überhaupt ausreicht, um die zugelassene
 * Volatilität zu tragen.
 */
export function binsForCoverage(params: {
  sigmas: number;
  volatilityPctDaily: number;
  binStep: number;
  horizonHours: number;
  sided?: PresetConfig["strategy"]["sided"];
}): number | null {
  const { sigmas, volatilityPctDaily, binStep, horizonHours } = params;
  if (
    !Number.isFinite(volatilityPctDaily) ||
    volatilityPctDaily <= 0 ||
    binStep <= 0 ||
    horizonHours <= 0
  ) {
    return null;
  }
  const perBin = Math.log(1 + binStep / 10_000);
  if (perBin <= 0) return null;

  const perSide = sigmas * (volatilityPctDaily / 100) * Math.sqrt(horizonHours / 24);
  const spanLog = params.sided === "quote_only" ? perSide : 2 * perSide;
  return Math.round(spanLog / perBin);
}

/** Bin-Zahl samt Herkunft — für Engine, Log und Oberfläche. */
export function deriveBinWidth(params: DeriveBinWidthParams): BinWidth {
  const { binRange, binStep, horizonHours } = params;
  const midpoint = Math.round((binRange.min + binRange.max) / 2);

  const sigmas = binRange.coverageSigmas;
  const volatility = params.volatilityPctDaily;
  if (sigmas === undefined || volatility === null || volatility === undefined) {
    return { bins: midpoint, derived: null, clamped: null };
  }

  const derived = binsForCoverage({
    sigmas,
    volatilityPctDaily: volatility,
    binStep,
    horizonHours,
    ...(params.sided !== undefined ? { sided: params.sided } : {}),
  });
  if (derived === null) return { bins: midpoint, derived: null, clamped: null };

  if (derived > binRange.max) return { bins: binRange.max, derived, clamped: "max" };
  if (derived < binRange.min) return { bins: binRange.min, derived, clamped: "min" };
  return { bins: derived, derived, clamped: null };
}

/** Nur die Bin-Zahl. `deriveBinWidth` sagt zusätzlich, wo sie herkommt. */
export function deriveBinCount(params: DeriveBinWidthParams): number {
  return deriveBinWidth(params).bins;
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
  // Die Seitigkeit gehört zur Gewichtung: Bei `quote_only` liegt der aktive
  // Preis über dem obersten Bin, nicht in der Mitte der Bins.
  const weights = strategyWeights(ids.length, strategy, sided);

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

/**
 * Anteil eines Intervalls [tief, hoch], der innerhalb der Range lag.
 *
 * Solange die Engine nur Schlusskurse sah, war Zeit-in-Range eine Ja/Nein-Frage
 * an einen Zeitpunkt — und damit systematisch zu freundlich: Ein Preis, der die
 * Range zwischen zwei Schlusskursen verlässt und zurückkehrt, zählte als
 * durchgehend drinnen. Mit den Extrema einer Kerze lässt sich stattdessen der
 * **Überlappungsanteil** messen.
 *
 * Gerechnet wird in log-Preisen, weil die Bins geometrisch liegen: In linearen
 * Preisen bekäme die obere Hälfte des Intervalls mehr Gewicht als die untere,
 * obwohl beide dieselbe Zahl Bins umfassen.
 *
 * Der Anteil ist eine Näherung — er unterstellt, dass sich der Preis
 * gleichverteilt über sein Intervall aufgehalten hat. Der tatsächliche Pfad
 * innerhalb einer Kerze ist nicht bekannt und wird bewusst nicht geraten.
 * Ohne Extrema fällt die Funktion exakt auf das frühere Verhalten zurück.
 */
export function inRangeShare(
  bins: SimBin[],
  price: number,
  priceLow?: number,
  priceHigh?: number,
): number {
  if (bins.length === 0) return 0;
  const first = bins[0];
  const last = bins[bins.length - 1];
  if (first === undefined || last === undefined) return 0;

  const low = priceLow ?? price;
  const high = priceHigh ?? price;
  if (!(low > 0) || !(high > low)) return isInRange(bins, price) ? 1 : 0;

  const overlapLow = Math.max(low, first.price);
  const overlapHigh = Math.min(high, last.price);
  if (overlapHigh <= overlapLow) return 0;

  return (Math.log(overlapHigh) - Math.log(overlapLow)) / (Math.log(high) - Math.log(low));
}

export function isInRange(bins: SimBin[], price: number): boolean {
  if (bins.length === 0) return false;
  const first = bins[0];
  const last = bins[bins.length - 1];
  if (first === undefined || last === undefined) return false;
  return price >= first.price && price <= last.price;
}

/**
 * Liquiditätswert des **aktiven** Bins in SOL.
 *
 * Der Liquiditätswert eines Bins ist nach der DLMM-Doku `L = P·x + y` — bei
 * unserer Darstellung also genau sein SOL-Wert, gerechnet zum **Bin-Preis**
 * und nicht zum Marktpreis.
 *
 * Ist der aktive Bin nicht Teil der Position, ist der Wert 0.
 */
export function activeBinValueSol(bins: SimBin[], price: number, binStep: number): number {
  return crossedBins(bins, price, price, binStep).valueSol;
}

/**
 * Obergrenze der Bins, die ein einzelner Swap überqueren kann.
 *
 * Aus dem `lb_clmm`-Changelog 0.12.0: „max bins to swap in 1 instruction changes
 * from 280 bins to 260 bins". Rein als Plausibilitätsgrenze geführt — eine
 * Preisbewegung über mehr Bins entsteht aus mehreren Swaps, und jeder davon
 * verteilt seine Gebühren auf die von *ihm* überquerten Bins.
 */
export const MAX_BINS_PER_SWAP = 260;

export interface CrossedBins {
  /** Summierter Liquiditätswert der eigenen Bins im überquerten Bereich. */
  valueSol: number;
  /** Wie viele Bins der Preis insgesamt berührt hat (auch fremde). */
  binCount: number;
}

/**
 * Eigene Liquidität in den Bins, die der Preis zwischen zwei Beobachtungen
 * berührt hat — die Bins, die nach der Doku Gebühren verdienen.
 *
 * **Warum nicht nur der aktive Bin.** Die Doku ist eindeutig: *„DLMM calculates
 * fees per bin, which means the bins that participate in the swap are the bins
 * that earn fees"*, und der Anteil daran ist `eigene Liquidität in den
 * berechtigten Bins / Gesamtliquidität dort`. Nur den aktiven Bin zu zählen
 * unterschätzt den Ertrag genau dann, wenn der Preis läuft — also in den
 * Phasen, in denen eine Position ihr Inventar dreht und den Impermanent Loss
 * tatsächlich realisiert. Der Fehler wirkte damit einseitig gegen breite
 * Positionen, und die Strategie ist inzwischen auf breite Positionen umgestellt.
 *
 * Das dokumentierte 15-Bin-Limit gilt für **Liquidity-Mining-Rewards**, nicht
 * für Gebühren; für Gebühren nennt die Doku keine Grenze.
 *
 * Bei unverändertem Preis ist der berührte Bereich genau der aktive Bin — die
 * Rechnung geht dann exakt in die frühere über.
 */
export function crossedBins(
  bins: SimBin[],
  fromPrice: number,
  toPrice: number,
  binStep: number,
): CrossedBins {
  if (!(fromPrice > 0) || !(toPrice > 0)) return { valueSol: 0, binCount: 0 };

  const a = binIdFromPrice(fromPrice, binStep);
  const b = binIdFromPrice(toPrice, binStep);
  const lowId = Math.min(a, b);
  const highId = Math.max(a, b);

  let valueSol = 0;
  for (const bin of bins) {
    if (bin.id >= lowId && bin.id <= highId) valueSol += bin.sol + bin.token * bin.price;
  }
  return { valueSol, binCount: highId - lowId + 1 };
}

/**
 * Legt die Bins um einen neuen Preis herum neu an und verteilt den vorhandenen
 * Wert nach der Preset-Strategie. Grundlage des Rebalancings.
 *
 * Rückgabe enthält den Betrag, der dafür die Seite wechseln muss — daraus
 * ergeben sich Swap- und Composition-Kosten.
 */
export interface RecenterResult {
  bins: SimBin[];
  minBinId: number;
  maxBinId: number;
  /** SOL-Gegenwert, der zwischen den Seiten getauscht werden muss. */
  swappedSol: number;
  /** Wert, der in den aktiven Bin eingezahlt wird (Composition-Fee-Basis). */
  activeBinDepositSol: number;
}

export function recenterBins(params: OpenPositionParams): RecenterResult {
  const opened = openBins(params);
  const activeId = binIdFromPrice(params.price, params.binStep);
  const activeBin = opened.bins.find((bin) => bin.id === activeId);
  const activeBinDepositSol =
    activeBin === undefined ? 0 : activeBin.sol + activeBin.token * activeBin.price;

  return {
    bins: opened.bins,
    minBinId: opened.minBinId,
    maxBinId: opened.maxBinId,
    swappedSol: opened.swappedSol,
    activeBinDepositSol,
  };
}
