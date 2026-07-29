#!/usr/bin/env bash
#
# Dauerhafte Datenaufzeichnung mit automatischem Neustart.
#
#   pnpm aufzeichnen
#
# Warum ein Wrapper: Der Bot fängt Fehler innerhalb eines Durchgangs bereits ab,
# aber ein Absturz des Prozesses, ein Netzwerkabbruch beim Start oder ein
# Neustart der Datenbank beenden ihn. Diese Schleife nimmt die Aufzeichnung dann
# von selbst wieder auf — bereits geschriebene Daten bleiben erhalten, weil jeder
# Messpunkt sofort in die Datenbank geschrieben wird.
#
# Auf macOS wird zusätzlich der Ruhezustand unterdrückt (caffeinate). Das
# funktioniert nur bei geöffnetem Deckel und am Netzteil — ein zugeklappter
# Laptop schläft trotzdem und zeichnet nichts auf.

set -uo pipefail

cd "$(dirname "$0")/.."

INTERVAL_MIN="${INTERVAL_MIN:-5}"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/track.log"
RESTART_DELAY=30

mkdir -p "$LOG_DIR"

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG_FILE"
}

# Ruhezustand unterdrücken, solange dieses Skript läuft (nur macOS).
CAFFEINATE_PID=""
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w $$ &
  CAFFEINATE_PID=$!
  log "Ruhezustand unterdrückt (caffeinate, PID $CAFFEINATE_PID)."
  log "Hinweis: Bei zugeklapptem Deckel schläft der Mac trotzdem."
fi

cleanup() {
  log "Aufzeichnung beendet (Strg+C)."
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

## Datenbank bereitstellen ----------------------------------------------------
# Häufigster Stolperstein: Nach einem Neustart des Macs läuft der Container
# nicht, und die Aufzeichnung scheitert sofort. Statt das dem Benutzer zu
# überlassen, wird er hier gestartet — das ist der Zweck eines Startbefehls.
ensure_database() {
  command -v docker >/dev/null 2>&1 || return 0

  if ! docker info >/dev/null 2>&1; then
    log "Docker läuft nicht. Bitte Docker Desktop öffnen (Wal-Symbol in der Menüleiste)."
    return 1
  fi

  if docker compose ps --status running postgres 2>/dev/null | grep -q postgres; then
    return 0
  fi

  log "Datenbank läuft nicht — starte sie."
  docker compose up -d postgres >/dev/null 2>&1 || {
    log "Der Datenbank-Container ließ sich nicht starten."
    return 1
  }

  for _ in $(seq 1 40); do
    if docker compose exec -T postgres pg_isready -U lping -d lping >/dev/null 2>&1; then
      log "Datenbank ist bereit."
      return 0
    fi
    sleep 1
  done
  log "Datenbank antwortet nicht rechtzeitig."
  return 1
}

log "Start. Intervall ${INTERVAL_MIN} min, Protokoll: $LOG_FILE"
log "Beenden mit Strg+C."

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -gt 1 ] && log "Neustart Nr. $((ATTEMPT - 1))."

  # Vor jedem Versuch sicherstellen, dass die Datenbank erreichbar ist —
  # auch nach einem Neustart des Rechners oder von Docker Desktop.
  if ! ensure_database; then
    log "Warte ${RESTART_DELAY}s und versuche es erneut."
    sleep "$RESTART_DELAY"
    continue
  fi

  pnpm --filter @lping/bot track -- --interval "$INTERVAL_MIN" 2>&1 | tee -a "$LOG_FILE"

  # Hierhin kommt die Schleife nur, wenn der Prozess beendet wurde.
  log "Aufzeichnung gestoppt — neuer Versuch in ${RESTART_DELAY}s."
  log "Bereits gesammelte Daten bleiben erhalten."
  sleep "$RESTART_DELAY"
done
