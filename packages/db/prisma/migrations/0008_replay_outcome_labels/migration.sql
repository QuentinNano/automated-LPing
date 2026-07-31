-- Ergebnis-Labels aus der Simulation statt aus einer Pool-Kennzahl.
--
-- `fee_yield_pct` misst den Ertrag eines POOLS: Gebühren je TVL, über den
-- Horizont integriert — ohne Range, ohne Zeit außerhalb, ohne Impermanent Loss,
-- ohne Kosten. Ein Auswahlmodell darauf trainiert lernt "welcher Pool hat viel
-- Umschlag", nicht "welcher Pool trägt eine Position".
--
-- Die beiden neuen Spalten messen eine Standardposition durch dieselbe Engine,
-- die auch handelt. `fee_yield_pct` bleibt daneben stehen: Es ist billig, es
-- braucht keine Pool-Stammdaten und beantwortet eine andere, ebenfalls
-- sinnvolle Frage.
--
-- NULL heißt durchgehend "nicht simulierbar" (keine Stammdaten, zu wenige
-- Beobachtungen) — nicht "null Ertrag".
ALTER TABLE "candidate_outcomes"
  ADD COLUMN "replay_pnl_pct" DECIMAL(14,4),
  ADD COLUMN "replay_vs_hodl_pct" DECIMAL(14,4),
  -- Rechtszensiert: am Ende der Daten abgeschnitten statt am Horizont. Solche
  -- Labels messen einen kürzeren Zeitraum, als sie behaupten.
  ADD COLUMN "replay_censored" BOOLEAN NOT NULL DEFAULT FALSE;
