"""REST + WebSocket API for Wi-Fi Verse. Runs as root (it drives hostapd and the kernel), so it is
loopback-only, token-authenticated, and only ever builds commands from validated Topology fields."""
import asyncio
import json
import logging
import os
import re
import secrets
import struct
import tempfile
import time
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

import wifilab

from . import ROOT
from .cli import LAB_COMMANDS, catalog, parse
from .engine import RUNS_DIR, EngineError, LabEngine
from .frames import FrameStream, load_capture, pcap_record, pcap_snapshot
from .ftcache import report as ft_report
from .keys import KeyTracker
from .models import PRESETS, Topology

log = logging.getLogger("labd.api")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

LABS_DIR = ROOT / "labs"
UI_PORT = os.environ.get("WIFILAB_UI_PORT", "5173")
if not UI_PORT.isdigit():
    raise SystemExit("WIFILAB_UI_PORT must be a port number")
UI_ORIGINS = [f"http://localhost:{UI_PORT}", f"http://127.0.0.1:{UI_PORT}"]
SOURCE_RE = re.compile(r"^(global|[a-z][a-z0-9]{0,7})$")
LAB_NAME_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
RUN_RE = re.compile(r"^\d{8}-\d{6}-[a-z0-9-]{1,20}$")
NODE_RE = re.compile(r"^[a-z][a-z0-9]{0,7}$")
LOG_TAIL_BYTES = 4_000_000
TOKEN_FILE = os.environ.get("WIFILAB_TOKEN_FILE")
if not TOKEN_FILE:
    raise SystemExit("WIFILAB_TOKEN_FILE is not set; start the service with scripts/labd.sh")
TOKEN = Path(TOKEN_FILE).read_text().strip()


class Hub:
    def __init__(self) -> None:
        self.subs: set = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None

    def publish(self, msg: dict) -> None:
        for q in list(self.subs):
            if q.full():
                while not q.empty():
                    q.get_nowait()
                q.put_nowait({"type": "resync"})
            else:
                q.put_nowait(msg)

    def publish_threadsafe(self, msg: dict) -> None:
        if self.loop:
            self.loop.call_soon_threadsafe(self.publish, msg)


hub = Hub()
engine = LabEngine(hub.publish_threadsafe)


class Session:
    def __init__(self) -> None:
        self.streams: dict = {}
        self.keys: Optional[KeyTracker] = None
        self.roams: list = []
        self.prev_ap: dict = {}
        self.walks: dict = {}
        self.capture_stopped = False
        self.roam_gen = 0
        self.paused: Optional[str] = None  # why recording is paused, or None while it records
        self.connected: dict = {}
        self.pause_gen = 0
        self.t_start = time.monotonic()

    def reset(self) -> None:
        self.roams, self.prev_ap = [], {}
        self.capture_stopped = False
        self.paused, self.connected = None, {}
        self.t_start = time.monotonic()
        self.pause_gen += 1


session = Session()


def authorized(token: Optional[str]) -> bool:
    return bool(token) and secrets.compare_digest(token, TOKEN)


async def auth(request: Request) -> None:
    header = request.headers.get("authorization", "")
    if not (header.startswith("Bearer ") and authorized(header[7:])):
        raise HTTPException(401, "missing or invalid token")


# ---- capture plumbing --------------------------------------------------------------------------------------------

async def start_streams(run_dir: Path, sources: list, logs: dict) -> None:
    session.keys = KeyTracker(logs)
    for s in sources:
        stream = FrameStream(s["id"], s["ns"], s["iface"], run_dir, session.keys, hub.publish)
        stream.start()
        session.streams[s["id"]] = stream


def capture_hook(run_dir: Path, sources: list, logs: dict) -> None:
    asyncio.run_coroutine_threadsafe(start_streams(run_dir, sources, logs), hub.loop).result(10)


def cancel_walk(node_id: str) -> None:
    task = session.walks.pop(node_id, None)
    if task:
        task.cancel()


async def stop_streams() -> None:
    for node_id in list(session.walks):
        cancel_walk(node_id)
    for stream in list(session.streams.values()):
        await stream.stop()
    session.streams = {}


async def stop_capture(reason: str) -> None:
    """Stop recording but keep the lab running; the pcap files stay as they are."""
    if session.capture_stopped:
        return
    session.capture_stopped = True
    for stream in list(session.streams.values()):
        await stream.stop()
    hub.publish({"type": "capture", "state": "stopped", "reason": reason})


async def auto_stop_capture(gen: int) -> None:
    """Stop the capture when a roam is over and the client is neither walking nor roaming again."""
    await asyncio.sleep(2.5)
    while engine.state == "running" and session.roam_gen == gen:
        if all(t.done() for t in session.walks.values()):
            await stop_capture("the client finished roaming")
            return
        await asyncio.sleep(1.0)


engine.capture_hook = capture_hook

PAUSE_SETTLE_S = 3.0  # lets the last frames of a connection and the first chatter after it be recorded
FAIL_WINDOW_S = 25.0  # a client that cannot connect keeps retrying; this much of it is enough to study


def set_paused(paused: bool, reason: str = "") -> None:
    """Pause or resume recording on every capture without stopping tcpdump, so the files stay one continuous capture."""
    if (session.paused is not None) == paused or session.capture_stopped:
        return
    session.paused = reason if paused else None
    for stream in session.streams.values():
        stream.paused = paused
    hub.publish({"type": "capture", "state": "paused" if paused else "live", "reason": reason})


async def pause_when_settled(gen: int) -> None:
    await asyncio.sleep(PAUSE_SETTLE_S)
    if session.pause_gen == gen and engine.state == "running":
        set_paused(True, "the client is connected")


def resume_capture() -> None:
    session.pause_gen += 1
    set_paused(False)


def pause_later() -> None:
    if engine.topo and engine.topo.pause_capture_when_connected:
        session.pause_gen += 1
        asyncio.create_task(pause_when_settled(session.pause_gen))


# ---- background work ---------------------------------------------------------------------------------------------

async def analyze_roam(sta: dict, frm: str, to: str, t_detect: float, to_mac: str, security: str, from_mac: Optional[str] = None) -> None:
    await asyncio.sleep(1.0)
    record = {"sta": sta["id"], "from": frm, "to": to, "t": t_detect, "mode": security}
    if security == "ft-psk" and engine.topo:
        record.update({"ft_keys": engine.topo.ft_keys, "ft_over_ds": engine.topo.ft_over_ds})
    if session.capture_stopped:
        record["error"] = "The capture had already stopped (auto-stop after the first roam), so this roam was not recorded."
        session.roams.append(record)
        hub.publish({"type": "roam", "roam": record})
        return
    try:
        data = pcap_snapshot(engine.run_dir / "capture-global.pcap")
        with tempfile.NamedTemporaryFile(suffix=".pcap") as tmp:
            tmp.write(data)
            tmp.flush()
            events = await asyncio.to_thread(wifilab.tshark_events, Path(tmp.name))
        record.update(wifilab.roam_from_events(events, t_detect - 3.0, sta["mac"], to_mac, from_mac))
    except Exception as exc:  # analysis must never take the service down
        record["error"] = str(exc)
    session.roams.append(record)
    hub.publish({"type": "roam", "roam": record})
    session.roam_gen += 1
    if engine.topo and engine.topo.auto_stop_capture:
        asyncio.create_task(auto_stop_capture(session.roam_gen))


async def poll_loop() -> None:
    while True:
        await asyncio.sleep(0.5)
        if engine.state != "running":
            continue
        try:
            data = await asyncio.to_thread(engine.poll)
        except Exception:
            log.exception("poll failed")
            continue
        aps = {a["id"]: a["mac"] for a in data["aps"]}
        for s in data["stas"]:
            prev, cur = session.prev_ap.get(s["id"]), s["ap"]
            if prev and cur and prev != cur:
                asyncio.create_task(analyze_roam(s, prev, cur, time.time(), aps[cur], engine.topo.security.value, aps.get(prev)))
            if cur:
                session.prev_ap[s["id"]] = cur
            if engine.topo.pause_capture_when_connected:
                up = s["state"] == "COMPLETED" and bool(cur)
                if up != session.connected.get(s["id"], False):
                    session.connected[s["id"]] = up
                    if not up:
                        resume_capture()
                    elif all(session.connected.values()):
                        pause_later()
            if (engine.topo.pause_capture_when_connected and engine.topo.fault != "none" and session.paused is None
                    and not any(session.connected.values()) and time.monotonic() - session.t_start > FAIL_WINDOW_S):
                set_paused(True, "enough failed attempts are recorded")
        hub.publish({"type": "state", "t": time.time(), **data})


async def do_walk(node_id: str, tx: float, ty: float, speed: float) -> None:
    rt = engine.node(node_id)
    x0, y0 = rt.node.x, rt.node.y
    duration = max(((tx - x0) ** 2 + (ty - y0) ** 2) ** 0.5 / speed, 0.05)
    start, tick = time.monotonic(), 0
    while True:
        f = min((time.monotonic() - start) / duration, 1.0)
        x, y = x0 + (tx - x0) * f, y0 + (ty - y0) * f
        await asyncio.to_thread(engine.move, node_id, x, y)
        tick += 1
        if tick % 2 == 0 or f >= 1.0:
            hub.publish({"type": "move", "id": node_id, "x": round(x, 2), "y": round(y, 2)})
        if f >= 1.0:
            return
        await asyncio.sleep(0.05)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.loop = asyncio.get_running_loop()
    poller = asyncio.create_task(poll_loop())
    yield
    poller.cancel()
    await stop_streams()
    await asyncio.to_thread(engine.stop)


app = FastAPI(title="Wi-Fi Verse", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])
app.add_middleware(CORSMiddleware, allow_origins=UI_ORIGINS, allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])


@app.middleware("http")
async def reject_foreign_origins(request: Request, call_next):
    # The dev proxy injects the token, so a web page on another origin must never reach the API.
    origin = request.headers.get("origin")
    if origin and origin not in UI_ORIGINS and request.url.path != "/api/health":
        return Response("foreign origin", status_code=403)
    return await call_next(request)


# ---- requests ----------------------------------------------------------------------------------------------------

class Position(BaseModel):
    x: float = Field(ge=-1000, le=1000)
    y: float = Field(ge=-1000, le=1000)


class Walk(Position):
    speed: float = Field(default=3.0, gt=0.05, le=30)


class TxPower(BaseModel):
    dbm: int = Field(ge=0, le=30)


class RoamRequest(BaseModel):
    ap: str = Field(pattern=r"^[a-z][a-z0-9]{0,7}$")


class KickRequest(BaseModel):
    sta: str = Field(pattern=r"^[a-z][a-z0-9]{0,7}$")
    kind: Literal["deauth", "disassoc"] = "deauth"
    reason: int = Field(ge=1, le=71)


class CliRequest(BaseModel):
    command: str = Field(min_length=1, max_length=80)


def engine_call(fn, *args):
    async def run():
        try:
            return await asyncio.to_thread(fn, *args)
        except EngineError as exc:
            raise HTTPException(409, str(exc)) from exc
    return run()


# ---- routes ------------------------------------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/api/presets", dependencies=[Depends(auth)])
async def presets() -> dict:
    return {k: v.model_dump(mode="json") for k, v in PRESETS.items()}


@app.get("/api/state", dependencies=[Depends(auth)])
async def state() -> dict:
    return {"lab": engine.snapshot(), "roams": session.roams,
            "captures": {k: {"frames": s.total, "decrypted": s.decrypted_total} for k, s in session.streams.items()}}


@app.get("/api/labs", dependencies=[Depends(auth)])
async def list_labs() -> list:
    return sorted(p.stem for p in LABS_DIR.glob("*.json")) if LABS_DIR.exists() else []


@app.put("/api/labs/{name}", dependencies=[Depends(auth)])
async def save_lab(name: str, topo: Topology) -> dict:
    if not LAB_NAME_RE.match(name):
        raise HTTPException(422, "name must match [a-z0-9_-]{1,40}")
    LABS_DIR.mkdir(exist_ok=True)
    path = LABS_DIR / f"{name}.json"
    path.write_text(topo.model_dump_json(indent=1))
    os.chown(path, os.stat(ROOT).st_uid, os.stat(ROOT).st_gid)
    return {"saved": name}


@app.get("/api/labs/{name}", dependencies=[Depends(auth)])
async def load_lab(name: str) -> dict:
    path = LABS_DIR / f"{name}.json"
    if not LAB_NAME_RE.match(name) or not path.exists():
        raise HTTPException(404, "no such lab")
    return Topology.model_validate_json(path.read_text()).model_dump(mode="json")


@app.post("/api/lab/start", dependencies=[Depends(auth)])
async def lab_start(topo: Topology) -> dict:
    if engine.state != "stopped":
        raise HTTPException(409, f"lab is {engine.state}")
    session.reset()
    try:
        await asyncio.to_thread(engine.start, topo)
    except EngineError as exc:
        await stop_streams()
        raise HTTPException(409, str(exc)) from exc
    return engine.snapshot()


@app.post("/api/lab/stop", dependencies=[Depends(auth)])
async def lab_stop() -> dict:
    await stop_streams()
    await asyncio.to_thread(engine.stop)
    return engine.snapshot()


@app.post("/api/nodes/{node_id}/position", dependencies=[Depends(auth)])
async def set_position(node_id: str, pos: Position) -> dict:
    cancel_walk(node_id)
    await engine_call(engine.move, node_id, pos.x, pos.y)
    hub.publish({"type": "move", "id": node_id, "x": pos.x, "y": pos.y})
    return {"id": node_id, "x": pos.x, "y": pos.y}


@app.post("/api/nodes/{node_id}/tx", dependencies=[Depends(auth)])
async def set_tx(node_id: str, body: TxPower) -> dict:
    await engine_call(engine.set_txpower, node_id, body.dbm)
    return {"id": node_id, "dbm": body.dbm}


@app.post("/api/nodes/{node_id}/walk", dependencies=[Depends(auth)])
async def walk(node_id: str, body: Walk) -> dict:
    await engine_call(engine.node, node_id)
    cancel_walk(node_id)
    session.walks[node_id] = asyncio.create_task(do_walk(node_id, body.x, body.y, body.speed))
    return {"id": node_id, "to": [body.x, body.y], "speed": body.speed}


@app.delete("/api/nodes/{node_id}/walk", dependencies=[Depends(auth)])
async def stop_walk(node_id: str) -> dict:
    cancel_walk(node_id)
    return {"id": node_id, "walking": False}


@app.post("/api/nodes/{node_id}/reconnect", dependencies=[Depends(auth)])
async def reconnect(node_id: str) -> dict:
    resume_capture()
    try:
        await engine_call(engine.reconnect, node_id)
    finally:
        pause_later()
    return {"id": node_id}


@app.post("/api/capture/resume", dependencies=[Depends(auth)])
async def capture_resume() -> dict:
    resume_capture()
    return {"capture": "live"}


@app.get("/api/attempts", dependencies=[Depends(auth)])
async def attempts(sta: str, ap: str, run: Optional[str] = None) -> dict:
    """Every connection attempt of the client, successful or not, with the status and reason codes seen."""
    if not (NODE_RE.match(sta) and NODE_RE.match(ap)):
        raise HTTPException(422, "bad node id")
    macs = engine.macs
    if sta not in macs or ap not in macs:
        raise HTTPException(404, "no such device in the last run")
    snapshot = pcap_snapshot(_capture_file("global", True, run))
    with tempfile.NamedTemporaryFile(suffix=".pcap") as tmp:
        tmp.write(snapshot)
        tmp.flush()
        events = await asyncio.to_thread(wifilab.tshark_events, Path(tmp.name))
    return {"attempts": wifilab.attempts_from_events(events, macs[sta], macs[ap]),
            "mode": engine.topo.security.value if engine.topo else None, "fault": engine.topo.fault if engine.topo else "none"}


@app.post("/api/nodes/{node_id}/deauth", dependencies=[Depends(auth)])
async def deauth(node_id: str, body: KickRequest) -> dict:
    """An AP sends a Deauthentication or Disassociation with a reason code of your choice to one client."""
    resume_capture()
    try:
        out = await engine_call(engine.kick, node_id, body.sta, body.kind, body.reason)
    finally:
        pause_later()
    return {"id": node_id, "sta": body.sta, "kind": body.kind, "reason": body.reason, "output": out}


@app.get("/api/connection", dependencies=[Depends(auth)])
async def connection(sta: str, ap: str, run: Optional[str] = None) -> dict:
    """The client's connection attempts to an AP, measured from the capture."""
    if not (NODE_RE.match(sta) and NODE_RE.match(ap)):
        raise HTTPException(422, "bad node id")
    macs = engine.macs
    if sta not in macs or ap not in macs:
        raise HTTPException(404, "no such device in the last run")
    snapshot = pcap_snapshot(_capture_file("global", False, run))
    with tempfile.NamedTemporaryFile(suffix=".pcap") as tmp:
        tmp.write(snapshot)
        tmp.flush()
        events = await asyncio.to_thread(wifilab.tshark_events, Path(tmp.name))
    found = wifilab.connections_from_events(events, macs[sta], macs[ap])
    return {"connections": found, "mode": engine.topo.security.value if engine.topo else None}


@app.post("/api/nodes/{node_id}/roam", dependencies=[Depends(auth)])
async def roam(node_id: str, body: RoamRequest) -> dict:
    await engine_call(engine.roam, node_id, body.ap)
    return {"id": node_id, "ap": body.ap}


@app.get("/api/roams", dependencies=[Depends(auth)])
async def roams() -> list:
    return session.roams


@app.get("/api/frames", dependencies=[Depends(auth)])
async def frames(src: str = "global", limit: int = Query(200, ge=1, le=5000), beacons: bool = False,
                 t_from: Optional[float] = None, t_to: Optional[float] = None) -> list:
    stream = session.streams.get(src)
    if stream is None:
        raise HTTPException(404, "no such capture source")
    items = list(stream.ring) + (list(stream.beacons) if beacons else [])
    items.sort(key=lambda f: f["n"])
    if t_from is not None:
        items = [f for f in items if f["t"] >= t_from]
    if t_to is not None:
        items = [f for f in items if f["t"] <= t_to]
    return items[-limit:]


def _run_dir(run: Optional[str]) -> Path:
    if run is None:
        if engine.run_dir is None:
            raise HTTPException(404, "no such capture")
        return engine.run_dir
    path = RUNS_DIR / run
    if not RUN_RE.match(run) or not path.is_dir():
        raise HTTPException(404, "no such run")
    return path


def _capture_file(src: str, decrypted: bool, run: Optional[str] = None) -> Path:
    if not SOURCE_RE.match(src):
        raise HTTPException(404, "no such capture")
    path = _run_dir(run) / f"capture-{src}{'.decrypted' if decrypted else ''}.pcap"
    if not path.exists():
        raise HTTPException(404, "no such capture")
    return path


def _pdml_node(el: ET.Element) -> Optional[dict]:
    if el.get("hide") == "yes":
        return None
    name = el.get("name") or ""
    label = el.get("showname") or (f"{el.get('show')}" if el.get("show") else name)
    node: dict = {"l": label, "f": name, "v": el.get("show") or "", "p": int(el.get("pos") or 0), "s": int(el.get("size") or 0)}
    kids = [k for k in (_pdml_node(c) for c in el) if k is not None]
    if kids:
        node["c"] = kids
    return node


async def _tshark(*args: str, timeout: float = 20) -> tuple:
    proc = await asyncio.create_subprocess_exec("tshark", "-n", *args, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(504, "tshark timed out")
    return out, err.decode(errors="replace")


@app.get("/api/frames/{src}/{n}", dependencies=[Depends(auth)])
async def frame_detail(src: str, n: int, decrypted: bool = True, run: Optional[str] = None) -> dict:
    """Wireshark's own packet-details tree (PDML) and bytes for one frame. The whole capture is read so frame
    numbers, relative times and 'response in' links match what Wireshark shows."""
    snapshot = pcap_snapshot(_capture_file(src, decrypted, run))
    found = pcap_record(snapshot, n)
    if found is None:
        raise HTTPException(404, "no such frame")
    with tempfile.NamedTemporaryFile(suffix=".pcap") as tmp:
        tmp.write(snapshot)
        tmp.flush()
        out, err = await _tshark("-r", tmp.name, "-Y", f"frame.number == {n}", "-T", "pdml")
    try:
        packet_el = ET.fromstring(out).find("packet")
    except ET.ParseError:
        packet_el = None
    if packet_el is None:
        raise HTTPException(500, f"tshark could not dissect frame {n}: {err.strip()[:200]}")
    protos = [p for p in (_pdml_node(c) for c in packet_el if c.get("name") != "geninfo") if p is not None]
    packet = found[1][16:]
    return {"n": n, "src": src, "hex": packet.hex(), "radiotap_len": struct.unpack("<H", packet[2:4])[0], "tree": protos}


@app.get("/api/captures/{src}/filter", dependencies=[Depends(auth)])
async def display_filter(src: str, expr: str = Query(min_length=1, max_length=400), run: Optional[str] = None) -> dict:
    """Run a real Wireshark display filter over the (decrypted) capture and return the matching frame numbers."""
    snapshot = pcap_snapshot(_capture_file(src, True, run))
    with tempfile.NamedTemporaryFile(suffix=".pcap") as tmp:
        tmp.write(snapshot)
        tmp.flush()
        out, err = await _tshark("-r", tmp.name, "-Y", expr, "-T", "fields", "-e", "frame.number")
    # tshark running as root always warns on stderr; only a real message means a bad filter.
    problems = [line for line in err.splitlines() if line.strip() and not line.startswith("Running as")]
    if not out and problems:
        return {"numbers": [], "error": problems[0].replace('"' + expr + '" ', "").strip()[:300]}
    return {"numbers": [int(x) for x in out.decode().split() if x.isdigit()], "error": None}


class PingRequest(BaseModel):
    count: int = Field(default=4, ge=1, le=10)


@app.post("/api/nodes/{node_id}/ping", dependencies=[Depends(auth)])
async def ping(node_id: str, body: PingRequest) -> dict:
    """One-off ping from a client to the gateway (the lab sends no traffic of its own)."""
    resume_capture()
    try:
        return {"id": node_id, "output": await engine_call(engine.ping, node_id, body.count)}
    finally:
        pause_later()


@app.get("/api/cli", dependencies=[Depends(auth)])
async def cli_catalog() -> dict:
    return catalog()


def _node_kind(node_id: str) -> str:
    node = next((n for n in engine.topo.nodes if n.id == node_id), None) if engine.topo else None
    if not NODE_RE.match(node_id) or node is None:
        raise HTTPException(404, "no such node")
    return node.kind


@app.post("/api/nodes/{node_id}/cli", dependencies=[Depends(auth)])
async def node_cli(node_id: str, body: CliRequest) -> dict:
    """One read-only hostapd_cli / wpa_cli command from the fixed list in cli.py."""
    kind = _node_kind(node_id)
    if kind == "sniffer":
        raise HTTPException(422, "sniffers run no daemon")
    argv = parse(kind, body.command)
    if argv is None:
        raise HTTPException(422, "command not allowed; the terminal only offers the listed read-only commands")
    if argv[0] in LAB_COMMANDS:
        if engine.run_dir is None:
            raise HTTPException(409, "no run yet")
        out = await asyncio.to_thread(ft_report, engine.run_dir, node_id, kind)
        return {"id": node_id, "command": body.command, "output": out}
    return {"id": node_id, "command": body.command, "output": await engine_call(engine.daemon_cli, node_id, argv)}


@app.get("/api/nodes/{node_id}/log", dependencies=[Depends(auth)])
async def node_log(node_id: str, lines: int = Query(300, ge=1, le=5000), match: str = Query("", max_length=80),
                   run: Optional[str] = None) -> dict:
    """The tail of a daemon's debug log (hostapd -dd / wpa_supplicant -dd), optionally only lines containing `match`."""
    if not NODE_RE.match(node_id):
        raise HTTPException(404, "no such node")
    path = _run_dir(run) / f"{node_id}.log"
    if not path.exists():
        raise HTTPException(404, "no log yet")
    size = path.stat().st_size
    with path.open("rb") as fh:
        fh.seek(max(0, size - LOG_TAIL_BYTES))
        text = fh.read().decode(errors="replace")
    rows = text.splitlines()
    if size > LOG_TAIL_BYTES:
        rows = rows[1:]  # the first line is cut off
    needle = match.lower()
    if needle:
        rows = [r for r in rows if needle in r.lower()]
    return {"id": node_id, "size": size, "matches": len(rows), "lines": [r[:400] for r in rows[-lines:]]}


@app.get("/api/ft", dependencies=[Depends(auth)])
async def ft_config(run: Optional[str] = None) -> dict:
    """The fast-transition settings each AP of a run was started with (from its hostapd config file)."""
    aps = []
    for conf in sorted(_run_dir(run).glob("ap*.conf")):
        if not NODE_RE.match(conf.stem):
            continue
        values: dict = {}
        r0kh, r1kh = [], []
        for line in conf.read_text().splitlines():
            key, _, val = line.partition("=")
            if key == "r0kh":
                r0kh.append(val)
            elif key == "r1kh":
                r1kh.append(val)
            else:
                values[key] = val
        holder = values.get("r1_key_holder", "")
        aps.append({
            "id": conf.stem, "key_mgmt": values.get("wpa_key_mgmt", ""), "mobility_domain": values.get("mobility_domain", ""),
            "r0kh_id": values.get("nas_identifier", ""),
            "r1kh_id": ":".join(holder[i:i + 2] for i in range(0, len(holder), 2)),
            "generate_local": values.get("ft_psk_generate_local") == "1", "over_ds": values.get("ft_over_ds") == "1",
            "r0kh": r0kh, "r1kh": r1kh,
        })
    return {"ft": bool(aps) and all("FT" in a["key_mgmt"] for a in aps), "aps": aps}


LOG_TS = re.compile(r"^(\d+\.\d+): ")
# Lines the lab causes itself by polling wpa_supplicant for the signal.
LOG_POLLING = re.compile(r"SIGNAL_POLL|CTRL-DEBUG|ctrl_sock|ctrl_iface|Control interface|CTRL_IFACE|STA-FIRST|STA-NEXT|EAP Session-Id not available")


@app.get("/api/logs", dependencies=[Depends(auth)])
async def log_window(nodes: str = Query(max_length=60), t_from: float = 0, t_to: float = 1e12, run: Optional[str] = None,
                     match: str = Query("", max_length=80), limit: int = Query(4000, ge=1, le=10000), tail: bool = False, quiet: bool = False) -> list:
    """Debug-log lines of several daemons inside a time window, merged in time order (for the roam view)."""
    ids = [n for n in nodes.split(",") if n]
    if not ids or len(ids) > 6 or not all(NODE_RE.match(n) for n in ids):
        raise HTTPException(422, "bad node list")
    base = _run_dir(run)
    out: list = []
    for node in dict.fromkeys(ids):
        path = base / f"{node}.log"
        if not path.exists():
            continue
        size = path.stat().st_size
        with path.open("rb") as fh:
            fh.seek(max(0, size - LOG_TAIL_BYTES))
            rows = fh.read().decode(errors="replace").splitlines()
        last = None
        for row in rows:
            m = LOG_TS.match(row)
            if not m:
                if last is not None:
                    last["text"] += " " + row.strip()
                continue
            t = float(m[1])
            last = None
            if t_from <= t <= t_to:
                last = {"t": t, "node": node, "text": LOG_TS.sub("", row[m.end():], count=1)}
                out.append(last)
    out.sort(key=lambda r: r["t"])
    needle = match.lower()
    if quiet:
        out = [r for r in out if not LOG_POLLING.search(r["text"])]
    if needle:
        out = [r for r in out if needle in r["text"].lower()]
    for r in out:
        r["text"] = r["text"][:400]
    return out[-limit:] if tail else out[:limit]


@app.get("/api/captures", dependencies=[Depends(auth)])
async def captures() -> list:
    if engine.run_dir is None:
        return []
    return sorted(p.name[len("capture-"):-len(".pcap")] for p in engine.run_dir.glob("capture-*.pcap") if "decrypted" not in p.name)


@app.get("/api/runs", dependencies=[Depends(auth)])
async def runs() -> list:
    """Saved captures, newest first: every run directory that holds a capture."""
    current = engine.run_dir.name if engine.run_dir else None
    items = []
    for d in sorted((p for p in RUNS_DIR.iterdir() if p.is_dir() and RUN_RE.match(p.name)), reverse=True):
        sources = sorted(p.name[len("capture-"):-len(".pcap")] for p in d.glob("capture-*.pcap") if "decrypted" not in p.name)
        if "global" in sources:
            items.append({"id": d.name, "mode": d.name.split("-", 2)[2], "sources": sources, "current": d.name == current})
    return items


@app.get("/api/runs/{run}/frames", dependencies=[Depends(auth)])
async def run_frames(run: str, src: str = "global", t_from: Optional[float] = None, t_to: Optional[float] = None) -> list:
    return await asyncio.to_thread(load_capture, src, _capture_file(src, True, run), _capture_file(src, False, run), t_from, t_to)


@app.get("/api/captures/{src}/pcap", dependencies=[Depends(auth)])
async def download_pcap(src: str, decrypted: bool = False, run: Optional[str] = None) -> Response:
    data = pcap_snapshot(_capture_file(src, decrypted, run))
    name = f"{src}{'-decrypted' if decrypted else ''}.pcap"
    return Response(data, media_type="application/vnd.tcpdump.pcap", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/keys", dependencies=[Depends(auth)])
async def keys() -> list:
    if session.keys:
        session.keys.refresh()
    return session.keys.keys if session.keys else []


@app.websocket("/api/ws")
async def ws(websocket: WebSocket) -> None:
    header = websocket.headers.get("authorization", "")
    token = websocket.query_params.get("token") or (header[7:] if header.startswith("Bearer ") else None)
    origin = websocket.headers.get("origin")
    if not authorized(token) or (origin and origin not in UI_ORIGINS):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
    hub.subs.add(queue)
    try:
        recent = sorted(list(session.streams["global"].ring)[-200:] + list(session.streams["global"].beacons)[-20:],
                        key=lambda f: f["n"]) if "global" in session.streams else []
        await websocket.send_json({"type": "snapshot", "lab": engine.snapshot(), "roams": session.roams, "frames": recent,
                                   "capture": "stopped" if session.capture_stopped else "paused" if session.paused else "live"})
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        hub.subs.discard(queue)
