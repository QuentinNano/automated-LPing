import { mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigValidationError } from "@lping/core";
import { loadDefaultsFromDir } from "../src/loadConfig";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = path.join(repoRoot, "config");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyConfigTo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lping-config-"));
  tempDirs.push(dir);
  for (const file of readdirSync(configDir)) {
    copyFileSync(path.join(configDir, file), path.join(dir, file));
  }
  return dir;
}

describe("loadDefaultsFromDir", () => {
  it("lädt jede Preset-Datei des echten config-Verzeichnisses", () => {
    const config = loadDefaultsFromDir(configDir);

    // Erwartete Presets direkt aus dem Verzeichnis ableiten: so schlägt der
    // Test an, sobald Loader und Dateien auseinanderlaufen — genau der Fehler,
    // der beim Umstieg auf frei benennbare Presets zuschlug.
    const expected = readdirSync(configDir)
      .filter((f) => f.endsWith(".json") && f !== "global.json")
      .map((f) => path.basename(f, ".json"))
      .sort();

    expect(Object.keys(config.presets).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThanOrEqual(3);
  });

  it("nimmt neue Preset-Dateien ohne Codeänderung auf", () => {
    const dir = copyConfigTo();
    const degen = JSON.parse(readFileSync(path.join(dir, "degen.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      path.join(dir, "degen_eng.json"),
      JSON.stringify({ ...degen, label: "Degen eng", capitalSharePct: 0 }),
    );

    const config = loadDefaultsFromDir(dir);
    expect(config.presets["degen_eng"]?.label).toBe("Degen eng");
  });

  it("ignoriert Nicht-JSON-Dateien im config-Verzeichnis", () => {
    const dir = copyConfigTo();
    writeFileSync(path.join(dir, "notizen.txt"), "kein Preset");
    expect(() => loadDefaultsFromDir(dir)).not.toThrow();
  });

  it("meldet eine ungültige Preset-Datei mit Feldbezug", () => {
    const dir = copyConfigTo();
    writeFileSync(path.join(dir, "kaputt.json"), JSON.stringify({ label: "Kaputt" }));
    expect(() => loadDefaultsFromDir(dir)).toThrowError(ConfigValidationError);
    expect(() => loadDefaultsFromDir(dir)).toThrowError(/kaputt/);
  });
});
