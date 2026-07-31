# sol-automated-trading-bot

Automatisiertes Liquidity Providing auf [Meteora](https://www.meteora.ag/) DLMM
(Solana): Pool-Discovery, mehrstufige Risikofilterung, simulierter
Positions-Lebenszyklus, Web-UI zur Parametersteuerung und eine Datenaufzeichnung
für die spätere datengetriebene Optimierung.

> **Es findet kein echter Handel statt.** Es gibt keine Signier- oder Sende-Logik,
> `paperTrading` steht auf `true`. Alles unten simuliert auf echten Marktdaten.

| Dokument | Inhalt |
|---|---|
| **[KONZEPT.md](./KONZEPT.md)** | Strategie, Risikomodell, Architektur, Rollout-Plan |
| **[KONZEPT-ML.md](./KONZEPT-ML.md)** | Datengetriebene Optimierung: Datenfundament, Replay, Validierung |

---

## Schnellstart

Voraussetzungen: Node ≥ 20, pnpm ≥ 10, Docker (für PostgreSQL).

```bash
git clone https://github.com/QuentinNano/automated-LPing.git
cd automated-LPing
pnpm einrichten        # Abhängigkeiten, .env, Datenbank, Schema — wiederholbar
```

`pnpm einrichten` prüft die Voraussetzungen und bricht mit einer konkreten
Handlungsanweisung ab, wenn etwas fehlt. Eine vorhandene `.env` wird nicht
überschrieben.

Auf macOS vorab einmalig: `brew install node git`, `npm install -g pnpm`,
`brew install --cask docker` (danach Docker Desktop öffnen).

Danach der Normalbetrieb — zwei Terminals:

```bash
pnpm aufzeichnen                  # Daten sammeln, dauerhaft
pnpm --filter @lping/web dev      # Oberfläche → http://localhost:3000
```

---

## Kommandos

### Betrieb

| Befehl | Wozu |
|---|---|
| `pnpm aufzeichnen` | **Der Dauerläufer.** Sucht Pools, verfolgt ihren Verlauf, lädt Historie nach. Startet nach Abstürzen neu, protokolliert nach `logs/track.log` |
| `pnpm pruefen` | Beurteilt die Aufzeichnung — ein Urteil je Aspekt statt Zahlen zum Selbstdeuten |
| `pnpm abspielen` | Replay: aufgezeichnete Verläufe durch die Simulation, Preset-Vergleich |
| `pnpm stresstest` | Sensitivitätsanalyse auf synthetischen Pfaden: Woran hängt das Ergebnis — am Markt oder am Simulator? |
| `pnpm nachladen` | Historie rückwirkend holen (läuft automatisch mit; von Hand nach längerer Unterbrechung) |
| `pnpm sichern` | Datensicherung anlegen |

### Einzelschritte

| Befehl | Wozu |
|---|---|
| `pnpm --filter @lping/bot scan` | Discovery → Screening → Score-Tabelle, einmalig (Netzwerk nötig) |
| `pnpm --filter @lping/bot paper` | Paper-Trading: ein Zyklus über alle Presets |
| `pnpm --filter @lping/bot track` | Ein Aufzeichnungs-Durchgang |
| `pnpm --filter @lping/web dev` | Oberfläche |

### Diagnose

| Befehl | Wozu |
|---|---|
| `pnpm --filter @lping/bot calibrate -- --wallet <Adresse>` | **Misst die Engine an echten Positionen.** Der einzige Weg, die Ertragsannahmen zu prüfen statt sie zu setzen |
| `pnpm --filter @lping/bot api:check` | **Erste Anlaufstelle bei API-Problemen.** Zeigt, welche Schnittstelle antwortet und welche Felder ankommen |
| `pnpm --filter @lping/bot validate` | Konfiguration prüfen |
| `pnpm --filter @lping/bot health` | Erreichbarkeit aller Adapter |
| `pnpm --filter @lping/db db:check` | DB-Roundtrip nach `db:migrate` |
| `pnpm typecheck` / `pnpm test` | TypeScript strict / Vitest (ohne Netzwerk) |

### Häufige Optionen

```bash
# Aufzeichnung: Breite steuern. TOP = Kandidaten je Preset, die tief geprüft
# und damit verfolgt werden. Für die Modellierung zählen VERSCHIEDENE Pools,
# nicht wiederholte Messungen derselben.
TOP=60 SCAN_EVERY=8 BACKFILL_EVERY=12 pnpm aufzeichnen

# Aufzeichnung, einzelne Durchgänge
pnpm --filter @lping/bot track -- --status            # Fortschritt
pnpm --filter @lping/bot track -- --no-scan           # nur verfolgen
pnpm --filter @lping/bot track -- --no-backfill       # ohne Nachladen

# Replay
pnpm abspielen -- --days 14 --every 30                # Zeitraum, Einstiegsabstand
pnpm abspielen -- --pool <Adresse>                    # ein einzelner Pool

# Stresstest (braucht kein Netzwerk und keine Datenbank)
pnpm stresstest -- --preset balanced --runs 3000

# Kalibrierung gegen echte Positionen (braucht Netzwerk, keine Datenbank)
pnpm --filter @lping/bot calibrate -- --wallet <Adresse>
pnpm --filter @lping/bot calibrate -- --wallet <Adresse> --pool <Adresse> --max 50

# Nachladen
pnpm nachladen -- --status                            # Bestand der Historie
pnpm nachladen -- --timeframe 1h                      # gröber, weniger Zeilen
pnpm nachladen -- --lookback-hours 336                # weiter zurück als 7 Tage

# Scan / Paper
pnpm --filter @lping/bot scan -- --pages 1 --top 8    # kleinerer Lauf
pnpm --filter @lping/bot scan -- --no-db              # ohne Persistenz
pnpm --filter @lping/bot paper -- --interval 15       # dauerhaft, alle 15 min
pnpm --filter @lping/bot paper -- --tick-only         # nur bestehende Positionen

# Sicherung
bash scripts/backup.sh liste
bash scripts/backup.sh zurueck backups/DATEI
```

---

## Projektstruktur

```
apps/
  bot/      CLI: validate, health, scan, paper, track, backfill, replay,
            stress, calibrate
  web/      Next.js-UI: Preset-Vergleich, Positionen, Scanner, Parameter
packages/
  core/     Pure Domänenlogik ohne Netzwerk: Config-Schemas + versionierter
            ConfigService, Screening/Scoring, Paper-Engine (Bin-Modell, Fees,
            PnL, HODL-Benchmark), Replay-Engine, Regime-Beurteilung,
            Ground-Truth-Kalibrierung, ML-Merkmale und -Labels
  adapters/ Meteora-API, DexScreener, RugCheck, Jupiter; HTTP-Infrastruktur
            (Retry/Backoff, Rate-Limiting, zod-Validierung)
  db/       Prisma-Schema (13 Tabellen), Migrationen, Repositories
config/     global.json + eine Datei je Preset
```

Kernprinzip: **Alle Entscheidungslogik ist pure und ohne Netzwerk testbar.**
Adapter und (später) Execution sind dünne Schalen. Deshalb können Paper-Trading
und Replay denselben Code benutzen wie der spätere Live-Betrieb.

---

## Wie die Daten zusammenhängen

Die Aufzeichnung führt **zwei verschiedene Arten von Beobachtungen**. Der
Unterschied ist keine Feinheit — wer ihn übersieht, rechnet um Faktor 288 falsch:

| | **Messpunkte** (`pool_snapshots`) | **Kerzen** (`pool_history_candles`) |
|---|---|---|
| Woher | laufende Abfrage im Messraster | Historien-Endpunkte, rückwirkend |
| Auflösung | 15 min | 5 min |
| Enthält | TVL, SOL-Kurs, dynamische Gebühr, gleitende Zeitfenster | Open/High/Low/Close, Volumen, Gebühren, Protokollanteil **je Fenster** |
| Nachholbar | **nein** | **ja**, jederzeit |

Volumen und Gebühren einer Kerze gelten für ihr Fenster, nicht als Tagessumme.
Die Umrechnung in eine 24-Stunden-Rate passiert einmal zentral beim Lesen
(`loadHistory()`), damit sie nirgends sonst schiefgehen kann.

Zusammengeführt werden beide in `loadSeries()` — dem **einen** Lesepfad, den
Replay und Label-Berechnung teilen: Kerzen bilden das Raster, Messpunkte steuern
den TVL bei. Ausführlich in [KONZEPT-ML.md](./KONZEPT-ML.md) Abschnitt 3.3.

### Zwei Arten von Ergebnis-Labels

`candidate_outcomes` führt je Horizont **zwei verschiedene Antworten** auf die
Frage „war das ein guter Kandidat?", und sie können weit auseinanderliegen:

| | `fee_yield_pct` | `replay_pnl_pct` / `replay_vs_hodl_pct` |
|---|---|---|
| Misst | den Ertrag des **Pools**: Gebühren je TVL | den Ertrag einer **Position** durch die Paper-Engine |
| Enthält | nur die Gebührenrate | Range, Zeit außerhalb, Impermanent Loss, Kosten, Limit-Order-Abzweig |
| Braucht | nur die Zeitreihe | zusätzlich Pool-Stammdaten (Mints, Bin Step) |
| `NULL` heißt | keine Rate bestimmbar | nicht simulierbar — **nicht** „null Ertrag" |

Der Unterschied ist keine Feinheit. Im DB-Roundtrip liefert derselbe fallende
Verlauf **+4,05 %** als Pool-Rate und **−15,52 %** als tatsächlichen
Positionsertrag. Ein Auswahlmodell auf `fee_yield_pct` trainiert lernt „welcher
Pool hat viel Umschlag" — nicht „welcher Pool trägt eine Position". Genau diese
Verwechslung stehen `volatilityBoundsPctDaily` und der `yield_per_variance`-Term
im Score bereits entgegen: Gebühren wachsen linear mit dem Umschlag, der
Varianzverlust quadratisch mit der Volatilität.

Gemessen wird an einer **Standardposition** (`REFERENCE_POSITION`): feste Breite,
Spot, zweiseitig, Ausstiegsregeln an ihren Extremwerten. Eine Konstante im Code
und kein Preset aus der Konfiguration — hinge das Label an einer editierbaren
Datei, verschöbe jede Parameteränderung rückwirkend die Zielgröße.

Die Modellannahmen in `global.paper` gehen dagegen sehr wohl ein. Wer
`poolLiquidityBins` oder einen der Abschläge ändert, ändert **jedes** Label und
sollte sie neu berechnen — der Weg dafür steht unten unter „Aufzeichnung neu
beginnen".

---

## Presets

Drei Risikoprofile laufen **gleichzeitig auf denselben Marktdaten und mit
demselben virtuellen Kapital**. Unterschiede in den Ergebnissen stammen damit
ausschließlich aus den Parametern — ein kontrolliertes Experiment statt eines
Vergleichs von Äpfeln mit Birnen.

| Preset | Token-Alter | Min. TVL | Strategie | Einsatz | Stop-Loss | Haltedauer | Rebalancing |
|---|---|---|---|---|---|---|---|
| **Konservativ** | ≥ 7 Tage | 250 k$ | Curve, 50/50 | 5 SOL | 20 % | ≤ 14 Tage | ja |
| **Balanced** | ≥ 2 Tage | 120 k$ | Curve, 50/50 | 3 SOL | 25 % | ≤ 4 Tage | ja |
| **Degen** | 1–48 h | 50 k$ | BidAsk, nur SOL | 1 SOL | 30 % | ≤ 24 h | nein |

Die **Range-Breite steht nicht in der Tabelle**, weil sie nicht mehr gesetzt,
sondern aus der Volatilität des Tokens hergeleitet wird (KONZEPT.md 6.2b). Der
Stop-Loss ist die Rückfalllinie, nicht der primäre Ausgang — dafür sorgen die
zustandsabhängigen Regeln in `exit` (KONZEPT.md 6.2a).

Ein weiteres Profil entsteht durch eine zusätzliche Datei in `config/` (etwa
`degen_eng.json`) — sie erscheint automatisch in UI, Paper-Vergleich und Replay.

**Die globalen Grenzen `maxOpenPositions` und `maxTotalExposureSol` beschreiben
eine gemeinsame Wallet — im Paper-Betrieb gibt es die nicht.** Jedes Preset läuft
dort mit eigenem virtuellem Kapital, und genau diese Unabhängigkeit ist die
Grundlage des Vergleichs: Eine gemeinsame Obergrenze, die bindet, gäbe dem zuerst
gescannten Preset seine Positionen und dem letzten keine — gemessen würde
Reihenfolge statt Strategie. Deshalb greifen beide erst bei
`paperTrading: false`, und dann sowohl in der Schema-Prüfung (gegen die **Summe**
der aktiven Presets) als auch zur Laufzeit. Passt die Preset-Aufstellung nicht in
die Live-Grenzen, sagt `pnpm --filter @lping/bot validate` das schon im
Paper-Betrieb als Warnung — der Umstieg soll keine Überraschung sein.

Der **Kill-Switch** ist davon ausgenommen und wirkt immer: `pause` verhindert
neue Einstiege, `flatten` schließt zusätzlich alle offenen Positionen
(Ausstiegsgrund `kill_switch`). „Nichts mehr tun" gilt auch für eine Simulation.

---

## Oberfläche

| Seite | Inhalt |
|---|---|
| **Vergleich** | **Rendite** je Preset (nicht absoluter PnL — sonst gewinnt die größere Position statt der besseren Strategie), Fees, On-Chain-Kosten, Trefferquote, Zeit in Range, Vergleich gegen reines Halten |
| **Positionen** | Bin-Range mit Preis-Marker, Einsatz, Wert, Fees, Kosten, PnL, Zeit in Range; geschlossene mit Ausstiegsgrund |
| **Scanner** | Entdeckte Pools mit Score und ausformulierter Begründung, warum ein Kandidat abgelehnt wurde |
| **Parameter** | Alle Werte editierbar; jede Änderung wird validiert und versioniert, ungültige Eingaben ändern nichts |

Die UI hat **keine Authentifizierung** und gehört deshalb nur auf den lokalen
Rechner, nicht auf einen erreichbaren Server.

---

## Aufzeichnung: Betrieb und Wartung

### Was `pnpm pruefen` beurteilt

Der Bericht fällt je Aspekt ein Urteil: Läuft die Aufzeichnung? Werden Pools
verfolgt, kommen neue Kandidaten dazu? Wie groß war die längste Unterbrechung?
Liefert jede Datenquelle noch?

Beim letzten Punkt — den **Ergebnis-Labels** — zählt nicht ihre Anzahl, sondern
der **Rückstand**: fällige, aber fehlende Labels. Der Unterschied entscheidet:
Eine Nachberechnung, die nur die ältesten Kandidaten immer wieder anfasst, weist
weiterhin Tausende Labels aus und sieht gesund aus, während für jeden neuen
Kandidaten keines mehr entsteht. Ein Rückstand nach einer Unterbrechung ist
normal und baut sich ab; bleibt er stehen oder wächst er, wird nicht mehr
nachgeführt.

### Lücken

Ein zugeklappter Laptop zeichnet nichts auf, und die Lücken sind nicht bloß
fehlende Daten, sondern **systematisch verzerrte** — es fehlen die Nachtstunden,
in denen Memecoin-Märkte oft am stärksten schwanken. Empfohlen ist ein kleiner
VPS, der durchläuft.

Wie schwer eine Lücke wiegt, hängt davon ab, was in ihr fehlt:

| In der Lücke fehlt | Reparierbar? |
|---|---|
| Preis, High/Low, Volumen, Gebühren | **ja** — `pnpm nachladen`, feiner als das Messraster |
| TVL, SOL-Kurs | **nein** — nur als Momentaufnahme verfügbar |
| Merkmale nicht entdeckter Kandidaten | **nein** — der schwerste Verlust: Wer nicht gescreent hat, hat diese Pools nie gesehen |

### Aufzeichnung neu beginnen

Vor dem Löschen die entscheidende Frage: **Welcher Teil ist ersetzbar?**

| Tabelle | Ersetzbar? | Empfehlung |
|---|---|---|
| `candidate_outcomes` | **ja** — wird aus der Zeitreihe neu berechnet | löschen, wenn sich die Label-Berechnung geändert hat |
| `pool_history_candles` | **ja** — jederzeit über `pnpm nachladen` | löschen unkritisch |
| `pool_snapshots` | **nein** — TVL und SOL-Kurs gibt es nur als Momentaufnahme | behalten |
| `candidate_features` | **nein** — Stand von RugCheck/Jupiter/DexScreener zum Entscheidungszeitpunkt | behalten |

Daraus die Regel: **das Ersetzbare löschen, das Unersetzliche behalten.** Alles
wegzuwerfen, um Ableitungen loszuwerden, tauscht das Wertvolle gegen das
Wiederbeschaffbare — und der unersetzliche Teil wächst nur mit der Kalenderzeit
nach.

Der übliche Fall, nach einer Änderung an der Label-Berechnung:

```bash
pnpm sichern                       # immer zuerst
psql "$DATABASE_URL" -c "DELETE FROM candidate_outcomes;"
pnpm nachladen                     # Historie holen — macht die neuen Labels genauer
pnpm --filter @lping/bot track     # ein Durchgang rechnet sie neu
```

Wirklich alles verwerfen (bewusst ohne Skript — das soll man einmal von Hand
tippen):

```bash
pnpm sichern
psql "$DATABASE_URL" -c "TRUNCATE candidate_outcomes, candidate_features,
  pool_history_candles, pool_snapshots, tracked_pools, pool_candidates
  RESTART IDENTITY CASCADE;"
```

Positionen und Konfigurations-Historie bleiben unberührt. Wer auch die
Paper-Ergebnisse zurücksetzen will, nimmt `positions`, `position_events`,
`transactions` und `fee_claims` dazu.

---

## Wenn etwas nicht läuft

`pnpm --filter @lping/bot api:check` ist die erste Anlaufstelle. Die
Meteora-Schnittstellen sind nicht formal versioniert; ändern sich Pfade oder
Feldnamen, zeigt diese Ausgabe am schnellsten, woran es liegt. Sie weist aus:

- welche Schnittstelle antwortet (`dlmm.datapi.meteora.ag`, ersatzweise die
  ältere `dlmm-api.meteora.ag`),
- welche **Zeitfenster** ankommen und ob Gebührenstruktur (dynamische Gebühr,
  Protokollanteil, `collect_fee_mode`) und Pool-Alter gelesen werden,
- ob die **Historien-Endpunkte** antworten — samt Abgleich, ob ihr Preis
  dieselbe Einheit hat wie `current_price`. Diese Einheit ist nicht dokumentiert,
  und eine Verwechslung würde jede Bin-Zuordnung verschieben.

Fällt eine dieser Angaben aus, verarmt die Aufzeichnung still. Der Adapter liest
Feldnamen über Alias-Listen, ein umbenanntes Feld legt die Discovery also nicht
sofort lahm — aber es fehlt dann im Datensatz.

Bei Datenbankproblemen: `docker compose up -d postgres`, dann `pnpm db:migrate`
(nötig nach jedem `git pull`).

---

## Stand & nächste Schritte

**Umgesetzt:**

1. ✅ Monorepo, DB-Schema, versionierter Config-Service mit Schema-Migration
2. ✅ Daten-Adapter: Meteora, DexScreener, RugCheck, Jupiter (Quote + Token API)
3. ✅ Screening: Vor-Filter → Enrichment → Hard Filters (fail-closed) → Score
   0–100 → Kandidaten-Persistenz mit Shadow-Tracking
4. ✅ Paper-Engine: bin-genaues DLMM-Modell, Fee-Akkrual, On-Chain-Kosten,
   HODL-Benchmark, Exit-Regeln; Multi-Preset-Vergleich und Web-UI
5. ✅ Datenaufzeichnung (KONZEPT-ML.md M1): Merkmale je Kandidat, Verlauf,
   Ergebnis-Labels, Prüfbericht, Sammelabruf, rückwirkendes Nachladen
6. ✅ Replay-Engine (KONZEPT-ML.md M2): aufgezeichnete Verläufe durch **dieselbe**
   Paper-Engine, Einstiege an beliebigen Zeitpunkten, deterministisch,
   Gleichheitstest gegen den Live-Pfad

**Als Nächstes:**

0. **Kalibrierung gegen echte Positionen** (`pnpm --filter @lping/bot calibrate`).
   Der Bericht weist den Fit **kreuzgeprüft** aus: gesucht auf einer Hälfte der
   Pools, gemessen auf der anderen. Maßgeblich ist der Holdout-Faktor — der Fit
   über alle Fälle liegt per Konstruktion nahe 1, weil er genau darauf optimiert
   wurde.
   Der Replay prüft, ob die Engine ihre eigenen Regeln konsistent anwendet — er
   kann nicht prüfen, ob ihre **Annahmen** stimmen. `poolLiquidityBins`,
   `feeShareHaircutPct` und der Limit-Order-Abschlag wirken gemeinsam als ein
   Faktor unbekannter Größe auf der gesamten Ertragsseite. Fremde Positionen
   sind öffentlich abfragbar und machen ihn messbar, ohne Kapital und ohne RPC.
   Vor M3, weil eine Sensitivitätsanalyse über einen unkalibrierten Faktor vor
   allem das eigene Rauschen misst.

1. **Sensitivitätsanalyse** (KONZEPT-ML.md M3) — welche Parameter überhaupt etwas
   bewirken, und ob ein Ergebnis an den Daten hängt oder an den Modellannahmen.
   Der wirksamste Einzelschritt gegen Überanpassung. `pnpm abspielen` weist dafür
   jetzt Konfidenzintervalle aus (Block-Bootstrap über Pools): Ein Unterschied,
   der innerhalb der Intervalle liegt, ist keiner.
2. **Parametersuche und Validierung** (M4, M5) — Zufallssuche, Verfeinerung,
   rollierendes Vorwärts-Testen mit Sperrzonen.
3. **Execution Engine** (KONZEPT.md Abschnitt 7) — Transaktionsbau, Simulation
   vor dem Senden, Reconciliation, RPC-Failover, Alerts. Frühestens, wenn Phase 1
   ihre Go-Kriterien erfüllt (KONZEPT.md 13).

**Bekannte Lücken.** Im Paper-Modus folgenlos, vor echtem Kapital zwingend —
sie würden sonst ungeprüft live gehen:

| Lücke | Betrifft |
|---|---|
| **Verlustlimits nicht scharf:** `dailyLossLimitPct`, `hardLossLimitPct`, `minSolReserve`, `profitSweepThresholdSol` und `priorityFeeCapLamports` sind konfigurierbar, werden aber von keiner Logik durchgesetzt. Sie brauchen eine Bezugsgröße, die erst der Live-Betrieb liefert (Wallet-Stand, realisierter Tagesverlust). Kill-Switch sowie Positions- und Exposure-Grenzen sind seit F1 scharf | KONZEPT.md 6.3, 9 |
| **Keine On-Chain-Reads:** Authorities kommen nur von RugCheck; die Token-2022-Prüfung und die LP-Dominanz fehlen ganz | KONZEPT.md 5.1 |
| **Slippage-Impact geschätzt, nicht gemessen:** Die Größenabhängigkeit ist seit `swapImpactFactor` da, ihr Faktor ist aber eine Annahme. Die Jupiter-Roundtrip-Prüfung könnte ihn kalibrieren — sie filtert bislang nur | KONZEPT-ML.md 6.1 |
| **Limit-Order-Anteil geschätzt:** Seit `lb_clmm` 0.12.0 zweigt Order-Liquidität einen Teil der Gebühr ab. Der Abschlag ist als eigene Annahme geführt, aber nicht gemessen | KONZEPT-ML.md 6.1 |
| **Bin-Array-Initialisierung geschätzt:** Die Kosten werden seit F2 gebucht, aber als Erwartungswert über `binArrayInitProbability` — ob der Preisbereich tatsächlich neu ist, steht on-chain und wäre über den RPC-Adapter messbar | KONZEPT-ML.md 6.1 |
| **Shadow-Tracking wird erfasst, aber nicht ausgewertet** (Filter-Güte) | KONZEPT.md 5.5 |
| **Keine Sperrzonen im Replay:** Die Konfidenzintervalle sind da, das rollierende Vorwärts-Testen mit Sperrzone noch nicht — ein Replay über den ganzen Zeitraum vermischt weiterhin Trainings- und Prüfperiode | KONZEPT-ML.md 7.1 |
| **Regime-Schwellen ungeprüft:** Das Tor blockiert bereits, seine Schwellen sind aber gesetzt und nicht kalibriert. `regime_snapshots` sammelt die Grundlage | KONZEPT-ML.md 6.1 |
| **Web-UI ohne Authentifizierung** | KONZEPT.md 11 |
