"""Brings a Topology up as real hostapd / wpa_supplicant processes on mac80211_hwsim behind wmediumd.

Needs root. Every external command is an argv list built from validated model fields; no shell is involved
except the fixed wpa_cli one-liner in wmedium.poll_station.
"""
import logging
import os
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from wmedium import Medium, make_config, poll_station

from . import ROOT
from .models import Ap, Security, Sniffer, Sta, Topology

log = logging.getLogger("labd.engine")

LAB = Path("/run/wifilab")
WM_BIN = ROOT / "vendor/wmediumd/wmediumd/wmediumd"
WM_SOCK = Path("/var/run/wmediumd.sock")
RUNS_DIR = ROOT / "runs"
OWNER = os.environ.get("WIFILAB_OWNER", "root")
NS_DS = "wl_ds"
IP_GW = "10.10.0.254"
MOBILITY_DOMAIN = "4f57"
# What a client is wrongly configured with, per what the AP really offers (fault security_mismatch).
MISMATCH = {Security.open: Security.wpa2, Security.owe: Security.wpa2, Security.wpa2: Security.wpa3,
            Security.wpa3: Security.wpa2, Security.ft: Security.wpa2}
MAC_RE = re.compile(r"^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$", re.M)


class EngineError(RuntimeError):
    pass


def sh(*args: str, ns: Optional[str] = None, check: bool = True) -> str:
    cmd = ["ip", "netns", "exec", ns, *args] if ns else list(args)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if check and r.returncode != 0:
        raise EngineError(f"{' '.join(cmd)} failed: {(r.stderr or r.stdout).strip()}")
    return r.stdout


def retry(seconds: float, fn: Callable[[], bool], interval: float = 0.3) -> bool:
    end = time.monotonic() + seconds
    while True:
        try:
            if fn():
                return True
        except EngineError:
            pass
        if time.monotonic() >= end:
            return False
        time.sleep(interval)


def hwsim_loaded() -> bool:
    return any(line.startswith("mac80211_hwsim ") for line in Path("/proc/modules").read_text().splitlines())


def hwsim_phys() -> list:
    out = []
    for p in sorted(Path("/sys/class/ieee80211").glob("phy*"), key=lambda q: int(q.name[3:])):
        if "mac80211_hwsim" in str((p / "device").resolve()):
            out.append(p.name)
    return out


def ns_iface(ns: str) -> str:
    for line in sh("iw", "dev", ns=ns, check=False).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "Interface":
            return parts[1]
    return ""


@dataclass
class Runtime:
    node: object
    index: int
    ns: str
    iface: str = ""
    mac: str = ""
    ip: str = ""

    @property
    def ctrl(self) -> str:
        return str(LAB / self.node.id)


class LabEngine:
    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.state = "stopped"
        self.topo: Optional[Topology] = None
        self.run_dir: Optional[Path] = None
        self.rt: dict = {}
        self._ft_keys: dict = {}
        self._ds: dict = {}
        self.macs: dict = {}  # node id -> MAC, kept after stop so the UI can still label saved frames
        self.capture_hook: Optional[Callable[[Path, list, dict], None]] = None
        self._wm: Optional[subprocess.Popen] = None
        self._medium: Optional[Medium] = None
        self._mlock = threading.Lock()
        self._lock = threading.RLock()

    # ---- lifecycle -------------------------------------------------------------------------------------------

    def _set_state(self, state: str, error: Optional[str] = None) -> None:
        self.state = state
        self.emit({"type": "lab", "state": state, "error": error})

    def start(self, topo: Topology) -> None:
        with self._lock:
            if self.state != "stopped":
                raise EngineError(f"lab is {self.state}")
            if hwsim_loaded():
                raise EngineError("mac80211_hwsim is already loaded by something else; refusing to touch it")
            self._set_state("starting")
        try:
            self._bring_up(topo)
        except Exception as exc:
            log.exception("lab start failed")
            self._teardown()
            self._set_state("stopped", str(exc))
            raise exc if isinstance(exc, EngineError) else EngineError(str(exc)) from exc
        self._set_state("running")

    def stop(self) -> None:
        with self._lock:
            if self.state in ("stopped", "stopping"):
                return
            self._set_state("stopping")
            self._teardown()
            self._set_state("stopped")

    def _bring_up(self, topo: Topology) -> None:
        nodes = topo.ordered()
        self.topo = topo
        self.run_dir = RUNS_DIR / f"{datetime.now():%Y%m%d-%H%M%S}-{topo.security.value}"
        self.run_dir.mkdir(parents=True)
        LAB.mkdir(parents=True, exist_ok=True)
        (LAB / "state").write_text(str(self.run_dir))
        self._nm_unmanaged()

        sh("modprobe", "mac80211_hwsim", f"radios={len(nodes)}")
        if not retry(10, lambda: len(hwsim_phys()) >= len(nodes)):
            raise EngineError("hwsim radios did not appear")
        phys = hwsim_phys()
        self.rt = {}
        self._ft_keys = {}
        self._ds = {}
        self.macs = {}
        for i, node in enumerate(nodes):
            rt = Runtime(node=node, index=i, ns=f"wl_{node.id}")
            self.rt[node.id] = rt
            sh("ip", "netns", "add", rt.ns)
            sh("iw", "phy", phys[i], "set", "netns", "name", rt.ns)
            if not retry(5, lambda r=rt: bool(ns_iface(r.ns))):
                raise EngineError(f"no wireless interface appeared in {rt.ns}")
            rt.iface = ns_iface(rt.ns)
            rt.mac = sh("cat", f"/sys/class/net/{rt.iface}/address", ns=rt.ns).strip()
            self.macs[node.id] = rt.mac
            sh("ip", "link", "set", "lo", "up", ns=rt.ns)

        self._build_ds()
        self._start_wmediumd(nodes, topo)
        self._setup_sniffers()

        sh("ip", "link", "set", "hwsim0", "up")
        sources = [{"id": "global", "ns": None, "iface": "hwsim0"}]
        sources += [{"id": r.node.id, "ns": r.ns, "iface": r.iface} for r in self.rt.values() if r.node.kind == "sniffer"]
        logs = {r.node.id: self.run_dir / f"{r.node.id}.log" for r in self.rt.values() if r.node.kind != "sniffer"}
        if self.capture_hook:
            self.capture_hook(self.run_dir, sources, logs)

        for rt in self.rt.values():
            if rt.node.kind == "ap":
                self._start_ap(rt, topo)
        channels = sorted({r.node.channel for r in self.rt.values() if r.node.kind == "ap"})
        stas = [r for r in self.rt.values() if r.node.kind == "sta"]
        for k, rt in enumerate(stas):
            self._start_sta(rt, topo, channels, k)
        retry(4 if topo.fault != "none" else 20, lambda: all(self._sta_connected(r) for r in stas))

    def _build_ds(self) -> None:
        """Each AP bridges its wlan to a veth into a shared switch holding the gateway, so the gateway MAC survives a roam."""
        sh("ip", "netns", "add", NS_DS)
        sh("ip", "link", "set", "lo", "up", ns=NS_DS)
        sh("ip", "link", "add", "br-ds", "type", "bridge", ns=NS_DS)
        sh("ip", "addr", "add", f"{IP_GW}/24", "dev", "br-ds", ns=NS_DS)
        sh("ip", "link", "set", "br-ds", "up", ns=NS_DS)
        for rt in self.rt.values():
            if rt.node.kind != "ap":
                continue
            v, d = f"v{rt.node.id}", f"d{rt.node.id}"
            sh("ip", "-n", rt.ns, "link", "add", v, "type", "veth", "peer", "name", d, "netns", NS_DS)
            sh("ip", "link", "add", "br0", "type", "bridge", ns=rt.ns)
            sh("ip", "link", "set", v, "master", "br0", ns=rt.ns)
            sh("ip", "link", "set", v, "up", ns=rt.ns)
            sh("ip", "link", "set", "br0", "up", ns=rt.ns)
            sh("ip", "link", "set", d, "master", "br-ds", ns=NS_DS)
            sh("ip", "link", "set", d, "up", ns=NS_DS)
        self.gw_mac = sh("cat", "/sys/class/net/br-ds/address", ns=NS_DS).strip()
        self.aliases = {self.gw_mac: "gw"}
        for rt in self.rt.values():
            if rt.node.kind == "ap":
                self.aliases[sh("cat", "/sys/class/net/br0/address", ns=rt.ns).strip()] = f"{rt.node.id}-br"

    def _start_wmediumd(self, nodes: list, topo: Topology) -> None:
        cfg = self.run_dir / "wmediumd.cfg"
        specs = [(self.rt[n.id].mac, n.x, n.y, 0.0, getattr(n, "tx_dbm", 1)) for n in nodes]
        cfg.write_text(make_config(specs, 10, topo.path_loss_exponent,
                                   tuple(r.mac for r in self.rt.values() if r.node.kind == "sniffer")))
        out = open(self.run_dir / "wmediumd.log", "w")
        self._wm = subprocess.Popen([str(WM_BIN), "-c", str(cfg), "-s", "-l", "5"], stdout=out, stderr=subprocess.STDOUT)
        if not retry(10, WM_SOCK.exists):
            raise EngineError("wmediumd did not start; see wmediumd.log in the run directory")
        self._medium = Medium()

    def _setup_sniffers(self) -> None:
        for rt in self.rt.values():
            if rt.node.kind != "sniffer":
                continue
            sh("ip", "link", "set", rt.iface, "down", ns=rt.ns)
            sh("iw", "dev", rt.iface, "set", "type", "monitor", ns=rt.ns)
            sh("ip", "link", "set", rt.iface, "up", ns=rt.ns)
            sh("iw", "dev", rt.iface, "set", "channel", str(rt.node.channel), ns=rt.ns)

    def _ft_key(self, a: str, b: str) -> str:
        """The 128-bit secret two key holders use to protect their messages; the same on both ends."""
        return self._ft_keys.setdefault(tuple(sorted((a, b))), secrets.token_hex(16))

    def _start_ap(self, rt: Runtime, topo: Topology) -> None:
        lines = [
            f"interface={rt.iface}", "bridge=br0", "driver=nl80211", f"ctrl_interface={rt.ctrl}",
            f"ssid={topo.ssid}", "hw_mode=g", f"channel={rt.node.channel}",
            "supported_rates=60 90 120 180 240 360 480 540", "basic_rates=60 120 240",  # wmediumd models OFDM rates only
        ]
        sec = topo.security
        if sec == Security.owe:
            # Opportunistic Wireless Encryption: no password, a Diffie-Hellman exchange in the association; PMF is required.
            lines += ["wpa=2", "wpa_key_mgmt=OWE", "rsn_pairwise=CCMP", "ieee80211w=2"]
        elif sec == Security.wpa3:
            lines += ["wpa=2", "wpa_key_mgmt=SAE", f"sae_password={topo.passphrase}", "rsn_pairwise=CCMP", "ieee80211w=2",
                      "sae_require_mfp=1"]
        elif sec in (Security.wpa2, Security.ft):
            # PMF mismatch: the AP requires protected management frames, the client was configured without them.
            lines += ["wpa=2", f"wpa_passphrase={topo.passphrase}", "rsn_pairwise=CCMP",
                      f"ieee80211w={2 if topo.fault == 'pmf_mismatch' else 0}"]
        if topo.fault == "mac_blocked":
            deny = self.run_dir / f"{rt.node.id}.deny"
            deny.write_text("".join(f"{r.mac}\n" for r in self.rt.values() if r.node.kind == "sta"))
            lines += ["macaddr_acl=0", f"deny_mac_file={deny}"]
        if sec == Security.ft:
            lines += ["wpa_key_mgmt=FT-PSK", f"mobility_domain={MOBILITY_DOMAIN}", f"nas_identifier={rt.node.id}.lab",
                      f"r1_key_holder={rt.mac.replace(':', '')}", f"ft_over_ds={int(topo.ft_over_ds)}"]
            if topo.ft_keys == "local":
                lines.append("ft_psk_generate_local=1")
            else:
                # Pull and push: each AP lists the others as key holders and shares a secret with each of them.
                lines += ["ft_psk_generate_local=0", f"pmk_r1_push={int(topo.ft_keys == 'push')}"]
                for other in self.rt.values():
                    if other.node.kind == "ap" and other is not rt:
                        key = self._ft_key(rt.node.id, other.node.id)
                        lines += [f"r0kh={other.mac} {other.node.id}.lab {key}", f"r1kh={other.mac} {other.mac} {key}"]
        elif sec == Security.wpa2:
            lines.append("wpa_key_mgmt=WPA-PSK")
        conf = self.run_dir / f"{rt.node.id}.conf"
        conf.write_text("\n".join(lines) + "\n")
        sh("hostapd", "-B", "-P", str(LAB / f"{rt.node.id}.pid"), "-dd", "-K", "-t",
           "-f", str(self.run_dir / f"{rt.node.id}.log"), str(conf), ns=rt.ns)
        if not retry(10, lambda: "state=ENABLED" in sh("hostapd_cli", "-p", rt.ctrl, "-i", rt.iface, "status", ns=rt.ns, check=False)):
            raise EngineError(f"{rt.node.id}: hostapd did not reach ENABLED; see {rt.node.id}.log")

    @staticmethod
    def _sta_network(topo: Topology) -> str:
        """The security part of the wpa_supplicant network block. A fault makes it differ from what the AP expects."""
        sec = topo.security
        password = topo.passphrase
        if topo.fault == "security_mismatch":
            sec = MISMATCH[sec]
        if topo.fault == "wrong_password":
            password = ("wrong-" + password)[:63]
        if sec == Security.open:
            return "  key_mgmt=NONE\n"
        rsn = "  proto=RSN\n  pairwise=CCMP\n  group=CCMP\n"
        if sec == Security.owe:
            return "  key_mgmt=OWE\n" + rsn + "  ieee80211w=2\n"
        if sec == Security.wpa3:
            return f'  key_mgmt=SAE\n  sae_password="{password}"\n' + rsn + "  ieee80211w=2\n"
        kmgmt = "FT-PSK" if sec == Security.ft else "WPA-PSK"
        return f'  psk="{password}"\n  key_mgmt={kmgmt}\n' + rsn + "  ieee80211w=0\n"

    def _start_sta(self, rt: Runtime, topo: Topology, channels: list, ordinal: int) -> None:
        freqs = " ".join(str({1: 2412, 6: 2437, 11: 2462}[c]) for c in channels)
        conf = self.run_dir / f"{rt.node.id}.conf"
        # wpa_supplicant only roams over the air by itself. For over-the-DS the lab sends it FT_DS instead (see _ds_assist).
        bgscan = "" if self._over_ds(topo) else f"  bgscan=\"simple:1:{rt.node.roam_threshold_dbm}:5\"\n"
        conf.write_text(
            f"ctrl_interface={rt.ctrl}\nnetwork={{\n  ssid=\"{topo.ssid}\"\n{self._sta_network(topo)}"
            f"{bgscan}  freq_list={freqs}\n  scan_freq={freqs}\n}}\n"
        )
        sh("wpa_supplicant", "-B", "-P", str(LAB / f"{rt.node.id}.pid"), "-D", "nl80211", "-i", rt.iface, "-c", str(conf),
           "-dd", "-K", "-t", "-f", str(self.run_dir / f"{rt.node.id}.log"), ns=rt.ns)
        rt.ip = f"10.10.0.{10 + ordinal}"
        sh("ip", "addr", "add", f"{rt.ip}/24", "dev", rt.iface, ns=rt.ns)
        # A post-roam ARP retry adds a fixed 1 s that would hide real handoff time, so pin the gateway.
        sh("ip", "neigh", "replace", IP_GW, "lladdr", self.gw_mac, "dev", rt.iface, "nud", "permanent", ns=rt.ns)

    def _sta_connected(self, rt: Runtime) -> bool:
        return poll_station(rt.ns, rt.ctrl, rt.iface)["state"] == "COMPLETED"

    @staticmethod
    def _over_ds(topo: Optional[Topology]) -> bool:
        return bool(topo and topo.security == Security.ft and topo.ft_over_ds)

    def _wpa(self, sta: Runtime, *args: str) -> str:
        return sh("wpa_cli", "-p", sta.ctrl, "-i", sta.iface, *args, ns=sta.ns, check=False)

    def _scan_freqs(self) -> str:
        return ",".join(str({1: 2412, 6: 2437, 11: 2462}[r.node.channel]) for r in self.rt.values() if r.node.kind == "ap")

    def _ds_assist(self, stas: list) -> None:
        """Stand-in for a client driver that roams over the DS: wpa_supplicant never starts that on its own, so when
        the signal is below the roam trigger we scan and, like bgscan, move only to an AP at least 5 dB stronger."""
        now = time.monotonic()
        ap_macs = {r.mac for r in self.rt.values() if r.node.kind == "ap"}
        for s in stas:
            rt = self.rt.get(s["id"])
            if rt is None:
                continue
            st = self._ds.setdefault(s["id"], {"scan": 0.0, "pending": False, "cool": 0.0, "pin": None, "down": 0})
            if s["state"] != "COMPLETED":
                # A client that lost its AP must be free to join any AP again.
                st["down"] += 1
                if st["down"] > 4 and st["pin"]:
                    self._wpa(rt, "set_network", "0", "bssid", "00:00:00:00:00:00")
                    st["pin"] = None
                continue
            st["down"] = 0
            # Pinned to its current AP, the supplicant cannot roam over the air when a scan finishes; only FT_DS moves it.
            if st["pin"] != s["bssid"]:
                self._wpa(rt, "set_network", "0", "bssid", s["bssid"])
                st["pin"] = s["bssid"]
            if s["rssi"] is None or now < st["cool"]:
                continue
            if st["pending"]:
                if now - st["scan"] < 0.4:
                    continue
                st["pending"] = False
                seen = {}
                for line in self._wpa(rt, "scan_results").splitlines()[1:]:
                    f = line.split("\t")
                    if len(f) >= 3 and f[0] in ap_macs and f[2].lstrip("-").isdigit():
                        seen[f[0]] = int(f[2])
                here = seen.get(s["bssid"], s["rssi"])
                better = [(v, m) for m, v in seen.items() if m != s["bssid"] and v >= here + 5]
                if better:
                    target = max(better)[1]
                    log.info("%s: FT over the DS to %s (%d dBm against %d)", s["id"], target, max(better)[0], here)
                    self._wpa(rt, "ft_ds", target)
                    st["cool"] = now + 3.0
            elif s["rssi"] < rt.node.roam_threshold_dbm and now - st["scan"] >= 1.0:
                self._wpa(rt, "scan", f"freq={self._scan_freqs()}")
                st["scan"], st["pending"] = now, True

    def _nm_unmanaged(self) -> None:
        conf = Path("/etc/NetworkManager/conf.d/90-wifilab-unmanaged.conf")
        if conf.exists() or not conf.parent.is_dir():
            return
        conf.write_text("[keyfile]\nunmanaged-devices=driver:mac80211_hwsim;interface-name:hwsim*\n")
        subprocess.run(["nmcli", "general", "reload", "conf"], capture_output=True)

    def _teardown(self) -> None:
        for pf in sorted(LAB.glob("*.pid")):
            try:
                pid = int(pf.read_text().strip())
                os.kill(pid, 15)
                for _ in range(20):
                    os.kill(pid, 0)
                    time.sleep(0.2)
            except (ProcessLookupError, ValueError, FileNotFoundError):
                pass
        if self._medium:
            self._medium.sock.close()
            self._medium = None
        if self._wm:
            self._wm.terminate()
            try:
                self._wm.wait(5)
            except subprocess.TimeoutExpired:
                self._wm.kill()
            self._wm = None
        for rt in self.rt.values():
            sh("ip", "netns", "del", rt.ns, check=False)
        sh("ip", "netns", "del", NS_DS, check=False)
        if (LAB / "state").exists() and hwsim_loaded():
            sh("modprobe", "-r", "mac80211_hwsim", check=False)
        WM_SOCK.unlink(missing_ok=True)
        if self.run_dir and self.run_dir.exists():
            for f in self.run_dir.glob("*"):
                if f.suffix in (".log", ".conf", ".pcap", ".cfg", ".json"):
                    f.chmod(0o600)
            sh("chown", "-R", f"{OWNER}:", str(self.run_dir), check=False)
        subprocess.run(["rm", "-rf", str(LAB)], check=False)
        self.rt = {}

    # ---- live control ----------------------------------------------------------------------------------------

    def node(self, node_id: str) -> Runtime:
        if self.state != "running" or node_id not in self.rt:
            raise EngineError("no such node, or lab not running")
        return self.rt[node_id]

    def move(self, node_id: str, x: float, y: float) -> None:
        rt = self.node(node_id)
        with self._mlock:
            self._medium.set_position(rt.mac, x, y, 0.0)
        rt.node.x, rt.node.y = x, y

    def ping(self, sta_id: str, count: int) -> str:
        rt = self.node(sta_id)
        if rt.node.kind != "sta":
            raise EngineError("only clients can ping")
        return sh("ping", "-c", str(count), "-i", "0.5", "-W", "1", IP_GW, ns=rt.ns, check=False)

    def daemon_cli(self, node_id: str, argv: list) -> str:
        """Run hostapd_cli (AP) or wpa_cli (client) with an already validated argument list."""
        rt = self.node(node_id)
        if rt.node.kind == "sniffer":
            raise EngineError("sniffers run no daemon")
        tool = "hostapd_cli" if rt.node.kind == "ap" else "wpa_cli"
        cmd = ["ip", "netns", "exec", rt.ns, tool, "-p", rt.ctrl, "-i", rt.iface, *argv]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return (r.stdout + r.stderr).strip()

    def kick(self, ap_id: str, sta_id: str, kind: str, reason: int) -> str:
        """Make an AP send a Deauthentication or Disassociation with the chosen reason code to one client."""
        ap, sta = self.node(ap_id), self.node(sta_id)
        if ap.node.kind != "ap" or sta.node.kind != "sta":
            raise EngineError("an AP sends it, to a client")
        verb = "DEAUTHENTICATE" if kind == "deauth" else "DISASSOCIATE"
        return self.daemon_cli(ap_id, ["raw", verb, sta.mac, f"reason={reason}"])

    def set_txpower(self, node_id: str, dbm: int) -> None:
        rt = self.node(node_id)
        if rt.node.kind == "sniffer":
            raise EngineError("sniffers do not transmit")
        with self._mlock:
            self._medium.set_txpower(rt.mac, dbm)
        rt.node.tx_dbm = dbm

    def reconnect(self, sta_id: str) -> None:
        """Drop the client's connection and let it connect again, so the exchange can be watched a second time."""
        sta = self.node(sta_id)
        if sta.node.kind != "sta":
            raise EngineError("only clients can reconnect")
        self._wpa(sta, "disconnect")
        retry(5, lambda: "wpa_state=COMPLETED" not in self._wpa(sta, "status"))
        self._wpa(sta, "reconnect")
        if not retry(15, lambda: "wpa_state=COMPLETED" in self._wpa(sta, "status")):
            raise EngineError(f"{sta_id} did not connect again")

    def roam(self, sta_id: str, ap_id: str) -> None:
        sta, ap = self.node(sta_id), self.node(ap_id)
        if sta.node.kind != "sta" or ap.node.kind != "ap":
            raise EngineError("roam needs a client and an AP")
        freqs = self._scan_freqs()

        def cli(*a: str) -> str:
            return self._wpa(sta, *a)

        if self._over_ds(self.topo):
            current = cli("status")
            if f"bssid={ap.mac}" in current:
                return
            cur = re.search(r"^bssid=(\S+)", current, re.M)
            if cur:
                cli("set_network", "0", "bssid", cur[1])  # no over-the-air roam while we scan
            cli("scan", f"freq={freqs}")
            if not retry(6, lambda: ap.mac in cli("scan_results")):
                raise EngineError(f"{ap_id} is not in {sta_id}'s scan results (out of range?)")
            cli("ft_ds", ap.mac)
            if not retry(10, lambda: f"bssid={ap.mac}" in (s := cli("status")) and "wpa_state=COMPLETED" in s):
                raise EngineError(f"{sta_id} did not reach {ap_id} over the DS")
            return

        cli("set_network", "0", "bssid", ap.mac)
        cli("select_network", "0")
        cli("scan", f"freq={freqs}")  # select_network alone never starts a scan while connected
        ok = retry(15, lambda: f"bssid={ap.mac}" in (s := cli("status")) and "wpa_state=COMPLETED" in s)
        cli("set_network", "0", "bssid", "00:00:00:00:00:00")
        if not ok:
            raise EngineError(f"{sta_id} did not reach {ap_id} (out of range?)")

    def poll(self) -> dict:
        if self.state != "running":
            return {"stas": [], "aps": []}
        by_mac = {r.mac: r.node.id for r in self.rt.values() if r.node.kind == "ap"}
        stas, aps = [], []
        for rt in list(self.rt.values()):
            if rt.node.kind == "sta":
                p = poll_station(rt.ns, rt.ctrl, rt.iface)
                rssi = int(p["rssi"]) if p["rssi"].lstrip("-").isdigit() else None
                stas.append({"id": rt.node.id, "x": rt.node.x, "y": rt.node.y, "rssi": rssi, "bssid": p["bssid"],
                             "ap": by_mac.get(p["bssid"]), "state": p["state"], "ip": rt.ip, "mac": rt.mac})
            elif rt.node.kind == "ap":
                out = sh("hostapd_cli", "-p", rt.ctrl, "-i", rt.iface, "all_sta", ns=rt.ns, check=False)
                aps.append({"id": rt.node.id, "clients": MAC_RE.findall(out), "mac": rt.mac})
        if self._over_ds(self.topo):
            self._ds_assist(stas)
        return {"stas": stas, "aps": aps}

    def snapshot(self) -> dict:
        nodes = []
        if self.topo:
            for n in self.topo.nodes:
                d = n.model_dump(mode="json")
                rt = self.rt.get(n.id)
                d["mac"] = rt.mac if rt else self.macs.get(n.id)
                nodes.append(d)
        return {"state": self.state, "name": self.topo.name if self.topo else None,
                "security": self.topo.security.value if self.topo else None, "nodes": nodes,
                "ssid": self.topo.ssid if self.topo else None,
                "aliases": getattr(self, "aliases", {}),
                "path_loss_exponent": self.topo.path_loss_exponent if self.topo else None,
                "run_dir": str(self.run_dir) if self.run_dir else None}
