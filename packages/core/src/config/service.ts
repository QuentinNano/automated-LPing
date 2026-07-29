import { BotConfigSchema, type BotConfig, parseBotConfig } from "./schema";
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

  /**
   * Lädt die letzte Version oder seedet die Defaults als Version 1.
   *
   * Passt eine gespeicherte Version nicht mehr zum aktuellen Schema (neue
   * Pflichtfelder, entfernte Presets), wird sie einmalig migriert statt
   * abgelehnt: Defaults liefern die neuen Felder, die gespeicherten Werte
   * überschreiben sie, wo sie weiterhin gelten. Ohne das würde jede
   * Schema-Erweiterung den Bot mit einer unbrauchbaren Config stehen lassen.
   */
  static async init(store: ConfigStore, defaults: unknown): Promise<ConfigService> {
    const validatedDefaults = parseBotConfig(defaults);
    const latest = await store.latest();

    if (latest !== null) {
      const parsed = BotConfigSchema.safeParse(latest.config);
      if (parsed.success) return new ConfigService(store, latest);

      const migrated = await migrateStored(store, latest, validatedDefaults);
      return new ConfigService(store, migrated);
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

/**
 * Hebt eine veraltete gespeicherte Config auf das aktuelle Schema.
 *
 * Regeln:
 * - Globale Einstellungen: gespeicherte Werte gewinnen, neue Pflichtfelder
 *   kommen aus den Defaults.
 * - Presets: die Konfigurationsdateien bestimmen, welche Presets **existieren**;
 *   die Datenbank steuert nur deren Feinjustierung bei. Presets, die es nicht
 *   mehr gibt, verschwinden — ihre Werte würden sonst als unvollständige
 *   Fragmente wiederauferstehen.
 *
 * Ergibt die Zusammenführung eine widersprüchliche Konfiguration (etwa weil
 * alte Kapitalanteile nicht mehr zur neuen Preset-Aufteilung passen), wird auf
 * die Defaults zurückgefallen. Getunte Werte gehen dabei verloren — aber ein
 * Schema-Wechsel darf den Bot niemals startunfähig machen. Beide Fälle landen
 * mit Begründung in der Versionshistorie und sind damit nachvollziehbar.
 */
async function migrateStored(
  store: ConfigStore,
  stored: StoredConfig,
  defaults: BotConfig,
): Promise<StoredConfig> {
  const rawRecord = isRecord(stored.config) ? (stored.config as Record<string, unknown>) : {};
  const storedPresets = isRecord(rawRecord["presets"]) ? rawRecord["presets"] : {};

  const keptPresets: Record<string, unknown> = {};
  for (const id of Object.keys(defaults.presets)) {
    if (storedPresets[id] !== undefined) keptPresets[id] = storedPresets[id];
  }

  const merged = deepMerge(defaults, { global: rawRecord["global"], presets: keptPresets });
  const parsed = BotConfigSchema.safeParse(merged);

  if (parsed.success) {
    return store.append({
      config: parsed.data,
      actor: "system",
      reason: `Schema-Migration von Version ${stored.version}`,
    });
  }

  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return store.append({
    config: defaults,
    actor: "system",
    reason:
      `Schema-Migration von Version ${stored.version}: gespeicherte Werte waren nicht ` +
      `übernehmbar, Defaults wiederhergestellt (${issues})`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
