# Wi-Fi Verse: handover notes for the next AI agent

Read this first. It explains what the project is, how it is built, how to run and test it, what has been decided, and which traps were already hit.
Everything lives under `/home/raju/wifi-verse` on the user's Ubuntu host. The user is `raju`.
The project is called **Wi-Fi Verse**; the directory was renamed from `wifi-lab` to `wifi-verse`. Internal names stay as they were on purpose: package `labd`, `tools/wifilab.py`, `/run/wifilab`, `WIFILAB_*` variables, `wifilab.*` localStorage keys, the NetworkManager drop-in `90-wifilab-unmanaged.conf`. README.md is the public entry point (install, smoke test, security notes).

## 1. What the project is

A web-based Wi-Fi simulation lab, modelled on https://learnwifi.siamwireless.com/lab/ (numbered sections, floor plan, signal chart, frame ladder, frame decoder).
Devices dragged onto a floor plan become **real** Linux wireless stacks:

- access points = real `hostapd`
- clients = real `wpa_supplicant`
- radios = `mac80211_hwsim` virtual radios, one network namespace per node
- signal / mobility = `wmediumd` path-loss model, so moving a client changes the signal it sees
- sniffers = monitor-mode radios; the capture is real 802.11 frames, shown in a Wireshark-style panel with PCAP export

First use case: two APs and one walking client, comparing **802.11r Fast BSS Transition (FT-PSK) on vs off** (plain WPA2-PSK), with the captured frame exchanges and measured handoff time.

Nothing is faked: roams are triggered by the client's own `bgscan` when its measured signal falls below a threshold, and every number in the UI is derived from captured frames or from the radio model.

## 2. How the user works (preferences)

- The user insisted on **phases with approval gates** ("if you do it entirely and I don't like it, it is a waste"). Finish a phase, report, wait for feedback before big new scope.
- Answers must be short and impersonal. No emojis. Do not create extra markdown files unless asked (this file was explicitly requested).
- The user does not want continuous background traffic: "I don't need you to ping continuously, it's flooding". The lab must stay silent; traffic only on explicit user action.
- The capture panel must look and read like **Wireshark** (its fields and terminology, hex pane on the right, resizable panes). Show **all** packets, nothing hidden by default.
- The UI must feel polished. The signal must change when the client moves.
- The user opens the UI from other machines on the LAN (`http://<host-ip>:5173`), so the dev server listens on all interfaces by default; `UI_HOST=127.0.0.1` restricts it (see section 9).

## 3. Host facts and safety rules

- Ubuntu 24.04.4, kernel 7.0.0-38, bare metal, Secure Boot on (the signed `mac80211_hwsim` loads fine).
- The host's **real** Wi-Fi is `wlo1`, managed by NetworkManager. **Never touch it.** A NetworkManager drop-in `/etc/NetworkManager/conf.d/90-wifilab-unmanaged.conf` marks `driver:mac80211_hwsim;interface-name:hwsim*` unmanaged (created by the engine).
- The host also runs Docker (several `br-*` bridges) and some user `uvicorn` processes in Docker. **Do not touch them.** Tailscale is up (`<tailscale-ip>`).
- `sudo -n` works without a password (the user fixed sudoers). Never run interactive `sudo`/`su`.
- The engine refuses to start if `mac80211_hwsim` is already loaded by something else.
- Safety expectations: actions that are hard to reverse need confirmation. After any test, **stop the lab** and verify no leftovers: `ip netns list` empty, `pgrep -a 'tcpdump|wmediumd|hostapd'` empty, `lsmod | grep mac80211_hwsim` empty. (`wpa_supplicant` PID from NetworkManager is the host's own; leave it.)
- Secrets: `~/wifi-verse/.token` (API token) and the files in a run directory (`*.log`, keys) are mode 600. Do not paste them into answers. The UI no longer has a password (removed at the user's request); `.ui-password` is a leftover and unused.

## 4. Architecture

```
Browser (React UI, :5173)
   |  no login (removed)           Vite dev server, listens on 0.0.0.0
   |  /api/* and /api/ws  ----->   proxy adds "Authorization: Bearer <token>"
   v
labd FastAPI (root, 127.0.0.1:8787, TrustedHost + token + origin check)
   |
   +-- engine.py  : builds/tears down the lab (hwsim, netns, hostapd, wpa_supplicant, wmediumd)
   +-- frames.py  : tcpdump -> CCMP decrypt -> tshark -> frame events + live pcap files
   +-- keys.py    : parses TK/GTK from hostapd/wpa_supplicant -K debug logs
   +-- tools/     : shared analysis helpers (wifilab.py) and wmediumd client/config (wmedium.py)
```

Network layout inside the lab:

- One netns per node: `wl_<id>` (for example `wl_ap1`, `wl_sta1`, `wl_snf1`). Radios: APs first, then clients, then sniffers (`Topology.ordered()`, wmediumd indexes follow this order).
- Wired distribution system: each AP's `wlan` is bridged (`br0`) to a veth into a switch namespace `wl_ds` (bridge `br-ds`, gateway `10.10.0.254/24`). Clients get `10.10.0.10`, `.11`, ...
- 2.4 GHz only, channels 1, 6, 11 (5 GHz would need a regulatory domain change). APs use OFDM-only rates because of a wmediumd limitation.
- FT-PSK: `ft_psk_generate_local=1`, mobility domain `4f57`, `ft_over_ds=0` (over-the-air FT), `r1_key_holder=<mac without colons>`.
- Client config: `bgscan="simple:1:<roam_threshold_dbm>:5"`, `freq_list`/`scan_freq` limited to the AP channels. After association the gateway neighbour entry is pinned (`ip neigh replace ... nud permanent`); without it the post-roam ARP retry adds a fixed 1 s that would hide the real handoff time.
- `hwsim0` (the always-present monitor radio in the root namespace) is the "global" capture. It records a frame where it is **sent**, before path loss, so its captures have **no RSSI**. A sniffer node (monitor radio at a position and channel) hears frames through the path-loss model and does record `radiotap.dbm_antsignal`.

wmediumd:

- Source in `vendor/wmediumd` (ramonfontes fork, needs `libevent-dev`), binary at `vendor/wmediumd/wmediumd/wmediumd`. Patched by `vendor/wmediumd-sniffer.patch` so monitor interfaces (sniffers) hear traffic (`ifaces.monitors` plus hwaddr preset).
- Started with `-s` so it exposes a control socket `/var/run/wmediumd.sock`; `tools/wmedium.py` talks to it (messages are **big-endian**) to set positions and tx power live. Config model: `path_loss` with `log_distance`.
- RSSI model (also used by the UI in `ui/src/model.ts`): `rssi = tx_dbm + 2*5 dBi - (40.2 + 10 * n * log10(d))`, defaults tx 10 dBm, exponent `n = 3.5`.
- After changing the wmediumd header file, run `make clean` before rebuilding (a stale `wserver.o` once broke position updates).

## 5. Directory map

```
wifi-verse/
  AGENTS.md                 this file
  .token                    API token (600)
  .ui-password              unused leftover of the removed UI login
  scripts/
    smoke-test.sh           read-only environment check with install commands (--live also runs tests/smoke_api.py)
    setup.sh                installs the venv, UI packages and builds wmediumd
    lab.sh                  CLI lab (sudo): demo | walk | compare | down  (Phases 1-3, still works)
    labd.sh                 starts the API as root on 127.0.0.1:8787
  tools/
    wifilab.py              shared analysis: ccmp_decrypt, key parsing, tshark_events, roam metrics
    wmedium.py              wmediumd control-socket client + config writer
  labd/
    models.py               pydantic Topology/Ap/Sta/Sniffer, PRESETS (all config-bound strings validated here)
    engine.py               LabEngine: start/stop, move, set_txpower, roam, ping, poll, snapshot
    frames.py               FrameStream: live capture pipeline, ring buffers, pcap helpers
    keys.py                 KeyTracker: incremental TK/GTK extraction from -K logs
    api.py                  FastAPI app, WebSocket hub, walks, roam analysis, capture endpoints
  vendor/                   wmediumd source and sniffer patch
  runs/<timestamp>-<mode>/  per-run artefacts (see section 8); compare-*.json from the CLI compare
  labs/                     saved topologies (PUT/GET /api/labs/{name})
  tests/smoke_api.py        end-to-end API test (33 checks)
  ui/                       React 19 + TypeScript (strict) + Vite 7, no UI framework
```

UI files (`ui/src`):

- `App.tsx` page sections: 1 Build, 2 Signal, 3 Roams, 4 Capture, 5 FT vs not.
- `store.ts` tiny global store (`useStore`, `setState`), WebSocket handling (`onMessage`), actions (`walkTo`, `roamTo`, `moveNode`, ...). `MAX_FRAMES = 20000`; the `frames` case de-duplicates by frame number (a snapshot and a queued batch can overlap).
- `api.ts` REST client; `types.ts` shared types; `model.ts` RSSI model and colours; `explain.ts` plain-language notes keyed by Wireshark field names; `compare.ts` the FT vs non-FT runner.
- `components/`: `FloorPlan` (drag/drop palette, nodes, rings, walk mode), `Inspector` (node settings, walk/roam/ping buttons), `SignalChart`, `RoamPanel` (roam list, stats, frame ladder), `CapturePanel` (the Wireshark clone shell), `PacketList`, `PacketDetails`, `HexView`, `panes` (Splitter + `useStoredNumber`), `Compare`, `Header`.
- `styles.css` single stylesheet; Wireshark-panel styles are under the `/* Wireshark-style capture */` block (`.wsp*`, `.pl*`, `.pd*`, `.hx*`).

## 6. Backend details

### Engine (`labd/engine.py`)
- `start(topo)` -> `_bring_up`: loads `mac80211_hwsim radios=N`, creates netns, starts wmediumd, hostapd per AP (`-dd -K -t -f <run>/<id>.log`), wpa_supplicant per client, sniffers, then waits for association. Aliases (`self.aliases`) map the gateway MAC to `gw` and each AP bridge MAC to `<ap>-br`.
- `stop()` -> `_teardown()` (kills pidfiles in `/run/wifilab`, wmediumd, deletes netns, unloads hwsim, chowns the run dir to `WIFILAB_OWNER`).
- Live control: `move`, `set_txpower` (through wmediumd), `roam` (pin bssid, `select_network`, short scan, wait for COMPLETED, then unpin; this is how a non-FT roam is forced), `ping(sta_id, count)` (one-off `ping -c N -i 0.5 -W 1` to `10.10.0.254` in the client's netns; count capped at 10 by the API), `poll()` (RSSI/associations via `poll_station`), `snapshot()`.
- **The lab sends no traffic of its own.** The old background `ping -i 0.5` was removed on the user's request. Kernel-generated chatter (IPv6 router solicitations, MLD, XID) still appears; that is normal.

### Capture pipeline (`labd/frames.py`)
For each source (`global` = `hwsim0`, plus every sniffer):

1. `tcpdump -i <iface> -U --immediate-mode -s 0 -n -Z root -w -` (inside the node's netns). dumpcap block-buffers a pipe and hit AppArmor issues; tcpdump is the reliable choice.
2. `_pump` reads pcap records, writes `capture-<src>.pcap` (as heard), tries CCMP decryption of protected data frames with TK/GTK from `KeyTracker` (`ccmp_decrypt` in `tools/wifilab.py`), writes `capture-<src>.decrypted.pcap`, and feeds the decrypted record to tshark. The over-the-air length is remembered per frame number (`_air_len`) so the list shows the real length.
3. tshark reads from a real `os.pipe` (`tshark -r - -l -n -T fields ...`); asyncio's subprocess pipe is a socketpair and tshark rejects it.
4. `_read` turns each line into a frame dict: `src n t rel len rssi ch type sa da bssid alg status proto info dec scol dcol`.
   - `scol`/`dcol` are tshark's `_ws.col.def_src` / `_ws.col.def_dst` (what Wireshark shows in Source/Destination: IPs for IP traffic, MACs otherwise, `<mac> (RA)` for ACKs). `sa`/`da` are the MAC fields (control frames fall back to TA/RA); the roam ladder uses these.
   - `rel` is seconds since the first captured frame; `type` is a short internal name (`Auth`, `EAPOL-M1`, `Beacon`, ...); `proto`/`info` are Wireshark's Protocol/Info columns; `dec` says the payload was decrypted.
5. Frames go to a ring (5000), beacons to a separate deque (300) so 20 beacons/s never evict roam frames, and are published to WebSocket clients in batches every 0.1 s.

`pcap_snapshot()` returns only whole records so a pcap still being written is always valid; `pcap_record()` extracts packet n.

### Keys (`labd/keys.py`, `tools/wifilab.py`)
The user's key insight: "you already know the STA and AP PTK via the logs". hostapd and wpa_supplicant run with `-K -dd`, which logs PTK/TK/GTK. `KeyTracker` parses them incrementally; the decrypted pcap lets Wireshark (and the UI) show ICMP/ARP inside encrypted frames with no key entry. `GET /api/keys` exports them (secret material, 600 run files).

### API (`labd/api.py`), all under `/api`, token required except `/health`
| Route | Purpose |
|---|---|
| `GET /health` | open health check |
| `GET /presets`, `GET /state` | presets; lab snapshot, roams, capture counters |
| `GET /labs`, `PUT/GET /labs/{name}` | saved topologies |
| `POST /lab/start` (Topology body), `POST /lab/stop` | lifecycle |
| `POST /nodes/{id}/position`, `/tx`, `/roam`, `/ping` | live control (`/ping` body `{count: 1..10}`, returns `{output}`) |
| `POST/DELETE /nodes/{id}/walk` | background walk to (x, y) at speed m/s; signal-driven roams happen on their own |
| `GET /roams` | analysed roams |
| `GET /frames?src&limit&beacons&t_from&t_to` | recent frame summaries |
| `GET /frames/{src}/{n}?decrypted=true` | Wireshark packet details for one frame: `{n, src, hex, radiotap_len, tree}`. `tree` is a PDML-derived list of nodes `{l: showname, f: field name, v: show value, p: byte offset, s: size, c: children}`. The whole capture is dissected with `-Y frame.number == n` so frame numbers, relative times and "request in N" links match Wireshark. |
| `GET /captures`, `GET /captures/{src}/pcap?decrypted=` | list sources; download pcap |
| `GET /captures/{src}/filter?expr=` | runs a **real Wireshark display filter** (`tshark -Y`) over the decrypted capture; returns `{numbers: [...], error}` |
| `GET /keys` | extracted keys |
| `WS /ws` | `snapshot`, `lab`, `state`, `move`, `roam`, `frames`, `resync` messages |

Security design: single root process, loopback only, Bearer token, `TrustedHostMiddleware` (`127.0.0.1`, `localhost`), CORS plus a foreign-Origin rejection (only `http://localhost:5173` and `http://127.0.0.1:5173` allowed; applies to REST and WebSocket), pydantic validation of every value that reaches a config file or command line (`models.py`), SOURCE_RE/LAB_NAME_RE checks on path-like parameters. A split unprivileged API plus root helper was considered; the single process was chosen (the tradeoff was explained to the user).

Roam analysis: `analyze_roam` writes the relevant frame window to a temp pcap and uses `wifilab.tshark_events` to measure handoff (first Authentication to end of exchange), frame counts (auth, reassoc, EAPOL), and whether the 4-way handshake was skipped (FT) or happened (`eapol == 4` for WPA2). Typical results: FT about 8-20 ms with 0 EAPOL frames; WPA2 includes the 4-way handshake.

## 7. Frontend details

### Capture panel (Wireshark clone), requirement from the user
- Layout (`CapturePanel.tsx`): toolbar (source tabs, time format, Resolve names, Auto-scroll, Pause, Save .pcap, Save decrypted .pcap, Keys), a display-filter bar, then the three panes: **packet list** (top left), **packet details** tree (bottom left), **packet bytes** (right), a status bar and a bottom drag handle for the whole panel height.
- Sizes (`panelH`, `listH`, `hexW`) and column widths persist in `localStorage` (`wifilab.*`). `Splitter` is in `panes.tsx`.
- `PacketList.tsx`: virtualised (fixed 22 px rows, so 20k frames stay cheap), resizable columns, keyboard navigation (arrows, PageUp/PageDown, Home/End), Wireshark's default colour rules for ARP/ICMP plus tints for EAPOL, management, deauth. Columns: `No.`, `Time`, `Source`, `Destination`, `Protocol`, `Length`, `Ch`, `Signal` (only for sniffers that report RSSI), `Info`. Selecting a row turns Auto-scroll off.
- `PacketDetails.tsx`: expandable tree built from the API's PDML nodes; frame/radiotap/radio info start collapsed (like Wireshark). Selecting a node highlights its bytes; `pathForByte` does the reverse for clicks in the hex pane. `explain.ts` text appears under the tree for known fields.
- `HexView.tsx`: offset, 16 bytes in two groups of 8, ASCII. Header toggle **Decrypted / As heard** switches between the decrypted and raw pcap (offsets differ).
- Display filter: Enter applies the string through `GET /captures/{src}/filter`; green input = valid, red + message = tshark's error. It re-runs every 1.5 s while frames arrive. The **Filters** dropdown holds presets (`FILTERS` in `CapturePanel.tsx`) plus per-device `wlan.addr == <mac>` entries. "Apply as filter" in the status bar builds `field == value` from the selected tree node.
- Selecting a frame elsewhere (clicking a frame in the roam ladder sets `selectedFrame = {src: 'global', n}`) switches the capture tab and loads the frame.
- Because filters run on the whole capture but the UI keeps only the latest 20,000 frames, matches older than that are counted but not listed.

### Other UI behaviours
- Floor plan: HTML5 drag from the palette (or click to add at a default spot); devices are added/removed only while the lab is stopped; while running, nodes can be dragged and the client's position is pushed to wmediumd. Walk mode lets you click a destination.
- Inspector: coordinates, channel (stopped only), tx power (live through wmediumd), roam threshold (stopped only), modelled signal to each AP, Walk/Force-roam buttons and the **Ping gateway (4 packets)** button for clients.
- Signal chart: modelled RSSI per AP plus measured RSSI from the client, roam markers and the roam trigger line.
- Compare (`compare.ts`): restarts the lab once per mode (FT on, FT off), walks the first client to the farthest AP, collects the roam events, and shows handoff time, frame counts and EAPOL counts.

## 8. Running, testing, debugging

Start and stop the API/UI pair with the lifecycle script:
```
cd ~/wifi-verse && ./scripts/wifi-verse.sh start --api-port 9000 --ui-port 3000
./scripts/wifi-verse.sh status
./scripts/wifi-verse.sh stop                              # gracefully stops the lab, API and UI
```
Open `http://localhost:5173` (or the LAN IP); there is no login. The manager stores runtime state/logs under ignored `.runtime/`. Restart the API after any `labd/*.py` change; the Vite server hot-reloads (and restarts itself when `vite.config.ts` changes). Individual foreground launchers (`scripts/labd.sh` and `cd ui && npm run dev`) remain available.

Checks:
```
cd ~/wifi-verse/ui && . ~/.nvm/nvm.sh && npx tsc --noEmit && npm run build   # type-check and build
cd ~/wifi-verse && .venv/bin/python tests/smoke_api.py ft                    # also: wpa2
./scripts/smoke-test.sh                                                     # read-only host check, prints install commands
sudo scripts/lab.sh demo ft|psk | walk ft|psk | compare 3 walk | down      # CLI lab without the UI
```
`smoke_api.py` needs the API running and the lab stopped. It covers auth/host/origin/WebSocket rejection, hostile SSID, start/second-start refusal, association, RSSI changing while walking, signal-driven roam with the expected EAPOL count, no background traffic, one-off ping, decrypted ICMP in the live frames and in the pcap, path-traversal rejection, key export, display filter (valid and invalid), frame-detail tree and offsets, manual roam, tx power, and stop. Expected final line: `all checks passed`.

Run directory `runs/<timestamp>-<mode>/` (kept after stop): `ap*.conf/.log`, `sta*.conf/.log` (debug logs with keys, mode 600), `wmediumd.cfg/.log`, `capture-<src>.pcap`, `capture-<src>.decrypted.pcap`. Captures are downloadable after the lab stops (until the API restarts, since `engine.run_dir` is in memory).

Driving the UI from the integrated browser tool (what worked, what did not):
- The tool appends an accessibility-snapshot diff to every call. A large changing DOM floods the context. The packet list is virtualised now, but still **avoid full reloads and `read_page`** while the lab runs, and stop the lab before snapshot-heavy steps. Use `screenshot_page`, or return small JSON from `run_playwright_code`.
- The browser runs on the user's desktop. Files written by Playwright (for example screenshots to `/tmp`) are **not** on the server. `setViewportSize` does not stick (the pane stays about 700-1000 px wide).
- The UI no longer has a login. Anyone who can reach port 5173 can use the lab through the proxy, which attaches the root-level API token. Keep the host on a trusted network, or bind `server.host` to 127.0.0.1 and use an SSH tunnel (`ssh -L 5173:127.0.0.1:5173 raju@<host-ip>`).
- HTML5 drag-and-drop is not triggered by Playwright's `dragTo`; dispatch synthetic `dragstart`/`dragover`/`drop` events with a `DataTransfer`, or use the palette click.
- `.canvas svg` matches icons too; use `.canvas > svg`.

## 9. LAN access and the Vite gate (`ui/vite.config.ts`)

- `server.host` comes from `UI_HOST` and defaults to `0.0.0.0`, so the UI is reachable on the LAN, Tailscale and Docker bridge addresses (by IP; Vite refuses unknown hostnames). `UI_HOST=127.0.0.1` restricts it. The API stays on loopback only.
- Because that exposes a proxy that attaches the root-level API token, a **password gate** was added: a Vite plugin demands HTTP Basic auth (user `lab`, password from `~/wifi-verse/.ui-password`, generated once, 600, compared with `timingSafeEqual`). It guards both normal requests and WebSocket upgrades (upgrades skip the middleware chain, so a `prependListener('upgrade')` hook rewrites the URL and ends the socket with 401).
- The proxy injects the Bearer token and rewrites `Origin` to `http://127.0.0.1:5173` **only** when the request's Origin equals the page's own `http://<host>`; any other origin is forwarded unchanged and the API refuses it (protects against cross-site requests that ride the cached Basic credentials).
- Basic auth over plain HTTP is readable on the network: fine on a trusted LAN or Tailscale, otherwise use TLS or an SSH tunnel (`ssh -L 5173:127.0.0.1:5173 raju@<host-ip>`).

## 10. Gotchas already solved (do not rediscover)

- `dumpcap` flags/AppArmor/buffering -> use tcpdump. tshark `-r -` rejects sockets -> real `os.pipe`.
- Sniffers heard nothing in stock wmediumd -> `vendor/wmediumd-sniffer.patch`.
- wmediumd messages are big-endian; stale `wserver.o` needs `make clean`.
- Non-FT `wpa_cli roam` fails on its own -> pin bssid + `select_network` + a short scan.
- Post-roam 1 s ARP gap -> permanent neighbour entry for the gateway.
- Beacon floods evicting roam frames -> beacons kept in their own deque.
- tshark 4.2.2 syntax: `in {1,2}` needs **commas**; `{1 2}` is a syntax error. Source/Destination columns are `_ws.col.def_src` / `_ws.col.def_dst`.
- PDML `pos`/`size` are offsets into the dissected file's frame, so they line up with the hex of the same (decrypted or raw) pcap; that is why the detail endpoint takes `decrypted`.
- `useEffect` callbacks must not return a value (use block bodies) or React throws "destroy is not a function".
- `create_file` fails on existing files in this environment; replace via the edit tools (or delete the file you own first).
- Duplicate React keys appeared when a WebSocket snapshot overlapped queued frame batches; the store now drops frames whose number is not greater than the last stored one.

## 11. Known limits

- Topology edits (add/remove devices, channels, SSID, passphrase, exponent, security) need a lab restart.
- 2.4 GHz channels 1/6/11 only; OFDM rates only; max 6 APs, 6 clients, 4 sniffers (`models.py`).
- `hwsim0` has no RSSI; sniffers use a low default tx (1 dBm in the engine) which makes the symmetric link weaker than an AP's, so RSSI at a sniffer is lower than for a client at the same spot (consider setting 10 dBm).
- Single root API process; run data and keys are plain files with 600 permissions.
- The UI shows the newest 20,000 frames; the pcap files hold everything.
- Only the first client is used by the Compare runner.

## 12. Ideas for the next phase (ask the user first)

More device types, saved labs and presets in the UI, serving the production build (`ui/dist`) from the API with TLS, a 5 GHz option, showing sniffer RSSI on the floor plan, a per-frame "why" narrative for the roam ladder, Wireshark "follow"-style helpers (for example conversation filters from a selected row).

## 13. Quick state check for a new session

```
curl -s -H "Authorization: Bearer $(cat ~/wifi-verse/.token)" http://127.0.0.1:8787/api/state | head -c 300   # lab state
ip netns list; pgrep -a 'tcpdump|wmediumd|hostapd'; lsmod | grep mac80211_hwsim                              # leftovers
```
If the lab is left running or half-started, stop it with `POST /api/lab/stop` or `sudo scripts/lab.sh down`.

## 14. Later additions (dashboard, 11r lab, daemon console)

- **Pages** (`ui/src/router.tsx`, pushState routing, no library): `/` dashboard (`Dashboard.tsx`: 11r, Playground, "coming soon" cards), `/ft` the 802.11r lab (Learn chapters, `FtSetup`, then the shared sections), `/playground` the free sandbox. Each page has its own stored topology (`wifilab.topology.v1` playground, `wifilab.ft.topology.v1` ft, store field `topoKind`). The ft topology is fixed at 2 APs + 1 client (no add/delete). `loadLab(kind)` swaps the topology only while the lab is stopped.
- **FT options** (Topology fields `ft_keys: local|pull|push`, `ft_over_ds`): `engine._start_ap` writes `r0kh=`/`r1kh=` lines (one 128-bit secret per AP pair, `pmk_r1_push`), hostapd uses the AP wlan MAC as the RRB address and it works over the existing bridges. Over the DS: wpa_supplicant only does it on `FT_DS`, so `engine._ds_assist` (called from `poll()`) pins the client to its BSSID, scans when below the roam trigger and sends `FT_DS` to an AP at least 5 dB stronger; bgscan is omitted in that mode. Forced roams use the same path.
- **Roam analysis** now handles FT Action frames (`FT-Req/FT-Resp`, over the DS); roam records carry `transition`, `ft_action`, `ft_keys`, `ft_over_ds`.
- **API additions**: `/api/runs`, `/api/runs/{run}/frames`, run-scoped capture endpoints, `/api/cli` + `/api/nodes/{id}/cli` (allow-list in `labd/cli.py`), `/api/nodes/{id}/log`, `/api/logs` (merged window, `match`), `/api/ft`. Logs of a run are readable after stop; keys in `/api/keys` carry the `nodes` that logged them.
- **Restarting the API**: it ignores SIGTERM while browsers hold WebSockets; stop the lab first, then `sudo -n pkill -f 'uvicorn labd.api'` twice and `sudo -n kill -9` the python child if needed.
- **Browser testing**: headless Chrome plus a small CDP script (Node 22 has a global `WebSocket`) works well: launch `google-chrome --headless=new --remote-debugging-port=9333`, then drive it with `Runtime.evaluate`. The UI has no login any more (see section 9).
- **Client connection lab** (`/connect`, store kind `connect`, fixed 1 AP + 1 client): Security enum is now `open | owe | wpa2-psk | wpa3-sae | ft-psk` (per-mode hostapd/wpa_supplicant config in `engine._start_ap` / `_sta_network`). `engine.reconnect()` drops and re-joins the client (`POST /api/nodes/{id}/reconnect`); `GET /api/connection?sta&ap&run` returns measured attempts (`wifilab.connections_from_events`: duration, auth/SAE/assoc/EAPOL counts) plus the run's mode. UI: `ConnectLearn` (chapters), `ConnectSetup`, `ConnectionPanel` (attempt list, metrics, frame ladder), `ConnectCompare` (runs all four modes, first connection and reconnection), `SECURITY_INFO` in `model.ts`, store `connectTick`. Observed: WPA3 reconnection uses PMKSA caching (no SAE frames); WPA2/OWE reconnect repeat the 4-way handshake. Tested with headless Chrome CDP (`/tmp/conn.js`, not kept).
- **Connection logs** (`ui/src/components/ConnectLogs.tsx`): on `/connect` the console tab "Connection logs" (tab id `roam`) merges hostapd and wpa_supplicant lines for one connection attempt (`/api/logs` window), grouped into steps per mode (pick network, SAE or OWE, auth, assoc, 4-way, keys) with facts read from the logs (key management, PMF, PMKSA reuse, SAE time). The SAE password-element search lines are hidden unless "Show every log line".
- **Playground page** (`/playground`) is now its own layout (no roam or FT comparison sections): Build, Devices (`NetworkOverview.tsx`, live status table with ping), Signal, Sniff (capture), Terminal. The console tab "Merged logs" (`MergedLogs.tsx`) merges up to 6 daemons by time with a text filter and time window; `/api/logs` got `tail` (newest lines) and `quiet` (drops lab polling lines such as SIGNAL_POLL, STA-FIRST/NEXT, EAP Session-Id) params. Tab id `roam` is reused per page: FT = RoamLogs, connect = ConnectLogs, playground = MergedLogs.
- **Capture pause** (connect lab): Topology field `pause_capture_when_connected` (default true for `/connect`). `poll_loop` pauses recording `PAUSE_SETTLE_S` (3 s) after every client reaches COMPLETED; `FrameStream.paused` drops packets before the pcap files and tshark, so frame numbers stay continuous and tcpdump keeps running. Resumes on disconnect, `reconnect`, `ping`, or `POST /api/capture/resume`; the WS `capture` message and snapshot carry `live|paused|stopped` (store `capturePaused`). FT keeps its separate `auto_stop_capture` (stops for good after the roam).
- **Connection errors lab** (`/errors`, store kind `errors`, fixed 1 AP + 1 client): Topology field `fault` = `none | wrong_password | mac_blocked | pmf_mismatch | security_mismatch` (client passphrase prefixed `wrong-`; hostapd `deny_mac_file`; AP `ieee80211w=2` vs client 0; client profile from `engine.MISMATCH`). The mismatch faults put nothing on the air: the only trace is the client log line `skip RSN IE ...` (shown in `AttemptsPanel`). `wifilab.attempts_from_events` + `GET /api/attempts?sta&ap&run` return every attempt (outcome rejected/failed/no_response/connected, status code, EAPOL messages, the Deauth/Disassoc that ended it with its reason); `tshark_events` and frames now carry `status`, `reason`, `seq`. `POST /api/nodes/{ap}/deauth {sta, kind: deauth|disassoc, reason 1..71}` makes hostapd send one (`hostapd_cli raw DEAUTHENTICATE <mac> reason=N`); with PMF the reason is encrypted so the capture shows it hidden. A failing lab pauses recording after `FAIL_WINDOW_S` (25 s); deauth, reconnect and ping resume it. UI: `ErrorsGuide`, `ErrorsSetup`, `AttemptsPanel`, `KickPanel`, `ErrorCatalog`. The catalogue data is `ui/src/data/dot11Codes.ts` (generated from `tshark -G values`, 137 status and 63 reason codes, standard wording) plus hand-written notes, groups and a field guide in `dot11Notes.ts`. Not reproducible here: AP-full (status 17, needs a second client) and out-of-range beacon loss (reason 4) are only described.
