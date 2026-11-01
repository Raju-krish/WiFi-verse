#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME=$ROOT/.runtime
STATE=$RUNTIME/ports
ACTION=start
API_PORT_ARG=
UI_PORT_ARG=
UI_HOST_ARG=
SHOW_HELP=0

if [[ $# -gt 0 && $1 != --* ]]; then
  ACTION=$1
  shift
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --api-port)
      [[ $# -ge 2 ]] || { echo "--api-port needs a value" >&2; exit 2; }
      API_PORT_ARG=$2
      shift 2
      ;;
    --api-port=*) API_PORT_ARG=${1#*=}; shift ;;
    --ui-port)
      [[ $# -ge 2 ]] || { echo "--ui-port needs a value" >&2; exit 2; }
      UI_PORT_ARG=$2
      shift 2
      ;;
    --ui-port=*) UI_PORT_ARG=${1#*=}; shift ;;
    --ui-host)
      [[ $# -ge 2 ]] || { echo "--ui-host needs a value" >&2; exit 2; }
      UI_HOST_ARG=$2
      shift 2
      ;;
    --ui-host=*) UI_HOST_ARG=${1#*=}; shift ;;
    -h|--help) SHOW_HELP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if (( SHOW_HELP )); then
  echo "usage: $0 [start|stop|status] [--api-port PORT] [--ui-port PORT] [--ui-host HOST]"
  echo "Defaults: API_PORT=8787, UI_PORT=5173, UI_HOST=0.0.0.0."
  exit 0
fi

case $ACTION in
  start|stop|status) ;;
  *) echo "unknown action: $ACTION" >&2; exit 2 ;;
esac

saved_api=
saved_ui=
saved_host=
if [[ -r $STATE ]]; then
  mapfile -t saved < "$STATE"
  saved_api=${saved[0]:-}
  saved_ui=${saved[1]:-}
  saved_host=${saved[2]:-}
fi

if [[ $ACTION == start ]]; then
  API_PORT=${API_PORT_ARG:-${API_PORT:-${PORT:-${saved_api:-8787}}}}
  UI_PORT=${UI_PORT_ARG:-${UI_PORT:-${saved_ui:-5173}}}
  UI_HOST=${UI_HOST_ARG:-${UI_HOST:-${saved_host:-0.0.0.0}}}
else
  API_PORT=${API_PORT_ARG:-${saved_api:-${API_PORT:-${PORT:-8787}}}}
  UI_PORT=${UI_PORT_ARG:-${saved_ui:-${UI_PORT:-5173}}}
  UI_HOST=${UI_HOST_ARG:-${saved_host:-${UI_HOST:-0.0.0.0}}}
  if [[ $ACTION == stop && -n $saved_api && ( $API_PORT != "$saved_api" || $UI_PORT != "$saved_ui" ) ]]; then
    echo "Managed ports are $saved_api/$saved_ui. Stop those ports, or pass matching --api-port/--ui-port values." >&2
    exit 1
  fi
fi

valid_port() {
  [[ $1 =~ ^[0-9]{1,5}$ ]] || return 1
  local value=$((10#$1))
  (( value >= 1 && value <= 65535 ))
}

if ! valid_port "$API_PORT" || ! valid_port "$UI_PORT"; then
  echo "API_PORT and UI_PORT must be integers from 1 to 65535" >&2
  exit 2
fi

port_in_use() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

port_owned_by_pid() {
  ss -H -ltnp "sport = :$1" 2>/dev/null | grep -Fq "pid=$2,"
}

find_api_pid() {
  local pid owner comm args
  while read -r pid owner comm args; do
    if [[ $owner == root && ( $comm == uvicorn || $comm == python* ) &&
          $args == *"$ROOT/.venv/bin/uvicorn labd.api:app"* &&
          $args == *"--app-dir $ROOT"* &&
          $args == *"--host 127.0.0.1"* &&
          $args == *"--port $API_PORT"* &&
          $args == *"--no-access-log"* ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
  done < <(sudo -n ps -ww -eo pid=,user=,comm=,args= 2>/dev/null)
  return 1
}

ui_api_port_matches() {
  local process_api_port
  process_api_port=$(tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n 's/^API_PORT=//p' | head -n 1 || true)
  [[ -n $process_api_port ]] || process_api_port=8787
  [[ $process_api_port == "$API_PORT" ]]
}

find_ui_pid() {
  local pid args
  while read -r pid args; do
    case $args in
      *"$ROOT/ui/node_modules/.bin/vite"*|*"$ROOT/ui/node_modules/vite/bin/vite.js"*)
        if port_owned_by_pid "$UI_PORT" "$pid" && ui_api_port_matches "$pid"; then
          printf '%s\n' "$pid"
          return 0
        fi
        ;;
    esac
  done < <(ps -ww -eo pid=,args=)
  return 1
}

api_health() {
  [[ -r $ROOT/.token ]] || return 1
  curl -fsS --max-time 3 \
    -H "Authorization: Bearer $(<"$ROOT/.token")" \
    -H "Origin: http://127.0.0.1:$UI_PORT" \
    "http://127.0.0.1:$API_PORT/api/state" >/dev/null
}

wait_for_url() {
  curl --silent --fail --retry 20 --retry-connrefused \
    --retry-delay 1 --retry-max-time 25 --max-time 2 "$1" >/dev/null
}

save_ports() {
  umask 077
  printf '%s\n%s\n%s\n' "$API_PORT" "$UI_PORT" "$UI_HOST" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}

stop_api_pid() {
  local pid=$1 token
  if [[ -r $ROOT/.token ]]; then
    token=$(<"$ROOT/.token")
    curl -fsS --max-time 30 -X POST \
      -H "Authorization: Bearer $token" \
      "http://127.0.0.1:$API_PORT/api/lab/stop" >/dev/null || \
      echo "API stop request failed; SIGTERM will still run FastAPI shutdown cleanup." >&2
  fi
  sudo -n kill -TERM "$pid" 2>/dev/null || true
  if ! sudo -n timeout 10s tail --pid="$pid" -f /dev/null >/dev/null 2>&1; then
    if sudo -n kill -0 "$pid" 2>/dev/null; then
      echo "API did not exit after SIGTERM; sending SIGKILL." >&2
      sudo -n kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
}

stop_ui_pid() {
  local pid=$1
  kill -TERM "$pid" 2>/dev/null || true
  if ! timeout 10s tail --pid="$pid" -f /dev/null >/dev/null 2>&1; then
    if kill -0 "$pid" 2>/dev/null; then
      echo "UI did not exit after SIGTERM; sending SIGKILL." >&2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
}

start_services() {
  local api_pid ui_pid api_log ui_log api_started=0 ui_launcher_pid

  if [[ -n $saved_api && ( $saved_api != "$API_PORT" || $saved_ui != "$UI_PORT" ) ]]; then
    echo "A different managed port pair ($saved_api/$saved_ui) is recorded. Run '$0 stop' first." >&2
    return 1
  fi
  [[ -x $ROOT/.venv/bin/uvicorn ]] || { echo "Missing API environment; run scripts/setup.sh first." >&2; return 1; }
  [[ -x $ROOT/ui/node_modules/.bin/vite ]] || { echo "Missing UI dependencies; run 'cd ui && npm install' first." >&2; return 1; }
  sudo -n true || { echo "Passwordless sudo is required to run the API." >&2; return 1; }

  mkdir -p "$RUNTIME"
  chmod 700 "$RUNTIME"
  api_log=$RUNTIME/api-$API_PORT.log
  ui_log=$RUNTIME/ui-$UI_PORT.log

  api_pid=$(find_api_pid || true)
  if [[ -z $api_pid ]]; then
    if port_in_use "$API_PORT"; then
      echo "API port $API_PORT is already used by another process; leaving it untouched." >&2
      return 1
    fi
    echo "Starting API on 127.0.0.1:$API_PORT..."
    API_PORT=$API_PORT UI_PORT=$UI_PORT nohup "$ROOT/scripts/labd.sh" >"$api_log" 2>&1 </dev/null &
    if ! wait_for_url "http://127.0.0.1:$API_PORT/api/health"; then
      echo "API failed to start. Last log lines:" >&2
      tail -n 30 "$api_log" >&2 || true
      return 1
    fi
    api_pid=$(find_api_pid || true)
    if [[ -z $api_pid ]]; then
      echo "API answered health checks but its process did not match this project; leaving it untouched." >&2
      return 1
    fi
    api_started=1
  else
    echo "API already running on 127.0.0.1:$API_PORT (PID $api_pid)."
  fi

  if ! api_health; then
    echo "API is not configured to accept UI origin port $UI_PORT. Start both with matching API_PORT/UI_PORT values." >&2
    if (( api_started )); then stop_api_pid "$api_pid"; fi
    return 1
  fi

  ui_pid=$(find_ui_pid || true)
  if [[ -z $ui_pid ]]; then
    if port_in_use "$UI_PORT"; then
      echo "UI port $UI_PORT is already used by another process; leaving it untouched." >&2
      if (( api_started )); then stop_api_pid "$api_pid"; fi
      return 1
    fi
    echo "Starting UI on $UI_HOST:$UI_PORT..."
    (
      cd "$ROOT/ui"
      exec nohup env API_PORT="$API_PORT" UI_PORT="$UI_PORT" UI_HOST="$UI_HOST" \
        "$ROOT/ui/node_modules/.bin/vite" --host "$UI_HOST" --port "$UI_PORT"
    ) >"$ui_log" 2>&1 </dev/null &
    ui_launcher_pid=$!
    if ! wait_for_url "http://127.0.0.1:$UI_PORT/"; then
      echo "UI failed to start. Last log lines:" >&2
      tail -n 30 "$ui_log" >&2 || true
      kill -TERM "$ui_launcher_pid" 2>/dev/null || true
      if (( api_started )); then stop_api_pid "$api_pid"; fi
      return 1
    fi
    ui_pid=$(find_ui_pid || true)
    if [[ -z $ui_pid ]]; then
      echo "UI answered HTTP but its listener did not match this project's Vite process." >&2
      if (( api_started )); then stop_api_pid "$api_pid"; fi
      return 1
    fi
  else
    echo "UI already running on port $UI_PORT (PID $ui_pid)."
  fi

  save_ports
  echo "Wi-Fi Verse is ready: http://localhost:$UI_PORT/"
  echo "Logs: $api_log and $ui_log"
}

stop_services() {
  local api_pid ui_pid stopped=0
  api_pid=$(find_api_pid || true)
  ui_pid=$(find_ui_pid || true)

  if [[ -n $api_pid ]]; then
    echo "Stopping lab and API (PID $api_pid)..."
    stop_api_pid "$api_pid"
    stopped=1
  else
    echo "API is not running on port $API_PORT."
  fi
  if [[ -n $ui_pid ]]; then
    echo "Stopping UI (PID $ui_pid)..."
    stop_ui_pid "$ui_pid"
    stopped=1
  else
    echo "UI is not running on port $UI_PORT."
  fi

  if [[ -e /run/wifilab/state && -z $api_pid ]]; then
    echo "Warning: lab state remains but its API is absent; not unloading radios that may belong to another process." >&2
  fi
  rm -f "$STATE"
  (( stopped )) || echo "Nothing to stop."
}

show_status() {
  local api_pid ui_pid
  api_pid=$(find_api_pid || true)
  ui_pid=$(find_ui_pid || true)
  if [[ -n $api_pid ]]; then
    echo "API: running on 127.0.0.1:$API_PORT (PID $api_pid)"
  else
    echo "API: stopped (port $API_PORT)"
  fi
  if [[ -n $ui_pid ]]; then
    echo "UI: running on $UI_HOST:$UI_PORT (PID $ui_pid)"
  else
    echo "UI: stopped (port $UI_PORT)"
  fi
}

case $ACTION in
  start) start_services ;;
  stop) stop_services ;;
  status) show_status ;;
  *)
    echo "usage: $0 [start|stop|status] [--api-port PORT] [--ui-port PORT] [--ui-host HOST]" >&2
    exit 2
    ;;
esac