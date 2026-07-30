-- Messpunkte tragen ab jetzt die Gebührenstruktur und alle Zeitfenster.
--
-- Grund: pool_snapshots ist die Grundlage des Replays (KONZEPT-ML.md 5). Bisher
-- stand dort nur das 24-Stunden-Fenster, obwohl die Meteora-API im selben
-- Response 30m/1h/2h/4h/12h/24h liefert. Ein Replay auf 24-Stunden-Mittelwerten
-- kann Volatilitätsphasen nicht auflösen — und nachträglich beschaffen lässt
-- sich eine Zeitreihe nicht.
--
-- Alle Spalten sind NULL-fähig: Bestehende Messpunkte behalten ihren Wert und
-- weisen die neuen Felder als "nicht erhoben" aus, statt eine Null vorzutäuschen.
-- effectiveFeePct() in @lping/core kennt diesen Fall und fällt für alte Zeilen
-- auf die realisierte 24-Stunden-Rate zurück.

-- AlterTable
ALTER TABLE "pool_snapshots" ADD COLUMN     "base_fee_pct" DECIMAL(10,4),
ADD COLUMN     "dynamic_fee_pct" DECIMAL(10,4),
ADD COLUMN     "protocol_fee_pct" DECIMAL(10,4),
ADD COLUMN     "windows" JSONB;
