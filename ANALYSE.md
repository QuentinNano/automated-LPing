# Analyse: Beurteilung, Verbesserungen, Profitabilität

> Externe Durchsicht des Stands vom 30.07.2026 (Commit `17a4a6f`). Alle Zahlen
> stammen aus Monte-Carlo-Läufen **durch die echte Paper-Engine des Repos**
> (`openPaperPosition` / `tickPaperPosition` / `closePaperPosition`), nicht aus
> einem Nachbau. Die Marktpfade sind simuliert (GBM auf 15-Minuten-Raster); die
> Szenario-Annahmen stehen in Abschnitt 3 und sind der wichtigste Vorbehalt
> gegenüber allen Ergebnissen.

---

## 1. Gesamturteil

**Die Technik ist überdurchschnittlich. Die Strategie ist es nicht.**

Handwerklich gehört dieses Projekt in das obere Zehntel dessen, was man in
diesem Feld sieht: 324 grüne Tests, TypeScript strict, saubere Trennung von
purer Domänenlogik und Adaptern, Replay auf **demselben** Codepfad wie der
Live-Betrieb, fail-closed-Screening, korrekt behandelte Rechtszensierung in der
Replay-Statistik und eine Dokumentation, die ihre eigenen Modellfehler mit
Vorzeichen auflistet. Das ist mehr Disziplin, als die meisten Handelssysteme
mitbringen.

Genau deshalb ist der Befund unangenehm: Die Sorgfalt steckt in der Infrastruktur,
während die **Strategie selbst einen arithmetischen Konstruktionsfehler** trägt,
den keine Menge Datenaufzeichnung findet — weil er nicht in den Daten steht,
sondern in der Bin-Geometrie.

| Bereich | Urteil |
|---|---|
| Architektur, Testbarkeit, Datenmodell | **stark** |
| Datenaufzeichnung und Replay (M1/M2) | **stark**, methodisch sauber |
| Screening & Filter | solide Struktur, aber blind für die entscheidende Größe (Volatilität) |
| Simulationsmodell | strukturell richtig, in zwei Punkten unkalibriert |
| **Exit-Regeln (SL/TP)** | **fehlerhaft — Kernproblem, siehe Abschnitt 2** |
| Risk Manager | nicht vorhanden (bekannt und dokumentiert) |
| Kapitalmodell | drei widersprüchliche Definitionen der Positionsgröße |

---

## 2. Der zentrale Befund: die Exit-Regeln sind einseitig

Eine DLMM-Position hat einen **mathematisch begrenzten Preisgewinn**. Sie hält
Token in den Bins oberhalb des Einstiegspreises; steigt der Preis, werden diese
zum jeweiligen Bin-Preis verkauft. Der maximal erreichbare Gewinn aus
Preisbewegung ist damit durch die Range-Breite gedeckelt — und die Ranges sind
eng.

Gemessen an der Engine des Repos, ohne Gebühren:

| Preset | Bins × Bin Step | Range-Breite | **Max. Gewinn aus Preis** | **konfigurierter Take-Profit** |
|---|---|---|---|---|
| Konservativ | 65 × 20 bps | 13,6 % | **+1,26 %** | 40 % |
| Balanced | 50 × 50 bps | 27,7 % | **+2,18 %** | 50 % |
| Degen (`quote_only`) | 30 × 125 bps | 43,4 % | **±0,00 %** | 30 % |

Der Take-Profit liegt in jedem Preset **um den Faktor 20 bis 40 über dem, was die
Position überhaupt erreichen kann.** Er kann nicht auslösen. Der Stop-Loss
dagegen löst zuverlässig aus.

Damit sind die Exit-Regeln vollständig asymmetrisch: **Verluste werden gekappt,
Gewinne nie mitgenommen.** Eine Position kann die Range nur einmal nach oben
durchlaufen (danach ist sie zu 100 % SOL und verdient nichts mehr), läuft dann
ins Zeitlimit — oder sie fällt und wird ausgestoppt.

Der Beleg im Ergebnis ist eindeutig. Der Median-PnL ist praktisch **identisch mit
dem eingestellten Stop-Loss**:

| Stop-Loss | 10 % | 20 % | 35 % | 60 % | 100 % |
|---|---|---|---|---|---|
| Median-PnL | −13,97 % | −23,21 % | −37,91 % | −62,16 % | −94,41 % |
| Take-Profit-Exits | 0 | 0 | 0 | 0 | 0 |

Das ist keine Strategie mit schlechter Trefferquote. Das ist eine Konstruktion,
deren Ergebnis der Anwender über den Stop-Loss selbst einstellt.

**Das Gegenmittel ist einfach und wirkt sofort.** Ein Take-Profit, der innerhalb
der erreichbaren Spanne liegt (Balanced: 100 Bins, SL 12 %, 24 h):

| Take-Profit | 2 % | 4 % | 8 % | 15 % | 50 % (Ist) |
|---|---|---|---|---|---|
| Trefferquote | **62 %** | 43 % | 21 % | 5 % | 2 % |
| Median-PnL | **+1,71 %** | −13,45 % | −15,03 % | −15,80 % | −15,90 % |
| Mittel-PnL | −4,88 % | −7,87 % | −11,77 % | −15,28 % | −16,14 % |

Wichtig für die Erwartungshaltung: Der **Median** dreht ins Plus, der
**Mittelwert** bleibt negativ. Viele kleine Gewinne, wenige große Verluste — der
Fehler verschwindet nicht, er wird nur umverteilt. Das reicht nicht; es zeigt
aber, dass die Stellschraube wirkt.

---

## 3. Quantitative Analyse: was die Engine unter realistischen Bedingungen liefert

3.000 Pfade je Preset, 15-Minuten-Raster, Marktannahmen frei gewählt und bewusst
als solche gekennzeichnet:

| Preset | Pool-Annahme | Median-PnL | Mittel | Fees | Kosten | vs. HODL | Win | in Range | Exits |
|---|---|---|---|---|---|---|---|---|---|
| Konservativ | TVL 300 k$, Vol/TVL 3×, Fee 0,3 %, σ_tag 40 % | −17,4 % | −17,8 % | 0,10 % | 2,33 % | −11,8 % | **0 %** | 53 % | 100 % Stop-Loss |
| Balanced | TVL 150 k$, Vol/TVL 6×, Fee 0,6 %, σ_tag 80 % | −23,7 % | −24,4 % | 0,36 % | 2,88 % | −16,9 % | **0 %** | 66 % | 100 % Stop-Loss |
| Degen | TVL 80 k$, Vol/TVL 12×, Fee 2,0 %, σ_tag 150 % | −0,7 % | −10,4 % | 0,82 % | 1,00 % | −0,7 % | 19 % | 51 % | 56 % out_of_range |

Drei Dinge sind daran wichtiger als die Vorzeichen:

**1. Die Gebühren sind eine Nachkommastelle, die Kosten sind es nicht.** Bei
Konservativ verdient die Position 0,10 % und zahlt 2,33 % — ein Verhältnis von
1 : 23. Nicht weil die Gebührenrate niedrig wäre (das Modell impliziert
umgerechnet ~1 %/Tag ≈ 400 % APR, während die Position lebt), sondern weil sie
**nicht lange genug lebt**, um etwas anzusammeln. Der Stop-Loss greift nach
Stunden.

**2. Degen ist strukturell das beste der drei Profile.** Der einseitige
SOL-Einstieg ist eine gestaffelte Kauforder: Der Median-Fall wird nie befüllt und
verliert nur die Gebühren des Ein- und Ausstiegs. Der Preis dafür steht im
Mittelwert (−10,4 %) und im 10-Prozent-Quantil (−27,4 %) — wer befüllt wird, wird
in einen fallenden Markt hinein befüllt. Das ist ökonomisch eine **verkaufte
Verkaufsoption**: begrenzte Prämie, unbegrenztes Abwärtsrisiko. Als Bauform ist
das legitim; es muss nur so bepreist und so bewertet werden.

**3. Die Ranges sind zu eng für die Volatilität, auf die sie gerichtet sind.**
Eine Konservativ-Position umspannt 13,6 % Preisbreite bei einer angenommenen
Tagesvolatilität von 40 %. Sie ist binnen Stunden außerhalb.

### 3.1 Sensitivität: woran die Ergebnisse hängen

**`poolLiquidityBins` skaliert den Ertrag exakt linear** — und die Annahme ist
frei geraten:

| `poolLiquidityBins` | 10 | 20 | 35 | **70 (Ist)** | 140 |
|---|---|---|---|---|---|
| Fees Konservativ | 0,01 % | 0,03 % | 0,05 % | **0,10 %** | 0,21 % |
| Fees Balanced | 0,05 % | 0,10 % | 0,17 % | **0,34 %** | 0,72 % |

KONZEPT-ML.md 6.1 benennt das bereits als wichtigste Modellannahme. Die Messung
bestätigt es: Faktor 14 zwischen den Extremen, **auf der gesamten Ertragsseite**.
Der wahre Wert liegt bei Memecoin-Pools eher am unteren Ende — dort konzentriert
fast jeder LP eng um den Preis, nicht über 70 Bins. Das heißt: **Die Simulation
rechnet die Gebühren derzeit vermutlich zu hoch, nicht zu niedrig.**

**Volatilität hilft nicht, sie schadet.** Höhere Vola erzeugt zwar höhere
Gebühren pro Zeiteinheit, wirft die Position aber schneller aus der Range:

| σ_tag (Balanced) | 30 % | 60 % | 90 % | 120 % | 180 % |
|---|---|---|---|---|---|
| Fees | 2,56 % | 0,62 % | 0,27 % | 0,14 % | 0,06 % |
| Zeit in Range | 92 % | 75 % | 62 % | 50 % | 35 % |
| PnL | −21,7 % | −22,9 % | −24,0 % | −25,2 % | −27,2 % |

Der Gebührenertrag fällt um **Faktor 40**, während die Volatilität sich
versechsfacht. Das ist der Kern des LP-Problems und der Grund, warum
„hoher Fee/TVL-Wert" allein kein Auswahlkriterium ist.

**Das Abtastraster verschiebt das Ergebnis messbar** (Balanced, sonst identisch):

| Raster | 1 min | 5 min | 15 min (Ist) | 60 min |
|---|---|---|---|---|
| Zeit in Range | 77 % | 74 % | **65 %** | 42 % |
| PnL | −21,6 % | −22,5 % | **−23,8 %** | −26,6 % |

Anmerkung zu KONZEPT.md 13.1: Dort steht, das Ablesen an Intervallgrenzen
**überschätze** Zeit-in-Range und Gebühren. In dieser Messung wirkt es umgekehrt —
gröberes Raster senkt beides, weil der Preis je Schritt weiter springt und
häufiger außerhalb liegt. Beide Effekte existieren; welcher dominiert, ist eine
empirische Frage und sollte gemessen statt behauptet werden. Für die
Sensitivitätsanalyse (M3) gehört das Raster damit auf dieselbe Liste wie
`poolLiquidityBins`.

### 3.2 Gibt es überhaupt einen positiven Parametersatz?

Zufallssuche über 400 Kombinationen aus Bin-Zahl, Strategietyp, Seite,
Stop-Loss, Take-Profit, Haltedauer und Rebalancing — auf dem Balanced-Szenario:

```
Positive Erwartung (Mittel-PnL > 0):  0 von 400
```

Die besten Kandidaten konvergieren alle gegen dieselbe Antwort: *400 Bins,
`quote_only`, 2 Stunden Haltedauer* — also **so wenig teilnehmen wie möglich**,
Ergebnis ≈ −0,8 %. Das ist die ehrliche Antwort eines Optimierers, dem man einen
Markt ohne Vorteil vorlegt.

Erst eine Variation des **Marktregimes** findet ein positives Feld (Balanced,
100 Bins, SL 12 %, TP 4 %, 24 h, Drift 0):

| | Vol/TVL 6× | Vol/TVL 30× |
|---|---|---|
| σ_tag 20 % | −3,00 % | **+0,50 %** (vs. HODL +0,47 %, Win 80 %) |
| σ_tag 40 % | −5,43 % | −3,02 % |
| σ_tag 80 % | −7,73 % | −6,41 % |
| σ_tag 150 % | −9,88 % | −9,23 % |

**Das ist der wichtigste Satz dieser Analyse:** Profitabel wird die Bauform bei
**niedriger Volatilität und hohem Umschlag** — und die Presets suchen das genaue
Gegenteil. Degen filtert auf Token, die 1–48 Stunden alt sind, mit Bin Step ≥ 100
und Basisgebühr ≥ 1 %. Das sind per Konstruktion die volatilsten Pools des
Marktes.

Der Score belohnt Fee/TVL (35 Punkte) und Momentum (10 Punkte) — **eine
Volatilitätsgröße kommt darin nicht vor.** Genau die entscheidet aber, ob der
Gebührenertrag den Impermanent Loss übersteigt. Die Auswahl optimiert den Zähler
und ignoriert den Nenner.

---

## 4. Konkrete Befunde im Code

### 4.1 Die EV-Prüfung vor dem Rebalancing ist wirkungslos

`packages/core/src/paper/engine.ts:271` — `rebalanceIsWorthIt()` schätzt den
Zusatzertrag über:

```ts
const expected = accrueFees(projected, tick, global, remainingMs);
```

Zwei Fehler multiplizieren sich:

1. `remainingMs` ist die **gesamte Restlaufzeit** (Balanced: bis 96 h,
   Konservativ: bis 336 h), und `accrueFees` unterstellt dabei, die Position
   liege diese ganze Zeit im aktiven Bin — also 100 % Zeit in Range. Gemessen
   sind 50–66 %.
2. `tick.poolVolume24hUsd` kommt aus `volumeRate24hUsd()`
   (`packages/core/src/paper/ticks.ts:37`) und ist das **kürzeste verfügbare
   Fenster hochgerechnet** — bei `m30` also die letzten 30 Minuten × 48. Für den
   Fee-Akkrual über 15 Minuten ist das richtig. Über vier Tage extrapoliert ist
   es eine Volumenspitze, die zur Dauerannahme erklärt wird.

Ergebnis: Der geschätzte Ertrag übersteigt die Kosten um Größenordnungen,
`minEvFactor` von 2 oder 3 ist immer erfüllt. Die Gemessene Rebalance-Zahl
(≈ 2,0 je Position) folgt ausschließlich `cooldownMin` und `maxPerDay` — das
EV-Tor ist offen. Da Rebalancing im Modell der zweitgrößte Kostenblock ist, ist
das teuer.

**Fix:** Ertrag über ein begrenztes Fenster projizieren (z. B. `cooldownMin` oder
die Zeit bis zum nächsten erwarteten Trigger), mit der **beobachteten** Zeit in
Range gewichten und für die Projektion das trägste verfügbare Volumenfenster
verwenden, nicht das kürzeste.

### 4.2 Drei widersprüchliche Definitionen der Positionsgröße

| Ort | Formel | Ergebnis (Balanced) |
|---|---|---|
| `apps/bot/src/paper.ts:110` | `paper.capitalPerPresetSol × positionSizePct` | 0,20 SOL |
| `packages/core/src/replay/engine.ts:84` | dieselbe | 0,20 SOL |
| `packages/core/src/screening/filters.ts:183` | `global.maxTotalExposureSol × positionSizePct` | **0,40 SOL** |

Der Filter `pool_share_of_tvl` prüft damit eine **doppelt so große** Position, wie
die Simulation eröffnet. Zusätzlich ist `capitalSharePct` (40/35/25 %) im
gesamten Code nirgends gelesen — das dritte, für den Live-Betrieb gedachte
Kapitalmodell existiert nur als Konfigurationsfeld.

**Fix:** Eine Funktion `positionSizeSol(preset, global)` in `core`, die alle drei
Aufrufer bedient, und eine Entscheidung, was die Bezugsgröße ist.

### 4.3 Kapitalauslastung und Vergleichbarkeit der Presets

Bei `capitalPerPresetSol = 10` und `positionSizePct × maxPositions` ergibt sich:

| Preset | Positionsgröße | max. Positionen | **eingesetztes Kapital** |
|---|---|---|---|
| Konservativ | 0,30 SOL | 4 | 1,2 von 10 SOL (12 %) |
| Balanced | 0,20 SOL | 5 | 1,0 von 10 SOL (10 %) |
| Degen | 0,10 SOL | 5 | 0,5 von 10 SOL (5 %) |

Zwei Folgen. Erstens: 88–95 % des virtuellen Kapitals liegen brach; eine
Rendite-Aussage über das *Portfolio* lässt sich daraus nicht ableiten. Zweitens:
Die Vergleichstabelle (`formatComparison`) rankt nach **absolutem PnL in SOL**.
Konservativ setzt dreimal so viel Kapital je Position ein wie Degen und erscheint
damit bei gleicher prozentualer Güte dreifach so gut. Der im README
beanspruchte „kontrollierte Vergleich" hält für die Marktdaten, aber nicht für
die Kapitalbasis.

**Fix:** Zusätzlich Rendite auf eingesetztes Kapital und Median-PnL je Position
ausweisen; nach einer der beiden Größen sortieren.

### 4.4 Nicht durchgesetzte Risikoparameter

Bestätigt per Suche: `maxOpenPositions`, `killSwitch`, `dailyLossLimitPct`,
`hardLossLimitPct`, `minSolReserve`, `capitalSharePct` und der gesamte
`emergency`-Block werden **ausschließlich angezeigt** (UI, `main.ts`) und von
keiner Logik ausgewertet. Das ist im README korrekt als bekannte Lücke vermerkt.
Der Vollständigkeit halber: Es sind sieben Parameter, nicht ein Bereich, und die
UI suggeriert Wirksamkeit durch Editierbarkeit.

### 4.5 Kleinere Punkte

- **`sourceBonus` vergibt an alle Kandidaten 5 von 10 Punkten**
  (`score.ts:122`), da Fabriq nicht angebunden ist. 10 % des Scores sind eine
  Konstante — sie verschieben nur die Skala gegenüber `minScore`. Entweder
  entfernen und `minScore` um 5 senken, oder durch ein echtes zweites Signal
  ersetzen (Jupiter `organicScore` liegt bereits im Merkmalsvektor).
- **Fee/TVL wird über 24 h gemessen** (`score.ts:31`), was frische Pools
  systematisch benachteiligt. In KONZEPT.md 5.4 benannt, aber noch offen — die
  kürzeren Fenster (`m30`…`h4`) stehen in derselben API-Antwort und werden von
  `volumeRate24hUsd()` bereits genutzt.
- **Positions-Rent (~0,057 SOL) und Bin-Array-Initialisierung (~0,07 SOL,
  nicht erstattet)** fehlen im Kostenmodell. Die Begründung für Rent
  (erstattungsfähig, also gebundenes Kapital) ist richtig — bei einer
  Degen-Position von 0,10 SOL bindet sie allerdings **57 % des Einsatzes**, und
  eine einzige Bin-Array-Initialisierung würde die Position sofort um 70 %
  belasten. Bei diesen Positionsgrößen ist das kein Rundungsfehler.
- **`applyPriceMove` handelt zum Bin-Preis ohne Gebühr** — korrekt für den
  LP-seitigen Wertübergang, aber es fehlt der Effekt, dass der eigene Bestand
  beim Durchlaufen den Swap **erhält** und dabei mitverdient. Im Zusammenspiel
  mit „nur der aktive Bin verdient" unterschätzt das breite Positionen. Für die
  Rangfolge zwischen Presets relevant.

---

## 5. Kann der Bot profitabel sein?

Getrennt nach dem, was gemessen wurde, und dem, was Einschätzung ist.

### Was die Messung sagt

**Mit den heutigen Parametern: nein, und zwar nicht knapp.** Alle drei Presets
liefern in allen geprüften Szenarien negative Erwartung, und 0 von 400
Parametervariationen drehen das. Der Grund ist nicht die Marktlage, sondern die
Konstruktion: unerreichbarer Take-Profit, zu enge Ranges, wirkungsloses EV-Tor,
und eine Auswahl, die auf Volatilität optimiert, obwohl Volatilität den Ertrag
zerstört.

**Nach den Korrekturen aus Abschnitt 6: konditional ja, in einem schmalen
Fenster.** Das Modell findet ein positives Feld bei σ_tag ≈ 20 % **und**
Vol/TVL ≈ 30×, mit +0,5 % je Position und 80 % Trefferquote. Das ist eine
belastbare Größenordnung, aber ein enges Fenster — und die Presets müssen
gezielt dorthin gerichtet werden, statt zufällig hineinzustolpern.

### Was das für die Wirtschaftlichkeit heißt

Selbst im positiven Feld: +0,5 % je Position bei ~24 h Haltedauer und 5
Positionen bedeutet grob 2,5 % pro Tag **auf das eingesetzte Kapital** — bei
10 % Auslastung also 0,25 % auf das Gesamtkapital. Gegen die Fixkosten des
Live-Betriebs (60–130 €/Monat nach KONZEPT.md 15.1, ≈ 0,5–1 SOL) gerechnet,
braucht es bei der eigenen 10-%-Regel des Konzepts rund **5–10 SOL Monatsertrag**,
also bei dieser Rendite ein Arbeitskapital in der Größenordnung von **60–100 SOL**
— mit Positionsgrößen, die dann wieder an `maxPoolShareOfTvlPct` von 0,5–1 %
stoßen und größenabhängige Exit-Slippage auslösen, die das Modell noch gar nicht
kennt.

**Die praktische Untergrenze ist damit nicht die Strategie, sondern die
Positionsgröße.** Bei 15–45 $ je Position fressen Rent-Bindung, Priority Fees und
potenzielle Bin-Array-Initialisierung jede erreichbare Marge. Vor allem anderen
sollte durchgerechnet werden, ab welchem Einsatz eine Position ihre eigenen
On-Chain-Fixkosten überhaupt tragen kann — die Antwort liegt eher bei 2–5 SOL je
Position als bei 0,1.

### Was Einschätzung bleibt

Drei Vorbehalte, die in beide Richtungen wirken können:

1. **Meine Marktannahmen sind gesetzt, nicht gemessen.** σ_tag 40/80/150 % und
   die Drift-Werte sind plausible, aber freie Wahl. Der Datensatz des Projekts
   kann sie ersetzen — das ist genau der Zweck, für den er gebaut wurde. Bis
   dahin sind die absoluten Zahlen Illustration, die **Vorzeichen und
   Größenordnungen** dagegen robust, weil sie aus der Bin-Geometrie folgen.
2. **GBM ist zu freundlich.** Echte Memecoins springen. Ein Sprung durch die
   gesamte Range erzeugt vollen Impermanent Loss bei null Gebührenertrag. Die
   Realität liegt also eher **unter** diesen Ergebnissen als darüber.
3. **Die Gebührenseite kann besser sein, als das Modell rechnet.** Es verdient
   nur der aktive Bin, während real alle durchlaufenen Bins verdienen (bestätigt
   in den Meteora-Docs: *„fees are distributed to eligible liquidity in crossed
   bins"*). Das wirkt gegen die Simulation. Es wird aber überkompensiert von
   `poolLiquidityBins = 70`, das bei konzentrierten Konkurrenz-LPs deutlich zu
   hoch ist. Beide Fehler zu **messen** statt zu schätzen, braucht den
   RPC-Adapter — er ist der wertvollste offene Baustein des Projekts.

### Verdict

> Als Datenerhebungs- und Analysesystem ist das Projekt heute schon wertvoll.
> Als Ertragsquelle ist es in der jetzigen Form nicht tragfähig, und der Grund
> ist reparierbar. Die Reparatur ändert die Erfolgswahrscheinlichkeit, aber nicht
> die Grundlage: LPing auf volatile Solana-Pools ist ein Geschäft mit dünnen,
> vergänglichen Rändern — die eigene Einschätzung in KONZEPT-ML.md 12
> („Nicht zu erwarten: eine dauerhaft überlegene Strategie") ist zutreffend und
> sollte die Kapitalplanung bestimmen.

---

## 6. Verbesserungsvorschläge, nach Wirkung sortiert

### Sofort (verändern das Ergebnis, kosten wenige Stunden)

1. **Take-Profit an der Bin-Geometrie ausrichten.** Die erreichbare Obergrenze
   aus `binRange`, `binStep` und `strategy` berechnen und den Take-Profit als
   Anteil davon setzen (Startwert: 40–60 %). Für `quote_only`-Presets, deren
   Preisgewinn strukturell null ist, muss das Kriterium ein **Gebührenziel** sein,
   kein PnL-Ziel. Zusätzlich eine Schema-Validierung, die einen unerreichbaren
   Take-Profit als Konfigurationsfehler zurückweist — dieser Fehler darf nicht
   still bleiben.
2. **EV-Prüfung des Rebalancings reparieren** (4.1): begrenztes
   Projektionsfenster, Gewichtung mit der beobachteten Zeit in Range, trägstes
   Volumenfenster.
3. **Positionsgröße vereinheitlichen** (4.2) und die Wirtschaftlichkeitsgrenze je
   Position berechnen (Rent-Bindung, Priority Fees, Bin-Array-Initialisierung).
4. **Vergleichstabelle auf Rendite umstellen** (4.3).

### Als Nächstes (richten die Auswahl auf das profitable Feld)

5. **Realisierte Volatilität als erstklassiges Merkmal.** Sie ist aus den bereits
   aufgezeichneten Kerzen (`high`/`low`) direkt berechenbar, ohne neue
   Datenquelle. Einsatz an drei Stellen: als Score-Komponente, als Filter-Band
   (nicht nur Untergrenze — auch eine Obergrenze), und als Treiber der
   Range-Breite.
6. **Range-Breite an die Volatilität koppeln statt fest zu konfigurieren.**
   `binCount ≈ k · σ / binStep` statt `binRange: {min, max}`. Das ersetzt zwei
   geratene Parameter durch einen, der sich herleiten lässt — im Sinne von
   KONZEPT-ML.md 6.1 („manche Parameter werden hergeleitet, nicht optimiert").
7. **Score um das Verhältnis statt des Niveaus ergänzen.** Die entscheidende
   Größe ist Gebührenertrag **je Einheit Varianz**, nicht Fee/TVL allein.
   `sourceBonus` liefert dafür 10 freie Punkte.
8. **`high`/`low` in der Engine nutzen** (KONZEPT-ML.md 5.3, als offen markiert).
   Abschnitt 3.1 zeigt, dass das Raster das Ergebnis um mehrere Prozentpunkte
   verschiebt — solange die Engine nur den Schlusskurs sieht, ist jede
   Optimierung teilweise eine Optimierung des Rasters.

### Vor jedem echten Kapital (unverändert gültig, im README bereits benannt)

9. Risk Manager scharf schalten (4.4) — sieben Parameter, die heute Wirksamkeit
   vortäuschen.
10. RPC-Adapter: ersetzt `poolLiquidityBins` durch eine Messung (Faktor 14 auf
    der Ertragsseite) und liefert zugleich die fehlenden On-Chain-Prüfungen.
11. Größenabhängige Exit-Slippage — der Verlust-Tail ist derzeit zu freundlich.

### Für M3 (Sensitivitätsanalyse)

Die Analyse sollte mit den **Modellannahmen** beginnen, nicht mit den
Strategieparametern — `poolLiquidityBins`, `feeShareHaircutPct`, TVL-Forttragen,
`swapSlippagePct` **und das Abtastraster**. Solange ein Faktor 14 auf der
Ertragsseite unbestimmt ist, misst jede Parametersuche darüber vor allem das
eigene Rauschen.

Ein methodischer Zusatz: Die hier verwendete Monte-Carlo-Prüfung mit
**synthetischen** Pfaden (bekannte σ, bekannte Drift) ist eine sinnvolle Ergänzung
zum Replay auf echten Verläufen. Sie beantwortet eine Frage, die echte Daten
nicht beantworten können: *Bei welcher Volatilität und welchem Umschlag trägt die
Bauform überhaupt?* Der Replay sagt, was passiert **ist**; die synthetische
Prüfung sagt, wonach zu suchen **wäre**. Die Skripte dieser Analyse lassen sich
dafür als `pnpm --filter @lping/bot stress` verstetigen.

---

## 7. Reproduktion

Alle Zahlen stammen aus drei Skripten, die ausschließlich die exportierten
Funktionen des Repos aufrufen (`openPaperPosition`, `tickPaperPosition`,
`closePaperPosition`, `openBins`, `totalsOf`, `applyPriceMove`) und die echten
Preset-Dateien über `loadDefaultsFromDir("config")` laden. Deterministischer RNG
(Mulberry32, feste Seeds), daher exakt wiederholbar. Testlauf des Repos zum
Analysezeitpunkt: **324 Tests, 28 Dateien, alle grün**.
