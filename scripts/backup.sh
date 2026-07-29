#!/usr/bin/env bash
#
# Sicherung und Wiederherstellung der Datenbank.
#
#   pnpm sichern                        # Sicherung anlegen
#   bash scripts/backup.sh liste        # vorhandene Sicherungen auflisten
#   bash scripts/backup.sh zurueck DATEI  # Sicherung einspielen
#
# Warum das nötig ist: Die gesammelten Aufzeichnungsdaten sind nach einigen
# Wochen nicht wiederbeschaffbar — es gibt keine Historie, die man erneut
# abrufen könnte. Ein `docker compose down -v` oder ein Festplattendefekt
# würde sie unwiederbringlich löschen.

set -uo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${KEEP:-14}"

info() { printf "  %s\n" "$1"; }
ok() { printf "  ✓ %s\n" "$1"; }
die() {
  printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2
  [ $# -gt 1 ] && printf "\n%s\n" "$2" >&2
  exit 1
}

# --- Datenbankzugang bestimmen ----------------------------------------------
# Zwei Betriebsarten: PostgreSQL im Docker-Container (Standard-Setup) oder eine
# lokal installierte Instanz. Der Container wird bevorzugt, weil dort die
# Werkzeugversion garantiert zur Datenbank passt.
DB_NAME="lping"
DB_USER="lping"

use_docker() {
  command -v docker >/dev/null 2>&1 &&
    docker compose ps --status running postgres 2>/dev/null | grep -q postgres
}

load_env() {
  [ -f .env ] || return 0
  local url
  url="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"
  [ -n "$url" ] && export DATABASE_URL="$url"
}

dump_to_stdout() {
  if use_docker; then
    docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists
  else
    [ -n "${DATABASE_URL:-}" ] || die "Weder ein laufender Docker-Container noch DATABASE_URL gefunden." \
      "Starte die Datenbank mit:  docker compose up -d"
    command -v pg_dump >/dev/null 2>&1 || die "pg_dump ist nicht installiert." \
      "Auf macOS:  brew install libpq && brew link --force libpq"
    pg_dump "$DATABASE_URL" --clean --if-exists
  fi
}

restore_from_stdin() {
  if use_docker; then
    docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 --quiet
  else
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --quiet
  fi
}

# --- Sicherung ---------------------------------------------------------------
cmd_backup() {
  load_env
  mkdir -p "$BACKUP_DIR"
  local stamp file
  stamp="$(date '+%Y-%m-%d_%H%M%S')"
  file="$BACKUP_DIR/lping_$stamp.sql.gz"

  printf "\n\033[1m▶ Sicherung wird erstellt\033[0m\n"
  info "Ziel: $file"

  if ! dump_to_stdout | gzip > "$file"; then
    rm -f "$file"
    die "Die Sicherung ist fehlgeschlagen." "Läuft die Datenbank? Prüfe:  docker compose ps"
  fi

  # Eine leere oder abgebrochene Sicherung ist gefährlicher als keine, weil man
  # sich in Sicherheit wiegt. Deshalb wird der Inhalt geprüft, nicht nur der
  # Rückgabewert.
  local size
  size="$(wc -c < "$file" | tr -d ' ')"
  if [ "$size" -lt 500 ]; then
    rm -f "$file"
    die "Die Sicherung enthält keine Daten (nur $size Byte) und wurde verworfen."
  fi
  if ! gzip -dc "$file" | grep -q "candidate_features"; then
    rm -f "$file"
    die "Die Sicherung wirkt unvollständig — Tabellen fehlen. Sie wurde verworfen."
  fi

  ok "Sicherung erstellt ($(du -h "$file" | cut -f1))"

  # Inhalt kurz beziffern, damit erkennbar ist, ob wirklich Daten drin sind.
  local rows
  rows="$(gzip -dc "$file" | grep -c '^INSERT\|^COPY' || true)"
  info "Enthaltene Datenblöcke: $rows"

  # --- Alte Sicherungen ausdünnen -------------------------------------------
  local total
  total="$(find "$BACKUP_DIR" -name 'lping_*.sql.gz' | wc -l | tr -d ' ')"
  if [ "$total" -gt "$KEEP" ]; then
    find "$BACKUP_DIR" -name 'lping_*.sql.gz' | sort | head -n "$((total - KEEP))" |
      while read -r old; do
        rm -f "$old"
        info "Alte Sicherung entfernt: $(basename "$old")"
      done
  fi

  printf "\nWiederherstellen mit:\n  bash scripts/backup.sh zurueck %s\n" "$file"
}

# --- Auflisten ---------------------------------------------------------------
cmd_list() {
  printf "\n\033[1m▶ Vorhandene Sicherungen\033[0m\n"
  if [ ! -d "$BACKUP_DIR" ] || [ -z "$(find "$BACKUP_DIR" -name 'lping_*.sql.gz' 2>/dev/null)" ]; then
    info "Noch keine Sicherung vorhanden. Erstellen mit:  pnpm sichern"
    return 0
  fi
  find "$BACKUP_DIR" -name 'lping_*.sql.gz' | sort -r | while read -r file; do
    printf "  %-40s %8s\n" "$(basename "$file")" "$(du -h "$file" | cut -f1)"
  done
}

# --- Wiederherstellen --------------------------------------------------------
cmd_restore() {
  local file="${1:-}"
  [ -n "$file" ] || die "Keine Datei angegeben." \
    "Verwendung:  bash scripts/backup.sh zurueck backups/lping_....sql.gz
Vorhandene Sicherungen:  bash scripts/backup.sh liste"
  [ -f "$file" ] || die "Datei nicht gefunden: $file"

  load_env
  printf "\n\033[1m▶ Wiederherstellung\033[0m\n"
  info "Quelle: $file"
  printf "\n\033[31mACHTUNG: Der aktuelle Datenbankinhalt wird dabei ersetzt.\033[0m\n"

  # Vor dem Überschreiben eine Sicherung des Ist-Zustands — ein versehentliches
  # Zurückspielen darf nicht der letzte Datenverlust sein.
  printf "\nEs wird zuerst der aktuelle Stand gesichert.\n"
  read -r -p "Fortfahren? Tippe JA: " answer
  [ "$answer" = "JA" ] || die "Abgebrochen — nichts verändert."

  if cmd_backup >/dev/null 2>&1; then
    ok "Aktueller Stand vorsorglich gesichert ($(ls -1t "$BACKUP_DIR" | head -1))"
  else
    info "Hinweis: Der aktuelle Stand konnte nicht gesichert werden (leere Datenbank?)."
  fi

  # Nur stdout unterdrücken: Fehler gehen nach stderr und bleiben sichtbar.
  if ! gzip -dc "$file" | restore_from_stdin >/dev/null; then
    die "Die Wiederherstellung ist fehlgeschlagen." \
      "Die Datenbank kann jetzt unvollständig sein. Spiele die vorsorgliche
Sicherung aus $BACKUP_DIR ein oder melde die Fehlermeldung."
  fi

  ok "Wiederherstellung abgeschlossen"
  info "Prüfen mit:  pnpm --filter @lping/bot track -- --status"
}

case "${1:-sichern}" in
  sichern | backup) cmd_backup ;;
  liste | list) cmd_list ;;
  zurueck | restore) cmd_restore "${2:-}" ;;
  *)
    die "Unbekannter Befehl: $1" "Verfügbar: sichern | liste | zurueck DATEI"
    ;;
esac
