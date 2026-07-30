import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  PaperCloseReason,
  PaperPositionState,
  PaperValuation,
  PresetKind,
  PresetPerformance,
} from "@lping/core";

export interface OpenPaperPositionRecord {
  poolAddress: string;
  preset: PresetKind;
  strategyType: string;
  sided: string;
  mintX: string;
  mintY: string;
  binStep: number;
  state: PaperPositionState;
  openedAt: Date;
}

export interface TickPaperPositionRecord {
  positionId: string;
  state: PaperPositionState;
  valuation: PaperValuation;
}

export interface ClosePaperPositionRecord extends TickPaperPositionRecord {
  reason: PaperCloseReason;
  realizedPnlSol: number;
  closedAt: Date;
}

/** Eine offene Paper-Position samt deserialisiertem Simulationszustand. */
export interface OpenPaperPosition {
  id: string;
  poolAddress: string;
  preset: string;
  simState: PaperPositionState;
}

/**
 * Persistenz der Paper-Positionen (KONZEPT.md Abschnitt 13, Phase 1).
 * Nutzt die reguläre positions-Tabelle mit `paper = true`, damit Live-Betrieb
 * später denselben Codepfad und dieselbe Auswertung verwendet.
 */
export class PaperRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async open(record: OpenPaperPositionRecord): Promise<string> {
    const row = await this.prisma.position.create({
      data: {
        poolAddress: record.poolAddress,
        preset: record.preset,
        state: "ACTIVE",
        strategyType: record.strategyType,
        sided: record.sided,
        minBinId: record.state.minBinId,
        maxBinId: record.state.maxBinId,
        binStep: record.binStep,
        mintX: record.mintX,
        mintY: record.mintY,
        depositSol: record.state.depositSol,
        currentValueSol: record.state.depositSol,
        costsSol: record.state.costsSol,
        entryPrice: record.state.entryPrice,
        lastPrice: record.state.lastPrice,
        simState: asJson(record.state),
        paper: true,
        openedAt: record.openedAt,
      },
      select: { id: true },
    });

    await this.prisma.positionEvent.create({
      data: {
        positionId: row.id,
        fromState: "OPENING",
        toState: "ACTIVE",
        trigger: "tx_confirmed",
        context: { paper: true, depositSol: record.state.depositSol },
      },
    });
    return row.id;
  }

  async tick(record: TickPaperPositionRecord): Promise<void> {
    await this.prisma.position.update({
      where: { id: record.positionId },
      data: valuationData(record.state, record.valuation),
    });
  }

  async close(record: ClosePaperPositionRecord): Promise<void> {
    await this.prisma.position.update({
      where: { id: record.positionId },
      data: {
        ...valuationData(record.state, record.valuation),
        state: "CLOSED",
        realizedPnlSol: record.realizedPnlSol,
        closeReason: record.reason,
        closedAt: record.closedAt,
      },
    });
    await this.prisma.positionEvent.create({
      data: {
        positionId: record.positionId,
        fromState: "CLOSING",
        toState: "CLOSED",
        trigger: record.reason,
        context: { realizedPnlSol: record.realizedPnlSol },
      },
    });
  }

  async listOpen(preset?: PresetKind): Promise<OpenPaperPosition[]> {
    const rows = await this.prisma.position.findMany({
      where: {
        paper: true,
        state: { in: ["ACTIVE", "REBALANCING"] },
        ...(preset !== undefined ? { preset } : {}),
      },
      select: { id: true, poolAddress: true, preset: true, simState: true },
    });
    return rows
      .filter((row) => row.simState !== null)
      .map((row) => ({
        id: row.id,
        poolAddress: row.poolAddress,
        preset: row.preset,
        simState: row.simState as unknown as PaperPositionState,
      }));
  }

  async countOpen(preset: PresetKind): Promise<number> {
    return this.prisma.position.count({
      where: { paper: true, preset, state: { in: ["ACTIVE", "REBALANCING"] } },
    });
  }

  /** Ist für diesen Pool bereits eine Paper-Position des Presets offen? */
  async hasOpenFor(preset: PresetKind, poolAddress: string): Promise<boolean> {
    const count = await this.prisma.position.count({
      where: { paper: true, preset, poolAddress, state: { in: ["ACTIVE", "REBALANCING"] } },
    });
    return count > 0;
  }

  /** Auswertung je Preset für den Vergleich (Dashboard und CLI). */
  async performance(labels: Record<string, string> = {}): Promise<PresetPerformance[]> {
    const rows = await this.prisma.position.findMany({
      where: { paper: true },
      select: {
        preset: true,
        state: true,
        depositSol: true,
        currentValueSol: true,
        realizedPnlSol: true,
        feesEarnedSol: true,
        costsSol: true,
        hodlValueSol: true,
        timeInRangePct: true,
      },
    });

    const byPreset = new Map<string, PresetPerformance & { timeInRangeSum: number; timeInRangeCount: number }>();
    for (const row of rows) {
      const entry =
        byPreset.get(row.preset) ??
        {
          preset: row.preset,
          label: labels[row.preset] ?? row.preset,
          openPositions: 0,
          closedPositions: 0,
          realizedPnlSol: 0,
          unrealizedPnlSol: 0,
          totalPnlSol: 0,
          depositedSol: 0,
          feesEarnedSol: 0,
          costsSol: 0,
          wins: 0,
          losses: 0,
          winRatePct: null,
          avgTimeInRangePct: null,
          vsHodlSol: 0,
          timeInRangeSum: 0,
          timeInRangeCount: 0,
        };

      const closed = row.state === "CLOSED";
      const realized = Number(row.realizedPnlSol);
      const value = row.currentValueSol === null ? null : Number(row.currentValueSol);
      const deposit = Number(row.depositSol);

      entry.depositedSol += deposit;
      entry.feesEarnedSol += Number(row.feesEarnedSol);
      entry.costsSol += Number(row.costsSol);
      if (row.hodlValueSol !== null && value !== null) {
        entry.vsHodlSol += value - Number(row.hodlValueSol);
      }
      if (row.timeInRangePct !== null) {
        entry.timeInRangeSum += Number(row.timeInRangePct);
        entry.timeInRangeCount += 1;
      }

      if (closed) {
        entry.closedPositions += 1;
        entry.realizedPnlSol += realized;
        if (realized > 0) entry.wins += 1;
        else entry.losses += 1;
      } else {
        entry.openPositions += 1;
        if (value !== null) entry.unrealizedPnlSol += value - deposit;
      }
      byPreset.set(row.preset, entry);
    }

    return [...byPreset.values()].map((entry) => {
      const decided = entry.wins + entry.losses;
      const { timeInRangeSum, timeInRangeCount, ...rest } = entry;
      return {
        ...rest,
        totalPnlSol: entry.realizedPnlSol + entry.unrealizedPnlSol,
        winRatePct: decided > 0 ? (entry.wins / decided) * 100 : null,
        avgTimeInRangePct: timeInRangeCount > 0 ? timeInRangeSum / timeInRangeCount : null,
      };
    });
  }
}

function valuationData(
  state: PaperPositionState,
  valuation: PaperValuation,
): Prisma.PositionUncheckedUpdateInput {
  return {
    currentValueSol: valuation.totalValueSol,
    feesEarnedSol: state.feesClaimedSol + state.feesUnclaimedSol,
    costsSol: state.costsSol,
    hodlValueSol: valuation.hodlValueSol,
    timeInRangePct: valuation.timeInRangePct,
    lastPrice: state.lastPrice,
    minBinId: state.minBinId,
    maxBinId: state.maxBinId,
    simState: asJson(state),
  };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
