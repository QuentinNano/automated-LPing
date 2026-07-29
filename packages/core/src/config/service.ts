import { type BotConfig, parseBotConfig } from "./schema";
import { deepMerge } from "./merge";

/** Eine persistierte Konfigurationsversion (append-only Historie). */
export interface StoredConfig {
  version: number;
  config: BotConfig;
  actor: string;
  reason?: string;
  createdAt: Date;
}

export interface AppendConfigInput {
  config: BotConfig;
  actor: string;
  reason?: string;
}

/**
 * Persistenz-Port für Konfigurationsversionen. Implementierungen:
 * - MemoryConfigStore (Tests, Paper-Läufe ohne DB)
 * - PrismaConfigStore in @lping/db (config_versions-Tabelle)
 */
export interface ConfigStore {
  latest(): Promise<StoredConfig | null>;
  append(entry: AppendConfigInput): Promise<StoredConfig>;
  history(limit?: number): Promise<StoredConfig[]>;
}

export class MemoryConfigStore implements ConfigStore {
  private readonly entries: StoredConfig[] = [];

  async latest(): Promise<StoredConfig | null> {
    return this.entries.at(-1) ?? null;
  }

  async append(entry: AppendConfigInput): Promise<StoredConfig> {
    const stored: StoredConfig = {
      version: (this.entries.at(-1)?.version ?? 0) + 1,
      config: entry.config,
      actor: entry.actor,
      createdAt: new Date(),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
    this.entries.push(stored);
    return stored;
  }

  async history(limit = 20): Promise<StoredConfig[]> {
    return this.entries.slice(-limit).reverse();
  }
}

export type ConfigChangeListener = (next: StoredConfig, prev: StoredConfig) => void;

/**
 * Hält die aktuell gültige, validierte Konfiguration im Speicher, persistiert
 * jede Änderung als neue Version und benachrichtigt Subscriber (Hot-Reload).
 */
export class ConfigService {
  private current: StoredConfig;
  private readonly listeners = new Set<ConfigChangeListener>();

  private constructor(
    private readonly store: ConfigStore,
    initial: StoredConfig,
  ) {
    this.current = initial;
  }

  /** Lädt die letzte Version oder seedet die Defaults als Version 1. */
  static async init(store: ConfigStore, defaults: unknown): Promise<ConfigService> {
    const validatedDefaults = parseBotConfig(defaults);
    const latest = await store.latest();
    if (latest !== null) {
      // Persistierte Config erneut validieren: Schema kann sich seit dem
      // Speichern verschärft haben; ein Bot darf nie mit ungültiger Config laufen.
      parseBotConfig(latest.config);
      return new ConfigService(store, latest);
    }
    const seeded = await store.append({
      config: validatedDefaults,
      actor: "system",
      reason: "initial defaults",
    });
    return new ConfigService(store, seeded);
  }

  get config(): BotConfig {
    return this.current.config;
  }

  get version(): number {
    return this.current.version;
  }

  /**
   * Wendet einen partiellen Patch an. Validiert das Gesamtergebnis; bei
   * Ablehnung bleibt die bisherige Version unverändert gültig.
   */
  async update(patch: unknown, meta: { actor: string; reason?: string }): Promise<StoredConfig> {
    const merged = deepMerge(this.current.config, patch);
    const validated = parseBotConfig(merged);
    const stored = await this.store.append({
      config: validated,
      actor: meta.actor,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
    });
    const prev = this.current;
    this.current = stored;
    for (const listener of this.listeners) listener(stored, prev);
    return stored;
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async history(limit?: number): Promise<StoredConfig[]> {
    return this.store.history(limit);
  }
}
