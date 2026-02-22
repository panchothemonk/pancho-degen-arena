#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/dirdiebirdies/Documents/New project"
PID_FILE="$ROOT/data/devnet-autopilot.pid"
LOG_FILE="$ROOT/data/devnet-autopilot.log"
NOHUP_FILE="$ROOT/data/devnet-autopilot.nohup.log"

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

case "${1:-}" in
  start)
    if is_running; then
      echo "already running pid=$(cat "$PID_FILE")"
      exit 0
    fi
    cd "$ROOT"
    nohup scripts/devnet-autopilot.sh > "$NOHUP_FILE" 2>&1 &
    sleep 1
    if is_running; then
      echo "started pid=$(cat "$PID_FILE")"
    else
      echo "failed to start"
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      pid=$(cat "$PID_FILE")
      kill "$pid" || true
      sleep 1
      if ps -p "$pid" >/dev/null 2>&1; then
        kill -9 "$pid" || true
      fi
      rm -f "$PID_FILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  status)
    if is_running; then
      pid=$(cat "$PID_FILE")
      ps -p "$pid" -o pid=,etime=,command=
      [[ -f "$ROOT/data/devnet-autopilot.state" ]] && cat "$ROOT/data/devnet-autopilot.state"
      [[ -f "$ROOT/data/devnet-autopilot.heartbeat" ]] && echo "heartbeat=$(cat "$ROOT/data/devnet-autopilot.heartbeat")"
    else
      echo "not running"
      exit 1
    fi
    ;;
  logs)
    tail -n "${2:-80}" "$LOG_FILE"
    ;;
  *)
    echo "Usage: scripts/devnet-autopilotctl.sh {start|stop|status|logs [n]}"
    exit 1
    ;;
esac
