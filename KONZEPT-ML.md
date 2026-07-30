# Konzept: Automatische Strategie-Optimierung (ML)

> Ziel: Statt drei handgesetzter Presets sollen Parameter **und** Auswahlindikatoren
> datengetrieben optimiert werden. Bedienung: Aufzeichnung starten, warten,
> anschließend mehrere validierte Strategie-Kandidaten erhalten.

Ergänzt [KONZEPT.md](./KONZEPT.md). Die dort beschriebene Paper-Engine ist die
Grundlage — sie wird hier zum Simulator, gegen den optimiert wird.

---

## 1. Die zentrale Schwierigkeit: Overfitting

Das Vorhaben ist sinnvoll und umsetzbar. Der Engpass ist aber **nicht** Rechenzeit,
sondern die Menge unabhängiger Beobachtungen im Verhältnis zur Zahl der Stellschrauben.

Die aktuelle Konfiguration hat rund **40 Parameter je Preset**. Vier Wochen
Paper-Trading erzeugen — bei realistischen Annahmen — vielleicht **100 bis 400
geschlossene Positionen**. Wer 40 Parameter auf 300 verrauschten Beobachtungen
optimiert, findet garantiert eine Kombination, die in den Daten hervorragend
aussieht und live scheitert. Das ist keine theoretische Sorge: Es ist der
Normalfall bei Handelsstrategie-Optimierung.

Verschärfend kommt hinzu: **Der Optimierer nutzt jeden Fehler des Simulators aus.**
Unsere Paper-Engine rechnet den Gebührenanteil zwar bin-genau, muss die
Liquiditätsverteilung der **anderen** LPs aber annehmen (`poolLiquidityBins`);
sie vernachlässigt Slippage innerhalb eines Bins und kennt kein MEV. Eine Suche
über 50.000 Parametersätze findet zuverlässig genau die Kombination, die diese
Modellungenauigkeiten maximal ausbeutet — und die ist live wertlos. Deshalb
gehört `poolLiquidityBins` selbst in die Sensitivitätsanalyse: Hängt ein
Ergebnis stark daran, hängt es an einer Annahme, nicht an einer Messung.

**Alles Folgende ist deshalb primär gegen Overfitting konstruiert, nicht auf
maximale Optimierungsleistung.** Ein System, das ehrlich „kein belastbarer Vorteil
gefunden" meldet, ist wertvoller als eines, das immer eine schöne Strategie
ausspuckt.

Drei Konsequenzen, die die Architektur prägen:

1. **Datenmenge vervielfachen, statt Modelle zu vergrößern** (Abschnitt 3).
2. **Dimensionalität reduzieren**, bevor optimiert wird (Abschnitt 6.1).
3. **Out-of-Sample-Validierung ist nicht verhandelbar** (Abschnitt 7).

---

## 2. Zwei getrennte Lernprobleme

Ein häufiger Fehler ist, „die Strategie" als ein einziges Lernproblem zu behandeln.
Tatsächlich sind es zwei, mit völlig unterschiedlicher Datenlage:

| | **A: Auswahl** (welcher Pool?) | **B: Führung** (wie halten?) |
|---|---|---|
| Entscheidet über | Filter, Score-Gewichte, Mindestscore | Range-Breite, Strategie-Typ, SL/TP, Haltedauer, Rebalancing |
| Datenquelle | Kandidaten + ihre spätere Entwicklung | Simulation auf aufgezeichneten Preisverläufen |
| Verfügbare Beobachtungen | **hoch** (jeder gescreente Pool, auch abgelehnte) | **beliebig** (Replay erzeugt Positionen nach Bedarf) |
| Passendes Verfahren | Überwachtes Lernen (Tabellen-Modell) | Simulationsbasierte Parametersuche |

Der entscheidende Hebel steckt in Zeile 3: Beide Probleme lassen sich mit weit
mehr Beobachtungen füttern, als real eröffnete Positionen liefern — **wenn** wir
die richtigen Daten aufzeichnen.

---

## 3. Datenfundament: der eigentliche Engpass

### 3.1 Der Multiplikator: alle Kandidaten verfolgen, nicht nur die eröffneten

Wenn wir nur aus tatsächlich eröffneten Positionen lernen, haben wir zwei Probleme:
zu wenige Beobachtungen und **Selektionsverzerrung** — wir erfahren nie, dass ein
Filter zu streng ist, weil wir die abgelehnten Pools nie beobachten.

Das im Hauptkonzept vorgesehene **Shadow-Tracking** löst beides, muss dafür aber
mehr leisten als bisher: Statt nur zu vermerken „abgelehnt", zeichnen wir für
**jeden gescreenten Pool** den weiteren Verlauf auf.

Realistische Größenordnung:

| | pro Tag | in 4 Wochen |
|---|---|---|
| Gescreente Pool×Preset-Kandidaten | 100–300 | **3.000–8.000** |
| Davon real eröffnete Paper-Positionen | 3–15 | 100–400 |
| Durch Replay erzeugbare Positionen | — | **praktisch unbegrenzt** |

Aus 3.000–8.000 gelabelten Auswahl-Beobachtungen lässt sich ein Tabellenmodell mit
15–25 Merkmalen seriös schätzen. Aus 300 nicht.

### 3.2 Was aufgezeichnet wird

**Merkmale zum Entscheidungszeitpunkt** (`candidate_features`) — kritisch:
ausschließlich Werte, die zu diesem Zeitpunkt bekannt waren. Jede spätere
Information ist Look-Ahead-Bias und macht das Modell wertlos.

- Pool: Bin Step, Basis-/dynamische Gebühr, TVL, Volumen (30 min / 1 h / 24 h),
  `fee_tvl_ratio` je Fenster, Pool-Alter, `launchpad`, `tags`
- Markt (DexScreener): Token-Alter, Liquidität gesamt, Kauf/Verkauf-Verhältnis,
  Trades je Fenster, Preisänderung 5 m/1 h/6 h/24 h, FDV, Marktkapitalisierung
- Risiko (RugCheck): normalisierter Score, Authority-Status, Top-10-Anteil,
  Insider-Anteil, Holder-Anzahl
- Ausführbarkeit (Jupiter): Roundtrip-Verlust, Preis-Impact beider Richtungen,
  Routen-Anzahl
- **Neu (Jupiter Token API v2):** `organicScore` (0–100), `organicScoreLabel`,
  `holderCount`, Audit-Flags — siehe Abschnitt 4
- Abgeleitet: realisierte Volatilität, TVL-Trend (fließt Liquidität zu oder ab?),
  Volumen-Stetigkeit, Fee/TVL-Trend statt nur -Niveau
- **Gebührenstruktur (umgesetzt):** `dynamic_fee_pct` (Basis + Volatilitätsaufschlag,
  der Satz, mit dem Swaps tatsächlich belastet werden), `max_fee_pct`,
  `protocol_fee_pct` (10 % Standard / 20 % Launch-Pool gehen ans Protokoll, nicht
  an den LP) und `collect_fee_mode` samt abgeleiteter Gebührenwährung
  (`fee_currency`: fallen die Gebühren in SOL, im Memecoin oder gemischt an?).
  Letzteres ist vermutlich das stärkste einzelne Risikomerkmal des Degen-Presets
  — siehe die Korrektur in KONZEPT.md 8.3.
- **Pool-Alter (umgesetzt):** `pool_age_hours` aus `created_at`, getrennt vom
  Token-Alter. Ein neuer Pool auf einem älteren Token ist ein anderer Fall als
  ein neuer Token.

**Verlauf nach der Entscheidung** (`pool_snapshots`): Preis, TVL, Volumen, Gebühren
in dichten Abständen — 15 min für die ersten 48 h, danach stündlich bis Tag 7.
Das ist die Grundlage des Replays.

Je Messpunkt wird zusätzlich die **Gebührenstruktur** mitgeschrieben
(`dynamic_fee_pct`, `base_fee_pct`, `protocol_fee_pct`) sowie alle Zeitfenster
als JSON (`windows`). Grund: Der Replay rekonstruiert aus diesen Zeilen die
`MarketTick`-Objekte, gegen die optimiert wird. Ein Replay auf
24-Stunden-Mittelwerten kann Volatilitätsphasen nicht auflösen — und genau in
denen verdient eine DLMM-Position. `effectiveFeePct()` bestimmt daraus den
Gebührensatz nach einer Genauigkeits-Rangfolge: gemeldete Gesamtgebühr, sonst
realisierte Rate aus dem kürzesten belegten Fenster, sonst über 24 h, zuletzt
die Basisgebühr. Ist keine davon bestimmbar, liefert sie `null` — die Simulation
darf dann keine Gebühren buchen, statt eine Zahl zu erfinden.

Messpunkte von vor dieser Erweiterung tragen die neuen Spalten als `NULL` und
bleiben über die 24-Stunden-Rückfallebene nutzbar.

**Ergebnisse** (`candidate_outcomes`): abgeleitete Labels je Horizont
(1 h / 6 h / 24 h / 72 h / 7 d): Preisänderung, TVL-Änderung, aufgelaufene
Gebühren je TVL-Einheit, maximaler Drawdown sowie ein Rug-Indikator
(Preis oder TVL −90 %).

> **Was `feeYieldPct` ist und was nicht.** Das Label rechnet die laufende
> 24-Stunden-Rate `Gebühren / TVL` über den Horizont hoch. Das ist die
> Ertragskraft des **Pools**, nicht der Ertrag einer Position: Es fehlen die
> Bin-Konzentration, die Zeit in Range, der Protokollanteil und die Kosten. Als
> **Rangsignal** für Teil A ist das richtig und ausreichend — die Frage dort ist
> „welcher Pool verdient mehr?", nicht „wie viel verdienen wir?". Die zweite
> Frage beantwortet ausschließlich der Replay. Wer `feeYieldPct` als
> Ertragsprognose liest, überschätzt jede Strategie.

**Datenvolumen** (aktualisiert, mit nachgeladener Historie):

| Bestand | Zeilen |
|---|---|
| Messpunkte: 2.000 Pools × 96/Tag (15-min-Raster) | ~190.000/Tag |
| Kerzen: 2.000 Pools × 288/Tag (5-min-Raster) | ~580.000/Tag |
| Merkmale + Labels | wenige Tausend/Tag |

Zusammen rund 0,8 Mio. Zeilen/Tag, ~23 Mio./Monat — eine Größenordnung mehr als
die ursprüngliche Schätzung, weil sowohl die Pool-Zahl als auch die Auflösung
gestiegen sind. Für PostgreSQL auf einem kleinen VPS ist das handhabbar
(Kerzen sind schmale Zeilen mit zusammengesetztem Primärschlüssel), verlangt aber
eine **Ausdünnungsstrategie**: Kerzen älter als 30 Tage auf ein gröberes Raster
verdichten oder verwerfen — sie sind ohnehin jederzeit wieder abrufbar. Das ist
der praktische Nutzen daran, dass die Historie nicht mehr unwiederbringlich ist.

**Aufwand:** Die Aufzeichnung kostet wenig — Meteora erlaubt 30 Anfragen/s, und
seit dem Sammelabruf (`filter_by=pool_address=[…]`) sind 2.000 Pools rund 50
Anfragen je Messrunde statt 2.000. Das Nachladen ist teurer, aber selten: je Pool
und Tag zwei Anfragen. Die teuren Per-Token-Abrufe (RugCheck, Jupiter,
DexScreener) fallen weiterhin nur einmal beim Entdecken an.

### 3.3 Konsequenz für den Zeitplan

> **Korrektur (Juli 2026, nach Prüfung der Meteora-API-Referenz):** Der
> ursprüngliche Satz „die Aufzeichnung ist die einzige Komponente, die echte
> Kalenderzeit braucht, jeder Tag ohne sie ist unwiederbringlich" war in dieser
> Schärfe falsch. Die DLMM Data API hat zwei Historien-Endpunkte:
>
> | Endpunkt | Liefert | Raster |
> |---|---|---|
> | `GET /pools/{address}/ohlcv` | Open/High/Low/Close und Volumen je Kerze, `start_time`/`end_time` frei wählbar | 5 m, 30 m, 1 h, 2 h, 4 h, 12 h, 24 h |
> | `GET /pools/{address}/volume/history` | Volumen, Gebühren und **Protokollgebühren** je Zeitfenster | dieselben |
>
> Damit ist der **Preis-, Volumen- und Gebührenverlauf rückwirkend abrufbar** —
> feiner sogar als das eigene 15-Minuten-Raster, und mit `high`/`low` je Kerze
> statt nur einem Stichprobenwert.

Was das ändert und was nicht:

| Teil | Nachladbar? |
|---|---|
| Preis-, Volumen-, Gebührenverlauf (die Ticks des Replays) | **ja**, über die beiden Endpunkte oben |
| TVL-Verlauf | nein — die Pool-API liefert nur den aktuellen Stand |
| Merkmale zum Entscheidungszeitpunkt (RugCheck, Jupiter, DexScreener, Organic Score) | nein — das sind Momentaufnahmen fremder Dienste |

Die Aufzeichnung bleibt also nötig, aber sie ist **nicht mehr der kritische
Pfad des Replays**. Zwei Konsequenzen:

1. **M2 und M3 können sofort beginnen**, statt auf Wochen Kalenderzeit zu
   warten. Der Replay lässt sich auf nachgeladenen Verläufen bereits heute
   gegen die vorhandenen Presets rechnen.
2. **Lücken in der Verlaufsaufzeichnung sind reparierbar.** Ein Nachlade-Lauf
   füllt sie; nur die Merkmalszeilen und der TVL-Verlauf entstehen weiterhin
   ausschließlich live.

Unverändert richtig bleibt der Kern: Die Merkmalsaufzeichnung sollte laufen,
bevor der Optimierer gebaut wird, denn **sie** ist nicht nachholbar — und ohne
sie gibt es kein Auswahlmodell (Teil A), nur die Führungs-Optimierung (Teil B).

---

## 4. Zusätzliche Indikatoren

### 4.1 Jupiter Organic Score

Jupiter stellt in der **Token API v2** (`https://lite-api.jup.ag/tokens/v2`) einen
`organicScore` (0–100) samt `organicScoreLabel` (`high`/`medium`/`low`) sowie
`holderCount` bereit. Der Score bewertet, wie *echt* die Aktivität eines Tokens ist
— genau die Frage, die unsere selbstgebaute Wash-Trading-Heuristik (Abschnitt 5.3
im Hauptkonzept) nur grob beantwortet.

Einsatz an drei Stellen:

1. **Als Merkmal** im Auswahlmodell — vermutlich eines der stärksten.
2. **Als Hard Filter** mit lernbarem Schwellwert (statt geratener 40/30/20).
3. **Als Gegenprobe** zur eigenen Heuristik: Wo beide widersprechen, lohnt ein
   Blick — entweder ist unsere Heuristik falsch, oder der Score übersieht etwas.

Wichtig: Der Score ist ein **fremdes Modell**, dessen Berechnung wir nicht kennen
und das sich ändern kann. Er wird als Merkmal geführt, nie als alleiniges
Ausschlusskriterium, und seine Verfügbarkeit wird überwacht.

### 4.2 Weitere Kandidaten, nach erwartetem Nutzen sortiert

| Indikator | Quelle | Warum plausibel relevant |
|---|---|---|
| Realisierte Volatilität (1 h/6 h/24 h) | eigene Zeitreihe | Treibt die dynamische Gebühr **und** den Impermanent Loss — die zentrale Zielgröße |
| TVL-Trend | eigene Zeitreihe | Abfließende Liquidität anderer LPs geht Preisverfall oft voraus |
| Bin-Liquiditätsverteilung | DLMM-SDK (RPC) | Bestimmt unseren tatsächlichen Fee-Anteil — ersetzt die grobe TVL-Anteil-Schätzung |
| Volumen-Stetigkeit | eigene Zeitreihe | Unterscheidet gleichmäßigen Handel von wenigen Bursts (Wash-Trading-Indiz) |
| Anteil einzigartiger Trader | DexScreener/Bitquery | Ergänzt den Organic Score |
| Launchpad-Herkunft, Tags | Meteora (`launchpad`, `tags`) | Kategoriale Merkmale mit oft überraschend hohem Erklärungswert |
| Token/SOL-Korrelation | eigene Zeitreihe | Hoch korrelierte Token verhalten sich in der Range anders |

Die **Bin-Liquiditätsverteilung** ist der wertvollste Zugewinn: Sie ersetzt die
größte Ungenauigkeit unseres Simulators (geschätzter Fee-Anteil) durch eine
Messung. Das verbessert die Optimierung mehr als jedes zusätzliche Modell.

---

## 5. Replay: warum Wochen statt Jahre reichen

Kern der Umsetzbarkeit ist die **Replay-Engine**: Die vorhandene Paper-Engine
verarbeitet bereits `MarketTick`-Objekte. Genau diese Ticks zeichnen wir auf.
Damit lässt sich jede beliebige Parameterkombination auf denselben historischen
Verläufen durchspielen.

```
Aufgezeichnete Verläufe (Kalenderzeit: Wochen)
        │
        ├─ Parametersatz A → simulierte Positionen → Kennzahlen
        ├─ Parametersatz B → …                       (Rechenzeit: Millisekunden)
        └─ … 50.000 weitere
```

Eine Woche Aufzeichnung lässt sich in Minuten zehntausendfach durchspielen. Das
ist der Unterschied zu „50 Presets live parallel laufen lassen": Letzteres
bräuchte dieselbe Kalenderzeit **und** lieferte je Preset weniger Beobachtungen.

**Umsetzungsstand:** Die Replay-Engine steht (`replayPosition`, `replayEntries`,
`summarizeReplay`; Kommando `pnpm abspielen`). Sie besitzt **keine eigene
Positionslogik** — sie ruft `openPaperPosition`, `tickPaperPosition` und
`closePaperPosition`, also genau die Funktionen des Paper-Betriebs.

| Anforderung | Stand |
|---|---|
| Tick-Reader aus der Datenbank | ✅ `loadSeries()` — ein Pfad für Replay **und** Label-Berechnung |
| Einstiege an beliebigen Zeitpunkten | ✅ `replayEntries` mit einstellbarem Abstand |
| Determinismus | ✅ keine Wanduhr, kein Zufall; durch Tests festgehalten |
| Gleichheit Replay ↔ Live | ✅ beide Wege bauen ihren Tick in derselben Datei, ein Test hält sie aneinander |
| `high`/`low` für Zeit-in-Range | offen (Abschnitt 5.2) — bei den Labels bereits genutzt |

**Nicht verhandelbar:** Replay und Live-Betrieb müssen denselben Codepfad nutzen.
Sobald es zwei Implementierungen gibt, optimiert man gegen die eine und handelt
mit der anderen. Der Gleichheitstest ist die Absicherung dagegen: Er vergleicht
den Tick aus frischen Pool-Metriken mit dem aus einer aufgezeichneten
Beobachtung desselben Pools. Ohne ihn liefen beide Seiten für sich plausibel
auseinander, und niemand würde es merken.

### 5.0 Zensierte Positionen zählen anders

Ein Replay-Lauf endet dort, wo die Daten enden — mitten in offenen Positionen.
Diese Beobachtungen sind **rechtszensiert**: Wie sie ausgegangen wären, ist
unbekannt.

Sie einfach mitzuzählen wäre ein Fehler mit Richtung: Jede Strategie, die ihre
Verlierer lange hält, sähe dadurch besser aus, weil ihre schlechten Positionen
überproportional oft im offenen Zustand enden. Deshalb fließen zensierte
Positionen in Ertrag und Kosten ein (sie haben stattgefunden), aber **nicht** in
Trefferquote und Ausstiegsgründe. Der Bericht weist ihre Zahl aus.

### 5.1 Woraus ein Tick besteht — und was fehlt

Der Replay setzt einen `MarketTick` aus zwei Quellen zusammen, weil die API die
Bestandteile getrennt führt:

| Größe | Quelle | Auflösung |
|---|---|---|
| Preis, High/Low | Kerzen (`/ohlcv`) | 5 min, rückwirkend |
| Volumen, Gebühren, Protokollanteil | Kerzen (`/volume/history`) | 5 min, rückwirkend |
| **TVL** | nur Messpunkte der Aufzeichnung | Messraster, nicht nachladbar |
| SOL-Kurs | nur Messpunkte der Aufzeichnung | Messraster, nicht nachladbar |

Der TVL ist die unangenehme Zeile. Das Gebührenmodell braucht ihn: Der eigene
Anteil ist `eigene Liquidität im aktiven Bin / Gesamtliquidität dort`, und der
Nenner folgt aus dem Pool-TVL. Ohne TVL **darf** die Simulation keine Gebühren
buchen — sonst rechnet sie einen Anteil an einer unbekannten Größe aus.

Umgesetzte Regelung: `loadHistory()` trägt den TVL des letzten Messpunkts
höchstens sechs Stunden nach vorne und liefert danach `null`. Zwei Folgen, die
man kennen muss:

1. **Nachgeladene Zeiträume ohne jede Aufzeichnung sind gebührenfrei** und damit
   für die Ertragsoptimierung wertlos. Sie taugen für Preisverlauf und
   Drawdown-Statistik, nicht für Teil B.
2. **Die Aufzeichnung bleibt Pflicht.** Das Nachladen verdichtet und repariert
   ihre Zeitreihe; es ersetzt sie nicht. Wer die Aufzeichnung abschaltet, hat
   nach sechs Stunden nur noch Preisdaten.

Die Länge des Forttragens ist eine **Modellannahme** und gehört in die
Sensitivitätsanalyse (Abschnitt 6.1): Hängt ein Ergebnis daran, hängt es an einer
Interpolation, nicht an einer Messung.

### 5.2 Warum High und Low nicht optional sind

Die Paper-Engine bewertet jeden Tick an **einem** Preis. Zeit-in-Range und
Gebühren-Akkrual werden damit an den Intervallgrenzen abgelesen: Verlässt der
Preis zwischen zwei Beobachtungen die Range und kehrt zurück, sieht die
Simulation davon nichts und bucht die volle Zeit als „in Range". Bei einer
Konservativ-Position (65 Bins × 10 bps ≈ ±6,7 %) ist das im
15-Minuten-Raster keine Randerscheinung.

Der Fehler wächst genau mit der Volatilität — also dort, wo entschieden wird. Und
er wirkt einseitig zugunsten der Strategie, weil eine Position nie für
Ausflüge bestraft wird, die sie nicht überlebt hätte. `high`/`low` je Kerze
lösen das: Sie machen aus einer Stichprobe ein Intervall.

Bei den **Labels** ist das bereits umgesetzt — `maxDrawdownPct` nutzt `low`, wo
es vorliegt, und misst den Einbruch statt ihn zu verpassen. Im Replay steht es
noch aus und ist Teil von M2.

---

## 6. Optimierungsverfahren

### 6.1 Zuerst Dimensionalität reduzieren

Bevor optimiert wird, wird gemessen, **welche Parameter überhaupt etwas bewirken**:
Eine Sensitivitätsanalyse variiert jeden Parameter einzeln über seinen Bereich und
misst die Ergebnisstreuung. Erfahrungsgemäß erklären **5–10 Parameter den Großteil
der Varianz**; der Rest ist Rauschen.

Nur diese werden anschließend gemeinsam optimiert, der Rest bleibt auf begründeten
Defaults. Das senkt die Overfitting-Gefahr um Größenordnungen — und ist der
wirksamste einzelne Schritt des gesamten Konzepts.

Manche Parameter werden gar nicht optimiert, sondern **hergeleitet**: Der optimale
Fee-Claim-Zeitpunkt etwa folgt direkt aus „claimen, wenn erwartete Gebühren >
k × Transaktionskosten". Für so etwas eine Suche laufen zu lassen, verbrennt
Freiheitsgrade ohne Erkenntnisgewinn.

**Mit in die Analyse gehören die Modellannahmen selbst**, nicht nur die
Strategieparameter. Sie sehen im Code wie Konstanten aus, sind aber Schätzungen,
und ein Ergebnis, das an einer Schätzung hängt, ist keins:

| Annahme | Wo | Warum sie das Ergebnis verschiebt |
|---|---|---|
| `poolLiquidityBins` (Default 70) | `global.paper` | Skaliert den Gebührenanteil linear und entscheidet, ob sich Konzentration auszahlt |
| `feeShareHaircutPct` (Default 30) | `global.paper` | Pauschaler Sicherheitsabschlag auf den Gebührenanteil |
| TVL-Forttragen (6 h) | `loadHistory` | Bestimmt, welche nachgeladenen Zeiträume überhaupt Gebühren buchen (Abschnitt 5.1) |
| `costs.swapSlippagePct` | `global.paper` | Der größte variable Kostenposten, aktuell größenunabhängig |

Die Sensitivitätsanalyse variiert sie wie jeden anderen Parameter. Anders als
diese werden sie danach aber **nicht optimiert** — sie werden auf dem
konservativen Ende festgesetzt. Einen Modellfehler zu „optimieren" heißt, ihn
auszunutzen.

### 6.2 Teil B (Führung): simulationsbasierte Suche

- **Phase 1 – Zufallssuche** über den zulässigen Parameterraum (1.000–5.000
  Auswertungen). Robust, parallelisierbar, liefert eine Landkarte.
- **Phase 2 – Verfeinerung** in den aussichtsreichen Regionen mit einem
  evolutionären Verfahren (CMA-ES) oder Bayes'scher Optimierung (TPE).

Kein Deep Learning: Bei einigen tausend Beobachtungen und ~10 relevanten
Parametern sind neuronale Netze den klassischen Verfahren unterlegen — sie
brauchen mehr Daten, sind schwerer zu validieren und liefern keine
interpretierbaren Ergebnisse.

### 6.3 Teil A (Auswahl): Tabellenmodell

- **Stufe 1 (empfohlener Start):** Die bestehenden Score-Gewichte und
  Filter-Schwellen werden als Parameter mitoptimiert. Bleibt vollständig
  interpretierbar, bleibt in TypeScript, kein zusätzliches Werkzeug.
- **Stufe 2 (optional, später):** Gradient Boosting (LightGBM) auf den
  Merkmalen aus 3.2, Ziel: erwarteter Netto-Ertrag einer Standardposition.
  Lohnt sich erst, wenn Stufe 1 zeigt, dass noch Signal übrig ist.

Für Stufe 2 gilt: **monotone Nebenbedingungen** setzen, wo Fachwissen die Richtung
kennt (ein höherer Organic Score darf die Bewertung nie senken, ein höherer
Roundtrip-Verlust sie nie heben). Das verhindert, dass das Modell Rauschen als
Zusammenhang lernt, und macht es prüfbar.

Erst Stufe 2 rechtfertigt eine Python-Komponente. Bis dahin bleibt alles im
bestehenden Werkzeugkasten — für die Bedienbarkeit ein erheblicher Vorteil.

### 6.4 Zielfunktion

**Nicht** roher PnL. Optimiert wird eine Größe, die Robustheit belohnt:

```
Ziel = Median(Bootstrap(risikoadjustierter Netto-Ertrag))
       − λ · maximaler Drawdown
       − μ · Strafterm für wenige Positionen
```

- **Netto** heißt: nach allen simulierten On-Chain-Kosten. Fehlen die Kosten,
  findet der Optimierer garantiert eine Hochfrequenz-Rebalancing-Strategie, die
  live an Gebühren stirbt.
- **Bootstrap-Median** statt Mittelwert: Ein einziger Glückstreffer soll keine
  Strategie gewinnen lassen.
- **Strafterm** gegen Parametersätze, die nur eine Handvoll Positionen erzeugen —
  dort ist jedes Ergebnis Zufall.
- Zusätzlich als Nebenbedingung: Ergebnis muss auch **gegen die HODL-Benchmark**
  positiv sein. Eine Strategie, die schlechter ist als schlichtes Halten, ist
  keine Strategie.

### 6.5 Plateau statt Spitze

Ein Parametersatz wird **nicht mit seinem eigenen Ergebnis bewertet, sondern mit
dem Mittel seiner Nachbarschaft**. Ein scharfes Optimum ist fast immer Overfitting;
eine breite Hochebene ist ein echter Effekt. Diese Regel ist einfach umzusetzen und
filtert einen Großteil der Scheinfunde heraus.

---

## 7. Validierung: der Teil, an dem solche Systeme scheitern

### 7.1 Zeitliche Aufteilung, niemals zufällig

Aufgeteilt wird **nach Zeit**, nie zufällig — sonst lernt das Modell aus der
Zukunft. Rollierendes Vorwärts-Testen:

```
Woche 1–2 trainieren → Woche 3 prüfen
Woche 1–3 trainieren → Woche 4 prüfen
Woche 1–4 trainieren → Woche 5 prüfen
```

Zwischen Trainings- und Prüfzeitraum liegt eine **Sperrzone** (Embargo) in Länge
der maximalen Haltedauer, damit keine Position beide Zeiträume berührt.

### 7.2 Ein Zeitraum bleibt unberührt

Der letzte Abschnitt der Daten wird **einmal** am Ende benutzt — für die finale
Bewertung der ausgewählten Kandidaten. Wer ihn mehrfach anfasst, hat ihn verbraucht.

### 7.3 Mehrfachtestproblem

Wer 50.000 Parametersätze prüft, findet allein durch Zufall exzellent aussehende.
Das wird korrigiert (deflationierter Sharpe-Quotient bzw. explizite Berücksichtigung
der Anzahl Versuche). Praktische Faustregel, die im Bericht ausgewiesen wird:
**Wie gut wäre der beste Zufallsfund gewesen?** Liegt der Kandidat nicht deutlich
darüber, ist er keiner.

### 7.4 Ehrliches Abbruchkriterium

Das System muss „**kein belastbarer Vorteil gefunden**" melden dürfen und diese
Meldung sichtbar machen. Dieses Ergebnis ist wahrscheinlicher als ein Treffer und
korrekt — es verhindert, dass Kapital auf eine Zufallsfindung gesetzt wird.

### 7.5 Letzte Instanz: Live-Paper

Optimierte Kandidaten gehen **nicht direkt live**, sondern zuerst als neue Presets
in den bestehenden Paper-Vergleich (KONZEPT.md, Abschnitt 13). Erst wenn sie dort
über mehrere Wochen auf frischen Daten bestehen, ist echtes Kapital ein Thema.
Diese Stufe fängt genau das ab, was Replay nicht sehen kann: Modellfehler des
Simulators.

---

## 8. Mehrere Strategien statt einer

Der Wunsch nach zwei oder mehr Strategien ist fachlich richtig — er erzwingt
Diversifikation und macht Überanpassung sichtbar (echte Effekte tauchen in
mehreren guten Lösungen auf, Zufallsfunde nicht).

Umsetzung als **mehrkriterielle Optimierung**: Statt einer Bestlösung wird die
Pareto-Front über *Ertrag*, *Drawdown* und *Trefferquote* bestimmt. Aus ihr werden
Kandidaten gewählt, die sich zusätzlich **fachlich unterscheiden** — mit einer
Obergrenze für die Korrelation ihrer Positions-Ergebnisse. Zwei Strategien, die
dieselben Pools zur selben Zeit handeln, sind eine Strategie mit doppeltem Einsatz.

Erwartetes Ergebnis sind typischerweise Profile wie: eine ertragsstarke mit hohem
Drawdown, eine ruhige mit hoher Trefferquote, eine, die in Seitwärtsphasen trägt.
Sie werden als reguläre Preset-Dateien exportiert und laufen anschließend im
normalen Vergleich mit.

---

## 9. Bedienung: der Knopf

Neue Seite **„Strategie-Labor"** mit drei Zuständen:

**1. Aufzeichnung** — ein Schalter, danach Fortschrittsanzeige:
> „Aufzeichnung läuft seit 6 Tagen · 1.284 Kandidaten · 312.000 Messpunkte.
> Für eine belastbare Optimierung fehlen noch ca. 14 Tage."

Die Schätzung basiert auf der tatsächlichen Sammelrate, nicht auf einer
Pauschale — so ist die Wartezeit transparent statt gefühlt.

**2. Optimierung** — erst aktiv, wenn genug Daten vorliegen. Läuft Minuten bis
Stunden, mit Fortschritt und Zwischenständen.

**3. Ergebnis** — je Kandidat:
- Kennzahlen **auf dem unberührten Prüfzeitraum** (nicht auf den Trainingsdaten)
- Vergleich gegen die bestehenden Presets und gegen „nur halten"
- Vergleich gegen den besten Zufallsfund (Abschnitt 7.3)
- Welche Parameter sich vom Ausgangswert entfernt haben — und wie stark das Ergebnis
  davon abhängt
- Welche Indikatoren tragen (Merkmalsbedeutung), inklusive Organic Score
- Schaltfläche **„Als Preset übernehmen"** → schreibt eine neue Datei in `config/`
  und aktiviert sie im Paper-Vergleich

**Bewusst nicht vorgesehen:** eine automatische Übernahme in den Live-Betrieb. Der
Schritt von „im Test gut" zu „echtes Geld" bleibt eine menschliche Entscheidung.

---

## 10. Was das System nicht leisten kann

| Grenze | Bedeutung |
|---|---|
| **Regimewechsel** | Auf Juli-Daten optimierte Parameter können im September versagen. Memecoin-Marktphasen wechseln schnell. Gegenmaßnahme: rollierende Neu-Optimierung, Überwachung auf Leistungsabfall, Neubewertung bei Abweichung |
| **Simulatorfehler** | Der Optimierer beutet jede Ungenauigkeit aus. Gegenmaßnahme: konservative Abschläge, echte Bin-Liquidität statt Schätzung, Live-Paper als letzte Instanz. Die vier bekannten Abweichungen und ihre Richtung stehen unten |
| **Seltene Ereignisse** | Rugs, Netzwerkausfälle, Liquiditätskrisen sind in wenigen Wochen kaum enthalten. Die harten Sicherheitsfilter bleiben deshalb **außerhalb** der Optimierung — sie werden nicht wegoptimiert, nur ihre Schwellwerte justiert |
| **Kausalität** | Das Modell findet Zusammenhänge, keine Ursachen. Ein Merkmal kann Vorhersagekraft haben und trotzdem morgen wertlos sein |
| **Datenmenge** | Vier Wochen sind für Auswahlentscheidungen ausreichend, für Aussagen über seltene Marktphasen nicht |

**Nicht optimierbar (fest verdrahtet):** Mint-/Freeze-Authority, Verkaufbarkeit,
Blacklist-Status, die Verlustlimits und der Kill-Switch. Diese Regeln schützen vor
Totalverlust; sie stehen nicht zur Disposition eines Optimierers, der sie
kurzfristig als ertragsmindernd erkennen würde.

### 10.1 Die bekannten Abweichungen des Simulators, mit Vorzeichen

Ein Optimierer sucht nicht die beste Strategie, sondern das Maximum der
**Zielfunktion** — und die enthält jeden Modellfehler. Deshalb genügt es nicht zu
wissen, *dass* es Fehler gibt; man muss wissen, **in welche Richtung** sie wirken,
denn dorthin wird die Suche laufen.

| Abweichung | Richtung | Wohin der Optimierer dadurch gezogen wird |
|---|---|---|
| Nur der aktive Bin verdient. Die DLMM-Doku sagt: **alle am Swap beteiligten Bins** verdienen | unterschätzt Gebühren, und breite Positionen stärker als enge | zu **enge** Ranges |
| Fremde Liquidität gilt als gleichmäßig über `poolLiquidityBins` verteilt | unbekannt, skaliert den Gebührenanteil linear | zu **konzentrierte** Verteilungen, wenn der Wert zu hoch steht |
| Zeit-in-Range und Gebühren an Intervallgrenzen abgelesen (bis `high`/`low` im Replay genutzt werden) | überschätzt beides, mit der Volatilität wachsend | zu **volatile** Pools |
| Exit-Slippage pauschal statt größen- und liquiditätsabhängig | unterschätzt Verluste im Tail | zu **große** Positionen, zu **illiquide** Pools |

Praktische Konsequenz für M3/M4: Diese vier Annahmen gehören **als Parameter** in
die Sensitivitätsanalyse, nicht als Konstanten in den Code. Ein Ergebnis, das
gegen ihre Variation nicht stabil ist, ist ein Ergebnis über den Simulator und
nicht über den Markt.

### 10.2 Was der Datensatz kann und was nicht

| Frage | Beantwortbar? |
|---|---|
| Welche Merkmale sagen die Pool-Entwicklung vorher? | **ja** — dafür ist der Datensatz gebaut |
| Welche Filter-Schwellen sind zu streng/zu lasch? | **ja** — jeder gescreente Kandidat wird verfolgt, auch der abgelehnte |
| Wie verhält sich eine Position in einem gegebenen Verlauf? | **ja**, wo TVL vorliegt (Abschnitt 5.1) |
| Wie hoch ist der reale Ertrag inklusive Ausführung? | **nein** — dafür braucht es Phase 2 mit echten Mikro-Positionen |
| Wie oft passieren Rugs? | **eingeschränkt** — wenige Wochen enthalten wenige seltene Ereignisse |
| Wie verhält sich die Strategie in einer anderen Marktphase? | **nein** |

---

## 11. Umsetzungsplan

| Phase | Inhalt | Aufwand | Kalenderzeit |
|---|---|---|---|
| **M1 — Aufzeichnung** ✅ | `tracked_pools`, `candidate_features`, `candidate_outcomes`; `track`-Kommando; Jupiter-Token-API-Adapter (Organic Score); Fortschritts- und Lückenüberwachung | umgesetzt | **läuft** |
| **M1b — Merkmalsbreite** ✅ | Alle sechs Zeitfenster der Pool-API (`30m`–`24h`) samt Trend- und Stetigkeitsmerkmalen, Gebührenstruktur (dynamische Gebühr, Protokollanteil, `collect_fee_mode`), Farm-Rewards, Pool-Alter, Token-Angaben aus der Pool-API; Discovery über mehrere Sortierungen (`FEATURE_VERSION` 2) | umgesetzt | **läuft** |
| **M1c — Zeitreihe für den Replay** ✅ | `pool_snapshots` trägt Gebührenstruktur, SOL-Kurs und alle Zeitfenster je Messpunkt; `effectiveFeePct()` als Genauigkeits-Rangfolge; `loadTrack()` als gemeinsamer Lesepfad von Replay und Label-Berechnung | umgesetzt | **läuft** |
| **M1d — Simulator repariert** ✅ | Aktiv-Bin-Gebührenmodell statt TVL-Anteil, Protokollanteil, Gesamtgebühr statt Basisgebühr, Composition Fee, Rebalancing als ein Ablauf, Wartezustand einseitiger Positionen | umgesetzt | — |
| **M1e — Label-Nachberechnung** ✅ | Auswahl nur noch über offene Horizonte statt „älteste zuerst"; Rückstand als Kennzahl im Prüfbericht | umgesetzt | — |
| **M1f — Durchsatz und Nachladen** ✅ | Sammelabruf der Messpunkte (`filter_by=pool_address=[…]`, ~50 statt 2.000 Anfragen je Runde); `pool_history_candles` samt `backfill`-Kommando; `loadHistory()` als Lesepfad; `low` in der Drawdown-Messung | umgesetzt | — |
| **M2 — Replay** ✅ | `loadSeries()` als **ein** Lesepfad für Replay und Labels; `replayPosition`/`replayEntries` über dieselbe Paper-Engine; Einstiege an beliebigen Zeitpunkten; Determinismus geprüft; Gleichheitstest Replay ↔ Live; `replay`-Kommando mit Preset-Vergleich. Offen: `high`/`low` für Zeit-in-Range (Abschnitt 5.2) | umgesetzt | — |
| **M3 — Sensitivität** | Einzelparameter-Analyse **inklusive der Modellannahmen** (Abschnitt 6.1), Auswahl der 5–10 relevanten, Bericht | gering | **nächster Schritt** |
| **M4 — Suche** | Zufallssuche + Verfeinerung, Zielfunktion, Plateau-Bewertung | mittel | nach M3 |
| **M5 — Validierung** | Vorwärts-Testen, Sperrzonen, Mehrfachtestkorrektur, Zufallsvergleich | mittel | mit M4 |
| **M6 — Auswahl & UI** | Pareto-Front, Diversitätsfilter, Strategie-Labor-Seite, Preset-Export | mittel | nach M5 |
| **M7 — Lernmodell (optional)** | LightGBM mit monotonen Nebenbedingungen, Merkmalsbedeutung | hoch | nur bei Restsignal |

**Empfohlene Reihenfolge der ersten Schritte:** M1 läuft — die Merkmals-
aufzeichnung ist der Teil, dessen Wert von verstrichener Zeit abhängt, und sie
sollte durchgehend weiterlaufen. M2 ist der nächste Schritt und **nicht mehr an
Wartezeit gebunden**: Die Verläufe, gegen die der Replay rechnet, lassen sich
über die Historien-Endpunkte nachladen (Abschnitt 3.3). Erst danach lohnt der
Optimierer.

### Betriebsanforderung: lückenlose Laufzeit

Die Aufzeichnung braucht einen **dauerhaft laufenden Rechner**. Ein zugeklappter
Laptop schläft und zeichnet nichts auf — und die Lücken sind nicht nur fehlende
Daten, sondern **systematisch verzerrte**: Es fehlen genau die Nachtstunden, in
denen Memecoin-Märkte oft am stärksten schwanken. Ein Modell, das nur
Tagesstunden kennt, lernt eine Marktrealität, die es so nicht gibt.

| Betriebsart | Eignung | Anmerkung |
|---|---|---|
| **Kleiner VPS** (~9–15 €/Monat) | **empfohlen** | Läuft durch, unabhängig vom Laptop; entspricht der Infrastrukturplanung in KONZEPT.md Abschnitt 15 |
| Laptop dauerhaft wach (`caffeinate`) | Notlösung | Nur am Netzteil und mit offenem Deckel; jeder Neustart erzeugt eine Lücke |
| Laptop im normalen Alltagsbetrieb | **ungeeignet** | Erzeugt genau die systematischen Lücken, die den Datensatz entwerten |

Das `track --status`-Kommando meldet erkannte Lücken ausdrücklich, damit ein
verzerrter Datensatz nicht unbemerkt zur Grundlage einer Optimierung wird.

**Wie sehr eine Lücke schadet, hängt jetzt davon ab, was in ihr fehlt.** Das
Nachladen (Abschnitt 3.3) läuft im Dauerbetrieb mit und schließt sie teilweise:

| In der Lücke fehlt | Reparierbar? |
|---|---|
| Preis, High/Low, Volumen, Gebühren, Protokollanteil | **ja**, vollständig und feiner als das Messraster |
| TVL, SOL-Kurs | **nein** — nur Momentaufnahmen |
| Merkmale nicht entdeckter Kandidaten | **nein** — und das ist der schwerste Verlust: Wer in der Lücke nicht gescreent hat, hat diese Pools nie gesehen |

Eine durchlaufende Maschine bleibt damit die Anforderung — aber eine Nacht
Unterbrechung entwertet den Datensatz nicht mehr, sie verdünnt ihn. Nach einer
längeren Unterbrechung lohnt ein ausdrücklicher `pnpm nachladen`, statt auf den
nächsten automatischen Durchgang zu warten.

### Unterbrechungen sind unkritisch für den Bestand

Jeder Messpunkt wird sofort als eigene Transaktion in die Datenbank geschrieben —
nichts wird im Arbeitsspeicher gepuffert. Ein Absturz, ein Neustart oder ein
zugeklappter Deckel kosten daher nur die Zeit der Unterbrechung, nie bereits
gesammelte Daten. Nach dem Neustart sind alle verfolgten Pools sofort wieder
fällig, und die Aufzeichnung setzt fort.

Ein Teil der gesammelten Daten ist **nicht wiederbeschaffbar**: die
Merkmalszeilen zum Entscheidungszeitpunkt und der TVL-Verlauf. Für sie gibt es
keine Historie zum Abrufen — was nicht aufgezeichnet wurde, ist dauerhaft weg.
Preis-, Volumen- und Gebührenverlauf lassen sich dagegen über die
Meteora-Historien-Endpunkte nachladen (Abschnitt 3.3). Nach einigen Wochen
steckt im nicht-nachladbaren Teil der eigentliche Wert des Vorhabens.
`pnpm sichern` legt deshalb eine komprimierte Sicherung an, prüft sie
auf Vollständigkeit (eine leere Sicherung ist gefährlicher als keine, weil sie
Sicherheit vortäuscht) und hält die letzten 14 vor. Vor dem Zurückspielen wird
automatisch der Ist-Zustand gesichert.

Was eine Lücke jedoch beschädigt, sind die **Labels**, deren Horizont in sie
fällt. Deshalb führt jedes Label seine Abdeckung mit (`observations`,
`coveredHours`), und der Datensatz-Export verlangt standardmäßig 70 % Abdeckung
des Horizonts. Ein 24-Stunden-Label, das nur drei Stunden abdeckt, wird
aussortiert statt stillschweigend mittrainiert. `datasetQuality()` weist je
Horizont aus, wie viele Labels verwertbar sind — die ehrliche Rechnung dessen,
was Unterbrechungen tatsächlich gekostet haben.

### Nachberechnung der Labels: der Rückstand ist die Kennzahl

Labels entstehen nicht beim Erfassen eines Kandidaten, sondern nachträglich —
sobald ein Horizont **vollständig** verstrichen ist. Ein nach zwei Stunden
berechnetes 24-Stunden-Label wäre systematisch verzerrt. Jeder Durchgang der
Aufzeichnung holt deshalb einen Stapel von Kandidaten mit fälligen, aber noch
fehlenden Labels nach.

Die entscheidende Eigenschaft dieser Auswahl: Sie muss **fertige Kandidaten
überspringen**. Werden stattdessen einfach die ältesten genommen, belegen die
längst ausgewerteten den Stapel dauerhaft, und ab dem ersten vollen Stapel
bekommt kein neuer Kandidat je ein Label. Dieser Fehler ist besonders tückisch,
weil er sich nicht wie einer anfühlt: Es *sind* Tausende Labels da, sie gehören
nur alle zu den ersten Kandidaten.

Deshalb überwacht der Prüfbericht (`pnpm pruefen`) nicht die Anzahl der Labels,
sondern den **Rückstand** — fällige, aber fehlende Labels jenseits einer
Karenzzeit von sechs Stunden. Nach einer Unterbrechung ist ein Rückstand normal
und baut sich über die nächsten Durchgänge ab; bleibt er stehen oder wächst er,
wird nicht mehr nachgeführt. Ein Kandidat, dessen Pool im Horizont gar nicht
gemessen wurde, erhält ein **leeres** Label (`observations = 0`) statt gar
keines — auch „hier wurde nichts aufgezeichnet" ist ein Ergebnis, und nur so
verlässt er den Stapel. Für das Training ist es unschädlich: Export und
Qualitätsrechnung verlangen beide mindestens zwei Beobachtungen.

---

## 12. Ehrliche Erwartungshaltung

Was dieses System liefern kann:

- **Sicher:** Belastbare Aussagen darüber, welche Parameter überhaupt eine Rolle
  spielen und welche Indikatoren Vorhersagekraft haben (inklusive Organic Score).
  Allein das ist wertvoll — es ersetzt Bauchgefühl durch Messung.
- **Wahrscheinlich:** Eine bessere Justierung der Filter-Schwellen als geratene
  Startwerte, mit messbarem Vorteil gegenüber den drei Handpresets.
- **Möglich, nicht garantiert:** Zwei bis drei deutlich unterschiedliche
  Strategien, die im Vorwärts-Test bestehen.
- **Nicht zu erwarten:** Eine dauerhaft überlegene Strategie. Auf DLMM-Pools mit
  Memecoins konkurrieren viele automatisierte Teilnehmer; Vorteile sind klein und
  vergänglich.

Der realistischste Nutzen ist nicht „der Bot findet die Wunderformel", sondern
**„wir hören auf, an Parametern zu drehen, für die es keine Evidenz gibt"** — und
erkennen früher, wenn eine Strategie nicht mehr trägt.
