"""Live capture: dumpcap -> decrypt with keys from the logs -> tshark columns -> frame events.

Writes capture-<src>.pcap (as heard) and capture-<src>.decrypted.pcap into the run directory while streaming.
"""
import asyncio
import logging
import os
import struct
import subprocess
from collections import deque
from pathlib import Path
from typing import Callable, Optional

from wifilab import ccmp_decrypt

from .keys import KeyTracker

log = logging.getLogger("labd.frames")

FIELDS = [
    "frame.number", "frame.time_epoch", "frame.len", "radiotap.dbm_antsignal", "wlan_radio.channel",
    "wlan.fc.type_subtype", "wlan.sa", "wlan.da", "wlan.bssid", "wlan.fixed.auth.alg", "wlan.fixed.status_code",
    "wlan_rsna_eapol.keydes.msgnr", "_ws.col.protocol", "_ws.col.info", "wlan.ra", "wlan.ta",
    "_ws.col.def_src", "_ws.col.def_dst", "wlan.fixed.category_code", "wlan.fixed.action_code", "wlan.fixed.auth_seq",
    "wlan.fixed.reason_code",
]
SUBTYPES = {
    0x00: "AssocReq", 0x01: "AssocResp", 0x02: "ReassocReq", 0x03: "ReassocResp", 0x04: "ProbeReq", 0x05: "ProbeResp",
    0x08: "Beacon", 0x0A: "Disassoc", 0x0B: "Auth", 0x0C: "Deauth", 0x0D: "Action",
    0x20: "Data", 0x21: "Data+CF", 0x24: "Null", 0x28: "QoS Data", 0x2C: "QoS Null",
    0x1B: "RTS", 0x1C: "CTS", 0x1D: "ACK",
}
RING = 5000
FLUSH_SECONDS = 0.1
MAX_CAPTURE_BYTES = 50 * 1024 * 1024  # per capture file; recording stops when a source reaches it


def pcap_snapshot(path: Path) -> bytes:
    """Whole records only, so a capture that is still being written is always a valid pcap."""
    data = path.read_bytes()
    if len(data) < 24:
        return b""
    endian = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
    pos = 24
    while pos + 16 <= len(data):
        caplen = struct.unpack(endian + "I", data[pos + 8:pos + 12])[0]
        if pos + 16 + caplen > len(data):
            break
        pos += 16 + caplen
    return data[:pos]


def pcap_record(data: bytes, n: int) -> Optional[tuple]:
    """Return (global_header, record_bytes) for the 1-based packet n of a pcap, or None."""
    if len(data) < 24:
        return None
    endian = "<" if data[:4] == b"\xd4\xc3\xb2\xa1" else ">"
    pos, idx = 24, 0
    while pos + 16 <= len(data):
        caplen = struct.unpack(endian + "I", data[pos + 8:pos + 12])[0]
        if pos + 16 + caplen > len(data):
            return None
        idx += 1
        if idx == n:
            return data[:24], data[pos:pos + 16 + caplen]
        pos += 16 + caplen
    return None


def _int(s: str) -> Optional[int]:
    s = s.split(",")[0]
    return int(s) if s.lstrip("-").isdigit() else None


def frame_from_row(p: list, sid: str, t0: float, air_len: Optional[int], dec: bool) -> dict:
    """One tshark FIELDS row as a frame summary; shared by the live stream and saved captures."""
    subtype = int(p[5], 16) if p[5].startswith("0x") else None
    if p[11]:
        kind = f"EAPOL-M{p[11]}"
    else:
        kind = SUBTYPES.get(subtype, f"0x{subtype:02x}" if subtype is not None else "?")
    if kind == "Action" and p[18] == "6":  # category 6 is Fast BSS Transition (over the DS)
        kind = {"1": "FT-Req", "2": "FT-Resp", "3": "FT-Confirm", "4": "FT-Ack"}.get(p[19], "FT-Action")
    t = float(p[1] or 0)
    # Like Wireshark: control frames have no source, only a receiver (and sometimes a transmitter).
    return {
        "src": sid, "n": _int(p[0]) or 0, "t": t, "rel": t - t0, "len": air_len if air_len is not None else _int(p[2]),
        "rssi": _int(p[3]), "ch": _int(p[4]), "type": kind, "sa": p[6] or p[15], "da": p[7] or p[14],
        "bssid": p[8], "alg": p[9], "status": p[10], "proto": p[12], "info": p[13], "dec": dec,
        "scol": p[16], "dcol": p[17], "aseq": p[20], "reason": p[21],
    }


def _tshark_rows(path: Path, fields: list, display_filter: Optional[str] = None) -> list:
    cmd = ["tshark", "-r", str(path), "-n", "-T", "fields", "-E", "separator=/t", "-E", "occurrence=f"]
    if display_filter:
        cmd += ["-Y", display_filter]
    for f in fields:
        cmd += ["-e", f]
    out = subprocess.run(cmd, capture_output=True, check=False).stdout.decode(errors="replace")
    rows = []
    for line in out.splitlines():
        p = line.split("\t")
        rows.append(p + [""] * (len(fields) - len(p)))
    return rows


def load_capture(sid: str, decrypted: Path, raw: Path, t_from: Optional[float] = None, t_to: Optional[float] = None) -> list:
    """Frame summaries for a saved capture, optionally only a time window (epoch seconds). The over-the-air
    length comes from the raw file; decryption shortens a frame, so a length that differs between the two files
    marks a decrypted frame."""
    flt = None
    if t_from is not None and t_to is not None:
        flt = f"frame.time_epoch >= {t_from:.6f} && frame.time_epoch <= {t_to:.6f}"
    air = {_int(r[0]): _int(r[1]) for r in _tshark_rows(raw, ["frame.number", "frame.len"], flt)}
    rows = _tshark_rows(decrypted, FIELDS, flt)
    if not rows:
        return []
    t0 = float(rows[0][1] or 0)
    frames = []
    for p in rows:
        heard = air.get(_int(p[0]) or 0)
        frames.append(frame_from_row(p, sid, t0, heard, heard is not None and heard != _int(p[2])))
    return frames


class FrameStream:
    def __init__(self, sid: str, ns: Optional[str], iface: str, run_dir: Path, keys: KeyTracker,
                 publish: Callable[[dict], None]):
        self.sid, self.ns, self.iface, self.run_dir, self.keys, self.publish = sid, ns, iface, run_dir, keys, publish
        self.ring: deque = deque(maxlen=RING)
        self.beacons: deque = deque(maxlen=300)  # kept apart so 20 beacons/s never evict roam frames
        self.total = 0
        self.decrypted_total = 0
        self._decrypted: set = set()
        self._air_len: dict = {}  # frame number -> length as heard, before decryption shortens it
        self.t0: Optional[float] = None
        self.paused = False  # packets heard while paused are dropped before they reach the files or tshark
        self.on_limit: Optional[Callable[[str], None]] = None  # called once when the capture file reaches the size cap
        self.size = 0
        self._batch: list = []
        self._procs: list = []
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"frames-{self.sid}")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        for p in self._procs:
            if p.returncode is None:
                p.kill()
        for p in self._procs:
            await p.wait()

    async def _run(self) -> None:
        # dumpcap block-buffers a pipe; tcpdump -U --immediate-mode delivers each packet as it arrives.
        dump_cmd = ["tcpdump", "-i", self.iface, "-U", "--immediate-mode", "-s", "0", "-n", "-Z", "root", "-w", "-"]
        if self.ns:
            dump_cmd = ["ip", "netns", "exec", self.ns, *dump_cmd]
        dump = await asyncio.create_subprocess_exec(*dump_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        tsh_cmd = ["tshark", "-r", "-", "-l", "-n", "-T", "fields", "-E", "separator=/t", "-E", "occurrence=f"]
        for f in FIELDS:
            tsh_cmd += ["-e", f]
        # tshark -r - rejects sockets, so give it a real pipe (asyncio's subprocess PIPE is a socketpair).
        read_fd, write_fd = os.pipe()
        tsh = await asyncio.create_subprocess_exec(*tsh_cmd, stdin=read_fd, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.PIPE)
        os.close(read_fd)
        loop = asyncio.get_running_loop()
        transport, protocol = await loop.connect_write_pipe(lambda: asyncio.streams.FlowControlMixin(loop=loop),
                                                            os.fdopen(write_fd, "wb", buffering=0))
        writer = asyncio.StreamWriter(transport, protocol, None, loop)
        self._procs = [dump, tsh]
        try:
            await asyncio.gather(self._pump(dump, writer), self._read(tsh), self._flusher(),
                                 self._log_stderr(dump, "tcpdump"), self._log_stderr(tsh, "tshark"))
        except (asyncio.IncompleteReadError, BrokenPipeError, ConnectionResetError):
            log.warning("capture %s ended", self.sid)
        finally:
            writer.close()

    async def _log_stderr(self, proc, name: str) -> None:
        async for line in proc.stderr:
            log.warning("%s[%s]: %s", name, self.sid, line.decode(errors="replace").rstrip())

    def _decrypt(self, pkt: bytes, origlen: int):
        rt_len = struct.unpack("<H", pkt[2:4])[0]
        radiotap, frame = pkt[:rt_len], pkt[rt_len:]
        if not (len(frame) >= 24 and (frame[0] >> 2) & 3 == 2 and frame[1] & 0x40):
            return pkt, origlen, False
        plain = ccmp_decrypt(frame, self.keys.ciphers)
        if plain is None and self.keys.refresh():
            plain = ccmp_decrypt(frame, self.keys.ciphers)
        if plain is None:
            return pkt, origlen, False
        return radiotap + plain, origlen - (len(frame) - len(plain)), True

    async def _pump(self, dump, out_tsh) -> None:
        raw = open(self.run_dir / f"capture-{self.sid}.pcap", "wb")
        dec = open(self.run_dir / f"capture-{self.sid}.decrypted.pcap", "wb")
        try:
            hdr = await dump.stdout.readexactly(24)
            endian = "<" if hdr[:4] == b"\xd4\xc3\xb2\xa1" else ">"
            for sink in (raw, dec, out_tsh):
                sink.write(hdr)
            self.size = len(hdr)
            n = 0
            while True:
                rec = await dump.stdout.readexactly(16)
                ts_s, ts_us, caplen, origlen = struct.unpack(endian + "IIII", rec)
                pkt = await dump.stdout.readexactly(caplen)
                if self.paused:
                    continue
                n += 1
                self._air_len[n] = origlen
                out, out_orig, ok = self._decrypt(pkt, origlen)
                if ok:
                    self._decrypted.add(n)
                    self.decrypted_total += 1
                rec_dec = struct.pack(endian + "IIII", ts_s, ts_us, len(out), out_orig) + out
                raw.write(rec + pkt)
                dec.write(rec_dec)
                out_tsh.write(rec_dec)
                raw.flush()
                dec.flush()
                await out_tsh.drain()
                self.size += len(rec) + len(pkt)
                if self.size >= MAX_CAPTURE_BYTES:
                    if self.on_limit:
                        self.on_limit(self.sid)
                    return
        finally:
            raw.close()
            dec.close()

    async def _read(self, tsh) -> None:
        width = len(FIELDS)
        async for line in tsh.stdout:
            p = line.decode(errors="replace").rstrip("\n").split("\t")
            p += [""] * (width - len(p))
            n = _int(p[0]) or 0
            t = float(p[1] or 0)
            if self.t0 is None:
                self.t0 = t
            frame = frame_from_row(p, self.sid, self.t0, self._air_len.pop(n, None), n in self._decrypted)
            self._decrypted.discard(n)
            self.total += 1
            (self.beacons if frame["type"] == "Beacon" else self.ring).append(frame)
            self._batch.append(frame)

    async def _flusher(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_SECONDS)
            if self._batch:
                batch, self._batch = self._batch, []
                self.publish({"type": "frames", "src": self.sid, "frames": batch})
