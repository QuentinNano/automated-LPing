# sol-automated-trading-bot

Automatisierter DLMM-Liquidity-Providing-Bot für [Meteora](https://www.meteora.ag/) auf Solana.
Pool-Discovery über [Fabriq](https://fabriq.trade/trending) (Degen & Multiday), mehrstufige
Risiko-Filterung, automatisches Eröffnen/Rebalancen/Schließen von Positionen, Web-UI zur
Parametersteuerung und Analyse-Dashboard.

➡️ **[KONZEPT.md](./KONZEPT.md)** — vollständiges Umsetzungs- und Risikokonzept.
➡️ **[KONZEPT-ML.md](./KONZEPT-ML.md)** — datengetriebene Optimierung von Parametern
und Indikatoren. Die Datenaufzeichnung (M1) **läuft**; Replay und Optimierer stehen aus.

## Projektstruktur (Monorepo, pnpm)

```
apps/
  bot/            # CLI: validate, health, scan, paper, track
                  # (später: Execution-Loop)
  web/            # Next.js-UI: Preset-Vergleich, Positionen, Scanner, Parameter
packages/
  core/           # Pure Domänenlogik: Config-Schemas + versionierter ConfigService,
                  # Screening/Scoring, Paper-Trading-Engine (Bin-Modell, Fees,
                  # PnL, HODL-Benchmark), Positions-Lebenszyklus, ML-Merkmale/Labels
  adapters/       # Meteora-API, DexScreener, RugCheck, Jupiter (+ Fabriq-Spike),
                  # HTTP-Infra: Retry/Backoff, Rate-Limiting, zod-Validierung
  db/             # Prisma-Schema (11 Tabellen: 8 aus KONZEPT.md 10.2 plus die drei
                  # Aufzeichnungstabellen), Migrationen, PrismaConfigStore
config/           # global.json + ein JSON je Preset (konservativ, balanced, degen)
```

## Wenn etwas nicht läuft

`pnpm --filter @lping/bot api:check` prüft die externen Datenquellen und zeigt,
welche Schnittstelle antwortet und welche Felder sie liefert. Die Meteora-APIs
sind nicht formal versioniert; ändern sich Pfade oder Feldnamen, ist diese
Ausgabe der schnellste Weg zur Ursache.

Der Adapter spricht beide bekannten Meteora-Schnittstellen an
(`dlmm.datapi.meteora.ag/pools`, ersatzweise `dlmm-api.meteora.ag/pair/all`),
merkt sich die funktionierende und liest Feldnamen über Alias-Listen — ein
Umbenennen einzelner Felder legt die Discovery damit nicht sofort lahm.

`api:check` weist zusätzlich aus, **welche Zeitfenster** ankommen und ob
Gebührenstruktur (dynamische Gebühr, Protokollanteil, `collect_fee_mode`) und
Pool-Alter gelesen werden. Fällt eines davon aus, verarmt die Aufzeichnung
still — und aufgezeichnete Zeit lässt sich nicht nachholen.

## Discovery

Die Pool-Suche führt **mehrere Sortierungen** der Meteora-API zusammen, gefiltert
serverseitig (`filter_by=is_blacklisted=false && tvl>=…`):

| Sortierung | Wozu |
|---|---|
| `volume_24h:desc` | etablierte Aktivität — trägt die längerfristigen Presets |
| `fee_tvl_ratio_1h:desc` | aktuelle Ertragskraft — Pools, die gerade anfangen zu verdienen |
| `pool_created_at:desc` | neue Pools — das Degen-Fenster (1–48 h) ist über Volumen nicht erreichbar |

Der Grund für den Aufwand: Ein Pool, der vor drei Stunden entstanden ist, kann
per Definition kein hohes 24-Stunden-Volumen haben. Wer nur die
Standardsortierung liest, sieht das Degen-Universum nie. Die Ergebnisse werden
nach Pool-Adresse dedupliziert; `--pages` zählt Seiten **je Sortierung**.

Die Seiten-Auswahl ist Vorauswahl, nicht Entscheidung: Abgelehnt wird
ausschließlich im Screening, mit Begründung im Scanner. Die Quote-Token-Prüfung
bleibt deshalb clientseitig — `filter_by` verknüpft nur mit UND, und SOL kann
Token X *oder* Token Y sein.

## Presets

Ausgeliefert werden drei Risikoprofile, die im Paper-Trading **gleichzeitig** auf
denselben Marktdaten und mit demselben virtuellen Kapital laufen — Unterschiede in
den Ergebnissen stammen damit ausschließlich aus den Parametern:

| Preset | Token-Alter | Min. TVL | Strategie | Stop-Loss | Haltedauer | Rebalancing |
|---|---|---|---|---|---|---|
| **Konservativ** | ≥ 7 Tage | 250 k$ | Curve, 50/50 | 15 % | ≤ 14 Tage | ja |
| **Balanced** | ≥ 2 Tage | 120 k$ | Curve, 50/50 | 20 % | ≤ 4 Tage | ja |
| **Degen** | 1–48 h | 50 k$ | BidAsk, nur SOL | 15 % | ≤ 24 h | nein |

Ein weiteres Profil entsteht durch eine zusätzliche Datei in `config/` (z. B.
`degen_eng.json`) — sie erscheint automatisch in UI und Vergleich.

## Schnellstart (macOS)

Einmalig, im Terminal (Spotlight `Cmd`+Leertaste → „Terminal"):

```bash
# 1. Werkzeuge installieren (Homebrew von https://brew.sh vorausgesetzt)
brew install node git
npm install -g pnpm
brew install --cask docker      # danach Docker Desktop einmal öffnen

# 2. Projekt holen
git clone https://github.com/QuentinNano/automated-LPing.git
cd automated-LPing

# 3. Alles einrichten (Abhängigkeiten, .env, Datenbank, Schema)
pnpm einrichten
```

Danach der eigentliche Betrieb:

```bash
pnpm --filter @lping/bot paper       # ein Simulationslauf
pnpm --filter @lping/web dev         # Oberfläche → http://localhost:3000
```

`pnpm einrichten` prüft die Voraussetzungen und bricht mit einer konkreten
Handlungsanweisung ab, wenn etwas fehlt. Das Skript ist gefahrlos wiederholbar:
eine vorhandene `.env` wird nicht überschrieben.

## Setup (allgemein)

Voraussetzungen: Node >= 20, pnpm >= 10, Docker (für PostgreSQL).

```bash
pnpm install
cp .env.example .env          # DATABASE_URL etc. eintragen
docker compose up -d postgres # lokale DB
pnpm db:generate              # Prisma-Client generieren
pnpm db:migrate               # Migrationen anwenden (auch nach jedem git pull)

pnpm typecheck                # TypeScript strict über alle Pakete
pnpm test                     # Vitest (fixture-basiert, ohne Netzwerk)

pnpm --filter @lping/bot validate  # Default-Config prüfen
pnpm --filter @lping/bot health    # Adapter-Erreichbarkeit testen (Netzwerk nötig)
pnpm --filter @lping/bot api:check # Datenquellen diagnostizieren (bei API-Fehlern)
pnpm --filter @lping/db db:check   # DB-Roundtrip prüfen (nach db:migrate)

# Scanner: Discovery → Screening → Score-Tabelle (Netzwerk nötig).
# Persistiert Kandidaten + Snapshots, wenn DATABASE_URL gesetzt ist:
pnpm --filter @lping/bot scan
pnpm --filter @lping/bot scan -- --pages 1 --top 8   # kleinerer/schnellerer Lauf
pnpm --filter @lping/bot scan -- --no-db             # ohne Persistenz

# Paper-Trading: alle Presets parallel simulieren (benötigt Datenbank).
pnpm --filter @lping/bot paper                       # ein Zyklus
pnpm --filter @lping/bot paper -- --interval 15      # dauerhaft, alle 15 min
pnpm --filter @lping/bot paper -- --tick-only        # nur bestehende Positionen

# Datenaufzeichnung für die spätere Strategie-Optimierung (KONZEPT-ML.md).
# Sucht neue Pools UND verfolgt deren Verlauf; startet nach Abstürzen von
# selbst neu, hält den Mac wach, protokolliert nach logs/track.log:
pnpm aufzeichnen

# Breite statt Tiefe: Für die Auswahl-Modellierung zählen **verschiedene** Pools,
# nicht wiederholte Messungen derselben. TOP steuert, wie viele Kandidaten je
# Preset tief geprüft (und damit verfolgt) werden — Default 40.
TOP=60 SCAN_EVERY=8 pnpm aufzeichnen

# Prüfen, ob die Aufzeichnung wie erwartet arbeitet (Urteil je Aspekt):
pnpm pruefen

# Einzelne Durchgänge / Statusabfrage:
pnpm --filter @lping/bot track                       # ein Durchgang
pnpm --filter @lping/bot track -- --status           # Fortschritt
pnpm --filter @lping/bot track -- --top 60           # mehr verschiedene Pools verfolgen
pnpm --filter @lping/bot track -- --scan-every 8     # seltener nach neuen Pools suchen
pnpm --filter @lping/bot track -- --no-scan          # nur verfolgen, nichts Neues suchen

# Datensicherung (Merkmale und TVL-Verlauf sind nicht wiederbeschaffbar):
pnpm sichern                                    # Sicherung anlegen
bash scripts/backup.sh liste                    # vorhandene anzeigen
bash scripts/backup.sh zurueck backups/DATEI    # einspielen

# Oberfläche (http://localhost:3000)
pnpm --filter @lping/web dev

# Fabriq-Endpoint prüfen (optional, URL aus den Browser-Entwicklertools, siehe SPIKE.md):
pnpm --filter @lping/bot fabriq:check "https://…"
```

### Was `pnpm pruefen` beurteilt

Der Bericht fällt je Aspekt ein Urteil, statt Zahlen zu zeigen, die man selbst
deuten müsste: Läuft die Aufzeichnung? Werden Pools verfolgt und kommen neue
Kandidaten dazu? Wie groß war die längste Unterbrechung? Liefert jede
Datenquelle noch?

Der letzte Punkt sind die **Ergebnis-Labels**, und dort zählt nicht ihre Anzahl,
sondern der **Rückstand**: fällige, aber fehlende Labels. Der Unterschied ist
entscheidend — eine Nachberechnung, die nur die ältesten Kandidaten immer wieder
anfasst, weist weiterhin Tausende Labels aus und sieht damit gesund aus, während
für jeden neuen Kandidaten keines mehr entsteht. Ein Rückstand nach einer
Unterbrechung ist normal und baut sich über die nächsten Durchgänge ab; bleibt
er stehen oder wächst er, wird nicht mehr nachgeführt.

## Oberfläche

| Seite | Inhalt |
|---|---|
| **Vergleich** | PnL je Preset, davon Fees, On-Chain-Kosten, Trefferquote, Zeit in Range und der Vergleich gegen reines Halten |
| **Positionen** | Bin-Range mit Preis-Marker, Einsatz, aktueller Wert, Fees, Kosten, PnL, Zeit in Range; geschlossene Positionen mit Ausstiegsgrund |
| **Scanner** | Entdeckte Pools mit Score und ausformulierter Begründung, warum ein Kandidat abgelehnt wurde |
| **Parameter** | Alle Werte editierbar; jede Änderung wird validiert und versioniert, ungültige Eingaben ändern nichts |

## Stand & nächste Schritte

Es findet **kein** echter Handel statt: Es gibt keine Signier- oder Sende-Logik,
und `paperTrading` steht auf `true`.

**Umgesetzt** (KONZEPT.md Abschnitt 16, Schritte 1–4):

1. ✅ Monorepo-Gerüst, DB-Schema, versionierter Config-Service
2. ✅ Daten-Adapter (Meteora, DexScreener, RugCheck, Jupiter) + Fabriq-Spike.
   Spike-Ergebnis: kein stabiler Fabriq-Endpoint auffindbar → **eigene
   Replikation ist die primäre Discovery-Quelle** (KONZEPT.md 4.1).
3. ✅ Screening-Pipeline: Vor-Filter → Enrichment → Hard Filters (fail-closed)
   → Score 0–100 → Kandidaten-Persistenz mit Shadow-Tracking.
4. ✅ Paper-Trading-Engine (bin-genaues DLMM-Modell, Fee-Akkrual, On-Chain-Kosten,
   HODL-Benchmark, Exit-Regeln) mit Multi-Preset-Vergleich, plus Web-UI.
5. ✅ Datenaufzeichnung für die Strategie-Optimierung (KONZEPT-ML.md M1–M1d):
   `track`-Kommando, Merkmale je Kandidat, Verlaufsaufzeichnung, Ergebnis-Labels,
   Prüfbericht.

**Aktueller Arbeitsschwerpunkt** ist die Aufzeichnung, nicht die Execution
Engine: Sie ist die einzige Komponente, deren Wert von verstrichener Zeit
abhängt, und sie läuft parallel zum Paper-Vergleich (`pnpm aufzeichnen`).

**Als Nächstes**, in dieser Reihenfolge:

1. **Replay-Engine** (KONZEPT-ML.md M2) — aufgezeichnete und über die
   Meteora-Historie nachgeladene Verläufe als `MarketTick`s durch dieselbe
   Paper-Engine schicken. Voraussetzung für alles Weitere der Optimierung.
2. **Sensitivitätsanalyse** (M3) — welche Parameter überhaupt etwas bewirken.
3. **Execution Engine** (KONZEPT.md Schritt 5) — Transaktionsbau, Simulation vor
   dem Senden, Reconciliation nach Neustart, RPC-Failover, Telegram-Alerts.
   Frühestens, wenn Phase 1 ihre Go-Kriterien erfüllt (KONZEPT.md 13).

**Bekannte Lücken**, die vor dem Live-Betrieb geschlossen sein müssen — sie sind
im Paper-Modus folgenlos, würden Phase 2 aber ungeprüft erreichen:

- Der **Risk Manager** (KONZEPT.md 6.3) ist noch nicht scharf: `killSwitch`,
  `maxOpenPositions`, `maxTotalExposureSol`, die Verlustlimits und die
  `emergency`-Schwellen sind konfigurier- und anzeigbar, werden aber von keiner
  Logik durchgesetzt.
- **Keine On-Chain-Reads:** Mint-/Freeze-Authority kommen ausschließlich von
  RugCheck; die Token-2022-Prüfung aus KONZEPT.md 5.1 und die LP-Dominanz
  fehlen ganz. Beides braucht den RPC-Adapter aus Schritt 5.
- Die **Web-UI hat keine Authentifizierung** und gehört bis dahin nur auf den
  lokalen Rechner, nicht auf einen erreichbaren Server (KONZEPT.md 11).
