# Konzept: Automatische Strategie-Optimierung

> Ziel: Statt handgesetzter Presets sollen Parameter **und** Auswahlindikatoren
> datengetrieben bestimmt werden. Bedienung: Aufzeichnung läuft, Optimierung
> anstoßen, mehrere validierte Strategie-Kandidaten erhalten.

Ergänzt [KONZEPT.md](./KONZEPT.md). Die dort beschriebene Paper-Engine ist die
Grundlage — sie wird hier zum Simulator, gegen den optimiert wird.

---

## 1. Die zentrale Schwierigkeit: Overfitting

Der Engpass ist **nicht** Rechenzeit, sondern die Menge unabhängiger
Beobachtungen im Verhältnis zur Zahl der Stellschrauben.

Die Konfiguration hat rund **40 Parameter je Preset**. Vier Wochen Paper-Trading
erzeugen vielleicht **100 bis 400 geschlossene Positionen**. Wer 40 Parameter auf
300 verrauschten Beobachtungen optimiert, findet garantiert eine Kombination, die
in den Daten hervorragend aussieht und live scheitert. Das ist keine theoretische
Sorge, sondern der Normalfall bei Handelsstrategie-Optimierung.

Verschärfend: **Der Optimierer nutzt jeden Fehler des Simulators aus.** Eine
Suche über 50.000 Parametersätze findet zuverlässig genau die Kombination, die
die Modellungenauigkeiten maximal ausbeutet — und die ist live wertlos. Welche
Ungenauigkeiten das sind und in welche Richtung sie wirken, steht in Abschnitt
10.1.

**Alles Folgende ist deshalb primär gegen Overfitting konstruiert, nicht auf
maximale Optimierungsleistung.** Ein System, das ehrlich „kein belastbarer
Vorteil gefunden" meldet, ist wertvoller als eines, das immer eine schöne
Strategie ausspuckt.

Drei Konsequenzen prägen die Architektur:

1. **Datenmenge vervielfachen**, statt Modelle zu vergrößern (Abschnitt 3).
2. **Dimensionalität reduzieren**, bevor optimiert wird (Abschnitt 6.1).
3. **Out-of-Sample-Validierung ist nicht verhandelbar** (Abschnitt 7).

---

## 2. Zwei getrennte Lernprobleme

Ein häufiger Fehler ist, „die Strategie" als ein einziges Lernproblem zu
behandeln. Tatsächlich sind es zwei mit völlig unterschiedlicher Datenlage:

| | **A: Auswahl** (welcher Pool?) | **B: Führung** (wie halten?) |
|---|---|---|
| Entscheidet über | Filter, Score-Gewichte, Mindestscore | Range-Breite, Strategie-Typ, SL/TP, Haltedauer, Rebalancing |
| Datenquelle | Kandidaten und ihre spätere Entwicklung | Simulation auf aufgezeichneten Verläufen |
| Verfügbare Beobachtungen | **hoch** — jeder gescreente Pool, auch der abgelehnte | **beliebig** — Replay erzeugt Positionen nach Bedarf |
| Passendes Verfahren | Überwachtes Lernen, Tabellenmodell | Simulationsbasierte Parametersuche |

Der Hebel steckt in Zeile 3: Beide Probleme lassen sich mit weit mehr
Beobachtungen füttern, als real eröffnete Positionen liefern — **wenn** die
richtigen Daten aufgezeichnet werden.

---

## 3. Datenfundament

### 3.1 Der Multiplikator: alle Kandidaten verfolgen

Wer nur aus tatsächlich eröffneten Positionen lernt, hat zwei Probleme: zu wenige
Beobachtungen und **Selektionsverzerrung** — man erfährt nie, dass ein Filter zu
streng ist, weil die abgelehnten Pools nie beobachtet werden.

Deshalb wird für **jeden gescreenten Pool** der weitere Verlauf aufgezeichnet,
unabhängig vom Urteil.

| | pro Tag | in 4 Wochen |
|---|---|---|
| Gescreente Pool×Preset-Kandidaten | 100–300 | **3.000–8.000** |
| Davon real eröffnete Paper-Positionen | 3–15 | 100–400 |
| Durch Replay erzeugbare Positionen | — | **praktisch unbegrenzt** |

Aus 3.000–8.000 gelabelten Auswahl-Beobachtungen lässt sich ein Tabellenmodell
mit 15–25 Merkmalen seriös schätzen. Aus 300 nicht.

### 3.2 Was aufgezeichnet wird

**Merkmale zum Entscheidungszeitpunkt** (`candidate_features`). Kritisch:
ausschließlich Werte, die zu diesem Zeitpunkt bekannt waren. Jede spätere
Information ist Look-Ahead-Bias und macht das Modell wertlos.

| Gruppe | Inhalt |
|---|---|
| Pool | Bin Step, TVL, Volumen und Fee/TVL je Zeitfenster (30 m…24 h), Pool-Alter, `launchpad`, `tags`, Farm-Rewards |
| Gebührenstruktur | `dynamic_fee_pct` (Basis + Volatilitätsaufschlag — der Satz, mit dem Swaps tatsächlich belastet werden), `max_fee_pct`, `protocol_fee_pct`, `collect_fee_mode` samt abgeleiteter **Gebührenwährung** |
| Markt (DexScreener) | Token-Alter, Liquidität, Kauf/Verkauf-Verhältnis, Trades je Fenster, Preisänderungen, FDV, Marktkapitalisierung |
| Risiko (RugCheck) | normalisierter Score, Authority-Status, Top-10-Anteil, Insider-Anteil, Holder-Anzahl |
| Ausführbarkeit (Jupiter) | Roundtrip-Verlust, Preis-Impact beider Richtungen, Routen-Anzahl |
| Organik (Jupiter Token API) | `organicScore`, Label, `holderCount`, Verifizierung (Abschnitt 4.1) |
| Abgeleitet | Fee/TVL-**Trend** statt -Niveau, Volumen-Stetigkeit, Anteil des Pools an der Token-Liquidität, Übereinstimmung der Authority-Angaben zweier Quellen |

Die Gebührenwährung ist dabei vermutlich das stärkste einzelne Risikomerkmal des
Degen-Profils: Sie entscheidet, ob geclaimte Gebühren offenes Token-Exposure sind
oder nicht (KONZEPT.md 2.1). Und das Pool-Alter wird getrennt vom Token-Alter
geführt — ein neuer Pool auf einem älteren Token ist ein anderer Fall als ein
neuer Token.

**Ergebnisse** (`candidate_outcomes`): Labels je Horizont (1 h / 6 h / 24 h /
72 h / 7 d) — Preisänderung, TVL-Änderung, Gebührenertrag je TVL-Einheit,
maximaler Drawdown und ein Rug-Indikator (Preis oder TVL −90 %). Jedes Label
trägt seine Abdeckung mit (`observations`, `coveredHours`), damit lückenhafte
Labels vor dem Training aussortiert werden können statt stillschweigend
mitzutrainieren.

> **Was `feeYieldPct` ist und was nicht.** Das Label rechnet die laufende
> Rate `Gebühren / TVL` über den Horizont hoch. Das ist die Ertragskraft des
> **Pools**, nicht der Ertrag einer Position: Es fehlen Bin-Konzentration, Zeit in
> Range, Protokollanteil und Kosten. Als **Rangsignal** für Teil A ist das richtig
> und ausreichend — die Frage dort lautet „welcher Pool verdient mehr?", nicht
> „wie viel verdienen wir?". Die zweite Frage beantwortet ausschließlich der
> Replay. Wer `feeYieldPct` als Ertragsprognose liest, überschätzt jede Strategie.

### 3.3 Zwei Quellen: Messpunkte und Kerzen

Die Zeitreihe, gegen die optimiert wird, kommt aus zwei verschiedenen Quellen.
Der Unterschied ist entscheidend:

| | **Messpunkte** (`pool_snapshots`) | **Kerzen** (`pool_history_candles`) |
|---|---|---|
| Woher | laufende Abfrage im Messraster | `/pools/{address}/ohlcv` und `/volume/history`, rückwirkend |
| Auflösung | 15 min | 5 min (bis 24 h wählbar) |
| Enthält | TVL, SOL-Kurs, dynamische Gebühr, gleitende Zeitfenster | Open/High/Low/Close, Volumen, Gebühren, Protokollanteil **je Fenster** |
| Nachholbar | **nein** | **ja**, jederzeit |

Volumen und Gebühren einer Kerze gelten für ihr Fenster, nicht als Tagessumme —
eine 5-Minuten-Kerze als 24-Stunden-Wert zu lesen läge um Faktor 288 daneben. Die
Umrechnung passiert einmal zentral beim Lesen, der Gebührensatz wird als Quotient
genommen und ist damit skalenfrei.

**Was das für den Zeitplan bedeutet.** Ein Teil der Zeitreihe ist nachholbar:

| Größe | Nachladbar? |
|---|---|
| Preis samt High/Low, Volumen, Gebühren, Protokollanteil | **ja** — feiner als das eigene Messraster |
| TVL, SOL-Kurs | **nein** — nur als Momentaufnahme verfügbar |
| Merkmale zum Entscheidungszeitpunkt | **nein** — Momentaufnahmen fremder Dienste |

Daraus folgen drei Dinge:

1. **Der Replay ist nicht an Wartezeit gebunden.** Verläufe lassen sich für jeden
   bekannten Pool rückwirkend holen, auch für die Zeit vor seiner Entdeckung.
2. **Lücken sind teilweise reparierbar.** Eine Unterbrechung kostet nicht mehr den
   Preis- und Gebührenverlauf, sondern nur TVL, SOL-Kurs und — am schwersten —
   die Kandidaten, die in dieser Zeit nicht gescreent wurden.
3. **Die Merkmalsaufzeichnung bleibt der zeitkritische Teil.** Ohne sie gibt es
   kein Auswahlmodell (Teil A), sondern nur die Führungs-Optimierung (Teil B).

Zusammengeführt werden beide Quellen in **einem** Lesepfad (`loadSeries()`), den
Replay und Label-Berechnung teilen: Kerzen bilden das Raster, wo es sie gibt;
Messpunkte steuern den TVL bei und füllen Zeiträume ohne Kerzen. Zwei getrennte
Lesepfade wären ein stiller Fehler — man optimierte gegen die eine Zeitreihe und
bewertete mit der anderen.

### 3.4 Datenvolumen und Aufwand

| Bestand | Zeilen |
|---|---|
| Messpunkte: 2.000 Pools × 96/Tag | ~190.000/Tag |
| Kerzen: 2.000 Pools × 288/Tag | ~580.000/Tag |
| Merkmale und Labels | wenige Tausend/Tag |

Zusammen rund 0,8 Mio. Zeilen/Tag, etwa 23 Mio./Monat. Für PostgreSQL auf einem
kleinen VPS handhabbar — Kerzen sind schmale Zeilen mit zusammengesetztem
Primärschlüssel —, verlangt aber eine **Ausdünnungsstrategie**: Kerzen älter als
30 Tage auf ein gröberes Raster verdichten oder verwerfen. Sie sind ohnehin
jederzeit wieder abrufbar; das ist der praktische Nutzen daran, dass die Historie
nicht mehr unwiederbringlich ist.

Der Abrufaufwand ist gering. Meteora erlaubt 30 Anfragen/s; über den Sammelabruf
(`filter_by=pool_address=[…]`) kosten 2.000 Pools rund 50 Anfragen je Messrunde
statt 2.000. Das Nachladen ist teurer, aber selten: je Pool und Tag zwei
Anfragen. Die teuren Per-Token-Abrufe fallen nur einmal beim Entdecken an.

---

## 4. Zusätzliche Indikatoren

### 4.1 Jupiter Organic Score

Die Token API v2 liefert einen `organicScore` (0–100) samt Label sowie
`holderCount`. Der Score bewertet, wie *echt* die Aktivität eines Tokens ist —
genau die Frage, die die eigene Wash-Trading-Heuristik nur grob beantwortet.

Einsatz an drei Stellen: als **Merkmal** im Auswahlmodell (vermutlich eines der
stärksten), als **Hard Filter** mit lernbarem statt geratenem Schwellwert, und
als **Gegenprobe** zur eigenen Heuristik — wo beide widersprechen, lohnt ein
Blick.

Wichtig: Der Score ist ein **fremdes Modell**, dessen Berechnung unbekannt ist und
sich ändern kann. Er wird als Merkmal geführt, nie als alleiniges
Ausschlusskriterium, und seine Verfügbarkeit wird überwacht.

### 4.2 Weitere Kandidaten, nach erwartetem Nutzen

| Indikator | Quelle | Warum plausibel relevant |
|---|---|---|
| **Bin-Liquiditätsverteilung** | DLMM-SDK (RPC) | Bestimmt den tatsächlichen Gebührenanteil — ersetzt die größte Schätzung des Simulators durch eine Messung |
| Realisierte Volatilität | eigene Zeitreihe | Treibt die dynamische Gebühr **und** den Impermanent Loss |
| TVL-Trend | eigene Zeitreihe | Abfließende Liquidität geht Preisverfall oft voraus |
| Volumen-Stetigkeit | eigene Zeitreihe | Unterscheidet gleichmäßigen Handel von wenigen Bursts |
| Anteil einzigartiger Trader | DexScreener | Ergänzt den Organic Score |
| Launchpad-Herkunft, Tags | Meteora | Kategoriale Merkmale mit oft überraschend hohem Erklärungswert |
| Token/SOL-Korrelation | eigene Zeitreihe | Hoch korrelierte Token verhalten sich in der Range anders |

Die **Bin-Liquiditätsverteilung** ist der wertvollste Zugewinn: Sie ersetzt die
größte Ungenauigkeit des Simulators durch eine Messung und verbessert die
Optimierung mehr als jedes zusätzliche Modell. Sie braucht den RPC-Adapter, der
ohnehin für die Execution Engine kommt.

---

## 5. Replay

Die Paper-Engine verarbeitet `MarketTick`-Objekte. Genau diese Ticks lassen sich
aus der Aufzeichnung rekonstruieren — damit ist jede Parameterkombination auf
denselben historischen Verläufen durchspielbar.

```
Aufgezeichnete und nachgeladene Verläufe
        │
        ├─ Parametersatz A → simulierte Positionen → Kennzahlen
        ├─ Parametersatz B → …                       (Rechenzeit: Millisekunden)
        └─ … 50.000 weitere
```

Der Unterschied zu „50 Presets live parallel laufen lassen": Letzteres bräuchte
dieselbe Kalenderzeit **und** lieferte je Preset weniger Beobachtungen.

### 5.1 Stand

Die Replay-Engine ist umgesetzt (`replayPosition`, `replayEntries`,
`summarizeReplay`; Kommando `pnpm abspielen`). Sie besitzt **keine eigene
Positionslogik** — sie ruft `openPaperPosition`, `tickPaperPosition` und
`closePaperPosition`, also genau die Funktionen des Paper-Betriebs.

| Anforderung | Stand |
|---|---|
| Tick-Reader aus der Datenbank | ✅ `loadSeries()` — ein Pfad für Replay **und** Labels |
| Einstiege an beliebigen Zeitpunkten | ✅ `replayEntries` mit einstellbarem Abstand |
| Determinismus | ✅ keine Wanduhr, kein Zufall; durch Tests festgehalten |
| Gleichheit Replay ↔ Live | ✅ beide Wege bauen ihren Tick an derselben Stelle; der Test vergleicht **alle** Tick-Felder und führt die zulässigen Abweichungen mit Begründung auf |
| `high`/`low` für Zeit-in-Range | ✅ Überlappungsanteil statt Abtastung (Abschnitt 5.3); offen bleibt allein der Bin-Zustand |
| Range-Breite im Replay | ✅ aus `realizedVolatilityPctDaily` über ein **rückwärts** gerichtetes Fenster — vorher fiel der Replay auf die Mitte von `binRange` zurück und simulierte damit eine andere Strategie als der Live-Pfad |

**Nicht verhandelbar:** Replay und Live-Betrieb nutzen denselben Codepfad. Gäbe
es zwei Implementierungen, optimierte man gegen die eine und handelte mit der
anderen. Der Gleichheitstest ist die Absicherung: Er vergleicht den Tick aus
frischen Pool-Metriken mit dem aus einer aufgezeichneten Beobachtung desselben
Pools. Ohne ihn liefen beide Seiten auseinander, während jede für sich plausibel
aussähe.

### 5.2 Woraus ein Tick besteht — und was fehlt

| Größe | Quelle |
|---|---|
| Preis, High/Low | Kerzen |
| Volumen, Gebühren, Protokollanteil | Kerzen |
| **TVL** | nur Messpunkte |
| SOL-Kurs | nur Messpunkte |

Der TVL ist die unangenehme Zeile. Das Gebührenmodell braucht ihn: Der eigene
Anteil ist `eigene Liquidität im aktiven Bin / Gesamtliquidität dort`, und der
Nenner folgt aus dem Pool-TVL. Ohne TVL **darf** die Simulation keine Gebühren
buchen — sonst rechnet sie einen Anteil an einer unbekannten Größe.

Umgesetzte Regelung: Der TVL des letzten Messpunkts wird höchstens sechs Stunden
nach vorne getragen, danach `null`. Zwei Folgen:

1. **Nachgeladene Zeiträume ohne jede Aufzeichnung sind gebührenfrei** und damit
   für die Ertragsoptimierung wertlos. Sie taugen für Preisverlauf und
   Drawdown-Statistik, nicht für Teil B.
2. **Die Aufzeichnung bleibt Pflicht.** Das Nachladen verdichtet und repariert
   ihre Zeitreihe, es ersetzt sie nicht.

Die Länge des Forttragens ist eine **Modellannahme** und gehört in die
Sensitivitätsanalyse (6.1): Hängt ein Ergebnis daran, hängt es an einer
Interpolation, nicht an einer Messung.

Ein Tick braucht außerdem die **Mints** des Pools. `price_native` ist immer der
Preis von Token X in Token Y; steht SOL auf der X-Seite, muss invertiert werden.
Ohne diese Information läge jede Bin-Zuordnung falsch herum.

### 5.3 Warum High und Low nicht optional sind

Die Paper-Engine bewertet jeden Tick an **einem** Preis. Zeit-in-Range und
Gebühren-Akkrual werden damit an den Intervallgrenzen abgelesen: Verlässt der
Preis zwischen zwei Beobachtungen die Range und kehrt zurück, sieht die
Simulation nichts davon und bucht die volle Zeit als „in Range". Bei einer
Konservativ-Position (65 Bins × 10 bps ≈ ±6,7 %) ist das im 15-Minuten-Raster
keine Randerscheinung.

Der Fehler wächst mit der Volatilität — also dort, wo entschieden wird — und
wirkt einseitig zugunsten der Strategie: Eine Position wird nie für Ausflüge
bestraft, die sie nicht überlebt hätte. `high`/`low` je Kerze machen aus einer
Stichprobe ein Intervall.

Bei den **Labels** ist das umgesetzt: `maxDrawdownPct` nutzt `low`, wo es
vorliegt, und misst den Einbruch, statt ihn zu verpassen.

**In der Engine inzwischen ebenfalls**, an den drei Stellen, an denen ein
Intervall etwas anderes aussagt als sein Endpunkt:

| Größe | vorher | jetzt |
|---|---|---|
| Zeit in Range | ja/nein am Intervallende | **Überlappungsanteil** von [Tief, Hoch] mit der Range, in log-Preisen |
| Stop-Loss und Preissturz | nur am Schlusskurs | zusätzlich am **Tief**; löst der Ausstieg erst dort aus, wird die Position auch dort bewertet |
| „Range erreicht" (einseitig) | nur am Schlusskurs | auch per Docht — eine Leiter, die der Preis kurz berührt hat, **hat** gekauft |

Nicht umgesetzt und bewusst offen: der **Bin-Zustand** folgt weiter dem
Schlusskurs. Ob der Preis innerhalb einer Kerze erst zum Hoch und dann zum Tief
lief oder umgekehrt, steht nirgends — und die beiden Reihenfolgen ergeben
verschiedene Bestände. Eine Reihenfolge zu raten hieße, eine Verzerrung
unbekannter Richtung einzubauen; die drei Größen oben haben dagegen eine
eindeutige Lesart. Der verbleibende Fehler unterschätzt damit weiterhin
Bin-Überquerungen, also **beides**: realisierten Impermanent Loss und
Gebührenanfall.

### 5.4 Zensierte Positionen zählen anders

Ein Replay-Lauf endet dort, wo die Daten enden — mitten in offenen Positionen.
Diese Beobachtungen sind **rechtszensiert**: Wie sie ausgegangen wären, ist
unbekannt.

Sie mitzuzählen wäre ein Fehler mit Richtung: Jede Strategie, die ihre Verlierer
lange hält, sähe besser aus, weil ihre schlechten Positionen überproportional oft
im offenen Zustand enden. Deshalb fließen zensierte Positionen in Ertrag und
Kosten ein — sie haben stattgefunden —, aber **nicht** in Trefferquote und
Ausstiegsgründe. Der Bericht weist ihre Zahl aus.

---

## 6. Optimierungsverfahren

### 6.1 Zuerst Dimensionalität reduzieren

Bevor optimiert wird, wird gemessen, **welche Parameter überhaupt etwas
bewirken**: Eine Sensitivitätsanalyse variiert jeden Parameter einzeln über
seinen Bereich und misst die Ergebnisstreuung. Erfahrungsgemäß erklären **5–10
Parameter den Großteil der Varianz**; der Rest ist Rauschen.

Nur diese werden anschließend gemeinsam optimiert, der Rest bleibt auf begründeten
Defaults. Das senkt die Overfitting-Gefahr um Größenordnungen und ist der
wirksamste einzelne Schritt des gesamten Konzepts.

Manche Parameter werden gar nicht optimiert, sondern **hergeleitet**: Der optimale
Fee-Claim-Zeitpunkt folgt direkt aus „claimen, wenn erwartete Gebühren >
k × Transaktionskosten". Dafür eine Suche laufen zu lassen verbrennt
Freiheitsgrade ohne Erkenntnisgewinn.

**Mit in die Analyse gehören die Modellannahmen selbst.** Sie sehen im Code wie
Konstanten aus, sind aber Schätzungen — und ein Ergebnis, das an einer Schätzung
hängt, ist keins:

| Annahme | Warum sie das Ergebnis verschiebt |
|---|---|
| `poolLiquidityBins` | Skaliert den Gebührenanteil linear und entscheidet, ob sich Konzentration auszahlt. **Gemessen: Faktor 14 zwischen 10 und 140** — der Default steht deshalb auf dem konservativen 30 statt 70 |
| `feeShareHaircutPct` | Pauschaler Sicherheitsabschlag auf den Gebührenanteil |
| `limitOrderShareHaircutPct` | Was Limit-Order-Liquidität von der Handelsgebühr abzweigt. Seit `lb_clmm` 0.12.0 ist jeder Pool ohne Rewards ein Limit-Order-Pool — also praktisch jeder Zielpool. Messbar aus den `/positions/.../historical`-Events |
| TVL-Forttragen (6 h) | Bestimmt, welche nachgeladenen Zeiträume überhaupt Gebühren buchen (5.2) |
| `costs.swapSlippagePct` | Grundslippage je Swap, größenunabhängig |
| `swapImpactFactor` | Preisimpact je Anteil am Pool-TVL. Trifft vor allem den Ausstiegs-Swap und damit den Verlust-Tail. Messbar über die Jupiter-Roundtrip-Prüfung, die heute nur filtert |
| `costs.priorityFeeSol` | Nicht der größte Posten, aber der einzige, der in Stressphasen um Größenordnungen springt — und Stressphasen sind die, in denen die Ausstiege feuern |
| `rebalance.projectionHours` | Über welchen Zeitraum der Zusatzertrag eines Rebalances gilt. Vorher implizit die gesamte Restlaufzeit — das öffnete das EV-Tor vollständig |
| Abtastraster (`tickMinutes`) | Verschiebt Zeit-in-Range und Ergebnis um mehrere Prozentpunkte; die Richtung ist **nicht** offensichtlich und gehört gemessen |

Eine Beobachtung aus der Messung, die gegen die Erwartung läuft: Gebühren in den
**überquerten** Bins statt nur im aktiven zu verteilen, erhöht den Ertrag nicht
durchgehend. Bei kleinen Bewegungen sinkt er sogar (−12 % bei ±5 %), weil eine
Position, die breiter ist als die unterstellte Fremdverteilung, pro berührtem
Bin weniger beisteuert als die Konkurrenz. Erst wenn der Preis über die eigene
Range hinausläuft, dreht es (+57 % bei ±15 %). Die Richtung hängt damit am
Verhältnis von Positionsbreite zu `poolLiquidityBins` — was beide Annahmen
aneinanderkoppelt und ein weiteres Argument dafür ist, `poolLiquidityBins` zu
**messen** statt zu schätzen.

Die Sensitivitätsanalyse variiert sie wie jeden anderen Parameter. Anders als
diese werden sie danach aber **nicht optimiert**, sondern auf dem konservativen
Ende festgesetzt. Einen Modellfehler zu „optimieren" heißt, ihn auszunutzen.

### 6.1b Die Ausnahme: was sich messen lässt, wird gemessen

Für drei dieser Annahmen — `poolLiquidityBins`, `feeShareHaircutPct` und
`limitOrderShareHaircutPct` — gilt der Satz „konservativ festsetzen" nur so
lange, wie sie unmessbar sind. Sie sind es nicht mehr.

Die DLMM-Positions-Endpunkte sind **öffentlich**: `/portfolio` nennt die Pools
eines Wallets, `/positions/{pool}/pnl` seine Positionen mit Zeitraum, Einsatz,
Bin-Range und Gebührenertrag. Damit lässt sich jede fremde Position durch die
eigene Engine schicken und der Gebührenertrag vergleichen —
`pnpm --filter @lping/bot calibrate -- --wallet <Adresse>`.

Was dabei herauskommt, ist **nicht** der Wert der drei Annahmen einzeln; aus
einer Beobachtung sind sie nicht zu trennen. Was herauskommt, ist ihr Produkt,
ausgedrückt als der `poolLiquidityBins`-Wert, der die Lücke schließt. Genau das
ist die Größe, die zählt: Ob die Simulation um Faktor 3 zu großzügig oder zu
streng rechnet, entscheidet über jede Aussage zur Profitabilität — welche der
drei Annahmen den Fehler trägt, ist demgegenüber zweitrangig.

Zwei Vorbehalte, die zum Verfahren gehören:

1. **Der TVL wird fortgetragen.** Die Historien-Endpunkte liefern keinen TVL;
   die Kalibrierung nimmt den heutigen. Ein Pool, dessen Liquidität sich seither
   halbiert hat, verschiebt den Faktor um denselben Betrag. Deshalb sind kurze,
   junge Zeiträume vorzuziehen und der Median über viele Positionen belastbarer
   als jeder Einzelfall.
2. **Ohne Bin-Range kein Fall.** Positionen, deren Antwort die Range nicht
   ausweist, werden übersprungen statt geschätzt. Ein Vergleich auf geratener
   Breite sähe aus wie eine Messung und wäre keine.

### 6.1c Regime statt Auswahl: die vorgelagerte Frage

Screening und Score beantworten „welcher Pool ist der beste?". Sie beantworten
nicht „ist heute überhaupt einer gut genug?" — und aus einem Feld schlechter
Kandidaten wählt der Score zuverlässig den besten schlechten aus und eröffnet
ihn.

Die Bedingung, unter der LPing trägt, ist dieselbe wie beim einzelnen Pool:
Gebührenertrag über Varianzverlust. Über die Kandidaten eines Durchgangs
aggregiert (Median, nicht Mittelwert — ein Ausreißer soll den Markt nicht
drehen) ergibt sie ein Urteil über das **Regime**, und ein Tor davor wirkt auf
alle Presets gleichzeitig. Das ist der billigste verfügbare Hebel: Er kostet
keine Kalenderzeit, während jede Parametersuche erst einen Datensatz braucht
und danach nur ein Preset verbessert.

Bewertet wird das **ganze** Kandidatenfeld, auch das abgelehnte. Ein Urteil aus
den Pools, die die Filter passiert haben, misst die Filter mit und wäre per
Konstruktion immer freundlich.

Die Schwellen (`adverseBelow`, `favourableAbove`) sind gesetzt, nicht gemessen.
`regime_snapshots` zeichnet deshalb **jedes** Urteil auf, auch wenn es nicht
blockiert hat: Erst diese Reihe zeigt, ob „ungünstig" tatsächlich schlechtere
Ergebnisse vorhersagt — und damit, ob das Tor mehr nützt als es an Einstiegen
kostet. Ein Tor, das nie gemessen wird, ist eine Behauptung.

### 6.1a Zwei Wege, zwei Fragen: Replay und Stresstest

Der Replay läuft auf **aufgezeichneten** Verläufen und sagt, was passiert wäre.
Er kann aber nicht sagen, *warum*: Volatilität und Umschlag sind dort so
verwoben, wie der Markt sie geliefert hat, und lassen sich nicht trennen.

`pnpm stresstest` fährt dieselbe Engine auf **synthetischen** Pfaden mit
getrennt einstellbarem σ, Umschlag und Drift. Das beantwortet die Frage, an der
die Auslegung der Presets hängt: **Bei welcher Volatilität und welchem Umschlag
trägt diese Bauform überhaupt?** Und es zeigt, ob ein Ergebnis am Markt hängt
oder am Simulator.

Beides ist nötig und keins ersetzt das andere. Der Stresstest sagt, wonach zu
suchen wäre; der Replay, ob es das gab. Ein Ergebnis, das nur der Stresstest
kennt, ist eine Aussage über ein Modell — ein Ergebnis, das nur der Replay
kennt, kann Zufall einer Marktphase sein.

Die Regime-Landkarte des Stresstests ist dabei die wichtigste Einzelausgabe: Sie
zeigt, ob die Auswahlfilter überhaupt in die Richtung zeigen, in der das Ergebnis
positiv wird.

### 6.2 Teil B (Führung): simulationsbasierte Suche

- **Phase 1 — Zufallssuche** über den zulässigen Parameterraum (1.000–5.000
  Auswertungen). Robust, parallelisierbar, liefert eine Landkarte.
- **Phase 2 — Verfeinerung** in den aussichtsreichen Regionen mit einem
  evolutionären Verfahren (CMA-ES) oder Bayes'scher Optimierung (TPE).

Kein Deep Learning: Bei einigen tausend Beobachtungen und ~10 relevanten
Parametern sind neuronale Netze den klassischen Verfahren unterlegen — mehr
Datenbedarf, schwerer zu validieren, keine interpretierbaren Ergebnisse.

### 6.3 Teil A (Auswahl): Tabellenmodell

- **Stufe 1 (empfohlener Start):** Die bestehenden Score-Gewichte und
  Filter-Schwellen werden als Parameter mitoptimiert. Bleibt vollständig
  interpretierbar und in TypeScript, kein zusätzliches Werkzeug.
- **Stufe 2 (optional):** Gradient Boosting auf den Merkmalen aus 3.2, Ziel ist
  der erwartete Netto-Ertrag einer Standardposition. Lohnt sich erst, wenn
  Stufe 1 zeigt, dass noch Signal übrig ist — und rechtfertigt erst dann eine
  Python-Komponente.

Für Stufe 2 gilt: **monotone Nebenbedingungen** setzen, wo Fachwissen die Richtung
kennt (ein höherer Organic Score darf die Bewertung nie senken, ein höherer
Roundtrip-Verlust sie nie heben). Das verhindert, dass das Modell Rauschen als
Zusammenhang lernt, und macht es prüfbar.

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
- **Nebenbedingung:** Das Ergebnis muss auch gegen die HODL-Benchmark positiv
  sein. Eine Strategie, die schlechter ist als schlichtes Halten, ist keine.

### 6.5 Plateau statt Spitze

Ein Parametersatz wird **nicht mit seinem eigenen Ergebnis bewertet, sondern mit
dem Mittel seiner Nachbarschaft**. Ein scharfes Optimum ist fast immer
Overfitting, eine breite Hochebene ein echter Effekt. Einfach umzusetzen und
filtert einen Großteil der Scheinfunde heraus.

---

## 7. Validierung

### 7.1 Zeitliche Aufteilung, niemals zufällig

Aufgeteilt wird **nach Zeit** — sonst lernt das Modell aus der Zukunft.
Rollierendes Vorwärts-Testen:

```
Woche 1–2 trainieren → Woche 3 prüfen
Woche 1–3 trainieren → Woche 4 prüfen
Woche 1–4 trainieren → Woche 5 prüfen
```

Zwischen Trainings- und Prüfzeitraum liegt eine **Sperrzone** in Länge der
maximalen Haltedauer, damit keine Position beide Zeiträume berührt.

### 7.2 Ein Zeitraum bleibt unberührt

Der letzte Abschnitt der Daten wird **einmal** am Ende benutzt, für die finale
Bewertung der ausgewählten Kandidaten. Wer ihn mehrfach anfasst, hat ihn
verbraucht.

### 7.3 Mehrfachtestproblem

Wer 50.000 Parametersätze prüft, findet allein durch Zufall exzellent aussehende.
Das wird korrigiert (deflationierter Sharpe-Quotient beziehungsweise explizite
Berücksichtigung der Versuchsanzahl). Praktische Faustregel, die im Bericht steht:
**Wie gut wäre der beste Zufallsfund gewesen?** Liegt der Kandidat nicht deutlich
darüber, ist er keiner.

### 7.4 Ehrliches Abbruchkriterium

Das System muss „**kein belastbarer Vorteil gefunden**" melden dürfen und diese
Meldung sichtbar machen. Dieses Ergebnis ist wahrscheinlicher als ein Treffer und
korrekt — es verhindert, dass Kapital auf eine Zufallsfindung gesetzt wird.

### 7.5 Letzte Instanz: Live-Paper

Optimierte Kandidaten gehen **nicht direkt live**, sondern zuerst als neue Presets
in den bestehenden Paper-Vergleich. Erst wenn sie dort über mehrere Wochen auf
frischen Daten bestehen, ist echtes Kapital ein Thema. Diese Stufe fängt genau
das ab, was der Replay nicht sehen kann: Modellfehler des Simulators.

---

## 8. Mehrere Strategien statt einer

Mehrere Strategien erzwingen Diversifikation und machen Überanpassung sichtbar —
echte Effekte tauchen in mehreren guten Lösungen auf, Zufallsfunde nicht.

Umsetzung als **mehrkriterielle Optimierung**: Statt einer Bestlösung wird die
Pareto-Front über *Ertrag*, *Drawdown* und *Trefferquote* bestimmt. Aus ihr werden
Kandidaten gewählt, die sich zusätzlich **fachlich unterscheiden** — mit einer
Obergrenze für die Korrelation ihrer Positions-Ergebnisse. Zwei Strategien, die
dieselben Pools zur selben Zeit handeln, sind eine Strategie mit doppeltem
Einsatz.

Erwartbare Profile: eine ertragsstarke mit hohem Drawdown, eine ruhige mit hoher
Trefferquote, eine, die in Seitwärtsphasen trägt. Sie werden als reguläre
Preset-Dateien exportiert und laufen anschließend im normalen Vergleich mit.

---

## 9. Bedienung: das Strategie-Labor

Geplante UI-Seite mit drei Zuständen:

**1. Aufzeichnung** — Fortschrittsanzeige mit einer Schätzung, die auf der
tatsächlichen Sammelrate beruht statt auf einer Pauschale:

> „Aufzeichnung läuft seit 6 Tagen · 1.284 Kandidaten · 312.000 Messpunkte.
> Für eine belastbare Optimierung fehlen noch ca. 14 Tage."

**2. Optimierung** — erst aktiv, wenn genug Daten vorliegen. Läuft Minuten bis
Stunden, mit Fortschritt und Zwischenständen.

**3. Ergebnis** — je Kandidat:

- Kennzahlen **auf dem unberührten Prüfzeitraum**, nicht auf den Trainingsdaten
- Vergleich gegen die bestehenden Presets und gegen „nur halten"
- Vergleich gegen den besten Zufallsfund (7.3)
- Welche Parameter sich vom Ausgangswert entfernt haben — und wie stark das
  Ergebnis davon abhängt
- Welche Indikatoren tragen (Merkmalsbedeutung)
- Schaltfläche **„Als Preset übernehmen"** → schreibt eine Datei in `config/` und
  aktiviert sie im Paper-Vergleich

**Bewusst nicht vorgesehen:** eine automatische Übernahme in den Live-Betrieb. Der
Schritt von „im Test gut" zu „echtes Geld" bleibt eine menschliche Entscheidung.

---

## 10. Grenzen

| Grenze | Bedeutung |
|---|---|
| **Regimewechsel** | Auf Juli-Daten optimierte Parameter können im September versagen. Gegenmaßnahme: rollierende Neu-Optimierung, Überwachung auf Leistungsabfall |
| **Simulatorfehler** | Der Optimierer beutet jede Ungenauigkeit aus — siehe 10.1 |
| **Seltene Ereignisse** | Rugs, Netzwerkausfälle und Liquiditätskrisen sind in wenigen Wochen kaum enthalten. Die harten Sicherheitsfilter bleiben deshalb **außerhalb** der Optimierung |
| **Kausalität** | Das Modell findet Zusammenhänge, keine Ursachen. Ein Merkmal kann Vorhersagekraft haben und morgen wertlos sein |
| **Datenmenge** | Vier Wochen reichen für Auswahlentscheidungen, nicht für Aussagen über seltene Marktphasen |

**Nicht optimierbar, fest verdrahtet:** Mint- und Freeze-Authority,
Verkaufbarkeit, Blacklist-Status, Verlustlimits und Kill-Switch. Diese Regeln
schützen vor Totalverlust und stehen nicht zur Disposition eines Optimierers, der
sie kurzfristig als ertragsmindernd erkennen würde.

### 10.1 Die bekannten Abweichungen des Simulators, mit Vorzeichen

Ein Optimierer sucht nicht die beste Strategie, sondern das Maximum der
**Zielfunktion** — und die enthält jeden Modellfehler. Es genügt deshalb nicht zu
wissen, *dass* es Fehler gibt; man muss wissen, **in welche Richtung** sie wirken,
denn dorthin läuft die Suche.

| Abweichung | Richtung | Wohin der Optimierer gezogen wird |
|---|---|---|
| Nur der aktive Bin verdient; tatsächlich verdienen alle vom Swap durchlaufenen Bins | unterschätzt Gebühren, breite Positionen stärker als enge | zu **enge** Ranges |
| Fremde Liquidität gilt als gleichmäßig über `poolLiquidityBins` verteilt | skaliert den Gebührenanteil linear | zu **konzentrierte** Verteilungen, wenn der Wert zu hoch steht |
| Zeit-in-Range und Gebühren an Intervallgrenzen abgelesen | überschätzt beides, wachsend mit der Volatilität | zu **volatile** Pools |
| Exit-Slippage pauschal statt größen- und liquiditätsabhängig | unterschätzt Verluste im Tail | zu **große** Positionen, zu **illiquide** Pools |

Praktische Konsequenz: Diese Annahmen gehören **als Parameter** in die
Sensitivitätsanalyse, nicht als Konstanten in den Code. Ein Ergebnis, das gegen
ihre Variation nicht stabil ist, ist ein Ergebnis über den Simulator und nicht
über den Markt.

### 10.2 Was der Datensatz beantworten kann

| Frage | Beantwortbar? |
|---|---|
| Welche Merkmale sagen die Pool-Entwicklung vorher? | **ja** — dafür ist der Datensatz gebaut |
| Welche Filter-Schwellen sind zu streng oder zu lasch? | **ja** — jeder gescreente Kandidat wird verfolgt, auch der abgelehnte |
| Wie verhält sich eine Position in einem gegebenen Verlauf? | **ja**, wo TVL vorliegt (5.2) |
| Wie hoch ist der reale Ertrag inklusive Ausführung? | **nein** — dafür braucht es Phase 2 mit echten Mikro-Positionen |
| Wie oft passieren Rugs? | **eingeschränkt** — wenige Wochen enthalten wenige seltene Ereignisse |
| Wie verhält sich die Strategie in einer anderen Marktphase? | **nein** |

---

## 11. Umsetzungsplan

| Meilenstein | Inhalt | Stand |
|---|---|---|
| **M1 — Aufzeichnung** | `tracked_pools`, `candidate_features`, `candidate_outcomes`, `pool_snapshots`, `pool_history_candles`; `track`- und `backfill`-Kommando; Merkmalsschema v2 mit allen Zeitfenstern, Gebührenstruktur und Organic Score; Sammelabruf über `filter_by`; Prüfbericht mit Lücken- und Rückstandsüberwachung | ✅ |
| **M2 — Replay** | `loadSeries()` als ein Lesepfad für Replay und Labels; Replay über dieselbe Paper-Engine; Einstiege an beliebigen Zeitpunkten; Determinismus; feldweise vollständiger Gleichheitstest gegen den Live-Pfad; Range-Breite und träges Volumenfenster auch im Replay; `high`/`low` für Zeit-in-Range und Ausstieg; `replay`-Kommando mit Preset-Vergleich | ✅ |
| **M3 — Sensitivität** | Einzelparameter-Analyse **inklusive der Modellannahmen** (6.1), Auswahl der 5–10 relevanten, Bericht | **teilweise** — `pnpm stresstest` fährt Modellannahmen, Strategie-Stellschrauben, Marktbedingungen und eine Regime-Landkarte auf synthetischen Pfaden. Offen: dieselbe Analyse auf den **aufgezeichneten** Verläufen |
| **M4 — Suche** | Zufallssuche und Verfeinerung, Zielfunktion, Plateau-Bewertung | offen |
| **M5 — Validierung** | Vorwärts-Testen, Sperrzonen, Mehrfachtestkorrektur, Zufallsvergleich | offen, mit M4 |
| **M6 — Auswahl & UI** | Pareto-Front, Diversitätsfilter, Strategie-Labor, Preset-Export | offen |
| **M7 — Lernmodell** | Gradient Boosting mit monotonen Nebenbedingungen | nur bei Restsignal |

### 11.1 Betrieb der Aufzeichnung

Die Aufzeichnung braucht einen **dauerhaft laufenden Rechner**. Ein zugeklappter
Laptop zeichnet nichts auf, und die Lücken sind nicht bloß fehlende Daten,
sondern **systematisch verzerrte**: Es fehlen genau die Nachtstunden, in denen
Memecoin-Märkte oft am stärksten schwanken. Ein Modell, das nur Tagesstunden
kennt, lernt eine Marktrealität, die es so nicht gibt.

| Betriebsart | Eignung |
|---|---|
| **Kleiner VPS** (~9–15 €/Monat) | **empfohlen** — läuft durch, unabhängig vom Laptop |
| Laptop dauerhaft wach (`caffeinate`) | Notlösung; nur am Netzteil und mit offenem Deckel |
| Laptop im Alltagsbetrieb | **ungeeignet** — erzeugt genau die systematischen Lücken |

Das Nachladen läuft im Dauerbetrieb mit und schließt Lücken teilweise (3.3). Eine
Nacht Unterbrechung entwertet den Datensatz damit nicht mehr, sie verdünnt ihn.
Nach einer längeren Unterbrechung lohnt ein ausdrückliches `pnpm nachladen`,
statt auf den nächsten automatischen Durchgang zu warten.

Jeder Messpunkt wird sofort in die Datenbank geschrieben, nichts im
Arbeitsspeicher gepuffert. Ein Absturz kostet daher nur die Zeit der
Unterbrechung, nie bereits gesammelte Daten. `pnpm sichern` legt eine
komprimierte Sicherung an, prüft sie auf Vollständigkeit — eine leere Sicherung
ist gefährlicher als keine, weil sie Sicherheit vortäuscht — und hält die letzten
14 vor.

### 11.2 Nachberechnung der Labels: der Rückstand ist die Kennzahl

Labels entstehen nicht beim Erfassen eines Kandidaten, sondern nachträglich —
sobald ein Horizont **vollständig** verstrichen ist. Ein nach zwei Stunden
berechnetes 24-Stunden-Label wäre systematisch verzerrt. Jeder Durchgang holt
deshalb einen Stapel Kandidaten mit fälligen, aber fehlenden Labels nach.

Die entscheidende Eigenschaft dieser Auswahl: Sie muss **fertige Kandidaten
überspringen**. Werden einfach die ältesten genommen, belegen die längst
ausgewerteten den Stapel dauerhaft, und ab dem ersten vollen Stapel bekommt kein
neuer Kandidat je ein Label. Der Fehler ist tückisch, weil er sich nicht wie
einer anfühlt: Es *sind* Tausende Labels da — sie gehören nur alle zu den ersten
Kandidaten.

Deshalb überwacht der Prüfbericht nicht die Anzahl der Labels, sondern den
**Rückstand**: fällige, aber fehlende Labels jenseits einer Karenzzeit. Nach einer
Unterbrechung ist ein Rückstand normal und baut sich ab; bleibt er stehen oder
wächst er, wird nicht mehr nachgeführt.

Ein Kandidat, dessen Pool im Horizont gar nicht gemessen wurde, erhält ein
**leeres** Label statt gar keines — auch „hier wurde nichts aufgezeichnet" ist ein
Ergebnis, und nur so verlässt er den Stapel. Für das Training ist das
unschädlich: Export und Qualitätsrechnung verlangen beide mindestens zwei
Beobachtungen.

---

## 12. Ehrliche Erwartungshaltung

- **Sicher:** Belastbare Aussagen darüber, welche Parameter überhaupt eine Rolle
  spielen und welche Indikatoren Vorhersagekraft haben. Allein das ist wertvoll —
  es ersetzt Bauchgefühl durch Messung.
- **Wahrscheinlich:** Eine bessere Justierung der Filter-Schwellen als geratene
  Startwerte, mit messbarem Vorteil gegenüber den Handpresets.
- **Möglich, nicht garantiert:** Zwei bis drei deutlich unterschiedliche
  Strategien, die im Vorwärts-Test bestehen.
- **Nicht zu erwarten:** Eine dauerhaft überlegene Strategie. Auf DLMM-Pools mit
  Memecoins konkurrieren viele automatisierte Teilnehmer; Vorteile sind klein und
  vergänglich.

Der realistischste Nutzen ist nicht „der Bot findet die Wunderformel", sondern
**„wir hören auf, an Parametern zu drehen, für die es keine Evidenz gibt"** — und
erkennen früher, wenn eine Strategie nicht mehr trägt.
