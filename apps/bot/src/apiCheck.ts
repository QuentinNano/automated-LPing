import { MeteoraAdapter, WSOL_MINT, DexScreenerAdapter, normalizeMeteoraPair } from "@lping/adapters";
import { METRIC_WINDOWS, type WindowedMetric } from "@lping/core";

/**
 * Prüft die externen Datenquellen und zeigt, was sie tatsächlich liefern.
 *
 * Die Meteora-Schnittstellen sind nicht formal versioniert; ändern sich
 * Pfade oder Feldnamen, bricht die Discovery. Dieses Kommando macht sichtbar,
 * welche Quelle antwortet und welche Felder ankommen — die Ausgabe reicht,
 * um den Adapter gezielt nachzuziehen.
 */

interface Probe {
  label: string;
  url: string;
}

const PROBES: Probe[] = [
  { label: "datapi (aktuell)", url: "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=2" },
  { label: "legacy", url: "https://dlmm-api.meteora.ag/pair/all" },
];

export async function cmdApiCheck(): Promise<number> {
  console.log("Prüfe die Meteora-Schnittstellen…\n");

  let anyOk = false;
  for (const probe of PROBES) {
    process.stdout.write(`  ${probe.label.padEnd(18)} `);
    let response: Response;
    const started = Date.now();
    try {
      response = await fetch(probe.url, { headers: { accept: "application/json" } });
    } catch (error) {
      console.log(`nicht erreichbar (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const ms = Date.now() - started;

    if (!response.ok) {
      console.log(`HTTP ${response.status} (${ms} ms)`);
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      console.log(`HTTP 200, aber kein JSON (${ms} ms)`);
      continue;
    }

    console.log(`HTTP 200 (${ms} ms)`);
    anyOk = true;
    describe(payload);
  }

  console.log("\nAdapter-Abruf über die eingebaute Quellenwahl:");
  try {
    const page = await new MeteoraAdapter().getPairsPage({ page: 0, limit: 5 });
    console.log(`  ✓ Quelle "${page.source}": ${page.pairs.length} Pools gelesen, ${page.skipped} übersprungen`);
    for (const pool of page.pairs.slice(0, 3)) {
      console.log(
        `    ${pool.name ?? pool.poolAddress.slice(0, 12)}  binStep ${pool.binStep}  ` +
          `TVL ${pool.tvlUsd?.toFixed(0) ?? "?"}  Vol24h ${pool.volume24hUsd?.toFixed(0) ?? "?"}`,
      );
    }
    if (page.pairs.length === 0) {
      console.log("  ! Keine Pools verwertbar — vermutlich haben sich die Feldnamen geändert.");
    }
  } catch (error) {
    console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }

  await checkHistory();

  console.log("\nDexScreener (SOL-Preis):");
  try {
    const { pairs } = await new DexScreenerAdapter().getPairsForToken(WSOL_MINT);
    const withPrice = pairs.find((p) => p.priceUsd !== undefined && p.priceUsd > 0);
    console.log(
      withPrice?.priceUsd !== undefined
        ? `  ✓ SOL ≈ ${withPrice.priceUsd.toFixed(2)} USD (${pairs.length} Paare)`
        : "  ! Antwort erhalten, aber kein Preis gefunden",
    );
  } catch (error) {
    console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!anyOk) {
    console.log(
      "\nKeine Meteora-Schnittstelle hat geantwortet.\n" +
        "  → Internetverbindung prüfen. Bleibt es dabei, bitte diese Ausgabe melden.",
    );
    return 1;
  }
  return 0;
}

/**
 * Prüft die Historien-Endpunkte — und zwar die eine Frage, die die Doku offen
 * lässt: **In welcher Einheit steht der Preis?**
 *
 * `current_price` ist der Preis von Token X in Token Y. Ob OHLCV dieselbe
 * Einheit nutzt oder USD, ist nicht dokumentiert. Der Unterschied ist für den
 * Replay entscheidend: Eine Verwechslung verschiebt jede Bin-Zuordnung. Deshalb
 * wird hier verglichen statt angenommen — die jüngste Kerze sollte nahe am
 * aktuellen Preis liegen.
 */
async function checkHistory(): Promise<void> {
  console.log("\nHistorie (nachladbarer Verlauf):");
  const meteora = new MeteoraAdapter();

  let pool;
  try {
    const page = await meteora.getPairsPage({ page: 0, limit: 1 });
    pool = page.pairs[0];
  } catch (error) {
    console.log(`  ✗ Kein Pool zum Prüfen: ${message(error)}`);
    return;
  }
  if (pool === undefined) {
    console.log("  ! Kein Pool verwertbar — Historie nicht prüfbar.");
    return;
  }

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 2 * 3_600_000);
  try {
    const candles = await meteora.getHistory(pool.poolAddress, {
      timeframe: "5m",
      startTime,
      endTime,
    });
    if (candles.length === 0) {
      console.log(
        `  ! ${pool.name ?? pool.poolAddress.slice(0, 10)}: keine Kerzen für die letzten 2 Stunden.`,
      );
      return;
    }

    const last = candles[candles.length - 1]!;
    const withFees = candles.filter((candle) => candle.feesUsd !== null).length;
    console.log(
      `  ✓ ${candles.length} Kerzen (5m) für ${pool.name ?? pool.poolAddress.slice(0, 10)}, ` +
        `davon ${withFees} mit Gebühren`,
    );
    console.log(
      `    Letzte Kerze: close ${fmt(last.close ?? undefined)}, ` +
        `high ${fmt(last.high ?? undefined)}, low ${fmt(last.low ?? undefined)}, ` +
        `Volumen ${fmt(last.volumeUsd ?? undefined)} USD`,
    );

    // Der eigentliche Zweck: Einheit des Preises gegenprüfen.
    const current = pool.priceNative;
    if (current !== undefined && current > 0 && last.close !== null && last.close > 0) {
      const ratio = last.close / current;
      const plausible = ratio > 0.5 && ratio < 2;
      console.log(
        `    Abgleich mit current_price ${fmt(current)}: Verhältnis ${ratio.toFixed(3)} — ` +
          (plausible
            ? "gleiche Einheit (Preis von X in Y)."
            : "ABWEICHUNG! Vermutlich andere Einheit (USD?) — der Replay würde Bins falsch zuordnen."),
      );
    }
  } catch (error) {
    console.log(`  ✗ Historie nicht abrufbar: ${message(error)}`);
    console.log("    Ohne sie lassen sich Aufzeichnungslücken nicht nachträglich schließen.");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Zeigt Envelope-Struktur und Feldnamen des ersten Datensatzes. */
function describe(payload: unknown): void {
  if (Array.isArray(payload)) {
    console.log(`      Antwort: Array mit ${payload.length} Einträgen`);
    describeFirst(payload[0]);
    return;
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    console.log(`      Envelope-Felder: ${Object.keys(record).join(", ")}`);
    for (const key of ["data", "pairs", "pools", "items", "results"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        console.log(`      "${key}" enthält ${value.length} Einträge`);
        describeFirst(value[0]);
        return;
      }
    }
  }
  console.log("      Unerwartete Antwortform.");
}

function describeFirst(item: unknown): void {
  if (typeof item !== "object" || item === null) {
    console.log("      Kein Objekt im ersten Eintrag.");
    return;
  }
  const keys = Object.keys(item as Record<string, unknown>);
  console.log(`      Felder je Pool: ${keys.join(", ")}`);

  const normalized = normalizeMeteoraPair(item);
  if (normalized === null) {
    console.log("      ✗ Adapter kann daraus keine Pool-Metriken lesen.");
  } else {
    const missing = [
      normalized.tvlUsd === undefined ? "TVL" : null,
      normalized.volume24hUsd === undefined ? "Volumen" : null,
      normalized.baseFeePct === undefined ? "Gebühr" : null,
      normalized.feeTvl24hPct === undefined ? "Fee/TVL" : null,
      // Ab hier: Felder, die nicht den Filter, sondern die Aufzeichnung
      // betreffen. Fallen sie aus, verarmt der Datensatz still — und
      // aufgezeichnete Zeit lässt sich nicht nachholen.
      normalized.dynamicFeePct === undefined ? "dynamische Gebühr" : null,
      normalized.protocolFeePct === undefined ? "Protokollanteil" : null,
      normalized.collectFeeMode === undefined ? "collect_fee_mode" : null,
      normalized.poolCreatedAt === undefined ? "Pool-Alter" : null,
    ].filter((x): x is string => x !== null);

    console.log(
      `      ✓ Adapter liest: ${normalized.poolAddress.slice(0, 10)}…, binStep ${normalized.binStep}` +
        `, TVL ${fmt(normalized.tvlUsd)}, Vol24h ${fmt(normalized.volume24hUsd)}` +
        `, Gebühr ${fmt(normalized.baseFeePct)}%, Fee/TVL ${fmt(normalized.feeTvl24hPct)}%`,
    );
    console.log(
      `        Gebührenstruktur: dynamisch ${fmt(normalized.dynamicFeePct)}%` +
        `, max ${fmt(normalized.maxFeePct)}%, Protokollanteil ${fmt(normalized.protocolFeePct)}%` +
        `, Modus ${normalized.collectFeeMode ?? "—"}`,
    );
    console.log(`        Zeitfenster Volumen: ${describeWindows(normalized.volumeUsd)}`);
    console.log(`        Zeitfenster Fee/TVL: ${describeWindows(normalized.feeTvlPct)}`);

    const windowCount = Object.keys(normalized.volumeUsd).length;
    if (windowCount <= 1) {
      console.log(
        "      ! Nur ein Zeitfenster gelesen. Die Trend-Merkmale der Optimierung",
        "\n        brauchen die kurzen Fenster — Feldnamen im Datensatz unten prüfen.",
      );
    }
    if (missing.length > 0) {
      console.log(`      ! Nicht gelesen: ${missing.join(", ")}`);
    }
  }

  // Vollständiger Datensatz: die verschachtelten Werte (pool_config, volume,
  // fees …) sind der einzige verlässliche Weg, die echten Feldnamen zu sehen.
  console.log("\n      Erster Datensatz vollständig:");
  console.log(indent(JSON.stringify(item, null, 2).slice(0, 4000), "      "));
}

function fmt(value: number | undefined): string {
  return value === undefined ? "—" : String(Math.round(value * 100) / 100);
}

/** Zeigt, welche Zeitfenster tatsächlich ankommen — nicht nur ob überhaupt. */
function describeWindows(metric: WindowedMetric): string {
  const present = METRIC_WINDOWS.filter((window) => metric[window] !== undefined);
  if (present.length === 0) return "keine";
  return present.map((window) => `${window}=${fmt(metric[window])}`).join("  ");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}
