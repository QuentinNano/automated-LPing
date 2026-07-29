import { configService, dbAvailable } from "@/lib/data";
import { DbMissing, Notice } from "../components";
import { ParameterForm } from "./form";

export const dynamic = "force-dynamic";

export default async function ParameterPage() {
  const db = await dbAvailable();
  if (!db.ok) return <DbMissing error={db.error} />;

  const service = await configService();
  const history = await service.history(8);

  return (
    <>
      <h1>Parameter</h1>
      <p className="subtitle">
        Änderungen werden validiert und als neue Version gespeichert. Schlägt die Prüfung
        fehl, bleibt die bisherige Version unverändert gültig — der Bot läuft nie mit einer
        ungültigen Konfiguration.
      </p>

      <Notice title="Presets gleichzeitig testen">
        Jedes aktive Preset eröffnet eigene Positionen auf denselben Marktdaten. Willst du
        eine Variante ausprobieren, ohne die anderen zu stören, kopiere eine Preset-Datei in{" "}
        <code>config/</code> unter neuem Namen (z. B. <code>degen_eng.json</code>) und passe
        sie an — sie erscheint automatisch hier und im Vergleich.
      </Notice>

      <ParameterForm config={service.config} version={service.version} />

      <h2>Änderungsverlauf</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">Version</th>
              <th>Wer</th>
              <th>Grund</th>
              <th>Wann</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.version}>
                <td className="num">{entry.version}</td>
                <td>{entry.actor}</td>
                <td className="muted">{entry.reason ?? "–"}</td>
                <td className="muted">
                  {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
