"""Incrementally extracts CCMP keys (PTK TK and GTK) from hostapd / wpa_supplicant -K debug logs."""
from cryptography.hazmat.primitives.ciphers.aead import AESCCM

from wifilab import RE_KEYDATA, RE_PTK, RE_SETKEY


class KeyTracker:
    def __init__(self, logs: dict):
        self.logs = logs
        self.offset = {n: 0 for n in logs}
        self.partial = {n: "" for n in logs}
        self.pending = {n: None for n in logs}
        self.seen: set = set()
        self.ciphers: list = []  # newest first
        self.keys: list = []  # (ts, node, kind, hex), for export
        self._by_key: dict = {}

    def _add(self, ts: float, node: str, kind: str, hexkey: str) -> None:
        if hexkey in self.seen:
            # The same key in another daemon's log means both ends installed it.
            nodes = self._by_key[hexkey]["nodes"]
            if node not in nodes:
                nodes.append(node)
            return
        self.seen.add(hexkey)
        self.ciphers.insert(0, AESCCM(bytes.fromhex(hexkey), tag_length=8))
        entry = {"ts": ts, "node": node, "nodes": [node], "kind": kind, "key": hexkey}
        self._by_key[hexkey] = entry
        self.keys.append(entry)

    def refresh(self) -> bool:
        before = len(self.seen)
        for node, path in self.logs.items():
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                continue
            if size <= self.offset[node]:
                continue
            with path.open("rb") as fh:
                fh.seek(self.offset[node])
                chunk = fh.read()
            self.offset[node] += len(chunk)
            *lines, self.partial[node] = (self.partial[node] + chunk.decode(errors="replace")).split("\n")
            for line in lines:
                self._parse(node, line)
        return len(self.seen) != before

    def _parse(self, node: str, line: str) -> None:
        m = RE_PTK.match(line)
        if m:
            ptk = m[3].replace(" ", "")
            if int(m[2]) == 48:
                self._add(float(m[1]), node, "tk", ptk[-32:])
            return
        m = RE_SETKEY.match(line)
        if m:
            self.pending[node] = (float(m[1]), int(m[2]), int(m[3]))
            return
        m = RE_KEYDATA.search(line)
        pending = self.pending[node]
        if m and pending and pending[1] == 3 and int(m[1]) == 16 and pending[2] >= 1:
            self._add(pending[0], node, "gtk", m[2].replace(" ", ""))
        if m:
            self.pending[node] = None
