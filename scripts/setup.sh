#!/usr/bin/env bash
# Installs the parts of Wi-Fi Verse that do not need root: the Python virtualenv, the UI packages and wmediumd.
# System packages (hostapd, tshark, ...) come from apt: scripts/smoke-test.sh prints the exact command.
#
# Usage: scripts/setup.sh [all|python|ui|wmediumd]      (default: all)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WM_DIR=${WM_DIR:-$ROOT/vendor/wmediumd}
WM_URL=https://github.com/ramonfontes/wmediumd.git
WM_COMMIT=63e9fc995cfb260065c7a0d4c2b14f715f224436 # the commit sniffer.patch was made against

say() { printf '\n==> %s\n' "$1"; }

python_env() {
  say "Python virtualenv"
  command -v python3 >/dev/null || { echo "python3 not found: sudo apt install -y python3 python3-venv python3-pip" >&2; exit 1; }
  [[ -x $ROOT/.venv/bin/python ]] || python3 -m venv "$ROOT/.venv" ||
    { echo "venv failed: sudo apt install -y python3-venv" >&2; exit 1; }
  "$ROOT/.venv/bin/pip" install --upgrade pip >/dev/null
  "$ROOT/.venv/bin/pip" install -r "$ROOT/requirements.txt"
}

ui_packages() {
  say "UI packages"
  if ! command -v node >/dev/null && [[ -s $HOME/.nvm/nvm.sh ]]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
  command -v npm >/dev/null || { echo "node 20.19 or newer is needed; see the README (nvm install 22)" >&2; exit 1; }
  (cd "$ROOT/ui" && npm ci)
}

wmediumd_build() {
  say "wmediumd (signal model) with the sniffer patch"
  for tool in git make gcc pkg-config; do
    command -v "$tool" >/dev/null || { echo "$tool not found: sudo apt install -y build-essential git pkg-config" >&2; exit 1; }
  done
  pkg-config --exists libnl-3.0 libnl-genl-3.0 libevent libconfig ||
    { echo "build libraries missing: sudo apt install -y libnl-3-dev libnl-genl-3-dev libevent-dev libconfig-dev" >&2; exit 1; }
  if [[ ! -d $WM_DIR/.git ]]; then
    git clone "$WM_URL" "$WM_DIR"
    git -C "$WM_DIR" checkout --quiet "$WM_COMMIT"
  fi
  if git -C "$WM_DIR" apply --reverse --check "$ROOT/vendor/wmediumd-sniffer.patch" 2>/dev/null; then
    echo "patch already applied"
  else
    git -C "$WM_DIR" apply "$ROOT/vendor/wmediumd-sniffer.patch"
    echo "patch applied"
  fi
  make -C "$WM_DIR/wmediumd" clean >/dev/null 2>&1 || true # a stale object file once broke position updates
  make -C "$WM_DIR/wmediumd"
  echo "built $WM_DIR/wmediumd/wmediumd"
}

case ${1:-all} in
  python) python_env ;;
  ui) ui_packages ;;
  wmediumd) wmediumd_build ;;
  all) python_env; ui_packages; wmediumd_build ;;
  *) echo "usage: $0 [all|python|ui|wmediumd]" >&2; exit 2 ;;
esac

say "Done. Check everything with scripts/smoke-test.sh"
