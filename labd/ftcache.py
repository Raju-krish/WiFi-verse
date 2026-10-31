"""Reads the FT PMK-R1 entries a daemon logged. hostapd has no control command that lists its PMK-R1 cache, so the
debug log (hostapd/wpa_supplicant -dd -K) is the only place to see what was pushed, pulled or derived."""
import re
from datetime import datetime
from pathlib import Path

LINE = re.compile(r"^(\d+\.\d+): (.*)$")
HEX = re.compile(r"hexdump(?:_ascii)?\(len=(\d+)\): ((?:[0-9a-f]{2} ?)+)", re.I)
STARTS = (
    (re.compile(r"FT: Received PMK-R1 push"), "push"),
    (re.compile(r"FT: Received PMK-R1 pull response"), "pull"),
    (re.compile(r"FT: Derive PMK-R1 using"), "derive"),
)


def _hexbytes(text: str):
    m = HEX.search(text)
    return bytes(int(h, 16) for h in m[2].split()[: int(m[1])]) if m else None


def parse_log(path: Path) -> list:
    """PMK-R1 entries in time order: {t, how, r0kh, r1kh, s1kh, name, key, expires}."""
    entries: list = []
    cur = None

    def close() -> None:
        nonlocal cur
        if cur and cur.get("key") and cur.get("name"):
            if not entries or (entries[-1]["name"], entries[-1]["how"]) != (cur["name"], cur["how"]):
                entries.append(cur)
        cur = None

    try:
        text = path.read_text(errors="replace")
    except FileNotFoundError:
        return entries
    for raw in text.splitlines():
        m = LINE.match(raw)
        if not m:
            continue
        t, body = float(m[1]), m[2]
        for rx, how in STARTS:
            if rx.search(body):
                close()
                cur = {"t": t, "how": how}
                break
        else:
            if cur is None or not body.startswith("FT:"):
                continue
            if body.startswith("FT: Derive PTK"):  # the PMK-R1 block is over; later FT lines belong to something else
                close()
                continue
            if "R0KH-ID" in body and "hexdump" in body and "STA R0KH-ID" not in body:
                b = _hexbytes(body)
                if b:
                    cur["r0kh"] = b.decode(errors="replace")
            elif body.startswith("FT: R1KH-ID"):
                if "hexdump" in body:
                    b = _hexbytes(body)
                    if b:
                        cur["r1kh"] = ":".join(f"{x:02x}" for x in b)
                else:
                    cur["r1kh"] = body.split("=", 1)[-1].strip()
            elif body.startswith("FT: S1KH-ID"):
                cur["s1kh"] = re.search(r"S1KH-ID[:=] ?(\S+)", body)[1]
            elif body.startswith("FT: PMKR1Name - hexdump"):
                b = _hexbytes(body)
                if b:
                    cur["name"] = b.hex()
            elif body.startswith("FT: PMK-R1 - hexdump"):
                b = _hexbytes(body)
                if b:
                    cur["key"] = b.hex()
            elif "expires_in=" in body:
                cur["expires"] = int(body.rsplit("=", 1)[-1])
    close()
    return entries


def _mask(h: str) -> str:
    return f"{h[:8]}...{h[-4:]}"


def report(run_dir: Path, node: str, kind: str) -> str:
    own = ""
    conf = run_dir / f"{node}.conf"
    if conf.exists():
        for line in conf.read_text().splitlines():
            if line.startswith("r1_key_holder="):
                h = line.split("=", 1)[1]
                own = ":".join(h[i:i + 2] for i in range(0, len(h), 2))
    mine = parse_log(run_dir / f"{node}.log")
    holders: dict = {}
    for log in sorted(run_dir.glob("*.log")):
        if log.stem == node or not re.fullmatch(r"(ap|sta)\d+", log.stem):
            continue
        for e in parse_log(log):
            holders.setdefault(e["name"], []).append((log.stem, e["how"]))
    if not mine:
        return f"No PMK-R1 entry in {node}.log yet. One appears when a client joins (generated, pushed or pulled)."
    daemon = "hostapd" if kind == "ap" else "wpa_supplicant"
    out = [f"PMK-R1 entries seen by {daemon} on {node}, read from {node}.log (no {daemon} command lists them).", ""]
    for i, e in enumerate(mine[-8:], 1):
        when = datetime.fromtimestamp(e["t"]).strftime("%H:%M:%S.%f")[:-3]
        if e["how"] == "push":
            how = f"PUSHED to this AP by R0KH {e.get('r0kh', '?')}"
        elif e["how"] == "pull":
            how = "PULLED from the R0KH (pull response)"
        elif kind == "sta":
            how = "derived by the client"
        elif own and e.get("r1kh") and e["r1kh"] != own:
            how = f"derived here, to be PUSHED to R1KH {e['r1kh']}"
        else:
            how = "derived by this AP from the passphrase (local generation or initial association)"
        out.append(f"#{i}  {when}  {how}")
        out.append(f"    client (S1KH-ID) {e.get('s1kh', '?')}    holder (R1KH-ID) {e.get('r1kh', '?')}")
        life = f"    lifetime {e['expires']} s" if "expires" in e else ""
        out.append(f"    PMKR1Name {e['name']}")
        out.append(f"    PMK-R1    {_mask(e['key'])} ({len(e['key']) // 2} bytes){life}")
        others = holders.get(e["name"], [])
        if others:
            out.append("    same PMK-R1 also seen on: " + ", ".join(f"{n} ({h})" for n, h in others))
        out.append("")
    return "\n".join(out).rstrip()
