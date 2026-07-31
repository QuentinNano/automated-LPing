/**
 * Konfidenzintervalle für Replay-Kennzahlen (KONZEPT-ML.md 6.4, 7.3).
 *
 * **Warum ein Punktschätzer hier nicht reicht.** `replayEntries` erzeugt per
 * Konstruktion **überlappende** Positionen: Bei einem Einstiegsabstand von 30
 * Minuten und einer Haltedauer von 96 Stunden sehen bis zu 192 aufeinander
 * folgende Positionen fast dieselbe Preisbewegung. Eine Trefferquote über 500
 * solcher Positionen sieht aus wie n = 500 und trägt die Information von
 * vielleicht einem Dutzend unabhängiger Beobachtungen. Wer sie ohne Streumaß
 * berichtet, berichtet eine Genauigkeit, die die Daten nicht hergeben — und die
 * Parametersuche aus KONZEPT-ML.md 6.2 findet dann garantiert einen Gewinner,
 * der Rauschen ist.
 *
 * **Warum nach Pool gebündelt und nicht nach Position.** Ein gewöhnlicher
 * Bootstrap zieht einzelne Beobachtungen und unterstellt damit, sie seien
 * unabhängig. Genau das sind sie nicht: Positionen desselben Pools teilen sich
 * Preisverlauf, TVL und Gebührenregime. Der Block-Bootstrap zieht deshalb
 * **ganze Pools** mit Zurücklegen. Was er misst, ist die Frage, auf die es
 * ankommt: Wie sähe das Ergebnis aus, wenn wir andere Pools erwischt hätten?
 *
 * Deterministisch über einen eigenen RNG mit festem Seed — dieselbe Eingabe
 * ergibt dasselbe Intervall, sonst wäre keine Optimierung reproduzierbar.
 */

/** Reproduzierbarer RNG — keine Wanduhr, kein `Math.random`. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ConfidenceInterval {
  low: number;
  high: number;
  /** Überdeckungswahrscheinlichkeit, etwa 0,9 für ein 90-%-Intervall. */
  confidence: number;
  /** Wie viele Ziehungen einen Wert ergaben. */
  resamples: number;
}

export interface BootstrapOptions {
  /**
   * Zahl der Ziehungen. 2.000 ist für Perzentil-Intervalle reichlich; mehr
   * verfeinert das Intervall nicht mehr messbar, kostet aber Rechenzeit in
   * jedem Optimierungsschritt.
   */
  resamples?: number;
  /** Überdeckung, Default 0,9 — ein 90-%-Intervall. */
  confidence?: number;
  seed?: number;
}

const DEFAULT_RESAMPLES = 2_000;
const DEFAULT_CONFIDENCE = 0.9;
const DEFAULT_SEED = 0x5eed;

/**
 * Perzentil-Bootstrap über **Cluster**.
 *
 * `clusters` ist die nach Zusammengehörigkeit gruppierte Stichprobe; gezogen
 * wird auf dieser Ebene, ausgewertet auf der zusammengeführten.
 *
 * `null`, wenn weniger als zwei Cluster vorliegen: Aus einer einzigen Gruppe
 * lässt sich keine Streuung zwischen Gruppen schätzen, und ein Intervall aus
 * einem Cluster wäre eine Aussage über nichts.
 */
export function clusterBootstrapCI<T>(
  clusters: readonly (readonly T[])[],
  statistic: (sample: T[]) => number | null,
  options: BootstrapOptions = {},
): ConfidenceInterval | null {
  const usable = clusters.filter((cluster) => cluster.length > 0);
  if (usable.length < 2) return null;

  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  const random = mulberry32(options.seed ?? DEFAULT_SEED);

  const values: number[] = [];
  for (let draw = 0; draw < resamples; draw++) {
    const sample: T[] = [];
    for (let i = 0; i < usable.length; i++) {
      const picked = usable[Math.floor(random() * usable.length)];
      if (picked !== undefined) sample.push(...picked);
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }

  if (values.length === 0) return null;
  values.sort((a, b) => a - b);

  const tail = (1 - confidence) / 2;
  return {
    low: percentile(values, tail),
    high: percentile(values, 1 - tail),
    confidence,
    resamples: values.length,
  };
}

/** Lineare Interpolation zwischen den benachbarten Rängen. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Gruppiert eine Stichprobe nach einem Schlüssel.
 *
 * Die Reihenfolge der Cluster ist die des ersten Auftretens — damit hängt das
 * Ergebnis nicht an der Iterationsreihenfolge einer Map-Implementierung.
 */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const existing = groups.get(id);
    if (existing === undefined) groups.set(id, [item]);
    else existing.push(item);
  }
  return [...groups.values()];
}
