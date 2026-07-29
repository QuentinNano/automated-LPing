import { currentConfig, dbAvailable, listCandidates } from "@/lib/data";
import { DbMissing, Notice, Num, Usd } from "../components";

export const dynamic = "force-dynamic";

/** Klartext für die Filter-IDs aus dem Screening (KONZEPT.md Abschnitt 5). */
const CHECK_LABELS: Record<string, string> = {
  quote_is_sol: "Pool nicht SOL-quotiert",
  mint_authority_revoked: "Mint-Authority nicht entzogen",
  freeze_authority_revoked: "Freeze-Authority nicht entzogen",
  risk_score: "RugCheck-Risikoscore zu hoch",
  risk_flags: "kritische RugCheck-Warnung",
  sellable: "nicht verkaufbar / illiquide",
  top10_concentration: "Top-10-Holder halten zu viel",
  single_holder: "einzelner Holder zu groß",
  insider_share: "Insider-Anteil zu hoch",
  min_holders: "zu wenige Holder",
  min_tvl: "TVL zu niedrig",
  vol_tvl_ratio: "Volumen/TVL außerhalb des Bandes",
  token_age: "Token-Alter außerhalb des Fensters",
  price_divergence: "Pool-Preis weicht vom Markt ab",
  wash_trading_avg_trade: "Wash-Trading-Verdacht",
  pool_share_of_tvl: "eigene Position zu groß für den Pool",
  single_lp_dominance: "LP-Dominanz",
  min_score: "Score unter Preset-Mindestwert",
};

export default async function ScannerPage() {
  const db = await dbAvailable();
  if (!db.ok) return <DbMissing error={db.error} />;

  const config = await currentConfig();
  const candidates = await listCandidates(80);
  const labels = Object.fromEntries(
    Object.entries(config.presets).map(([id, preset]) => [id, preset.label]),
  );

  return (
    <>
      <h1>Scanner</h1>
      <p className="subtitle">
        Zuletzt entdeckte Pools mit Screening-Ergebnis. Abgelehnte Kandidaten werden 7 Tage
        weiterverfolgt (Shadow-Tracking), um später zu messen, ob die Filter zu streng oder
        zu lasch eingestellt sind.
      </p>

      {candidates.length === 0 && (
        <Notice title="Noch keine Kandidaten">
          Starte einen Scan mit <code>pnpm --filter @lping/bot scan</code>.
        </Notice>
      )}

      {candidates.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Preset</th>
                <th>Pool</th>
                <th className="num">TVL</th>
                <th className="num">Vol 24h</th>
                <th className="num">Fee/TVL</th>
                <th className="num">Score</th>
                <th>Ergebnis</th>
                <th>Begründung</th>
                <th>Gefunden</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const accepted = candidate.status === "DISCOVERED";
                const reasons = candidate.rejectionReason?.split(", ").filter(Boolean) ?? [];
                return (
                  <tr key={candidate.id}>
                    <td>{labels[candidate.preset] ?? candidate.preset}</td>
                    <td title={candidate.poolAddress}>
                      {candidate.metrics.name ?? `${candidate.poolAddress.slice(0, 10)}…`}
                    </td>
                    <td className="num">
                      <Usd value={candidate.metrics.tvlUsd} />
                    </td>
                    <td className="num">
                      <Usd value={candidate.metrics.volume24hUsd} />
                    </td>
                    <td className="num">
                      <Num value={candidate.metrics.feeTvl24hPct ?? null} digits={2} suffix="%" />
                    </td>
                    <td className="num">
                      <Num value={candidate.score} digits={1} />
                    </td>
                    <td>
                      <span className={`badge ${accepted ? "ok" : "bad"}`}>
                        {accepted ? "akzeptiert" : "abgelehnt"}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "normal", maxWidth: 340 }}>
                      {reasons.length === 0 ? (
                        <span className="muted">alle Prüfungen bestanden</span>
                      ) : (
                        <details className="why">
                          <summary>
                            {reasons.length} Prüfung{reasons.length === 1 ? "" : "en"} nicht bestanden
                          </summary>
                          <ul>
                            {reasons.map((reason) => (
                              <li key={reason}>{CHECK_LABELS[reason] ?? reason}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="muted">
                      {candidate.discoveredAt.toISOString().slice(5, 16).replace("T", " ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
