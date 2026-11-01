#!/usr/bin/env python3
"""End-to-end smoke test for the lab API (needs the service running via scripts/labd.sh and sudo for nothing).

Usage: .venv/bin/python tests/smoke_api.py [ft|wpa2]
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parent.parent
PORT = os.environ.get("API_PORT", "8787")
BASE = f"http://127.0.0.1:{PORT}"
TOKEN = (ROOT / ".token").read_text().strip()
H = {"Authorization": f"Bearer {TOKEN}"}
mode = "wpa2-psk" if (sys.argv[1:] == ["wpa2"]) else "ft-psk"
failures = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'ok' if ok else 'FAIL'}] {name} {detail}")
    if not ok:
        failures.append(name)


async def main() -> None:
    async with httpx.AsyncClient(base_url=BASE, headers=H, timeout=60) as c:
        print("auth")
        async with httpx.AsyncClient(base_url=BASE) as anon:
            check("health is open", (await anon.get("/api/health")).status_code == 200)
            check("state needs a token", (await anon.get("/api/state")).status_code == 401)
            check("wrong token rejected", (await anon.get("/api/state", headers={"Authorization": "Bearer nope"})).status_code == 401)
            check("foreign Host header rejected", (await anon.get("/api/health", headers={"Host": "evil.example"})).status_code == 400)
        try:
            async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/ws?token=bad"):
                check("ws without token rejected", False)
        except Exception:
            check("ws without token rejected", True)

        topo = (await c.get("/api/presets")).json()["two-ap-roam"]
        topo["security"] = mode
        bad = dict(topo, ssid='x"; rm -rf /')
        check("hostile SSID rejected (422)", (await c.post("/api/lab/start", json=bad)).status_code == 422)

        print(f"start lab ({mode})")
        r = await c.post("/api/lab/start", json=topo)
        check("lab started", r.status_code == 200, r.text[:120] if r.status_code != 200 else "")
        if r.status_code != 200:
            return
        check("second start refused", (await c.post("/api/lab/start", json=topo)).status_code == 409)

        frames, events = [], []
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/ws?token={TOKEN}") as ws:
            snap = json.loads(await ws.recv())
            check("ws snapshot", snap["type"] == "snapshot" and snap["lab"]["state"] == "running")
            sta = None
            for _ in range(20):
                msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
                events.append(msg["type"])
                if msg["type"] == "state" and msg["stas"] and msg["stas"][0]["ap"]:
                    sta = msg["stas"][0]
                    break
            check("client associated", sta is not None and sta["ap"] == "ap1", f"{sta and (sta['ap'], sta['rssi'])}")

            print("walk ap1 -> ap2")
            await c.post("/api/nodes/sta1/walk", json={"x": 38, "y": 0, "speed": 4})
            rssis, roam_evt, deadline = [], None, asyncio.get_event_loop().time() + 25
            while asyncio.get_event_loop().time() < deadline and roam_evt is None:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
                if msg["type"] == "state" and msg["stas"]:
                    rssis.append((msg["stas"][0]["x"], msg["stas"][0]["rssi"], msg["stas"][0]["ap"]))
                elif msg["type"] == "roam":
                    roam_evt = msg["roam"]
                elif msg["type"] == "frames":
                    frames += msg["frames"]
            check("RSSI changed while walking", len({r[1] for r in rssis if r[1] is not None}) > 3, f"{rssis[0][:2]}..{rssis[-1][:2]}" if rssis else "")
            check("signal-driven roam event", roam_evt is not None and "error" not in (roam_evt or {}), str(roam_evt)[:200])
            if roam_evt and "handoff_ms" in roam_evt:
                exp_eapol = 0 if mode == "ft-psk" else 4
                check(f"EAPOL frames in roam == {exp_eapol}", roam_evt["eapol"] == exp_eapol, f"handoff {roam_evt['handoff_ms']} ms")

        print("capture")
        await asyncio.sleep(2)
        fr = (await c.get("/api/frames", params={"src": "global", "limit": 5000})).json()
        check("lab sends no traffic by itself", not any(f["proto"] == "ICMP" for f in fr))
        r = await c.post("/api/nodes/sta1/ping", json={"count": 3})
        check("one-off ping works", r.status_code == 200 and "3 received" in r.text, r.text[-120:])
        await asyncio.sleep(2)
        fr = (await c.get("/api/frames", params={"src": "global", "limit": 5000})).json()
        types = {f["type"] for f in fr}
        protos = {f["proto"] for f in fr if f["dec"]}
        check("management frames seen", {"Auth", "ReassocReq"} <= types, str(sorted(types))[:80])
        check("data frames decrypted live (ICMP/ARP)", bool({"ICMP", "ARP"} & protos), str(sorted(protos)))
        snf = (await c.get("/api/frames", params={"src": "snf1", "limit": 100})).json()
        check("sniffer snf1 hears frames", len(snf) > 0, f"{len(snf)} frames")
        caps = (await c.get("/api/captures")).json()
        check("capture sources listed", {"global", "snf1"} <= set(caps), str(caps))

        for dec in (False, True):
            r = await c.get("/api/captures/global/pcap", params={"decrypted": dec})
            with tempfile.NamedTemporaryFile(suffix=".pcap") as f:
                f.write(r.content)
                f.flush()
                out = subprocess.run(["tshark", "-r", f.name, "-Y", "icmp"], capture_output=True, text=True).stdout.count("\n")
            check(f"pcap export decrypted={dec}", r.status_code == 200 and (out > 0) == dec, f"{len(r.content)} bytes, {out} ICMP")
        check("path traversal rejected", (await c.get("/api/captures/..%2f..%2fetc%2fpasswd/pcap")).status_code in (404, 422))
        keys = (await c.get("/api/keys")).json()
        check("keys exported", len(keys) >= 2, f"{len(keys)} keys")

        flt = (await c.get("/api/captures/global/filter", params={"expr": "icmp.type == 8"})).json()
        check("display filter returns matches", len(flt["numbers"]) == 3 and flt["error"] is None, str(flt)[:100])
        bad = (await c.get("/api/captures/global/filter", params={"expr": "wlan.bogus =="})).json()
        check("bad display filter reports an error", bad["numbers"] == [] and bool(bad["error"]), str(bad)[:100])
        n = flt["numbers"][0]
        d = (await c.get(f"/api/frames/global/{n}")).json()
        names = {t["f"] for t in d["tree"]}
        raw = bytes.fromhex(d["hex"])
        wlan = next(t for t in d["tree"] if t["f"] == "wlan")
        check("detail tree has Wireshark layers", {"frame", "radiotap", "wlan", "icmp"} <= names and d["tree"][0]["l"].startswith(f"Frame {n}:"), str(sorted(names)))
        check("tree offsets match bytes", wlan["p"] == d["radiotap_len"] and wlan["p"] + wlan["s"] <= len(raw), f"wlan at {wlan['p']} size {wlan['s']} of {len(raw)}")

        print("manual roam + tx power")
        r = await c.post("/api/nodes/sta1/roam", json={"ap": "ap1"})
        check("manual roam back to ap1", r.status_code == 200, r.text[:100])
        check("tx power change", (await c.post("/api/nodes/ap1/tx", json={"dbm": 15})).status_code == 200)
        check("unknown node -> 409", (await c.post("/api/nodes/nope/position", json={"x": 1, "y": 1})).status_code == 409)

        print("stop")
        r = await c.post("/api/lab/stop")
        check("lab stopped", r.status_code == 200 and r.json()["state"] == "stopped")
        check("captures still downloadable after stop", (await c.get("/api/captures/global/pcap")).status_code == 200)


asyncio.run(main())
print("\nFAILED: " + ", ".join(failures) if failures else "\nall checks passed")
sys.exit(1 if failures else 0)
