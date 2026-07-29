# Fabriq-Spike: Endpoint finden und verifizieren

Fabriq (fabriq.trade) hat keine dokumentierte öffentliche API. Der Adapter in
diesem Ordner ist ein **Spike**: lauffähig und defensiv gebaut, aber mit
Platzhalter-Endpoint. Diese Anleitung zeigt Schritt für Schritt, wie du den
echten Endpoint findest — auch ohne Vorkenntnisse.

**Wichtig vorab:** Das ist kein Blocker. Solange der Endpoint fehlt, nutzt die
Discovery die eigene Preset-Replikation aus Meteora-API + DexScreener
(KONZEPT.md Abschnitt 4.1, Weg 2). Fabriq ist eine Verbesserung, keine
Voraussetzung.

## Schritt 1: Endpoint im Browser finden

Am einfachsten mit Chrome, Edge oder Firefox am Desktop:

1. **https://fabriq.trade/trending** öffnen.
2. **Entwicklertools öffnen:** Taste `F12`
   (Mac: `Cmd` + `Option` + `I`; alternativ Rechtsklick auf die Seite →
   „Untersuchen" / „Inspect").
3. Oben im Entwicklertools-Fenster auf den Tab **„Network"** (deutsch: „Netzwerk")
   klicken.
4. Darunter erscheint eine Filterleiste — dort **„Fetch/XHR"** anklicken. Das
   blendet Bilder, Skripte und CSS aus, sodass nur noch Datenabfragen übrig bleiben.
5. Die Seite **neu laden** (`F5` bzw. `Cmd` + `R`). Jetzt füllt sich die Liste.
6. Nacheinander die Reiter **„Degen"** und **„Multiday"** auf der Fabriq-Seite
   anklicken und beobachten, welche neuen Einträge dazukommen — das sind die
   interessanten.

### Den richtigen Eintrag erkennen

Klicke die Einträge nacheinander an und schau in den Tab **„Preview"** oder
**„Response"** (rechts bzw. unterhalb). Gesucht ist die Antwort, in der die
Pools stehen — erkennbar an langen Zeichenketten wie
`BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y` (Solana-Adressen) sowie an Feldern
wie `score`, `tvl` oder `volume`.

Tipps:
- Die Pool-Liste ist meist einer der **größten** Einträge — du kannst die Liste
  per Klick auf die Spalte „Size"/„Größe" sortieren.
- „Preview" ist lesbarer als „Response", weil es das JSON aufklappbar darstellt.

### Die URL kopieren

Hast du den richtigen Eintrag gefunden: Tab **„Headers"** öffnen, ganz oben steht
**„Request URL"**. Diese Zeile komplett kopieren (Rechtsklick → Kopieren).

Beispiel, wie so etwas aussehen kann:
`https://api.fabriq.trade/v1/pools/trending?type=degen&limit=50`

## Schritt 2: URL prüfen

Im Projektordner ausführen (URL in Anführungszeichen!):

```bash
pnpm --filter @lping/bot fabriq:check "https://…die…kopierte…URL…"
```

Das Kommando sagt dir direkt, ob es passt:

- **`✓ N Pools erkannt`** → perfekt. Darunter stehen die fertigen Zeilen für
  deine `.env` — einfach übernehmen.
- **`✗ Antwort ist kein JSON`** → es war der falsche Eintrag, zurück zu Schritt 1.
- **`✗ keine Pools erkannt`** → Endpoint stimmt, aber die Struktur ist anders als
  erwartet. Die Ausgabe (plus ein paar Zeilen aus „Preview") reicht, um den
  Parser anzupassen.
- **`HTTP 401/403`** → der Endpoint verlangt zusätzliche Header. Dann im Tab
  „Headers" unter **„Request Headers"** nachsehen, welche (siehe Warnung unten).

## Schritt 3: Eintragen

Die vom Prüf-Kommando ausgegebenen Zeilen in die `.env` im Projekt-Hauptordner
schreiben:

```
FABRIQ_API_BASE=https://api.fabriq.trade
FABRIQ_TRENDING_PATH=/v1/pools/trending
```

Wichtig ist außerdem der **Query-Parameter für die Kategorie**: Der Adapter hängt
derzeit `?category=degen` bzw. `?category=multiday` an. Heißt der Parameter bei
Fabriq anders (z. B. `?type=degen` oder `?tab=multiday`), muss
`packages/adapters/src/fabriq/index.ts` entsprechend angepasst werden. Vergleiche
dazu die URLs beider Reiter.

## ⚠ Sicherheitshinweis zum Teilen

Die Entwicklertools bieten „Copy as cURL" an — praktisch, aber die Ausgabe
enthält oft **Cookies und Zugangstoken** deiner Browser-Sitzung. Solche Werte
sind wie Passwörter:

- Zeilen mit `cookie:`, `authorization:` oder `x-…-token:` vor dem Weitergeben
  **entfernen oder durch `…` ersetzen**.
- Nicht in die `.env` schreiben und nicht committen.
- Im Zweifel nur die reine **Request URL** teilen — die reicht für den Anfang.

## Schritt 4: Akzeptanzkriterien (Spike → produktiv)

- [ ] Endpoint liefert über ≥ 7 Tage stabil parsebare Antworten (Health-Log).
- [ ] Kategorien Degen/Multiday sind eindeutig abbildbar (Parameter oder
      getrennte Endpoints), nicht nur geraten.
- [ ] Nutzungsbedingungen/robots.txt von Fabriq geprüft und unkritisch.
- [ ] Schema-Drift-Alarm getestet (Parser meldet `schema_drift`, statt Müll zu liefern).

## Rahmenbedingungen

- Rate-Limit im Adapter: max. 1 Request / 30 s — nicht erhöhen.
- Der User-Agent kennzeichnet den Bot ehrlich; nicht verschleiern.
- Die Discovery darf nie hart von Fabriq abhängen: Bei `unavailable` oder
  `schema_drift` übernimmt die eigene Replikation. Der Adapter signalisiert das
  über seinen Status, statt Exceptions zu werfen.
