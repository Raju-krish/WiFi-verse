#!/usr/bin/env python3
"""Control a running wmediumd (live positions / tx power) and walk a station while logging RSSI.

Usage: wmedium.py mkconfig --out FILE --node MAC,x,y,z [--node ...] [--tx 20] [--exp 3.0]
       wmedium.py setpos MAC x y [z]
       wmedium.py settx MAC DBM
       wmedium.py walk --mac MAC --from-x X --to-x X --speed MPS --netns NS --ctrl DIR --iface IF --out CSV
"""
import argparse
import csv
import socket
import struct
import subprocess
import sys
import time

SOCK = "/var/run/wmediumd.sock"
POSITION_UPDATE = 13
TXPOWER_UPDATE = 15


def mac_bytes(mac: str) -> bytes:
    return bytes(int(b, 16) for b in mac.split(":"))


class Medium:
    def __init__(self, path: str = SOCK):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)

    def _call(self, request: bytes, response_len: int) -> None:
        self.sock.sendall(request)
        buf = b""
        while len(buf) < response_len:
            chunk = self.sock.recv(response_len - len(buf))
            if not chunk:
                raise ConnectionError("wmediumd closed the control socket")
            buf += chunk
        if buf[-1] != 0:
            raise RuntimeError(f"wmediumd rejected the update (code {buf[-1]}; 1 = unknown MAC)")

    def set_position(self, mac: str, x: float, y: float, z: float = 0.0) -> None:
        self._call(struct.pack("!B6sfff", POSITION_UPDATE, mac_bytes(mac), x, y, z), 21)

    def set_txpower(self, mac: str, dbm: int) -> None:
        self._call(struct.pack("!B6si", TXPOWER_UPDATE, mac_bytes(mac), dbm), 13)


def make_config(nodes: list, tx_dbm: float, exponent: float, monitors: tuple = ()) -> str:
    """nodes: (mac, x, y, z) or (mac, x, y, z, tx_dbm); tx_dbm is the default. monitors need the patched wmediumd."""
    ids = ",\n        ".join(f'"{n[0]}"' for n in nodes)
    mon = "".join(f'    monitors = [{", ".join(chr(34) + m + chr(34) for m in monitors)}];\n' for _ in [0] if monitors)
    pos = ",\n        ".join(f"({n[1]:.1f}, {n[2]:.1f}, {n[3]:.1f})" for n in nodes)
    tx = ", ".join(f"{(n[4] if len(n) > 4 else tx_dbm):.1f}" for n in nodes)
    return (
        f"ifaces : {{\n    ids = [\n        {ids}\n    ];\n{mon}}};\n\n"
        f"model : {{\n    type = \"path_loss\";\n    positions = (\n        {pos}\n    );\n"
        f"    tx_powers = ({tx});\n    model_name = \"log_distance\";\n"
        f"    path_loss_exp = {exponent:.1f};\n    xg = 0.0;\n}};\n"
    )


def poll_station(netns: str, ctrl: str, iface: str) -> dict:
    script = f"wpa_cli -p {ctrl} -i {iface} signal_poll; wpa_cli -p {ctrl} -i {iface} status"
    out = subprocess.run(["ip", "netns", "exec", netns, "sh", "-c", script], capture_output=True, text=True).stdout
    kv = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return {"rssi": kv.get("RSSI", ""), "avg_rssi": kv.get("AVG_RSSI", ""), "bssid": kv.get("bssid", ""),
            "freq": kv.get("freq", ""), "state": kv.get("wpa_state", "")}


def walk(a: argparse.Namespace) -> None:
    medium = Medium()
    duration = abs(a.to_x - a.from_x) / a.speed
    start = time.monotonic()
    next_poll = 0.0
    with open(a.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t_epoch", "x", "y", "rssi", "avg_rssi", "bssid", "freq", "state"])
        while True:
            t = time.monotonic() - start
            x = a.from_x + (a.to_x - a.from_x) * min(t / duration, 1.0)
            medium.set_position(a.mac, x, a.y)
            if t >= next_poll:
                p = poll_station(a.netns, a.ctrl, a.iface)
                w.writerow([f"{time.time():.4f}", f"{x:.2f}", a.y, p["rssi"], p["avg_rssi"], p["bssid"], p["freq"], p["state"]])
                fh.flush()
                next_poll += a.poll
            if t >= duration + a.hold:
                break
            time.sleep(a.step)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("mkconfig")
    p.add_argument("--out", required=True)
    p.add_argument("--node", action="append", required=True, help="MAC,x,y,z (order = wmediumd index)")
    p.add_argument("--tx", type=float, default=20.0)
    p.add_argument("--exp", type=float, default=3.0)
    p = sub.add_parser("setpos")
    p.add_argument("mac")
    p.add_argument("x", type=float)
    p.add_argument("y", type=float)
    p.add_argument("z", type=float, nargs="?", default=0.0)
    p = sub.add_parser("settx")
    p.add_argument("mac")
    p.add_argument("dbm", type=int)
    p = sub.add_parser("walk")
    p.add_argument("--mac", required=True)
    p.add_argument("--from-x", type=float, required=True)
    p.add_argument("--to-x", type=float, required=True)
    p.add_argument("--y", type=float, default=0.0)
    p.add_argument("--speed", type=float, default=4.0, help="metres per second")
    p.add_argument("--hold", type=float, default=3.0, help="seconds to stay at the end")
    p.add_argument("--step", type=float, default=0.05, help="position update interval, seconds")
    p.add_argument("--poll", type=float, default=0.2, help="RSSI poll interval, seconds")
    p.add_argument("--netns", required=True)
    p.add_argument("--ctrl", required=True)
    p.add_argument("--iface", required=True)
    p.add_argument("--out", required=True)
    a = ap.parse_args()

    if a.cmd == "mkconfig":
        nodes = []
        for spec in a.node:
            mac, *nums = spec.split(",")
            nodes.append((mac, *map(float, nums)))
        open(a.out, "w").write(make_config(nodes, a.tx, a.exp))
    elif a.cmd == "setpos":
        Medium().set_position(a.mac, a.x, a.y, a.z)
    elif a.cmd == "settx":
        Medium().set_txpower(a.mac, a.dbm)
    elif a.cmd == "walk":
        walk(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
