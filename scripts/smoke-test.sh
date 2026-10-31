#!/usr/bin/env bash
# Wi-Fi Verse smoke test: checks that everything the project needs is installed and, for anything missing,
# prints the command that fixes it. Read-only: it installs nothing and needs no root.
#
# Usage: scripts/smoke-test.sh           check the machine
#        scripts/smoke-test.sh --live    also run the end-to-end API test (the API must already be running)
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIVE=0
[[ ${1:-} == --live ]] && LIVE=1

if [[ -t 1 ]]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'; else G=; R=; Y=; B=; N=; fi
PASS=0; FAIL=0; WARN=0
APT=()      # apt packages to install
STEPS=()    # other fixes, as commands

ok()      { printf '  %s[ ok ]%s %s\n' "$G" "$N" "$1"; PASS=$((PASS + 1)); }
bad()     { printf '  %s[FAIL]%s %s\n' "$R" "$N" "$1"; FAIL=$((FAIL + 1)); }
warn()    { printf '  %s[warn]%s %s\n' "$Y" "$N" "$1"; WARN=$((WARN + 1)); }
info()    { printf '         %s\n' "$1"; }
section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
need_apt() { local p; for p in "$@"; do [[ " ${APT[*]:-} " == *" $p "* ]] || APT+=("$p"); done; }
need_step() { local s; for s in "${STEPS[@]:-}"; do [[ $s == "$1" ]] && return; done; STEPS+=("$1"); }
ver_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1) == "$2" ]]; } # ver_ge have want

# Node installed through nvm is not on PATH in a non-interactive shell.
if ! command -v node >/dev/null && [[ -s $HOME/.nvm/nvm.sh ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

printf '%sWi-Fi Verse smoke test%s  (%s)\n' "$B" "$N" "$ROOT"

section "System"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ ${ID:-} == ubuntu || ${ID:-} == debian || ${ID_LIKE:-} == *debian* ]]; then
    ok "${PRETTY_NAME:-$ID} (apt based, the install commands below apply)"
  else
    warn "${PRETTY_NAME:-unknown OS}: the install commands below use apt; use your distribution's package names"
  fi
fi
ok "kernel $(uname -r), $(uname -m)"

if [[ $(lsmod | awk '$1 == "mac80211_hwsim"') ]]; then
  warn "mac80211_hwsim is already loaded; the lab refuses to start while something else uses it"
  info "unload it when nothing needs it:  sudo modprobe -r mac80211_hwsim"
elif modinfo mac80211_hwsim >/dev/null 2>&1; then
  ok "kernel module mac80211_hwsim is available"
else
  bad "kernel module mac80211_hwsim not found (it provides the virtual radios)"
  need_apt "linux-modules-extra-$(uname -r)"
  info "on a custom or cloud kernel, rebuild it with CONFIG_MAC80211_HWSIM=m"
fi

if [[ -e /proc/self/ns/net ]] && command -v ip >/dev/null; then
  ok "network namespaces are supported"
else
  bad "network namespaces are not available"
fi

if sudo -n true 2>/dev/null; then
  ok "sudo works without a password (the API runs as root)"
else
  bad "sudo asks for a password; the API is started with 'sudo -n'"
  need_step "echo \"\$USER ALL=(ALL) NOPASSWD:ALL\" | sudo tee /etc/sudoers.d/wifiverse && sudo chmod 440 /etc/sudoers.d/wifiverse   # or run scripts/labd.sh from a root shell instead"
fi

section "Programs"
# command  apt-package
for pair in "hostapd:hostapd" "hostapd_cli:hostapd" "wpa_supplicant:wpasupplicant" "wpa_cli:wpasupplicant" \
  "iw:iw" "ip:iproute2" "ping:iputils-ping" "tcpdump:tcpdump" "tshark:tshark" "git:git" "pkg-config:pkg-config" \
  "gcc:build-essential" "make:build-essential" "python3:python3"; do
  cmd=${pair%%:*}; pkg=${pair##*:}
  if command -v "$cmd" >/dev/null; then ok "$cmd"; else bad "$cmd not found"; need_apt "$pkg"; fi
done
command -v nmcli >/dev/null && info "NetworkManager found: the lab keeps its virtual radios unmanaged and never touches your real Wi-Fi"

section "hostapd, wpa_supplicant and tshark features"
if command -v hostapd >/dev/null; then
  v=$(hostapd -v 2>&1 | sed -n 's/^hostapd v\([0-9.]*\).*/\1/p' | head -1)
  if [[ -n $v ]] && ver_ge "$v" 2.10; then ok "hostapd $v (2.10 or newer)"; else bad "hostapd ${v:-unknown} is too old (2.10 or newer needed for WPA3 and OWE)"; need_apt hostapd; fi
  hostapd -h 2>&1 | grep -q -- ' -K' && ok "hostapd can log keys (-K), used to decrypt captures" || { bad "hostapd has no -K option"; need_apt hostapd; }
  for feat in SAE OWE FT-PSK; do
    grep -aq -- "$feat" "$(command -v hostapd)" && ok "hostapd built with $feat" || { bad "hostapd lacks $feat (use the distribution's full hostapd build)"; need_apt hostapd; }
  done
fi
if command -v wpa_supplicant >/dev/null; then
  v=$(wpa_supplicant -v 2>&1 | sed -n 's/^wpa_supplicant v\([0-9.]*\).*/\1/p' | head -1)
  if [[ -n $v ]] && ver_ge "$v" 2.10; then ok "wpa_supplicant $v (2.10 or newer)"; else bad "wpa_supplicant ${v:-unknown} is too old (2.10 or newer)"; need_apt wpasupplicant; fi
  wpa_supplicant -h 2>&1 | grep -q -- ' -K' && ok "wpa_supplicant can log keys (-K)" || { bad "wpa_supplicant has no -K option"; need_apt wpasupplicant; }
  for feat in SAE OWE FT-PSK; do
    grep -aq -- "$feat" "$(command -v wpa_supplicant)" && ok "wpa_supplicant built with $feat" || { bad "wpa_supplicant lacks $feat"; need_apt wpasupplicant; }
  done
fi
if command -v tshark >/dev/null; then
  v=$(tshark --version 2>/dev/null | sed -n 's/^TShark (Wireshark) \([0-9.]*\).*/\1/p' | head -1)
  if [[ -n $v ]] && ver_ge "$v" 4.0; then ok "tshark $v"; else warn "tshark ${v:-unknown}: tested with 4.2, older versions may reject the display filters"; fi
fi

section "Python"
if command -v python3 >/dev/null; then
  pv=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  if ver_ge "$pv" 3.10; then ok "python $pv (3.10 or newer)"; else bad "python $pv is too old (3.10 or newer needed)"; need_apt python3; fi
  if python3 -c 'import ensurepip, venv' 2>/dev/null; then ok "python3-venv"; else bad "python3-venv is missing"; need_apt python3-venv python3-pip; fi
fi
if [[ -x $ROOT/.venv/bin/python ]]; then
  missing=$("$ROOT/.venv/bin/python" - <<'EOF'
import importlib.util
print(" ".join(m for m in ("fastapi", "uvicorn", "pydantic", "websockets", "httpx", "cryptography") if importlib.util.find_spec(m) is None))
EOF
)
  if [[ -z $missing ]]; then ok "virtualenv .venv has fastapi, uvicorn, pydantic, websockets, httpx, cryptography"; else
    bad ".venv is missing: $missing"; need_step "scripts/setup.sh python"; fi
else
  bad "virtualenv .venv not created yet"; need_step "scripts/setup.sh python"
fi

section "Web UI"
if command -v node >/dev/null; then
  nv=$(node --version | sed 's/^v//')
  if ver_ge "$nv" 20.19; then ok "node $nv (20.19 or newer)"; else
    bad "node $nv is too old (Vite 7 needs 20.19 or newer, 22 recommended)"
    need_step "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22"; fi
  command -v npm >/dev/null && ok "npm $(npm --version)" || bad "npm not found (it comes with node)"
else
  bad "node not found"
  need_step "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 22"
fi
if [[ -x $ROOT/ui/node_modules/.bin/vite ]]; then ok "UI packages installed (ui/node_modules)"; else bad "UI packages not installed"; need_step "scripts/setup.sh ui"; fi

section "wmediumd (the signal model)"
WM=$ROOT/vendor/wmediumd/wmediumd/wmediumd
if [[ -x $WM ]]; then
  ok "wmediumd is built"
  if git -C "$ROOT/vendor/wmediumd" apply --reverse --check ../wmediumd-sniffer.patch >/dev/null 2>&1; then
    ok "sniffer patch applied"
  else
    warn "the sniffer patch does not look applied; sniffers would hear nothing"
    need_step "scripts/setup.sh wmediumd"
  fi
else
  bad "wmediumd is not built"
  need_step "scripts/setup.sh wmediumd"
  if command -v pkg-config >/dev/null; then
    for lib in "libnl-3.0:libnl-3-dev" "libnl-genl-3.0:libnl-genl-3-dev" "libevent:libevent-dev" "libconfig:libconfig-dev"; do
      pkg-config --exists "${lib%%:*}" 2>/dev/null || { bad "library ${lib%%:*} (needed to build wmediumd) not found"; need_apt "${lib##*:}"; }
    done
  fi
fi

section "State of this machine"
if [[ -n $(ip netns list 2>/dev/null | grep '^wl_') ]]; then
  warn "leftover lab namespaces found (a lab was not stopped)"; info "clean up:  sudo scripts/lab.sh down"
else
  ok "no leftover lab namespaces"
fi
if command -v iw >/dev/null; then
  real=$(iw dev 2>/dev/null | awk '/Interface/ && $2 !~ /^(hwsim|wlan[0-9]+$)/ {printf "%s ", $2}')
  info "real Wi-Fi interfaces seen: ${real:-none} (the lab never touches them)"
fi
for port in 8787 5173; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$port\$"; then
    if [[ $port == 8787 ]] && curl -fs "http://127.0.0.1:8787/api/health" >/dev/null 2>&1; then ok "port 8787: the Wi-Fi Verse API is running"; else info "port $port is in use (by a running Wi-Fi Verse, or by something else)"; fi
  else
    ok "port $port is free"
  fi
done

if (( LIVE )); then
  section "Live API test"
  if curl -fs "http://127.0.0.1:8787/api/health" >/dev/null 2>&1 && [[ -x $ROOT/.venv/bin/python ]]; then
    if "$ROOT/.venv/bin/python" "$ROOT/tests/smoke_api.py" ft; then ok "API end-to-end test passed"; else bad "API end-to-end test failed"; fi
  else
    bad "the API is not running on 127.0.0.1:8787"; need_step "scripts/labd.sh   # in its own terminal, then repeat --live"
  fi
fi

printf '\n%s%d ok, %d warnings, %d failed%s\n' "$B" "$PASS" "$WARN" "$FAIL" "$N"
if (( FAIL )); then
  printf '\nTo fix what is missing:\n'
  n=1
  if (( ${#APT[@]} )); then printf '  %d. sudo apt update && sudo apt install -y %s\n' "$n" "${APT[*]}"; n=$((n + 1)); fi
  for s in "${STEPS[@]:-}"; do [[ -n $s ]] && { printf '  %d. %s\n' "$n" "$s"; n=$((n + 1)); }; done
  printf '\nThen run this script again.\n'
  exit 1
fi
printf '\nEverything needed is in place. Start with:  scripts/labd.sh   and   cd ui && npm run dev\n'
