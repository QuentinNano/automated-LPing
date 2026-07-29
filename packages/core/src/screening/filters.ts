import { priceDivergencePct } from "./aggregate";
import type { FilterCheck, ScreeningInput } from "./types";

/**
 * Hard Filters (K.o.-Kriterien) gemäß KONZEPT.md Abschnitt 5.1–5.3.
 *
 * Fail-closed-Prinzip: Bei sicherheitskritischen Prüfungen führt fehlende
 * Information zur Ablehnung ("keine Daten" ist nie "unbedenklich"). Reine
 * Qualitätsprüfungen, deren Datenquelle optional ist, werden bei fehlenden
 * Daten als `skipped` markiert und blockieren nicht.
 */
export function runHardFilters(input: ScreeningInput): FilterCheck[] {
  const checks: FilterCheck[] = [];
  const { preset, pool, market, risk, sellability } = input;
  const s = preset.screening;

  // --- Pool-Grundform -------------------------------------------------------
  checks.push(
    input.tokenMint !== null
      ? { id: "quote_is_sol", status: "passed", value: input.tokenMint }
      : {
          id: "quote_is_sol",
          status: "failed",
          value: null,
          detail: "v1 handelt nur X/SOL-Pools",
        },
  );

  // --- Token-Sicherheit (5.1, fail-closed) ---------------------------------
  checks.push(
    failClosedBool("mint_authority_revoked", risk?.mintAuthorityRevoked ?? null, true),
    failClosedBool("freeze_authority_revoked", risk?.freezeAuthorityRevoked ?? null, true),
  );

  const riskScore = risk?.normalizedScore ?? null;
  checks.push(
    riskScore === null
      ? failClosedMissing("risk_score", s.maxNormalizedRiskScore)
      : {
          id: "risk_score",
          status: riskScore <= s.maxNormalizedRiskScore ? "passed" : "failed",
          value: riskScore,
          limit: s.maxNormalizedRiskScore,
        },
  );

  if (risk === null) {
    checks.push(failClosedMissing("risk_flags"));
  } else {
    const dangers = risk.risks.filter((r) => (r.level ?? "").toLowerCase() === "danger");
    checks.push(
      dangers.length === 0
        ? { id: "risk_flags", status: "passed", value: risk.risks.length }
        : {
            id: "risk_flags",
            status: "failed",
            value: dangers.map((d) => d.name).join(", "),
            detail: "kritische RugCheck-Flags",
          },
    );
  }

  checks.push(
    sellability === null
      ? failClosedMissing("sellable")
      : {
          id: "sellable",
          status: sellability.verdict === "sellable" ? "passed" : "failed",
          value: sellability.verdict,
          ...(sellability.roundTripLossPct !== null
            ? { detail: `Roundtrip-Verlust ${sellability.roundTripLossPct.toFixed(1)}%` }
            : {}),
        },
  );

  // --- Holder & Verteilung (5.2, fail-closed) ------------------------------
  checks.push(
    failClosedNumberMax("top10_concentration", risk?.top10HolderPct ?? null, s.maxTop10HolderPct),
  );

  const largestHolderPct =
    risk !== undefined && risk !== null && risk.topHolders.length > 0
      ? Math.max(...risk.topHolders.map((h) => h.pct))
      : null;
  checks.push(failClosedNumberMax("single_holder", largestHolderPct, s.maxSingleHolderPct));

  checks.push(failClosedNumberMax("insider_share", risk?.insiderPct ?? null, s.maxInsiderPct));

  const totalHolders = risk?.totalHolders ?? null;
  checks.push(
    totalHolders === null
      ? failClosedMissing("min_holders", s.minHolders)
      : {
          id: "min_holders",
          status: totalHolders >= s.minHolders ? "passed" : "failed",
          value: totalHolders,
          limit: s.minHolders,
        },
  );

  // --- Markt- & Pool-Qualität (5.3) ----------------------------------------
  checks.push(
    pool.tvlUsd === undefined
      ? failClosedMissing("min_tvl", preset.minTvlUsd)
      : {
          id: "min_tvl",
          status: pool.tvlUsd >= preset.minTvlUsd ? "passed" : "failed",
          value: round2(pool.tvlUsd),
          limit: preset.minTvlUsd,
        },
  );

  const volTvl =
    pool.tvlUsd !== undefined && pool.tvlUsd > 0 && pool.volume24hUsd !== undefined
      ? pool.volume24hUsd / pool.tvlUsd
      : null;
  checks.push(
    volTvl === null
      ? failClosedMissing("vol_tvl_ratio")
      : {
          id: "vol_tvl_ratio",
          status:
            volTvl >= preset.volTvlBounds.min && volTvl <= preset.volTvlBounds.max
              ? "passed"
              : "failed",
          value: round2(volTvl),
          limit: `${preset.volTvlBounds.min}–${preset.volTvlBounds.max}`,
          detail: "zu niedrig = tot, absurd hoch = Wash-Trading-Verdacht",
        },
  );

  const age = market?.tokenAgeHours ?? null;
  const ageMax = preset.tokenAgeHours.max;
  checks.push(
    age === null
      ? failClosedMissing("token_age")
      : {
          id: "token_age",
          status:
            age >= preset.tokenAgeHours.min && (ageMax === undefined || age <= ageMax)
              ? "passed"
              : "failed",
          value: round2(age),
          limit: ageMax === undefined ? `>= ${preset.tokenAgeHours.min}h` : `${preset.tokenAgeHours.min}–${ageMax}h`,
        },
  );

  // Preis-Konsistenz: Manipulations-/Illiquiditätsindikator. Ohne Marktpreis
  // nicht bewertbar → skipped (Jupiter-Sellability deckt den harten Fall ab).
  const divergence = market !== null ? priceDivergencePct(pool, market) : null;
  checks.push(
    divergence === null
      ? skipped("price_divergence", "kein Vergleichspreis verfügbar")
      : {
          id: "price_divergence",
          status: divergence <= s.maxPriceDivergencePct ? "passed" : "failed",
          value: round2(divergence),
          limit: s.maxPriceDivergencePct,
        },
  );

  // Wash-Trading-Heuristik: absurd hohe Durchschnitts-Trade-Größe.
  const txns = market?.txns24h ?? null;
  const marketVol = market?.volume24hUsd ?? null;
  const txnCount = txns === null ? 0 : txns.buys + txns.sells;
  const avgTradeUsd = txns !== null && marketVol !== null && txnCount > 0 ? marketVol / txnCount : null;
  checks.push(
    avgTradeUsd === null
      ? skipped("wash_trading_avg_trade", "keine Trade-Statistik verfügbar")
      : {
          id: "wash_trading_avg_trade",
          status: avgTradeUsd <= s.maxAvgTradeUsd ? "passed" : "failed",
          value: round2(avgTradeUsd),
          limit: s.maxAvgTradeUsd,
        },
  );

  // Eigener Fußabdruck: geplante Positionsgröße relativ zum Pool-TVL.
  const solPrice = market?.solPriceUsd ?? null;
  if (solPrice === null || pool.tvlUsd === undefined || pool.tvlUsd <= 0) {
    checks.push(skipped("pool_share_of_tvl", "SOL-Preis oder TVL unbekannt"));
  } else {
    const positionSol = (input.global.maxTotalExposureSol * preset.positionSizePct) / 100;
    const sharePct = ((positionSol * solPrice) / pool.tvlUsd) * 100;
    checks.push({
      id: "pool_share_of_tvl",
      status: sharePct <= s.maxPoolShareOfTvlPct ? "passed" : "failed",
      value: round2(sharePct),
      limit: s.maxPoolShareOfTvlPct,
    });
  }

  // LP-Dominanz einzelner Wallets: erfordert On-Chain-Positionsdaten (RPC),
  // kommt mit der Execution-Schicht (Schritt 5 der Umsetzungsreihenfolge).
  checks.push(skipped("single_lp_dominance", "benötigt RPC-Adapter (Schritt 5)"));

  return checks;
}

function failClosedBool(id: string, value: boolean | null, expected: boolean): FilterCheck {
  if (value === null) return failClosedMissing(id);
  return {
    id,
    status: value === expected ? "passed" : "failed",
    value,
  };
}

function failClosedNumberMax(id: string, value: number | null, limit: number): FilterCheck {
  if (value === null) return failClosedMissing(id, limit);
  return {
    id,
    status: value <= limit ? "passed" : "failed",
    value: round2(value),
    limit,
  };
}

function failClosedMissing(id: string, limit?: number): FilterCheck {
  return {
    id,
    status: "failed",
    value: null,
    detail: "keine Daten (fail-closed)",
    ...(limit !== undefined ? { limit } : {}),
  };
}

function skipped(id: string, detail: string): FilterCheck {
  return { id, status: "skipped", value: null, detail };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
