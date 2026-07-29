# sol-automated-trading-bot

Automatisierter DLMM-Liquidity-Providing-Bot für [Meteora](https://www.meteora.ag/) auf Solana.
Pool-Discovery über [Fabriq](https://fabriq.trade/trending) (Degen & Multiday), mehrstufige
Risiko-Filterung, automatisches Eröffnen/Rebalancen/Schließen von Positionen, Web-UI zur
Parametersteuerung und Analyse-Dashboard.

➡️ **[KONZEPT.md](./KONZEPT.md)** — vollständiges Umsetzungs- und Risikokonzept.

## Projektstruktur (Monorepo, pnpm)

```
apps/
  bot/            # CLI/Runtime: validate, health (später: Discovery→Execution-Loop)
  web/            # Platzhalter für die Next.js-UI (Schritt 3/4)
packages/
  core/           # Pure Domänenlogik: Config-Schemas + versionierter ConfigService,
                  # Positions-Lebenszyklus (Zustandsmaschine), Domänentypen
  adapters/       # Meteora-API, DexScreener, RugCheck, Jupiter (+ Fabriq-Spike),
                  # HTTP-Infra: Retry/Backoff, Rate-Limiting, zod-Validierung
  db/             # Prisma-Schema (8 Tabellen aus KONZEPT.md 10.2), Migrationen,
                  # PrismaConfigStore
config/           # Default-Parameter (global.json, degen.json, multiday.json)
```

## Setup

Voraussetzungen: Node >= 20, pnpm >= 10, Docker (für PostgreSQL).

```bash
pnpm install
cp .env.example .env          # DATABASE_URL etc. eintragen
docker compose up -d postgres # lokale DB
pnpm db:generate              # Prisma-Client generieren
pnpm db:migrate               # Migrationen anwenden

pnpm typecheck                # TypeScript strict über alle Pakete
pnpm test                     # Vitest (fixture-basiert, ohne Netzwerk)

pnpm --filter @lping/bot validate  # Default-Config prüfen
pnpm --filter @lping/bot health    # Adapter-Erreichbarkeit testen (Netzwerk nötig)
pnpm --filter @lping/db db:check   # DB-Roundtrip prüfen (nach db:migrate)

# Scanner: Discovery → Screening → Score-Tabelle (Netzwerk nötig).
# Persistiert Kandidaten + Snapshots, wenn DATABASE_URL gesetzt ist:
pnpm --filter @lping/bot scan
pnpm --filter @lping/bot scan -- --pages 4 --top 8   # kleinerer/schnellerer Lauf
pnpm --filter @lping/bot scan -- --no-db             # ohne Persistenz

# Fabriq-Endpoint prüfen (optional, URL aus den Browser-Entwicklertools, siehe SPIKE.md):
pnpm --filter @lping/bot fabriq:check "https://…"
```

## Stand & nächste Schritte

Umgesetzt sind Schritte 1–3 der Umsetzungsreihenfolge (KONZEPT.md, Abschnitt 16):

1. ✅ Monorepo-Gerüst, DB-Schema, versionierter Config-Service
2. ✅ Daten-Adapter (Meteora, DexScreener, RugCheck, Jupiter) + Fabriq-Spike.
   Spike-Ergebnis: kein stabiler Fabriq-Endpoint auffindbar → **eigene
   Degen/Multiday-Replikation ist die primäre Discovery-Quelle** (KONZEPT.md 4.1).
3. ✅ Screening-Pipeline: Vor-Filter (Replikation) → Enrichment → Hard Filters
   (fail-closed) → Score 0–100 → Kandidaten-Persistenz mit Shadow-Tracking.
   Sichtbar über `pnpm --filter @lping/bot scan`.

Als Nächstes (Schritt 4): Paper-Trading-Engine + Scanner-/Dashboard-UI. Es findet
noch **kein** Handel statt; `paperTrading` ist fest auf `true` gesetzt.
