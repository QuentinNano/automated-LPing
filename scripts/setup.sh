#!/usr/bin/env bash
#
# Einmaliges Setup für den Paper-Modus: prüft die Voraussetzungen, legt die
# .env an, startet die Datenbank und richtet das Schema ein.
#
# Aufruf aus dem Projektordner:  pnpm einrichten
#
# Das Skript ist absichtlich gesprächig und bricht bei jedem Problem mit einer
# konkreten Handlungsanweisung ab, statt still weiterzulaufen.

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf "\n\033[1m▶ %s\033[0m\n" "$1"; }
ok() { printf "  ✓ %s\n" "$1"; }
fail() {
  printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2
  [ $# -gt 1 ] && printf "\n%s\n" "$2" >&2
  exit 1
}

# --- 1. Voraussetzungen ------------------------------------------------------
step "Voraussetzungen prüfen"

command -v node >/dev/null 2>&1 || fail "Node.js ist nicht installiert." \
  "Installiere es mit:  brew install node
(Homebrew fehlt? Siehe https://brew.sh)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $(node -v) ist zu alt (mindestens Version 20 nötig)." \
  "Aktualisiere mit:  brew upgrade node"
ok "Node.js $(node -v)"

command -v pnpm >/dev/null 2>&1 || fail "pnpm ist nicht installiert." \
  "Installiere es mit:  npm install -g pnpm"
ok "pnpm $(pnpm --version)"

# --- 2. Konfiguration --------------------------------------------------------
step "Konfiguration (.env)"

if [ -f .env ]; then
  ok ".env ist bereits vorhanden (unverändert gelassen)"
else
  cp .env.example .env
  ok ".env aus .env.example erstellt"
fi

# DATABASE_URL aus der .env lesen, ohne die Datei auszuführen.
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "$DB_URL" ]; then
  fail "In der .env fehlt DATABASE_URL." \
    "Trage diese Zeile ein:
DATABASE_URL=postgresql://lping:lping@localhost:5432/lping"
fi
export DATABASE_URL="$DB_URL"
ok "DATABASE_URL gesetzt"

# --- 3. Abhängigkeiten -------------------------------------------------------
step "Abhängigkeiten installieren (dauert beim ersten Mal ein paar Minuten)"
pnpm install --silent
ok "Pakete installiert"

# --- 4. Datenbank ------------------------------------------------------------
step "Datenbank starten"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose up -d postgres >/dev/null
  ok "PostgreSQL-Container gestartet"

  printf "  … warte auf Bereitschaft"
  for _ in $(seq 1 40); do
    if docker compose exec -T postgres pg_isready -U lping -d lping >/dev/null 2>&1; then
      printf "\n"
      ok "Datenbank ist bereit"
      break
    fi
    printf "."
    sleep 1
  done
else
  printf "  Docker läuft nicht — überspringe den Container.\n"
  printf "  Es wird angenommen, dass unter DATABASE_URL bereits eine PostgreSQL läuft.\n"
fi

# --- 5. Schema ---------------------------------------------------------------
step "Datenbankschema einrichten"

pnpm --filter @lping/db db:generate >/dev/null 2>&1 || fail "prisma generate ist fehlgeschlagen."
ok "Prisma-Client erzeugt"

if ! pnpm --filter @lping/db db:migrate >/dev/null 2>&1; then
  fail "Die Datenbank ist nicht erreichbar." \
    "Prüfe:
  • Läuft Docker Desktop? (Wal-Symbol in der Menüleiste)
  • Starte die Datenbank von Hand:  docker compose up -d
  • Stimmt DATABASE_URL in der .env?

Danach dieses Skript erneut ausführen:  pnpm einrichten"
fi
ok "Tabellen angelegt"

pnpm --filter @lping/db db:check 2>&1 | grep -q "OK" && ok "Datenbank funktioniert (Selbsttest bestanden)"

# --- Fertig ------------------------------------------------------------------
cat <<'DONE'

────────────────────────────────────────────────────────────
✓ Setup abgeschlossen. Der Bot läuft im Paper-Modus — es wird
  kein echtes Geld bewegt.

Nächste Schritte:

  1) Ersten Simulationslauf starten:
       pnpm --filter @lping/bot paper

  2) Oberfläche öffnen (in einem zweiten Terminal-Fenster):
       pnpm --filter @lping/web dev
     danach im Browser:  http://localhost:3000

  3) Dauerbetrieb (aktualisiert alle 15 Minuten, Abbruch mit Strg+C):
       pnpm --filter @lping/bot paper -- --interval 15
────────────────────────────────────────────────────────────
DONE
