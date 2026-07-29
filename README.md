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

# Fabriq-Endpoint prüfen (URL aus den Browser-Entwicklertools, siehe SPIKE.md):
pnpm --filter @lping/bot fabriq:check "https://…"
```

## Stand & nächste Schritte

Umgesetzt sind Schritt 1 und 2 der Umsetzungsreihenfolge (KONZEPT.md, Abschnitt 16):
Monorepo-Gerüst, DB-Schema, versionierter Config-Service sowie die Daten-Adapter
inkl. Fabriq-Spike (Endpoint-Verifikation offen, siehe
`packages/adapters/src/fabriq/SPIKE.md`). Es findet noch **kein** Handel statt;
`paperTrading` ist fest auf `true` gesetzt, bis Screening/Scoring und die
Paper-Trading-Engine (Schritte 3–4) stehen.
