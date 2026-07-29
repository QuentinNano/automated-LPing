# Fabriq-Spike: Endpoint-Verifikation

Fabriq (fabriq.trade) hat keine dokumentierte öffentliche API. Der Adapter in
diesem Ordner ist ein **Spike**: lauffähig, defensiv, aber mit Platzhalter-
Endpoint. Bevor Fabriq als primäre Discovery-Quelle gilt, sind folgende
Schritte nötig (KONZEPT.md Abschnitt 4.1 und 16):

## 1. Endpoint identifizieren

1. https://fabriq.trade/trending im Browser öffnen, DevTools → Network → Fetch/XHR.
2. Tabs **Degen** und **Multiday** anklicken und die JSON-Requests notieren:
   - vollständige URL + Query-Parameter (Kategorie? Zeitfenster? Pagination?)
   - benötigte Header (Origin/Referer? Auth-Token? Cookies?)
   - Response-Struktur (Pfad zum Pool-Array, Feldnamen für Adresse/Score)
3. Werte eintragen in `.env`:
   - `FABRIQ_API_BASE` (z. B. `https://api.fabriq.trade`)
   - `FABRIQ_TRENDING_PATH` (z. B. `/v1/pools/trending`)
4. Passt die Struktur nicht zur Heuristik in `extractFabriqPools`, den Parser
   um ein explizites zod-Schema ergänzen (Heuristik bleibt als Fallback).

## 2. Rahmenbedingungen prüfen

- **ToS/robots.txt von Fabriq prüfen**, bevor der Adapter produktiv pollt.
- Rate-Limit im Adapter: max. 1 Request / 30 s (nicht erhöhen).
- User-Agent kennzeichnet den Bot; nicht verschleiern.

## 3. Akzeptanzkriterien (Spike → produktiv)

- [ ] Endpoint liefert über >= 7 Tage stabil parsebare Antworten (Health-Log).
- [ ] Kategorien Degen/Multiday sind eindeutig abbildbar (Parameter oder
      getrennte Endpoints), nicht nur geraten.
- [ ] ToS-Prüfung dokumentiert und unkritisch.
- [ ] Schema-Drift-Alarm getestet (Parser meldet `schema_drift` statt Müll zu liefern).

## Fallback ist Pflicht, kein Nice-to-have

Die Discovery darf nie hart von Fabriq abhängen: Bei `unavailable` oder
`schema_drift` übernimmt die eigene Preset-Replikation auf Basis der
Meteora-API + DexScreener (KONZEPT.md Abschnitt 4.1, Weg 2). Der Adapter
signalisiert das über seinen Status statt Exceptions zu werfen.
