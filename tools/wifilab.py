#!/usr/bin/env python3
"""Post-process Wi-Fi Verse runs: keys from -K logs, CCMP-decrypted pcap, roam metrics, FT vs PSK comparison.

Usage: wifilab.py analyze RUN_DIR
       wifilab.py compare RUN_DIR [RUN_DIR ...]
"""
import csv
import json
import re
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESCCM

NODES = ("ap1", "ap2", "sta1")
RE_PTK = re.compile(r"^(\d+\.\d+): (?:WPA|FT): PTK - hexdump\(len=(\d+)\): ([0-9a-f ]+)")
RE_SETKEY = re.compile(r"^(\d+\.\d+): wpa_driver_nl80211_set_key: .*alg=(\d+) .*key_idx=(\d+) .*key_len=(\d+)")
RE_KEYDATA = re.compile(r"nl80211: KEY_DATA - hexdump\(len=(\d+)\): ([0-9a-f ]+)")
RE_PING = re.compile(r"^\[(\d+\.\d+)\] \d+ bytes from .*icmp_seq=(\d+)")
SUBTYPES = {0: "AssocReq", 1: "AssocResp", 2: "ReassocReq", 3: "ReassocResp", 10: "Disassoc", 11: "Auth", 12: "Deauth", 13: "Action"}
PING_INTERVAL_MS = 20


def extract_keys(run: Path, nodes=NODES) -> dict:
    pairwise, group = [], []
    for node in nodes:
        log = run / f"{node}.log"
        if not log.exists():
            continue
        pending = None
        for line in log.read_text(errors="replace").splitlines():
            m = RE_PTK.match(line)
            if m:
                ptk = m[3].replace(" ", "")
                pairwise.append({"ts": float(m[1]), "node": node, "ptk": ptk, "tk": ptk[-32:]})
                continue
            m = RE_SETKEY.match(line)
            if m:
                pending = (float(m[1]), int(m[2]), int(m[3]), int(m[4]))
                continue
            m = RE_KEYDATA.search(line)
            if m and pending and pending[1] == 3 and int(m[1]) == 16 and pending[2] >= 1:
                group.append({"ts": pending[0], "node": node, "key_idx": pending[2], "gtk": m[2].replace(" ", "")})
            pending = None if m else pending
    return {"pairwise": pairwise, "group": group}


def candidate_keys(keys: dict) -> list:
    seen, out = set(), []
    for h in [k["tk"] for k in keys["pairwise"]] + [k["gtk"] for k in keys["group"]]:
        if h not in seen:
            seen.add(h)
            out.append(AESCCM(bytes.fromhex(h), tag_length=8))
    return out


def read_pcap(path: Path):
    data = path.read_bytes()
    endian = {b"\xd4\xc3\xb2\xa1": "<", b"\xa1\xb2\xc3\xd4": ">"}.get(data[:4])
    if endian is None or struct.unpack(endian + "I", data[20:24])[0] != 127:
        raise ValueError("expected a classic pcap with radiotap (linktype 127)")
    records, pos = [], 24
    while pos + 16 <= len(data):
        ts_s, ts_us, caplen, origlen = struct.unpack(endian + "IIII", data[pos:pos + 16])
        pos += 16
        records.append((ts_s, ts_us, data[pos:pos + caplen], origlen))
        pos += caplen
    return data[:24], endian, records


def ccmp_decrypt(frame: bytes, ciphers: list):
    """Return the unprotected frame, or None if no key authenticates. Caller checks the Protected bit."""
    fc0, fc1 = frame[0], frame[1]
    qos = bool(fc0 & 0x80)
    four_addr = bool(fc1 & 1) and bool(fc1 & 2)
    hlen = 24 + (6 if four_addr else 0) + (2 if qos else 0)
    if len(frame) < hlen + 16:
        return None
    c = frame[hlen:hlen + 8]
    pn = bytes([c[7], c[6], c[5], c[4], c[1], c[0]])
    a1, a2, a3, sc = frame[4:10], frame[10:16], frame[16:22], frame[22:24]
    a4 = frame[24:30] if four_addr else b""
    qc = frame[hlen - 2:hlen] if qos else b""
    nonce = bytes([(qc[0] & 0x0F) if qos else 0]) + a2 + pn
    fc1_masked = fc1 & ~(0x08 | 0x10 | 0x20 | (0x80 if qos else 0))
    for fcs_len in (0, 4):
        body = frame[hlen + 8:len(frame) - fcs_len]
        for qc_mask in (0x0F, 0x8F):
            aad = bytes([fc0 & 0x8F, fc1_masked]) + a1 + a2 + a3 + bytes([sc[0] & 0x0F, 0]) + a4
            if qos:
                aad += bytes([qc[0] & qc_mask, 0])
            for cipher in ciphers:
                try:
                    plain = cipher.decrypt(nonce, body, aad)
                except InvalidTag:
                    continue
                return bytes([fc0, fc1 & ~0x40]) + frame[2:hlen] + plain
    return None


def decrypt_pcap(run: Path, keys: dict) -> dict:
    ciphers = candidate_keys(keys)
    hdr, endian, records = read_pcap(run / "capture.pcap")
    out, protected, decrypted = [hdr], 0, 0
    for ts_s, ts_us, pkt, origlen in records:
        rt_len = struct.unpack("<H", pkt[2:4])[0]
        radiotap, frame = pkt[:rt_len], pkt[rt_len:]
        if len(frame) >= 24 and (frame[0] >> 2) & 3 == 2 and frame[1] & 0x40:
            protected += 1
            plain = ccmp_decrypt(frame, ciphers)
            if plain is not None:
                decrypted += 1
                origlen -= len(frame) - len(plain)
                pkt = radiotap + plain
        out.append(struct.pack(endian + "IIII", ts_s, ts_us, len(pkt), origlen) + pkt)
    (run / "capture.decrypted.pcap").write_bytes(b"".join(out))
    return {"frames": len(records), "protected": protected, "decrypted": decrypted}


def tshark_events(pcap: Path) -> list:
    flt = "(wlan.fc.type_subtype in {0,1,2,3,10,11,12,13}) || eapol"
    fields = ["frame.time_epoch", "wlan.fc.type_subtype", "wlan.sa", "wlan.da", "wlan.fixed.auth.alg", "wlan_rsna_eapol.keydes.msgnr",
              "wlan.fixed.category_code", "wlan.fixed.action_code", "wlan.fixed.status_code", "wlan.fixed.reason_code",
              "wlan.fixed.auth_seq"]
    cmd = ["tshark", "-r", str(pcap), "-Y", flt, "-T", "fields"] + [x for f in fields for x in ("-e", f)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    events = []
    for line in out.splitlines():
        p = (line.split("\t") + [""] * 11)[:11]
        subtype = int(p[1], 16) if p[1] else -1
        name = f"EAPOL-M{p[5]}" if p[5] else SUBTYPES.get(subtype, f"data/{subtype}")
        if name == "Action" and p[6] == "6":  # category 6 is Fast BSS Transition
            name = {"1": "FT-Req", "2": "FT-Resp", "3": "FT-Confirm", "4": "FT-Ack"}.get(p[7], "FT-Action")
        events.append({"t": float(p[0]), "name": name, "sa": p[2], "da": p[3], "alg": p[4],
                       "status": _code(p[8]), "reason": _code(p[9]), "seq": _code(p[10])})
    return events


def _code(text: str) -> Optional[int]:
    try:
        return int(text.split(",")[0], 0)
    except ValueError:
        return None


def ping_replies(path: Path) -> list:
    out = []
    for line in path.read_text(errors="replace").splitlines():
        m = RE_PING.match(line)
        if m:
            out.append(float(m[1]))
    return out


def connections_from_events(events: list, sta: str, ap: str) -> list:
    """The connection attempts of one client to one AP, oldest first. Frames closer together than 1.5 s belong to the
    same attempt; an attempt counts when the AP answered the association."""
    keep = [e for e in events if {e["sa"], e["da"]} == {sta, ap} and (e["name"] in ("Auth", "AssocReq", "AssocResp", "ReassocReq", "ReassocResp") or e["name"].startswith("EAPOL"))]
    groups: list = []
    for e in keep:
        if groups and e["t"] - groups[-1][-1]["t"] <= 1.5:
            groups[-1].append(e)
        else:
            groups.append([e])
    out = []
    for g in groups:
        if not any(e["name"] in ("AssocResp", "ReassocResp") for e in g):
            continue
        count = lambda f: sum(1 for e in g if f(e))
        out.append({
            "t_start": g[0]["t"],
            "t_end": g[-1]["t"],
            "duration_ms": round((g[-1]["t"] - g[0]["t"]) * 1000, 2),
            "frames_total": len(g),
            "auth": count(lambda e: e["name"] == "Auth"),
            "sae": count(lambda e: e["name"] == "Auth" and e["alg"] == "3"),
            "assoc": count(lambda e: "Assoc" in e["name"]),
            "eapol": count(lambda e: e["name"].startswith("EAPOL")),
        })
    return out


def attempts_from_events(events: list, sta: str, ap: str) -> list:
    """Every connection attempt of one client to one AP, good or bad, oldest first. An attempt starts at the client's
    first Authentication frame and runs until the next one. Each carries how far it got, the status code the AP
    answered with, the EAPOL messages seen, and the Deauthentication or Disassociation that ended it, if any."""
    pair = [e for e in events if {e["sa"], e["da"]} == {sta, ap}]
    starts = [i for i, e in enumerate(pair) if e["name"] == "Auth" and e["sa"] == sta and e["seq"] == 1]
    out = []
    for k, i in enumerate(starts):
        g = pair[i:starts[k + 1] if k + 1 < len(starts) else len(pair)]
        by_ap = lambda e: e["sa"] == ap
        auth_replies = [e for e in g if e["name"] == "Auth" and by_ap(e)]
        assoc_replies = [e for e in g if e["name"] in ("AssocResp", "ReassocResp") and by_ap(e)]
        eapol = sorted({int(e["name"][-1]) for e in g if e["name"].startswith("EAPOL")})
        ended = next((e for e in g if e["name"] in ("Deauth", "Disassoc")), None)
        auth_bad = next((e["status"] for e in auth_replies if e["status"]), None)
        assoc_bad = next((e["status"] for e in assoc_replies if e["status"]), None)
        sta_m4 = any(e["name"] == "EAPOL-M4" and e["sa"] == sta for e in g)
        if not auth_replies:
            stage, outcome = "authentication", "no_response"
        elif auth_bad:
            stage, outcome = "authentication", "rejected"
        elif not assoc_replies:
            stage, outcome = "association", "no_response"
        elif assoc_bad:
            stage, outcome = "association", "rejected"
        elif eapol and not sta_m4:
            stage, outcome = "4-way handshake", "failed"
        elif ended and not eapol and not sta_m4 and ended["sa"] == ap and ended["t"] - g[0]["t"] < 1.0:
            stage, outcome = "after association", "dropped"
        else:
            stage, outcome = "connected", "connected"
        out.append({
            "t_start": g[0]["t"], "t_end": g[-1]["t"], "duration_ms": round((g[-1]["t"] - g[0]["t"]) * 1000, 2),
            "outcome": outcome, "stage": stage, "status": auth_bad or assoc_bad,
            "eapol": eapol, "sae": sum(1 for e in g if e["name"] == "Auth" and e["alg"] == "3"),
            "frames_total": len(g),
            "ended_by": ({"t": ended["t"], "kind": ended["name"], "reason": ended["reason"],
                          "from": "ap" if ended["sa"] == ap else "client"} if ended else None),
        })
    return out


def roam_from_events(events: list, t_roam: float, sta: str, ap2: str, ap1: Optional[str] = None) -> dict:
    """Measure one roam. Over the air it starts with an Authentication to the new AP; over the DS it starts with an
    FT Action request to the old AP, which relays it to the new AP over the wired network."""
    air = next((e for e in events if e["t"] >= t_roam and e["name"] == "Auth" and e["sa"] == sta and e["da"] == ap2), None)
    ds = next((e for e in events if e["t"] >= t_roam and e["name"] == "FT-Req" and e["sa"] == sta and (ap1 is None or e["da"] == ap1)), None)
    start = min((e for e in (air, ds) if e), key=lambda e: e["t"], default=None)
    if start is None:
        raise RuntimeError("no roam Auth or FT Action frame found in capture")
    over_ds = start is ds
    ends = [e["t"] for e in events if e["t"] >= start["t"] and e["sa"] == ap2 and e["da"] == sta and e["name"] == "ReassocResp"]
    ends += [e["t"] for e in events if start["t"] <= e["t"] <= start["t"] + 2 and e["name"] == "EAPOL-M4" and e["sa"] == sta and e["da"] == ap2]
    if not ends:
        raise RuntimeError("roam exchange did not complete in capture")
    t_end = max(ends)
    window = [e for e in events if start["t"] <= e["t"] <= t_end and (
        {e["sa"], e["da"]} == {sta, ap2} or (over_ds and e["name"].startswith("FT-") and sta in (e["sa"], e["da"])))]
    count = lambda n: sum(1 for e in window if e["name"] == n)
    return {
        "t_auth": start["t"],
        "t_end": t_end,
        "auth_alg": start["alg"],
        "transition": "ds" if over_ds else "air",
        "frames_total": len(window),
        "auth": count("Auth"),
        "ft_action": sum(1 for e in window if e["name"].startswith("FT-")),
        "reassoc": count("ReassocReq") + count("ReassocResp"),
        "eapol": sum(1 for e in window if e["name"].startswith("EAPOL")),
        "handoff_ms": round((t_end - start["t"]) * 1000, 2),
        "scan_to_auth_ms": round((start["t"] - t_roam) * 1000, 1),
    }


def roam_metrics(run: Path, roam: dict) -> dict:
    events = tshark_events(run / "capture.pcap")
    t_roam = float(roam["t_roam"])
    m = roam_from_events(events, t_roam, roam["sta_mac"], roam["ap2_bssid"])
    start_t, t_end = m.pop("t_auth"), m.pop("t_end")
    replies = ping_replies(run / "ping.log") if (run / "ping.log").exists() else []
    gaps = [(a, b) for a, b in zip(replies, replies[1:]) if a <= t_end and b >= start_t]
    if gaps:
        a, b = max(gaps, key=lambda g: g[1] - g[0])
        m["ping_gap_ms"] = round((b - a) * 1000 - PING_INTERVAL_MS, 1)
        m["restored_after_auth_ms"] = round((b - start_t) * 1000, 1)
    else:
        m["ping_gap_ms"] = 0.0
        m["restored_after_auth_ms"] = 0.0
    return m


def track_rows(run: Path) -> list:
    path = run / "track.csv"
    if not path.exists():
        return []
    return [r for r in csv.DictReader(path.open()) if r["x"]]


def track_metrics(run: Path, roam: dict) -> dict:
    rows = track_rows(run)
    if not rows:
        return {}
    ap1, ap2 = roam["ap1_bssid"], roam["ap2_bssid"]
    rssi = lambda r: int(r["rssi"]) if r["rssi"].lstrip("-").isdigit() else None
    first_ap2 = next((i for i, r in enumerate(rows) if r["bssid"] == ap2), None)
    out = {"track_samples": len(rows), "rssi_min": min(v for v in map(rssi, rows) if v is not None)}
    if first_ap2 is not None:
        before = [v for v in map(rssi, rows[:first_ap2]) if v is not None]
        out.update({"roam_x_m": float(rows[first_ap2]["x"]), "rssi_before_roam": before[-1] if before else None,
                    "rssi_after_roam": rssi(rows[first_ap2])})
    return out


def print_track(run: Path, roam: dict) -> None:
    rows = track_rows(run)
    if not rows:
        return
    t0, ap1, ap2 = float(rows[0]["t_epoch"]), roam["ap1_bssid"], roam["ap2_bssid"]
    print("\n  walk: RSSI at the client (bar = signal strength)")
    print("   t(s)   x(m)   RSSI  AP")
    last = -1
    for r in rows:
        sec = int(float(r["t_epoch"]) - t0)
        prev = rows[rows.index(r) - 1]["bssid"] if rows.index(r) else r["bssid"]
        if sec == last and r["bssid"] == prev:
            continue
        last = sec
        v = r["rssi"]
        bar = "#" * max(0, min(30, int(v) + 90)) if v.lstrip("-").isdigit() else ""
        ap = {ap1: "AP1", ap2: "AP2"}.get(r["bssid"], r["state"] or "-")
        mark = "  <-- roamed" if r["bssid"] != prev else ""
        print(f"  {float(r['t_epoch']) - t0:5.1f}  {float(r['x']):5.1f}  {v:>5}  {ap}  {bar}{mark}")


def analyze(run: Path) -> dict:
    roam = json.loads((run / "roam.json").read_text())
    keys = extract_keys(run)
    (run / "keys.json").write_text(json.dumps(keys, indent=1))
    dec = decrypt_pcap(run, keys)
    metrics = {"mode": roam["mode"], "run": run.name, "decrypt": dec, "keys": {"pairwise": len(keys["pairwise"]), "group": len(keys["group"])}}
    metrics.update(roam_metrics(run, roam))
    metrics.update(track_metrics(run, roam))
    (run / "metrics.json").write_text(json.dumps(metrics, indent=1))
    (run / "keys.json").chmod(0o600)
    print_track(run, roam)
    return metrics


def print_analysis(m: dict) -> None:
    d = m["decrypt"]
    print(f"\n  mode={m['mode']}  frames in roam exchange={m['frames_total']} (Auth={m['auth']} Reassoc={m['reassoc']} EAPOL={m['eapol']})")
    print(f"  handoff={m['handoff_ms']} ms   start->first Auth={m['scan_to_auth_ms']} ms   ping gap incl. scan={m['ping_gap_ms']} ms   traffic back {m['restored_after_auth_ms']} ms after first Auth")
    print(f"  keys: {m['keys']['pairwise']} PTK, {m['keys']['group']} GTK   decrypted {d['decrypted']}/{d['protected']} protected frames")
    print("  wrote: keys.json, capture.decrypted.pcap, metrics.json")


METRICS = ["frames_total", "auth", "reassoc", "eapol", "handoff_ms", "restored_after_auth_ms", "ping_gap_ms"]


def stats(values: list) -> dict:
    return {"mean": round(statistics.fmean(values), 2), "min": min(values), "max": max(values),
            "stdev": round(statistics.stdev(values), 2) if len(values) > 1 else 0.0}


def compare(runs: list) -> None:
    by_mode = {}
    for r in runs:
        m = json.loads((r / "metrics.json").read_text())
        by_mode.setdefault(m["mode"], []).append(m)
    summary = {mode: {k: stats([m[k] for m in ms]) for k in METRICS} | {"runs": len(ms)} for mode, ms in by_mode.items()}
    out = runs[0].parent / f"compare-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"summary": summary, "runs": by_mode}, indent=1))
    modes = [m for m in ("ft", "psk") if m in summary]
    print(f"\n{'metric (mean, min-max)':<26}" + "".join(f"{m.upper():>22}" for m in modes))
    for k in METRICS:
        row = "".join(f"{summary[m][k]['mean']} ({summary[m][k]['min']}-{summary[m][k]['max']})".rjust(22) for m in modes)
        print(f"{k:<26}{row}")
    print(f"{'runs':<26}" + "".join(f"{summary[m]['runs']:>22}" for m in modes))
    if {"ft", "psk"} <= set(summary):
        ft, psk = summary["ft"]["handoff_ms"]["mean"], summary["psk"]["handoff_ms"]["mean"]
        print(f"\nFT handoff is {psk / ft:.1f}x faster than WPA2-PSK on average ({ft} ms vs {psk} ms); results: {out}")


def main(argv: list) -> int:
    if len(argv) >= 3 and argv[1] == "analyze":
        print_analysis(analyze(Path(argv[2])))
        return 0
    if len(argv) >= 3 and argv[1] == "compare":
        compare([Path(a) for a in argv[2:]])
        return 0
    print(__doc__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
