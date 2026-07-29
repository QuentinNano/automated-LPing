-- Frei benennbare Presets + Paper-Trading-Felder.
--
-- Bewusst als verlustfreie Konvertierung geschrieben (statt DROP/ADD COLUMN,
-- wie es der Schema-Diff vorschlägt): bestehende Kandidaten und Positionen
-- behalten ihre Preset-Zuordnung, damit historische Auswertungen gültig bleiben.

-- CandidateSource: Preset-Anteil aus dem Enum entfernen (das Preset steht in
-- einer eigenen Spalte). FABRIQ_* -> FABRIQ, REPLICATED_* -> REPLICATED.
BEGIN;
CREATE TYPE "CandidateSource_new" AS ENUM ('FABRIQ', 'REPLICATED');

ALTER TABLE "pool_candidates"
  ALTER COLUMN "source" TYPE "CandidateSource_new"
  USING (
    CASE
      WHEN "source"::text LIKE 'FABRIQ%' THEN 'FABRIQ'
      ELSE 'REPLICATED'
    END
  )::"CandidateSource_new";

ALTER TYPE "CandidateSource" RENAME TO "CandidateSource_old";
ALTER TYPE "CandidateSource_new" RENAME TO "CandidateSource";
DROP TYPE "public"."CandidateSource_old";
COMMIT;

-- Preset: Enum -> TEXT. Alte Werte (DEGEN/MULTIDAY) werden zu den
-- kleingeschriebenen IDs, die die Konfiguration verwendet.
ALTER TABLE "pool_candidates"
  ALTER COLUMN "preset" TYPE TEXT USING lower("preset"::text);

ALTER TABLE "positions"
  ALTER COLUMN "preset" TYPE TEXT USING lower("preset"::text);

DROP TYPE "PresetKind";

-- Paper-Trading-Felder auf positions.
ALTER TABLE "positions"
  ADD COLUMN "bin_step" INTEGER,
  ADD COLUMN "close_reason" TEXT,
  ADD COLUMN "costs_sol" DECIMAL(20,9) NOT NULL DEFAULT 0,
  ADD COLUMN "entry_price" DECIMAL(30,15),
  ADD COLUMN "hodl_value_sol" DECIMAL(20,9),
  ADD COLUMN "last_price" DECIMAL(30,15),
  ADD COLUMN "sim_state" JSONB,
  ADD COLUMN "time_in_range_pct" DECIMAL(6,2);

-- CreateIndex
CREATE INDEX "positions_preset_state_idx" ON "positions"("preset", "state");
