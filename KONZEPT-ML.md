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
Unsere Paper-Engine schätzt den Fee-Anteil über den TVL-Anteil, vernachlässigt
Slippage innerhalb eines Bins und kennt kein MEV. Eine Suche über 50.000
Parametersätze findet zuverlässig genau die Kombination, die diese
Modellungenauigkeiten maximal ausbeutet — und die ist live wertlos.

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

**Verlauf nach der Entscheidung** (`pool_tracks`): Preis, TVL, Volumen, Gebühren
in dichten Abständen — 15 min für die ersten 48 h, danach stündlich bis Tag 7.
Das ist die Grundlage des Replays.

**Ergebnisse** (`candidate_outcomes`): abgeleitete Labels je Horizont
(1 h / 6 h / 24 h / 72 h / 7 d): Preisänderung, TVL-Änderung, aufgelaufene
Gebühren je TVL-Einheit, sowie ein Rug-Indikator (Preis −90 % oder Verkauf
unmöglich).

**Datenvolumen:** ~200 verfolgte Pools × 7 Tage bei genanntem Raster ≈ 130.000
Zeilen/Tag, rund 4 Mio./Monat. Für PostgreSQL unkritisch; ältere Verläufe werden
auf Stundenraster ausgedünnt.

**Aufwand:** Die Verlaufsaufzeichnung kostet fast nichts — Meteora erlaubt 30
Anfragen/s, 200 Pools alle 15 min sind ein Bruchteil davon. Die teuren
Per-Token-Abrufe (RugCheck, Jupiter, DexScreener) fallen nur einmal beim
Entdecken an.

### 3.3 Konsequenz für den Zeitplan

Die Aufzeichnung ist **die einzige Komponente, die echte Kalenderzeit braucht**.
Alles andere rechnet in Minuten. Deshalb sollte sie starten, bevor irgendein
Optimierer gebaut wird — jeder Tag ohne Aufzeichnung ist unwiederbringlich.

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

Die Replay-Engine ist überwiegend vorhanden — sie braucht:

- einen Tick-Reader aus `pool_tracks` statt Live-Abrufen,
- die Fähigkeit, Einstiege an beliebigen Zeitpunkten zu simulieren (nicht nur
  dort, wo real eröffnet wurde),
- deterministische Ausführung (feste Zufallssaat, keine Wanduhr).

**Nicht verhandelbar:** Replay und Live-Betrieb müssen denselben Codepfad nutzen.
Sobald es zwei Implementierungen gibt, optimiert man gegen die eine und handelt
mit der anderen.

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
| **Simulatorfehler** | Der Optimierer beutet jede Ungenauigkeit aus. Gegenmaßnahme: konservative Abschläge, echte Bin-Liquidität statt Schätzung, Live-Paper als letzte Instanz |
| **Seltene Ereignisse** | Rugs, Netzwerkausfälle, Liquiditätskrisen sind in wenigen Wochen kaum enthalten. Die harten Sicherheitsfilter bleiben deshalb **außerhalb** der Optimierung — sie werden nicht wegoptimiert, nur ihre Schwellwerte justiert |
| **Kausalität** | Das Modell findet Zusammenhänge, keine Ursachen. Ein Merkmal kann Vorhersagekraft haben und trotzdem morgen wertlos sein |
| **Datenmenge** | Vier Wochen sind für Auswahlentscheidungen ausreichend, für Aussagen über seltene Marktphasen nicht |

**Nicht optimierbar (fest verdrahtet):** Mint-/Freeze-Authority, Verkaufbarkeit,
Blacklist-Status, die Verlustlimits und der Kill-Switch. Diese Regeln schützen vor
Totalverlust; sie stehen nicht zur Disposition eines Optimierers, der sie
kurzfristig als ertragsmindernd erkennen würde.

---

## 11. Umsetzungsplan

| Phase | Inhalt | Aufwand | Kalenderzeit |
|---|---|---|---|
| **M1 — Aufzeichnung** ✅ | `tracked_pools`, `candidate_features`, `candidate_outcomes`; `track`-Kommando; Jupiter-Token-API-Adapter (Organic Score); Fortschritts- und Lückenüberwachung | umgesetzt | **läuft** |
| **M2 — Replay** | Tick-Reader, Einstiege an beliebigen Zeitpunkten, Determinismus, Gleichheitstest Replay ↔ Live | mittel | parallel zu M1 |
| **M3 — Sensitivität** | Einzelparameter-Analyse, Auswahl der 5–10 relevanten, Bericht | gering | nach ~1 Woche Daten |
| **M4 — Suche** | Zufallssuche + Verfeinerung, Zielfunktion, Plateau-Bewertung | mittel | nach M3 |
| **M5 — Validierung** | Vorwärts-Testen, Sperrzonen, Mehrfachtestkorrektur, Zufallsvergleich | mittel | mit M4 |
| **M6 — Auswahl & UI** | Pareto-Front, Diversitätsfilter, Strategie-Labor-Seite, Preset-Export | mittel | nach M5 |
| **M7 — Lernmodell (optional)** | LightGBM mit monotonen Nebenbedingungen, Merkmalsbedeutung | hoch | nur bei Restsignal |

**Empfohlene Reihenfolge der ersten Schritte:** M1 sofort umsetzen und die
Aufzeichnung starten — sie ist die einzige Komponente, deren Wert von der
verstrichenen Zeit abhängt. M2 lässt sich parallel bauen, während die Daten
auflaufen. Erst danach lohnt der Optimierer.

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
