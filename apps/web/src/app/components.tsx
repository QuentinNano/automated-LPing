import type { ReactNode } from "react";

export function Sol({ value, digits = 4 }: { value: number | null; digits?: number }) {
  if (value === null) return <span className="muted">–</span>;
  const sign = value > 0 ? "+" : "";
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "muted";
  return (
    <span className={cls}>
      {sign}
      {value.toFixed(digits)}
    </span>
  );
}

export function Num({ value, digits = 2, suffix = "" }: { value: number | null; digits?: number; suffix?: string }) {
  if (value === null || Number.isNaN(value)) return <span className="muted">–</span>;
  return (
    <>
      {value.toFixed(digits)}
      {suffix}
    </>
  );
}

export function Usd({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="muted">–</span>;
  if (value >= 1_000_000) return <>${(value / 1_000_000).toFixed(2)}M</>;
  if (value >= 1_000) return <>${(value / 1_000).toFixed(0)}k</>;
  return <>${value.toFixed(0)}</>;
}

/**
 * Hinweis, dass die Range-Breite nicht der Volatilität folgt, sondern an eine
 * Leitplanke gestoßen ist.
 *
 * Ohne diesen Ausweis sieht eine geklemmte Position aus wie jede andere — und
 * geklemmt wird bevorzugt bei volatilen Pools, also gerade dort, wo die
 * hergeleitete Breite den größten Unterschied macht. `max` heißt: zu eng für
 * den Markt, `min` heißt: weiter als nötig, also unnötig verdünnt.
 */
export function BinWidthNote({
  clamped,
  derived,
}: {
  clamped: "min" | "max" | null;
  derived: number | null;
}) {
  if (clamped === null) return null;
  const title =
    derived === null
      ? "Bin-Zahl an der Leitplanke"
      : clamped === "max"
        ? `Volatilität verlangt ${derived} Bins — binRange.max begrenzt darunter, die Range ist zu eng`
        : `Volatilität verlangt nur ${derived} Bins — binRange.min hält sie breiter, die Liquidität ist verdünnt`;
  return (
    <span className="neg" title={title}>
      {" "}
      ⚠ {clamped === "max" ? "zu eng (max)" : "zu weit (min)"}
    </span>
  );
}

/**
 * Bin-Range mit Preis-Marker: zeigt auf einen Blick, wo der aktuelle Preis
 * innerhalb der Position liegt — die wichtigste Größe beim DLMM-LPing, denn
 * nur innerhalb der Range verdient die Position Gebühren.
 */
export function RangeBar({
  minBinId,
  maxBinId,
  binStep,
  price,
}: {
  minBinId: number | null;
  maxBinId: number | null;
  binStep: number | null;
  price: number | null;
}) {
  if (minBinId === null || maxBinId === null || binStep === null || price === null || price <= 0) {
    return <span className="muted">–</span>;
  }
  const factor = 1 + binStep / 10_000;
  const low = Math.pow(factor, minBinId);
  const high = Math.pow(factor, maxBinId);
  if (!(high > low)) return <span className="muted">–</span>;

  const ratio = (price - low) / (high - low);
  const clamped = Math.max(0, Math.min(1, ratio));
  const out = ratio < 0 || ratio > 1;

  return (
    <span
      className="range"
      title={`Range ${low.toExponential(3)} – ${high.toExponential(3)} SOL, aktuell ${price.toExponential(3)}`}
    >
      <span className="fill" />
      <span className={`marker${out ? " out" : ""}`} style={{ left: `${clamped * 100}%` }} />
    </span>
  );
}

export function Notice({
  title,
  children,
  warn = false,
}: {
  title: string;
  children: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className={`notice${warn ? " warn" : ""}`}>
      <strong>{title}</strong>
      <div className="muted" style={{ marginTop: 6 }}>
        {children}
      </div>
    </div>
  );
}

export function DbMissing({ error }: { error?: string }) {
  return (
    <Notice title="Keine Datenbankverbindung" warn>
      <p style={{ marginTop: 0 }}>{error}</p>
      <p>
        Starte die Datenbank und lege das Schema an:
        <br />
        <code>docker compose up -d</code> → <code>pnpm db:generate</code> →{" "}
        <code>pnpm db:migrate</code>
        <br />
        Danach <code>DATABASE_URL</code> in der <code>.env</code> eintragen (Vorlage:{" "}
        <code>.env.example</code>).
      </p>
    </Notice>
  );
}
