-- CreateTable
CREATE TABLE "tracked_pools" (
    "pool_address" TEXT NOT NULL,
    "token_mint" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "track_until" TIMESTAMP(3) NOT NULL,
    "last_tracked_at" TIMESTAMP(3),
    "point_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tracked_pools_pkey" PRIMARY KEY ("pool_address")
);

-- CreateTable
CREATE TABLE "candidate_features" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "token_mint" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "feature_version" INTEGER NOT NULL,
    "features" JSONB NOT NULL,
    "score" DECIMAL(6,2),
    "verdict" TEXT NOT NULL,
    "rejected_by" TEXT,

    CONSTRAINT "candidate_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_outcomes" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "horizon_hours" INTEGER NOT NULL,
    "price_change_pct" DECIMAL(14,4),
    "tvl_change_pct" DECIMAL(14,4),
    "fee_yield_pct" DECIMAL(14,4),
    "max_drawdown_pct" DECIMAL(14,4),
    "rugged" BOOLEAN NOT NULL DEFAULT false,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "covered_hours" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracked_pools_active_last_tracked_at_idx" ON "tracked_pools"("active", "last_tracked_at");

-- CreateIndex
CREATE INDEX "candidate_features_pool_address_captured_at_idx" ON "candidate_features"("pool_address", "captured_at");

-- CreateIndex
CREATE INDEX "candidate_features_captured_at_idx" ON "candidate_features"("captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_outcomes_feature_id_horizon_hours_key" ON "candidate_outcomes"("feature_id", "horizon_hours");

-- AddForeignKey
ALTER TABLE "candidate_outcomes" ADD CONSTRAINT "candidate_outcomes_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "candidate_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

