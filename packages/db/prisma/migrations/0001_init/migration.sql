-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('FABRIQ_DEGEN', 'FABRIQ_MULTIDAY', 'REPLICATED_DEGEN', 'REPLICATED_MULTIDAY');

-- CreateEnum
CREATE TYPE "PresetKind" AS ENUM ('DEGEN', 'MULTIDAY');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('DISCOVERED', 'REJECTED', 'QUEUED', 'OPENING', 'ACTIVE', 'REBALANCING', 'CLOSING', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "TxKind" AS ENUM ('OPEN', 'ADD_LIQUIDITY', 'CLAIM', 'REBALANCE', 'REMOVE_LIQUIDITY', 'CLOSE', 'SWAP', 'SWEEP');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BlacklistKind" AS ENUM ('MINT', 'DEPLOYER', 'POOL');

-- CreateTable
CREATE TABLE "pool_candidates" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "source" "CandidateSource" NOT NULL,
    "preset" "PresetKind" NOT NULL,
    "status" "LifecycleState" NOT NULL DEFAULT 'DISCOVERED',
    "score" DECIMAL(6,2),
    "raw_metrics" JSONB NOT NULL,
    "filter_result" JSONB,
    "rejection_reason" TEXT,
    "shadow_until" TIMESTAMP(3),
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT,
    "pool_address" TEXT NOT NULL,
    "position_pubkey" TEXT,
    "preset" "PresetKind" NOT NULL,
    "state" "LifecycleState" NOT NULL DEFAULT 'OPENING',
    "strategy_type" TEXT NOT NULL,
    "sided" TEXT NOT NULL,
    "min_bin_id" INTEGER,
    "max_bin_id" INTEGER,
    "mint_x" TEXT NOT NULL,
    "mint_y" TEXT NOT NULL,
    "deposit_sol" DECIMAL(20,9) NOT NULL,
    "current_value_sol" DECIMAL(20,9),
    "realized_pnl_sol" DECIMAL(20,9) NOT NULL DEFAULT 0,
    "fees_earned_sol" DECIMAL(20,9) NOT NULL DEFAULT 0,
    "paper" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_events" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "from_state" "LifecycleState",
    "to_state" "LifecycleState" NOT NULL,
    "trigger" TEXT NOT NULL,
    "context" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "position_id" TEXT,
    "signature" TEXT,
    "kind" "TxKind" NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "priority_fee_lamports" BIGINT,
    "fee_lamports" BIGINT,
    "slot" BIGINT,
    "error" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_claims" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "claim_transaction_id" TEXT,
    "amount_x_raw" TEXT NOT NULL,
    "amount_y_raw" TEXT NOT NULL,
    "value_sol_at_claim" DECIMAL(20,9) NOT NULL,
    "converted_sol" DECIMAL(20,9),
    "conversion_transaction_id" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_snapshots" (
    "id" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tvl_usd" DECIMAL(20,2),
    "volume_24h_usd" DECIMAL(20,2),
    "fees_24h_usd" DECIMAL(20,2),
    "fee_tvl_24h_pct" DECIMAL(10,4),
    "price_native" DECIMAL(30,15),
    "bin_step" INTEGER,
    "extra" JSONB,

    CONSTRAINT "pool_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_versions" (
    "version" SERIAL NOT NULL,
    "config" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_versions_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "blacklist" (
    "id" TEXT NOT NULL,
    "kind" "BlacklistKind" NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pool_candidates_pool_address_idx" ON "pool_candidates"("pool_address");

-- CreateIndex
CREATE INDEX "pool_candidates_status_discovered_at_idx" ON "pool_candidates"("status", "discovered_at");

-- CreateIndex
CREATE UNIQUE INDEX "positions_position_pubkey_key" ON "positions"("position_pubkey");

-- CreateIndex
CREATE INDEX "positions_state_idx" ON "positions"("state");

-- CreateIndex
CREATE INDEX "positions_pool_address_idx" ON "positions"("pool_address");

-- CreateIndex
CREATE INDEX "position_events_position_id_created_at_idx" ON "position_events"("position_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_signature_key" ON "transactions"("signature");

-- CreateIndex
CREATE INDEX "transactions_position_id_idx" ON "transactions"("position_id");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "fee_claims_position_id_idx" ON "fee_claims"("position_id");

-- CreateIndex
CREATE INDEX "pool_snapshots_pool_address_ts_idx" ON "pool_snapshots"("pool_address", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_kind_address_key" ON "blacklist"("kind", "address");

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "pool_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_events" ADD CONSTRAINT "position_events_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_claims" ADD CONSTRAINT "fee_claims_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

