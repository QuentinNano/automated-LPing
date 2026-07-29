import type { ScoreBreakdown, ScoreComponent, ScreeningInput } from "./types";

/**
 * Score 0–100 für das Ranking der Kandidaten (KONZEPT.md Abschnitt 5.4).
 * Gewichte: 35 Fee-Ertragskraft, 25 Markt-Qualität, 20 Sicherheitsmarge,
 * 10 Momentum, 10 Quellen-Bonus.
 *
 * Alle Kennlinien sind bewusst einfache, dokumentierte v1-Startwerte —
 * kalibriert wird datengetrieben über Paper-Trading und Shadow-Tracking,
 * nicht per Bauchgefühl im Code.
 */
export function computeScore(input: ScreeningInput): ScoreBreakdown {
  const components: ScoreComponent[] = [
    feeYield(input),
    marketQuality(input),
    safetyMargin(input),
    momentum(input),
    sourceBonus(input),
  ];
  const total = round1(components.reduce((sum, c) => sum + c.points, 0));
  return { total: clamp(total, 0, 100), components };
}

/** 35 P: Fee/TVL-Rate 24h. Degen-Vollausschlag bei 3 %/Tag, Multiday bei 1,5 %/Tag. */
function feeYield(input: ScreeningInput): ScoreComponent {
  const max = 35;
  const rate = input.pool.feeTvl24hPct;
  if (rate === undefined) return { id: "fee_yield", points: 0, max, detail: "keine Fee-Daten" };
  const fullAt = input.presetKind === "degen" ? 3 : 1.5;
  return {
    id: "fee_yield",
    points: round1(max * clamp(rate / fullAt, 0, 1)),
    max,
    detail: `fee/tvl 24h = ${rate.toFixed(2)}%`,
  };
}

/**
 * 25 P: Markt-Qualität — 10 Kauf/Verkauf-Balance, 10 plausible
 * Durchschnitts-Trade-Größe (100–3000 USD), 5 Handelsaktivität.
 */
function marketQuality(input: ScreeningInput): ScoreComponent {
  const max = 25;
  const market = input.market;
  const txns = market?.txns24h ?? null;
  if (market === null || txns === null) {
    return { id: "market_quality", points: 0, max, detail: "keine Markt-Daten" };
  }
  const total = txns.buys + txns.sells;
  if (total === 0) return { id: "market_quality", points: 0, max, detail: "keine Trades" };

  const imbalance = Math.abs(txns.buys - txns.sells) / total;
  const balancePts = 10 * clamp(1 - imbalance * 2, 0, 1);

  let sizePts = 0;
  if (market.volume24hUsd !== null) {
    const avg = market.volume24hUsd / total;
    const ratio = avg < 100 ? avg / 100 : avg > 3000 ? 3000 / avg : 1;
    sizePts = 10 * clamp(ratio, 0, 1);
  }

  const activityPts = 5 * clamp(total / 1000, 0, 1);

  return {
    id: "market_quality",
    points: round1(balancePts + sizePts + activityPts),
    max,
    detail: `${total} Trades/24h, Imbalance ${(imbalance * 100).toFixed(0)}%`,
  };
}

/** 20 P: Abstand zu den Sicherheits-Grenzwerten (Risk-Score, Top-10-Holder). */
function safetyMargin(input: ScreeningInput): ScoreComponent {
  const max = 20;
  const s = input.preset.screening;
  const risk = input.risk;
  if (risk === null) return { id: "safety_margin", points: 0, max, detail: "kein Risiko-Report" };

  let riskPts = 0;
  if (risk.normalizedScore !== null && s.maxNormalizedRiskScore > 0) {
    riskPts = 10 * clamp((s.maxNormalizedRiskScore - risk.normalizedScore) / s.maxNormalizedRiskScore, 0, 1);
  }
  let holderPts = 0;
  if (risk.top10HolderPct !== null && s.maxTop10HolderPct > 0) {
    holderPts = 10 * clamp((s.maxTop10HolderPct - risk.top10HolderPct) / s.maxTop10HolderPct, 0, 1);
  }
  return { id: "safety_margin", points: round1(riskPts + holderPts), max };
}

/**
 * 10 P: Momentum. Degen bewertet 6h-Trend (moderat positiv ideal, parabolisch
 * riskant), Multiday den 24h-Trend mit Präferenz für Stetigkeit.
 */
function momentum(input: ScreeningInput): ScoreComponent {
  const max = 10;
  const market = input.market;
  const change =
    input.presetKind === "degen" ? market?.priceChangeH6Pct : market?.priceChangeH24Pct;
  if (change === null || change === undefined) {
    return { id: "momentum", points: 0, max, detail: "kein Preistrend verfügbar" };
  }
  const idealMax = input.presetKind === "degen" ? 50 : 30;
  let points: number;
  if (change <= 0) {
    points = 0;
  } else if (change <= idealMax) {
    points = max * (change / idealMax);
  } else {
    // Über dem Ideal-Band: linear abfallend, ab dem 3-fachen nur noch Restpunkte.
    points = Math.max(2, max * (1 - (change - idealMax) / (idealMax * 2)));
  }
  return { id: "momentum", points: round1(clamp(points, 0, max)), max, detail: `${change.toFixed(1)}%` };
}

/** 10 P: Quellen-Bonus — Fabriq-bestätigte Kandidaten > eigene Replikation. */
function sourceBonus(input: ScreeningInput): ScoreComponent {
  const max = 10;
  const fromFabriq = input.source === "fabriq_degen" || input.source === "fabriq_multiday";
  return { id: "source_bonus", points: fromFabriq ? 10 : 5, max, detail: input.source };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
