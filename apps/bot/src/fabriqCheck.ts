import { extractFabriqPools } from "@lping/adapters";

/**
 * Hilfskommando für den Fabriq-Spike (siehe packages/adapters/src/fabriq/SPIKE.md).
 *
 * Nimmt eine im Browser-DevTools gefundene URL, ruft sie auf und prüft, ob
 * daraus Pools extrahierbar sind. Gibt am Ende die fertigen .env-Zeilen aus.
 * Läuft bewusst ohne Adapter-Rate-Limit — es ist ein einmaliger manueller Check.
 */
export async function cmdFabriqCheck(rawUrl: string | undefined): Promise<number> {
  if (rawUrl === undefined || rawUrl.length === 0) {
    console.error(
      [
        "Verwendung: pnpm --filter @lping/bot fabriq:check \"<URL>\"",
        "",
        "Die URL findest du im Browser: fabriq.trade/trending öffnen, F12 drücken,",
        "Tab 'Network' (Netzwerk), Filter 'Fetch/XHR', Seite neu laden, dann den",
        "Request anklicken, der die Pool-Liste enthält → 'Request URL' kopieren.",
        "Details: packages/adapters/src/fabriq/SPIKE.md",
      ].join("\n"),
    );
    return 2;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.error(`Das sieht nicht wie eine vollständige URL aus: ${rawUrl}`);
    console.error("Sie muss mit https:// beginnen, z. B. https://api.fabriq.trade/v1/pools/trending?type=degen");
    return 2;
  }

  console.log(`Prüfe: ${url.toString()}\n`);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "automated-lping/0.1 (personal research bot)",
      },
    });
  } catch (error) {
    console.error(`✗ Nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`);
    console.error("  Prüfe Tippfehler in der URL und deine Internetverbindung.");
    return 1;
  }

  console.log(`HTTP ${response.status} ${response.statusText} (${Date.now() - started} ms)`);

  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 200);
    console.error(`✗ Server hat abgelehnt.${snippet.length > 0 ? `\n  Antwort: ${snippet}` : ""}`);
    if (response.status === 401 || response.status === 403) {
      console.error(
        "  Hinweis: Der Endpoint braucht vermutlich Header (Token/Cookie/Referer).\n" +
          "  Schau im DevTools unter 'Request Headers' nach — dann brauchen wir eine\n" +
          "  erweiterte Adapter-Variante.",
      );
    }
    return 1;
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("✗ Antwort ist kein JSON (vermutlich HTML — dann war es der falsche Request).");
    console.error(`  Anfang der Antwort: ${text.slice(0, 120)}`);
    return 1;
  }

  const pools = extractFabriqPools(json);

  if (pools.length === 0) {
    console.error("✗ JSON erhalten, aber keine Pools erkannt.");
    if (typeof json === "object" && json !== null) {
      console.error(`  Felder auf oberster Ebene: ${Object.keys(json as object).join(", ")}`);
    }
    console.error("  Schicke mir diese Ausgabe plus ein paar Zeilen der Antwort — dann passe ich den Parser an.");
    return 1;
  }

  console.log(`✓ ${pools.length} Pools erkannt.\n`);
  for (const pool of pools.slice(0, 5)) {
    const score = pool.score !== undefined ? `Score ${pool.score}` : "kein Score-Feld";
    console.log(`  ${pool.poolAddress}  ${pool.name ?? "(kein Name)"}  ${score}`);
  }
  if (pools.length > 5) console.log(`  … und ${pools.length - 5} weitere`);

  console.log("\nTrage das in deine .env ein:\n");
  console.log(`  FABRIQ_API_BASE=${url.origin}`);
  console.log(`  FABRIQ_TRENDING_PATH=${url.pathname}`);
  if (url.search.length > 0) {
    console.log(`\nQuery-Parameter der URL: ${url.search}`);
    console.log("  → Schicke mir diese Zeile: der Adapter hängt aktuell '?category=degen' an,");
    console.log("    das muss ggf. an die echten Parameternamen angepasst werden.");
  }
  return 0;
}
