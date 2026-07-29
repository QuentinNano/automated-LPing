import type { Prisma, PrismaClient } from "@prisma/client";
import type { BotConfig, AppendConfigInput, ConfigStore, StoredConfig } from "@lping/core";

/**
 * ConfigStore-Implementierung auf der config_versions-Tabelle.
 * `version` ist autoincrement — konkurrierende Appends erhalten disjunkte
 * Versionen; es gilt Last-Writer-Wins über die höchste Version.
 */
export class PrismaConfigStore implements ConfigStore {
  constructor(private readonly prisma: PrismaClient) {}

  async latest(): Promise<StoredConfig | null> {
    const row = await this.prisma.configVersion.findFirst({ orderBy: { version: "desc" } });
    return row === null ? null : toStored(row);
  }

  async append(entry: AppendConfigInput): Promise<StoredConfig> {
    const row = await this.prisma.configVersion.create({
      data: {
        config: entry.config as unknown as Prisma.InputJsonValue,
        actor: entry.actor,
        reason: entry.reason ?? null,
      },
    });
    return toStored(row);
  }

  async history(limit = 20): Promise<StoredConfig[]> {
    const rows = await this.prisma.configVersion.findMany({
      orderBy: { version: "desc" },
      take: limit,
    });
    return rows.map(toStored);
  }
}

function toStored(row: {
  version: number;
  config: Prisma.JsonValue;
  actor: string;
  reason: string | null;
  createdAt: Date;
}): StoredConfig {
  return {
    version: row.version,
    // Bewusst ohne Validierung: der ConfigService ist die einzige Instanz, die
    // Configs prüft — und er kann veraltete Stände migrieren statt sie
    // abzulehnen. Würde der Store hier werfen, käme die Migration nie zum Zug.
    config: row.config as unknown as BotConfig,
    actor: row.actor,
    createdAt: row.createdAt,
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}
