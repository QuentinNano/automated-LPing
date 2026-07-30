import { currentConfig, dbAvailable, listPositions, presetPerformance } from "@/lib/data";
import { DbMissing, Notice, Num, Sol } from "./components";

export const dynamic = "force-dynamic";

export default async function ComparisonPage() {
  const db = await dbAvailable();
  if (!db.ok) return <DbMissing error={db.error} />;

  const config = await currentConfig();
  const rows = await presetPerformance(config);
  const positions = await listPositions(500);
  const closed = positions.filter((p) => p.state === "CLOSED").length;

  return (
    <>
      <h1>Preset-Vergleich</h1>
      <p className="subtitle">
        Alle Presets laufen gleichzeitig auf denselben Marktdaten und mit demselben
        virtuellen Kapital ({config.global.paper.capitalPerPresetSol} SOL je Preset).
        Unterschiede in den Ergebnissen kommen damit ausschließlich von den Parametern.
      </p>

      {closed < 20 && (
        <Notice title={`Stichprobe noch zu klein (${closed} geschlossene Positionen)`}>
          Unterschiede zwischen den Presets sind bei so wenigen Positionen überwiegend
          Zufall. Belastbar wird der Vergleich ab etwa 20–30 geschlossenen Positionen je
          Preset — bis dahin ist die Rangfolge unten eine Momentaufnahme, keine Aussage.
        </Notice>
      )}

      <div className="cards">
        {rows.map((row) => (
          <div className="card" key={row.preset}>
            <h3>{row.label}</h3>
            <div className="meta">
              {row.openPositions} offen · {row.closedPositions} geschlossen
            </div>
            {/* Rendite statt absolutem PnL: Presets setzen verschieden viel
                Kapital je Position ein, und wer nach SOL rankt, belohnt die
                größere Position statt der besseren Strategie. */}
            <div className="big">
              <Num
                value={row.depositedSol > 0 ? (row.totalPnlSol / row.depositedSol) * 100 : null}
                digits={2}
                suffix=" %"
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="kv">
                <span>PnL absolut</span>
                <span>
                  <Sol value={row.totalPnlSol} /> SOL
                </span>
              </div>
              <div className="kv">
                <span>Einsatz</span>
                <span>{row.depositedSol.toFixed(2)} SOL</span>
              </div>
              <div className="kv">
                <span>davon Fees</span>
                <span className="pos">+{row.feesEarnedSol.toFixed(4)}</span>
              </div>
              <div className="kv">
                <span>On-Chain-Kosten</span>
                <span className="neg">−{row.costsSol.toFixed(4)}</span>
              </div>
              <div className="kv">
                <span>vs. nur halten</span>
                <span>
                  <Sol value={row.vsHodlSol} />
                </span>
              </div>
              <div className="kv">
                <span>Trefferquote</span>
                <span>
                  <Num value={row.winRatePct} digits={0} suffix="%" />
                </span>
              </div>
              <div className="kv">
                <span>Zeit in Range</span>
                <span>
                  <Num value={row.avgTimeInRangePct} digits={0} suffix="%" />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2>Was die Kennzahlen bedeuten</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td style={{ width: 180 }}>
                <strong>PnL</strong>
              </td>
              <td className="muted" style={{ whiteSpace: "normal" }}>
                Realisiert (geschlossene Positionen) plus unrealisiert (offene), netto nach
                allen simulierten On-Chain-Kosten. Infrastrukturkosten sind bewusst nicht
                enthalten — sie sind monatlicher Fixaufwand und keiner Position zurechenbar.
              </td>
            </tr>
            <tr>
              <td>
                <strong>vs. nur halten</strong>
              </td>
              <td className="muted" style={{ whiteSpace: "normal" }}>
                Der Vergleich, auf den es ankommt: Hätte einfaches Halten des Einsatzes
                mehr gebracht? Ist dieser Wert negativ, hat sich das LPing trotz Fee-Einnahmen
                nicht gelohnt.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Zeit in Range</strong>
              </td>
              <td className="muted" style={{ whiteSpace: "normal" }}>
                Anteil der Laufzeit, in der der Preis innerhalb der Position lag. Nur dann
                verdient eine DLMM-Position Gebühren — ein niedriger Wert erklärt ausbleibende
                Erträge.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
