"use client";

import { useActionState } from "react";
import type { BotConfig } from "@lping/core";
import { saveConfig, type SaveResult } from "./actions";

/**
 * Parameter-Editor. Jedes Eingabefeld trägt seinen Konfigurationspfad im
 * name-Attribut ("presets.degen.stopLossPct|number"), damit die Server Action
 * daraus einen Patch bauen kann, ohne die Feldliste doppelt zu pflegen.
 */
export function ParameterForm({ config, version }: { config: BotConfig; version: number }) {
  const [result, formAction, pending] = useActionState<SaveResult | null, FormData>(
    saveConfig,
    null,
  );

  return (
    <form action={formAction} className="params">
      <fieldset>
        <legend>Global</legend>
        <div className="grid-inputs">
          <Bool
            path="global.paperTrading"
            label="Paper-Trading (kein echtes Kapital)"
            value={config.global.paperTrading}
          />
          <Select
            path="global.killSwitch"
            label="Kill-Switch"
            value={config.global.killSwitch}
            options={[
              ["off", "aus — normaler Betrieb"],
              ["pause", "Pause — keine neuen Positionen"],
              ["flatten", "Flatten — alles schließen"],
            ]}
          />
          <Num path="global.maxTotalExposureSol" label="Max. Gesamteinsatz (SOL)" value={config.global.maxTotalExposureSol} />
          <Num path="global.minSolReserve" label="SOL-Reserve für Gebühren" value={config.global.minSolReserve} />
          <Num path="global.maxOpenPositions" label="Max. offene Positionen" value={config.global.maxOpenPositions} step="1" />
          <Num path="global.dailyLossLimitPct" label="Tagesverlustlimit (%)" value={config.global.dailyLossLimitPct} />
          <Num path="global.hardLossLimitPct" label="Hartes Verlustlimit (%)" value={config.global.hardLossLimitPct} />
          <Num path="global.profitSweepThresholdSol" label="Gewinn-Sweep ab (SOL)" value={config.global.profitSweepThresholdSol} />
        </div>
      </fieldset>

      <fieldset>
        <legend>Paper-Trading-Annahmen</legend>
        <div className="grid-inputs">
          <Num
            path="global.paper.capitalPerPresetSol"
            label="Virtuelles Kapital je Preset (SOL)"
            value={config.global.paper.capitalPerPresetSol}
          />
          <Num
            path="global.paper.costs.priorityFeeSol"
            label="Priority Fee je Transaktion (SOL)"
            value={config.global.paper.costs.priorityFeeSol}
            step="0.0001"
          />
          <Num
            path="global.paper.costs.swapSlippagePct"
            label="Slippage je Swap (%)"
            value={config.global.paper.costs.swapSlippagePct}
          />
          <Num
            path="global.paper.feeShareHaircutPct"
            label="Abschlag auf Fee-Anteil (%)"
            value={config.global.paper.feeShareHaircutPct}
          />
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
          Nur On-Chain-Kosten: Infrastruktur (VPS, RPC) ist monatlicher Fixaufwand und
          keiner einzelnen Position zurechenbar — sie würde den Preset-Vergleich verzerren.
        </p>
      </fieldset>

      {Object.entries(config.presets).map(([id, preset]) => (
        <fieldset key={id}>
          <legend>{preset.label}</legend>
          <div className="grid-inputs">
            <Bool path={`presets.${id}.enabled`} label="Aktiv" value={preset.enabled} />
            <Num path={`presets.${id}.capitalSharePct`} label="Kapitalanteil live (%)" value={preset.capitalSharePct} />
            <Num path={`presets.${id}.positionSizeSol`} label="Positionsgröße (SOL)" value={preset.positionSizeSol} step="0.5" />
            <Num path={`presets.${id}.maxPositions`} label="Max. Positionen" value={preset.maxPositions} step="1" />
            <Num path={`presets.${id}.minScore`} label="Mindest-Score" value={preset.minScore} />
            <Num path={`presets.${id}.minTvlUsd`} label="Mindest-TVL (USD)" value={preset.minTvlUsd} step="1000" />
            <Num path={`presets.${id}.tokenAgeHours.min`} label="Token-Alter min (h)" value={preset.tokenAgeHours.min} />
            {preset.tokenAgeHours.max !== undefined && (
              <Num path={`presets.${id}.tokenAgeHours.max`} label="Token-Alter max (h)" value={preset.tokenAgeHours.max} />
            )}
            <Select
              path={`presets.${id}.strategy.type`}
              label="Liquiditätsverteilung"
              value={preset.strategy.type}
              options={[
                ["Spot", "Spot — gleichmäßig"],
                ["Curve", "Curve — um den Preis konzentriert"],
                ["BidAsk", "BidAsk — an den Rändern"],
              ]}
            />
            <Select
              path={`presets.${id}.strategy.sided`}
              label="Einstiegsform"
              value={preset.strategy.sided}
              options={[
                ["balanced", "50/50 um den Preis"],
                ["quote_only", "nur SOL unterhalb (Kauforders)"],
              ]}
            />
            <Num path={`presets.${id}.stopLossPct`} label="Stop-Loss (%) — Rückfalllinie" value={preset.stopLossPct} />
            <Num path={`presets.${id}.maxHoldHours`} label="Max. Haltezeit (h)" value={preset.maxHoldHours} />
            <Num path={`presets.${id}.binRange.coverageSigmas`} label="Range-Breite (σ der Tagesbewegung)" value={preset.binRange.coverageSigmas ?? 1.5} step="0.25" />
            <Num path={`presets.${id}.volatilityBoundsPctDaily.min`} label="Volatilität min (%/Tag)" value={preset.volatilityBoundsPctDaily.min} />
            <Num path={`presets.${id}.volatilityBoundsPctDaily.max`} label="Volatilität max (%/Tag)" value={preset.volatilityBoundsPctDaily.max} />
            <Num path={`presets.${id}.exit.priceCrashPct`} label="Ausstieg: Preissturz (%)" value={preset.exit.priceCrashPct} />
            <Num path={`presets.${id}.exit.tvlDrainPct`} label="Ausstieg: TVL-Abzug (%)" value={preset.exit.tvlDrainPct} />
            <Num path={`presets.${id}.exit.feeCollapsePct`} label="Ausstieg: Ertragseinbruch (%)" value={preset.exit.feeCollapsePct} />
            <Num path={`presets.${id}.exit.feeStallHours`} label="Ausstieg: Stunden ohne Ertrag" value={preset.exit.feeStallHours} step="0.5" />
            <Num path={`presets.${id}.slippageCapPct`} label="Slippage-Limit (%)" value={preset.slippageCapPct} />
            <Bool path={`presets.${id}.rebalance.enabled`} label="Rebalancing" value={preset.rebalance.enabled} />
            <Num path={`presets.${id}.rebalance.minEvFactor`} label="Rebalance nur ab Ertragsfaktor" value={preset.rebalance.minEvFactor} />
            <Num path={`presets.${id}.feeHarvest.claimIntervalMin`} label="Fee-Claim alle (min)" value={preset.feeHarvest.claimIntervalMin} step="1" />
            <Num path={`presets.${id}.feeHarvest.convertToSolPct`} label="Fees in SOL wandeln (%)" value={preset.feeHarvest.convertToSolPct} />
            <Num path={`presets.${id}.screening.maxNormalizedRiskScore`} label="Max. Risikoscore" value={preset.screening.maxNormalizedRiskScore} />
            <Num path={`presets.${id}.screening.maxTop10HolderPct`} label="Max. Top-10-Holder (%)" value={preset.screening.maxTop10HolderPct} />
            <Num path={`presets.${id}.screening.minHolders`} label="Mindest-Holder" value={preset.screening.minHolders} step="1" />
          </div>
        </fieldset>
      ))}

      <div className="form-footer">
        <button type="submit" disabled={pending}>
          {pending ? "Speichere…" : "Speichern"}
        </button>
        <span className="muted">Aktuelle Version: {version}</span>
        {result !== null && (
          <span className={result.ok ? "pos" : "neg"}>{result.message}</span>
        )}
      </div>
    </form>
  );
}

function Num({
  path,
  label,
  value,
  step = "any",
}: {
  path: string;
  label: string;
  value: number;
  step?: string;
}) {
  return (
    <label className="field">
      {label}
      <input type="number" name={`${path}|number`} defaultValue={value} step={step} />
    </label>
  );
}

function Bool({ path, label, value }: { path: string; label: string; value: boolean }) {
  return (
    <label className="field">
      {label}
      <select name={`${path}|bool`} defaultValue={String(value)}>
        <option value="true">ja</option>
        <option value="false">nein</option>
      </select>
    </label>
  );
}

function Select({
  path,
  label,
  value,
  options,
}: {
  path: string;
  label: string;
  value: string;
  options: [string, string][];
}) {
  return (
    <label className="field">
      {label}
      <select name={`${path}|string`} defaultValue={value}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
