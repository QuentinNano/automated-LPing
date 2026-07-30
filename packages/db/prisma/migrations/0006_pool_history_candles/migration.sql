-- CreateTable
CREATE TABLE "pool_history_candles" (
    "pool_address" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open" DECIMAL(30,15),
    "high" DECIMAL(30,15),
    "low" DECIMAL(30,15),
    "close" DECIMAL(30,15),
    "volume_usd" DECIMAL(20,2),
    "fees_usd" DECIMAL(20,2),
    "protocol_fees_usd" DECIMAL(20,2),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pool_history_candles_pkey" PRIMARY KEY ("pool_address","timeframe","ts")
);

-- CreateIndex
CREATE INDEX "pool_history_candles_pool_address_ts_idx" ON "pool_history_candles"("pool_address", "ts");
