-- Marktregime-Urteil je Scan-Durchgang.
--
-- Die Aufzeichnung läuft unabhängig davon, ob das Tor blockiert: Erst diese
-- Reihe zeigt, ob "ungünstig" tatsächlich schlechtere Ergebnisse vorhersagt.
-- Ohne sie wäre das Tor eine Behauptung.
CREATE TABLE "regime_snapshots" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "median_yield_per_variance" DECIMAL(18,6),
    "sampled" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "blocked_opening" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "regime_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "regime_snapshots_ts_idx" ON "regime_snapshots"("ts");
