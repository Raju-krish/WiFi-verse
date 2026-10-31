#!/usr/bin/env bash
# 2 APs + 1 client on mac80211_hwsim (one netns each) behind a wired distribution system.
# Captures a roam on hwsim0, decrypts it with keys from the -K logs, and measures it.
# Usage: sudo scripts/lab.sh demo [ft|psk]    one roam, readable output (KEEP=1 leaves the lab running)
#        sudo scripts/lab.sh walk [ft|psk]    client walks from AP1 to AP2 on a path-loss model; roam is signal-driven
#        sudo scripts/lab.sh compare [N] [walk]  N rounds of ft + psk, then a summary table
#        sudo scripts/lab.sh down             tear down anything left over
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=$HERE/../tools/wifilab.py
WMEDIUM=$HERE/../tools/wmedium.py
WM_BIN=$HERE/../vendor/wmediumd/wmediumd/wmediumd
WM_SOCK=/var/run/wmediumd.sock
# Positions in metres; log-distance model, 10 dBm tx, exponent 3.5.
AP1_X=0
AP2_X=40
STA_X0=2
STA_X1=38
WALK_SPEED=3
WM_TX=10
WM_EXP=3.5
LAB=/run/wifilab
OWNER=${SUDO_USER:-root}
RUNS_DIR=$(cd "$HERE/.." && pwd)/runs
SSID=LabNet
PSK=labpassword123
MD=4f57
NS_AP1=wl_ap1
NS_AP2=wl_ap2
NS_STA=wl_sta1
NS_DS=wl_ds
IP_GW=10.10.0.254
IP_STA=10.10.0.10
CAP_TMP=/tmp/wifilab-capture.pcap # dumpcap's AppArmor profile only allows /tmp and user dirs

say() { [[ ${QUIET:-0} == 1 ]] || echo "$@"; }
ns() { local n=$1; shift; ip netns exec "$n" "$@"; }

retry() { # seconds cmd...
  local end=$((SECONDS + $1)); shift
  until "$@" >/dev/null 2>&1; do
    (( SECONDS < end )) || return 1
    sleep 0.3
  done
}

hwsim_phys() {
  local p
  for p in /sys/class/ieee80211/phy*; do
    if [[ $(readlink -f "$p/device") == *mac80211_hwsim* ]]; then basename "$p"; fi
  done | sort -V
}

hwsim_loaded() { grep -q '^mac80211_hwsim ' /proc/modules; }
have_phys() { (( $(hwsim_phys | wc -l) >= 3 )); }
ns_if() { ns "$1" iw dev | awk '$1=="Interface" && !s {print $2; s=1}'; }
ns_has_if() { [[ -n $(ns_if "$1") ]]; }
ns_mac() { ns "$1" cat "/sys/class/net/$2/address"; }

down() {
  local f pid n i run_dir
  for f in "$LAB"/*.pid; do
    [[ -e $f ]] || continue
    pid=$(<"$f")
    kill "$pid" 2>/dev/null || true
    for i in $(seq 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    rm -f "$f"
  done
  for n in $NS_AP1 $NS_AP2 $NS_STA $NS_DS; do ip netns del "$n" 2>/dev/null || true; done
  if [[ -e $LAB/state ]]; then
    run_dir=$(<"$LAB/state")
    if [[ -f $CAP_TMP && -d $run_dir && ! -f $run_dir/capture.pcap ]]; then cp "$CAP_TMP" "$run_dir/capture.pcap"; fi
    chmod 600 "$run_dir"/*.log "$run_dir"/*.conf "$run_dir"/*.pcap "$run_dir"/*.json 2>/dev/null || true
    chown -R "$OWNER": "$RUNS_DIR" 2>/dev/null || true
  fi
  rm -f "$CAP_TMP"
  if [[ -e $LAB/state ]] && hwsim_loaded; then
    modprobe -r mac80211_hwsim || echo "warning: could not unload mac80211_hwsim" >&2
  fi
  rm -rf "$LAB" "$WM_SOCK"
}

nm_unmanaged() {
  local f=/etc/NetworkManager/conf.d/90-wifilab-unmanaged.conf
  [[ -e $f ]] && return 0
  [[ -d /etc/NetworkManager/conf.d ]] || return 0
  printf '[keyfile]\nunmanaged-devices=driver:mac80211_hwsim;interface-name:hwsim*\n' > "$f"
  nmcli general reload conf 2>/dev/null || true
}

# Each AP bridges its wlan to a veth that plugs into a shared switch holding the gateway IP,
# so the gateway MAC stays constant across a roam, as in a real wired distribution system.
build_ds() {
  local i ap
  ip netns add $NS_DS
  ns $NS_DS ip link set lo up
  ns $NS_DS ip link add br-ds type bridge
  ns $NS_DS ip addr add $IP_GW/24 dev br-ds
  ns $NS_DS ip link set br-ds up
  for i in 1 2; do
    ap=wl_ap$i
    ip -n "$ap" link add "vap$i" type veth peer name "vds$i" netns $NS_DS
    ns "$ap" ip link add br0 type bridge
    ns "$ap" ip link set "vap$i" master br0
    ns "$ap" ip link set "vap$i" up
    ns "$ap" ip link set br0 up
    ns $NS_DS ip link set "vds$i" master br-ds
    ns $NS_DS ip link set "vds$i" up
  done
}

ap_conf() { # file ctrl_name ifname channel nas_id bssid mode
  local file=$1 ctrl=$2 ifname=$3 chan=$4 nas=$5 bssid=$6 mode=$7
  {
    echo "interface=$ifname"
    echo "bridge=br0"
    echo "driver=nl80211"
    echo "ctrl_interface=$LAB/$ctrl"
    echo "ssid=$SSID"
    echo "hw_mode=g"
    echo "channel=$chan"
    echo "wpa=2"
    echo "wpa_passphrase=$PSK"
    echo "rsn_pairwise=CCMP"
    echo "ieee80211w=0"
    if [[ ${MEDIUM:-perfect} == wmediumd ]]; then
      # wmediumd's rate table is OFDM only, so drop the 802.11b rates.
      echo "supported_rates=60 90 120 180 240 360 480 540"
      echo "basic_rates=60 120 240"
    fi
    if [[ $mode == ft ]]; then
      echo "wpa_key_mgmt=FT-PSK"
      echo "mobility_domain=$MD"
      echo "nas_identifier=$nas"
      echo "r1_key_holder=${bssid//:/}"
      echo "ft_psk_generate_local=1"
      echo "ft_over_ds=0"
    else
      echo "wpa_key_mgmt=WPA-PSK"
    fi
  } > "$file"
}

ap_enabled() { [[ $(ns "$1" hostapd_cli -p "$LAB/$2" -i "$3" status 2>/dev/null) == *state=ENABLED* ]]; }
sta_cli() { ns "$NS_STA" wpa_cli -p "$LAB/sta1" -i "$STA_IF" "$@" 2>/dev/null; }
sta_on() { local s; s=$(sta_cli status); [[ $s == *wpa_state=COMPLETED* && $s == *"bssid=$1"* ]]; }
sta_sees() { [[ $(sta_cli scan_results) == *"$1"* ]]; }
gw_reachable() { ns $NS_STA ping -c 1 -W 1 $IP_GW; }

timeline() { # pcap roam_epoch
  tshark -r "$1" -Y '(wlan.fc.type_subtype in {0,1,2,3,10,11,12,13}) || eapol' -T fields \
    -e frame.time_epoch -e wlan.fc.type_subtype -e wlan.sa -e wlan.da \
    -e wlan.fixed.auth.alg -e wlan.fixed.status_code -e wlan_rsna_eapol.keydes.msgnr 2>/dev/null |
  awk -F'\t' -v t0="$2" '
    BEGIN {
      n["0x0000"]="AssocReq"; n["0x0001"]="AssocResp"; n["0x0002"]="ReassocReq"; n["0x0003"]="ReassocResp"
      n["0x000a"]="Disassoc"; n["0x000b"]="Auth"; n["0x000c"]="Deauth"; n["0x000d"]="Action"
    }
    $2 == "0x000c" { next }
    {
      if (!start) start = $1
      if (!marked && $1 >= t0) { printf "  ------------- ROAM TRIGGERED (t=%.4f) -------------\n", $1 - start; marked = 1 }
      name = ($7 != "") ? "EAPOL-Key M" $7 : ($2 in n ? n[$2] : "data/" $2)
      extra = ""
      if ($5 != "") extra = extra " alg=" $5 ($5 == 2 ? "(FT)" : $5 == 0 ? "(open)" : "")
      if ($6 != "") extra = extra " status=" $6
      printf "  %9.4f  %-14s %s -> %s%s\n", $1 - start, name, $3, $4, extra
    }'
}

demo() {
  local mode=${1:-ft}
  [[ $mode == ft || $mode == psk ]] || { echo "mode must be ft or psk" >&2; exit 1; }
  [[ -e $LAB/state ]] && { echo "lab already up; run: $0 down" >&2; exit 1; }
  if hwsim_loaded; then
    echo "mac80211_hwsim already loaded by something else; refusing to touch it" >&2; exit 1
  fi

  local run_dir=$RUNS_DIR/$(date +%Y%m%d-%H%M%S)-$mode
  mkdir -p "$LAB" "$run_dir"
  echo "$run_dir" > "$LAB/state"
  [[ ${KEEP:-0} == 1 ]] || trap down EXIT

  nm_unmanaged
  say "[1/7] loading mac80211_hwsim (3 radios)"
  modprobe mac80211_hwsim radios=3
  retry 10 have_phys || { echo "hwsim radios did not appear" >&2; exit 1; }
  local phys; mapfile -t phys < <(hwsim_phys)

  say "[2/7] moving radios into namespaces, building wired distribution system"
  local i names=("$NS_AP1" "$NS_AP2" "$NS_STA")
  for i in 0 1 2; do
    ip netns add "${names[$i]}"
    iw phy "${phys[$i]}" set netns name "${names[$i]}"
    retry 5 ns_has_if "${names[$i]}" || { echo "no interface in ${names[$i]}" >&2; exit 1; }
    ns "${names[$i]}" ip link set lo up
  done
  build_ds
  local AP1_IF AP2_IF AP1_BSSID AP2_BSSID STA_MAC
  AP1_IF=$(ns_if $NS_AP1); AP2_IF=$(ns_if $NS_AP2); STA_IF=$(ns_if $NS_STA)
  AP1_BSSID=$(ns_mac $NS_AP1 "$AP1_IF"); AP2_BSSID=$(ns_mac $NS_AP2 "$AP2_IF"); STA_MAC=$(ns_mac $NS_STA "$STA_IF")
  say "      AP1 $AP1_IF $AP1_BSSID | AP2 $AP2_IF $AP2_BSSID | STA $STA_IF $STA_MAC"

  if [[ ${MEDIUM:-perfect} == wmediumd ]]; then
    say "      starting wmediumd (path loss: AP1 x=$AP1_X, AP2 x=$AP2_X, client x=$STA_X0)"
    python3 "$WMEDIUM" mkconfig --out "$run_dir/wmediumd.cfg" --tx "$WM_TX" --exp "$WM_EXP" \
      --node "$AP1_BSSID,$AP1_X,0,0" --node "$AP2_BSSID,$AP2_X,0,0" --node "$STA_MAC,$STA_X0,0,0"
    "$WM_BIN" -c "$run_dir/wmediumd.cfg" -s -l 5 > "$run_dir/wmediumd.log" 2>&1 &
    echo $! > "$LAB/wmediumd.pid"
    retry 10 test -S "$WM_SOCK" || { echo "wmediumd did not start, see $run_dir/wmediumd.log" >&2; exit 1; }
  fi

  say "[3/7] starting capture on hwsim0"
  ip link set hwsim0 up
  dumpcap -q -i hwsim0 -P -w "$CAP_TMP" >/dev/null 2>&1 &
  echo $! > "$LAB/dumpcap.pid"

  say "[4/7] starting APs ($mode, channels 1 and 6)"
  ap_conf "$run_dir/ap1.conf" ap1 "$AP1_IF" 1 ap1.lab "$AP1_BSSID" "$mode"
  ap_conf "$run_dir/ap2.conf" ap2 "$AP2_IF" 6 ap2.lab "$AP2_BSSID" "$mode"
  ns $NS_AP1 hostapd -B -P "$LAB/ap1.pid" -dd -K -t -f "$run_dir/ap1.log" "$run_dir/ap1.conf" >/dev/null
  ns $NS_AP2 hostapd -B -P "$LAB/ap2.pid" -dd -K -t -f "$run_dir/ap2.log" "$run_dir/ap2.conf" >/dev/null
  retry 10 ap_enabled $NS_AP1 ap1 "$AP1_IF" || { echo "AP1 failed, see $run_dir/ap1.log" >&2; exit 1; }
  retry 10 ap_enabled $NS_AP2 ap2 "$AP2_IF" || { echo "AP2 failed, see $run_dir/ap2.log" >&2; exit 1; }

  say "[5/7] starting client, pinned to AP1"
  local kmgmt=WPA-PSK; [[ $mode == ft ]] && kmgmt=FT-PSK
  local pin="bssid=$AP1_BSSID"
  # In walk mode the client picks the strongest AP itself and roams on a signal threshold.
  [[ ${MEDIUM:-perfect} == wmediumd ]] && pin='bgscan="simple:1:-65:5"'
  cat > "$run_dir/sta1.conf" <<EOF
ctrl_interface=$LAB/sta1
network={
  ssid="$SSID"
  psk="$PSK"
  key_mgmt=$kmgmt
  proto=RSN
  pairwise=CCMP
  group=CCMP
  ieee80211w=0
  $pin
  freq_list=2412 2437
  scan_freq=2412 2437
}
EOF
  ns $NS_STA wpa_supplicant -B -P "$LAB/sta1.pid" -D nl80211 -i "$STA_IF" -c "$run_dir/sta1.conf" \
    -dd -K -t -f "$run_dir/sta1.log" >/dev/null
  retry 20 sta_on "$AP1_BSSID" || { echo "client did not connect to AP1, see $run_dir/sta1.log" >&2; exit 1; }
  ns $NS_STA ip addr add $IP_STA/24 dev "$STA_IF"
  retry 10 gw_reachable || { echo "client cannot reach gateway through AP1" >&2; exit 1; }
  # A post-roam ARP retry adds a fixed 1 s that would hide the 802.11 difference, so pin the gateway.
  ns $NS_STA ip neigh replace $IP_GW lladdr "$(ns_mac $NS_DS br-ds)" dev "$STA_IF" nud permanent
  say "      connected to AP1, gateway $IP_GW reachable"
  if [[ ${MEDIUM:-perfect} != wmediumd ]]; then
    sta_cli scan freq=2412,2437 >/dev/null
    retry 15 sta_sees "$AP2_BSSID" || { echo "AP2 not in scan results" >&2; exit 1; }
  fi

  ns $NS_STA stdbuf -oL ping -D -i 0.02 -O $IP_GW > "$run_dir/ping.log" 2>&1 &
  echo $! > "$LAB/ping.pid"
  sleep 1
  local t_roam; t_roam=$(date +%s.%N)
  if [[ ${MEDIUM:-perfect} == wmediumd ]]; then
    say "[6/7] client walks x=$STA_X0 -> $STA_X1 m at $WALK_SPEED m/s; the roam is signal-driven (bgscan below -65 dBm)"
    python3 "$WMEDIUM" walk --mac "$STA_MAC" --from-x "$STA_X0" --to-x "$STA_X1" --speed "$WALK_SPEED" \
      --netns $NS_STA --ctrl "$LAB/sta1" --iface "$STA_IF" --out "$run_dir/track.csv"
    sta_on "$AP2_BSSID" || { echo "client never roamed to AP2, see $run_dir/track.csv and sta1.log" >&2; exit 1; }
  else
    say "[6/7] roaming AP1 -> AP2 under a 20 ms ping"
    sta_cli set_network 0 bssid "$AP2_BSSID" >/dev/null
    sta_cli select_network 0 >/dev/null
    sta_cli scan freq=2412,2437 >/dev/null # select_network alone never starts a scan while connected
    retry 20 sta_on "$AP2_BSSID" || { echo "roam failed, see $run_dir/sta1.log" >&2; exit 1; }
    sleep 2
  fi
  kill "$(<"$LAB/ping.pid")" 2>/dev/null || true
  rm -f "$LAB/ping.pid"
  say "      now on: $(sta_cli status | grep -E '^(bssid|freq|key_mgmt)=' | tr '\n' ' ')"

  say "[7/7] stopping capture and analysing"
  kill -INT "$(<"$LAB/dumpcap.pid")" 2>/dev/null || true
  wait "$(<"$LAB/dumpcap.pid")" 2>/dev/null || true
  rm -f "$LAB/dumpcap.pid"
  cp "$CAP_TMP" "$run_dir/capture.pcap" && rm -f "$CAP_TMP"
  printf '{"mode":"%s","t_roam":%s,"sta_mac":"%s","ap1_bssid":"%s","ap2_bssid":"%s"}\n' \
    "$mode" "$t_roam" "$STA_MAC" "$AP1_BSSID" "$AP2_BSSID" > "$run_dir/roam.json"
  if [[ ${QUIET:-0} != 1 ]]; then
    echo
    echo "Frame exchange (beacons, probes and deauth hidden; data frames are encrypted in this view):"
    timeline "$run_dir/capture.pcap" "$t_roam" || echo "  (timeline failed)"
  fi
  python3 "$TOOLS" analyze "$run_dir" > "$run_dir/analysis.txt" || { cat "$run_dir/analysis.txt" >&2; exit 1; }
  say "$(<"$run_dir/analysis.txt")"
  chmod 600 "$run_dir"/*.log "$run_dir"/*.conf "$run_dir"/*.pcap "$run_dir"/*.json "$run_dir"/analysis.txt "$run_dir"/*.csv "$run_dir"/*.cfg 2>/dev/null || true
  chown -R "$OWNER": "$RUNS_DIR"
  say
  say "Artifacts: $run_dir (logs and keys.json contain secrets; keep local)"
  [[ ${QUIET:-0} == 1 ]] && echo "$run_dir"
  return 0
}

compare() {
  local n=${1:-5} i m dir runs=()
  [[ ${2:-} == walk ]] && export MEDIUM=wmediumd
  for i in $(seq "$n"); do
    for m in ft psk; do
      echo "round $i/$n: $m" >&2
      dir=$(QUIET=1 "$0" demo "$m" | tail -1)
      [[ -f $dir/metrics.json ]] || { echo "run failed ($m, round $i); see messages above" >&2; exit 1; }
      runs+=("$dir")
    done
  done
  python3 "$TOOLS" compare "${runs[@]}"
  chown -R "$OWNER": "$RUNS_DIR"
}

case ${1:-} in
  demo) demo "${2:-ft}" ;;
  walk) MEDIUM=wmediumd demo "${2:-ft}" ;;
  compare) compare "${2:-5}" "${3:-}" ;;
  down) down ;;
  *) echo "usage: $0 demo [ft|psk] | walk [ft|psk] | compare [N] [walk] | down" >&2; exit 1 ;;
esac
