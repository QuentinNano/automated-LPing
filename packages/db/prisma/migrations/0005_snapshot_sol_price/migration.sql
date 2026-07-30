-- SOL-Preis je Messpunkt.
--
-- Grund: Das reparierte Gebührenmodell bestimmt den Anteil am Gebührenfluss über
-- die Liquidität im aktiven Bin (DLMM-Doku: "your liquidity in eligible bins /
-- total liquidity in eligible bins"). Dafür muss der Pool-TVL in SOL umgerechnet
-- werden — und anders als in der früheren TVL-Anteil-Rechnung kürzt sich der
-- Umrechnungskurs dabei nicht heraus. Ohne diese Spalte kann der Replay den
-- Gebührenanteil aufgezeichneter Messpunkte nicht rekonstruieren.
--
-- Der Wert stammt aus den Token-Angaben der Pool-API (Preis der SOL-Seite);
-- ein Zusatzabruf entsteht nicht.

-- AlterTable
ALTER TABLE "pool_snapshots" ADD COLUMN     "sol_price_usd" DECIMAL(20,6);
