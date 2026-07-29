import { currentConfig, dbAvailable, listPositions } from "@/lib/data";
import { DbMissing, Notice, Num, RangeBar, Sol } from "../components";

export const dynamic = "force-dynamic";

const CLOSE_REASONS: Record<string, string> = {
  stop_loss: "Stop-Loss",
  take_profit: "Take-Profit",
  max_hold_time: "Haltezeit",
  out_of_range: "Range verlassen",
  manual: "manuell",
};

export default async function PositionsPage() {
  const db = await dbAvailable();
  if (!db.ok) return <DbMissing error={db.error} />;

  const config = await currentConfig();
  const positions = await listPositions(200);
  const labels = Object.fromEntries(
    Object.entries(config.presets).map(([id, preset]) => [id, preset.label]),
  );

  const open = positions.filter((p) => p.state !== "CLOSED" && p.state !== "FAILED");
  const closed = positions.filter((p) => p.state === "CLOSED");

  return (
    <>
      <h1>Positionen</h1>
      <p className="subtitle">
        {open.length} offen, {closed.length} geschlossen. Alle Werte in SOL, netto nach
        simulierten On-Chain-Kosten.
      </p>

      {positions.length === 0 && (
        <Notice title="Noch keine Positionen">
          Starte einen Paper-Trading-Zyklus mit <code>pnpm --filter @lping/bot paper</code>.
          Der Bot sucht dann Kandidaten und eröffnet für jedes Preset simulierte Positionen.
        </Notice>
      )}

      {open.length > 0 && (
        <>
          <h2>Offen</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Pool</th>
                  <th>Strategie</th>
                  <th>Bin-Range</th>
                  <th>Preis in Range</th>
                  <th className="num">Einsatz</th>
                  <th className="num">Aktueller Wert</th>
                  <th className="num">Fees</th>
                  <th className="num">Kosten</th>
                  <th className="num">PnL</th>
                  <th className="num">vs. halten</th>
                  <th className="num">in Range</th>
                  <th>Seit</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => {
                  const value = p.currentValueSol;
                  const pnl = value === null ? null : value - p.depositSol;
                  const vsHodl =
                    value === null || p.hodlValueSol === null ? null : value - p.hodlValueSol;
                  return (
                    <tr key={p.id}>
                      <td>{labels[p.preset] ?? p.preset}</td>
                      <td title={p.poolAddress}>{p.poolAddress.slice(0, 10)}…</td>
                      <td className="muted">
                        {p.strategyType}
                        {p.sided === "quote_only" ? " · nur SOL" : " · 50/50"}
                      </td>
                      <td className="muted">
                        {p.minBinId ?? "–"}…{p.maxBinId ?? "–"}
                        {p.binStep !== null && <span className="muted"> ({p.binStep}bps)</span>}
                      </td>
                      <td>
                        <RangeBar
                          minBinId={p.minBinId}
                          maxBinId={p.maxBinId}
                          binStep={p.binStep}
                          price={p.lastPrice}
                        />
                      </td>
                      <td className="num">{p.depositSol.toFixed(4)}</td>
                      <td className="num">
                        <Num value={value} digits={4} />
                      </td>
                      <td className="num pos">+{p.feesEarnedSol.toFixed(4)}</td>
                      <td className="num neg">−{p.costsSol.toFixed(4)}</td>
                      <td className="num">
                        <Sol value={pnl} />
                      </td>
                      <td className="num">
                        <Sol value={vsHodl} />
                      </td>
                      <td className="num">
                        <Num value={p.timeInRangePct} digits={0} suffix="%" />
                      </td>
                      <td className="muted">
                        {p.openedAt === null ? "–" : p.openedAt.toISOString().slice(5, 16).replace("T", " ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {closed.length > 0 && (
        <>
          <h2>Geschlossen</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Pool</th>
                  <th>Grund</th>
                  <th className="num">Einsatz</th>
                  <th className="num">Erlös</th>
                  <th className="num">Fees</th>
                  <th className="num">Kosten</th>
                  <th className="num">PnL</th>
                  <th className="num">in Range</th>
                  <th>Geschlossen</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((p) => (
                  <tr key={p.id}>
                    <td>{labels[p.preset] ?? p.preset}</td>
                    <td title={p.poolAddress}>{p.poolAddress.slice(0, 10)}…</td>
                    <td>
                      <span className={`badge ${p.realizedPnlSol >= 0 ? "ok" : "bad"}`}>
                        {p.closeReason === null ? "–" : (CLOSE_REASONS[p.closeReason] ?? p.closeReason)}
                      </span>
                    </td>
                    <td className="num">{p.depositSol.toFixed(4)}</td>
                    <td className="num">
                      <Num value={p.currentValueSol} digits={4} />
                    </td>
                    <td className="num pos">+{p.feesEarnedSol.toFixed(4)}</td>
                    <td className="num neg">−{p.costsSol.toFixed(4)}</td>
                    <td className="num">
                      <Sol value={p.realizedPnlSol} />
                    </td>
                    <td className="num">
                      <Num value={p.timeInRangePct} digits={0} suffix="%" />
                    </td>
                    <td className="muted">
                      {p.closedAt === null ? "–" : p.closedAt.toISOString().slice(5, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
