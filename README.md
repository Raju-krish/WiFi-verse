# Wi-Fi Verse

> Source: <https://github.com/Raju-krish/WiFi-verse>

Learn Wi-Fi by running the real thing. Wi-Fi Verse is a web-based lab where every access point is a real `hostapd`, every client a real `wpa_supplicant`, and the radios are virtual (`mac80211_hwsim`) behind a signal model (`wmediumd`). Move a client on the floor plan and the signal it measures changes; capture the frames and you read what the protocol actually did. Nothing is mocked: every number in the UI comes from captured frames or from the radio model.

No Wi-Fi hardware is needed, and your real Wi-Fi is never touched.

## Labs

| Page | What it teaches |
|---|---|
| **802.11 client connection** (`/connect`) | One access point, one client. Connect with **Open, OWE, WPA2 or WPA3 (SAE)** and see what is exchanged, in which frames, and what an eavesdropper could read. Disconnect and reconnect to see WPA3 skip SAE through PMKSA caching. Merged hostapd and wpa_supplicant logs are grouped into the steps of each mode. |
| **Connection errors and deauthentication** (`/errors`) | Make connections fail on purpose (wrong password on WPA2 and WPA3, blocked client, PMF mismatch, security mismatch) and read the real status and reason codes. Each attempt is measured from the capture. Make the access point send a deauthentication or disassociation with any reason code. Includes a searchable catalogue of every 802.11 status code and reason code with plain explanations. |
| **802.11r Fast Transition** (`/ft`) | Two access points, one walking client. Roaming with FT on and off, key distribution (local, pull, push), over the air or over the DS, with measured handoff times, frame ladders, key checks and logs. |
| **Playground** (`/playground`) | An empty floor: add up to 6 access points, 6 clients and 4 sniffers, change power, channels and security, walk clients around, sniff and analyse. |

Every lab has a **Wireshark-style capture** (packet list, decoded details, hex, real Wireshark display filters, PCAP export, decrypted view using the keys the daemons log) and a **terminal** that runs read-only `hostapd_cli` / `wpa_cli` commands against the live daemons.

## How it works

```
Browser (React UI, :5173)
   |  /api and /api/ws            Vite dev server proxies and adds the API token
   v
labd (FastAPI, runs as root, 127.0.0.1:8787)
   |-- engine.py  hwsim radios, one network namespace per node, hostapd, wpa_supplicant, wmediumd
   |-- frames.py  tcpdump -> CCMP decryption -> tshark -> live frames and PCAP files
   `-- keys.py    PTK/GTK read from the daemons' debug logs
```

- Access points are `hostapd`, clients are `wpa_supplicant`, each in its own network namespace (`wl_ap1`, `wl_sta1`, ...), bridged to a virtual wired network.
- Signal and mobility come from `wmediumd` with a log-distance path-loss model (2.4 GHz, channels 1, 6, 11).
- Sniffers are monitor-mode radios that hear frames through the same path-loss model and record signal strength.
- The lab sends no traffic of its own; traffic only happens when you ask for it (ping, reconnect, walk).

## Requirements

| | |
|---|---|
| OS | Linux with `apt` (developed and tested on **Ubuntu 24.04**). Other distributions work if you install the equivalent packages. |
| Privileges | `sudo` without a password prompt. The API runs as root because it creates namespaces and loads a kernel module. |
| Kernel | `mac80211_hwsim` module and network namespaces. On Ubuntu the module is in `linux-modules-extra-$(uname -r)`. |
| hostapd, wpa_supplicant | **2.10 or newer**, full build with SAE, OWE and FT (the Ubuntu packages are). |
| tshark | 4.0 or newer (tested with 4.2). |
| Python | 3.10 or newer, with `venv`. |
| Node.js | **20.19 or newer** (22 recommended) and npm. |
| Build tools | `gcc`, `make`, `git`, `pkg-config` and the `libnl-3`, `libnl-genl-3`, `libevent`, `libconfig` development packages, to build wmediumd. |

A bare-metal machine or a VM that allows loading kernel modules works. Some container and cloud kernels do not ship `mac80211_hwsim`.

### System packages (Ubuntu / Debian)

```bash
sudo apt update
sudo DEBIAN_FRONTEND=noninteractive apt install -y \
  hostapd wpasupplicant iw iproute2 iputils-ping tcpdump tshark \
  build-essential git pkg-config libnl-3-dev libnl-genl-3-dev libevent-dev libconfig-dev \
  python3 python3-venv python3-pip curl "linux-modules-extra-$(uname -r)"
```

Node.js 20.19+ (skip if you already have it):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22
```

Passwordless sudo, if your account does not have it yet (this grants full root to your user; use it on a lab machine, or start the API from a root shell instead):

```bash
echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/wifiverse && sudo chmod 440 /etc/sudoers.d/wifiverse
```

### Python packages

Listed in [requirements.txt](requirements.txt): `fastapi`, `uvicorn`, `pydantic`, `websockets`, `httpx`, `cryptography`. The UI uses React 19, TypeScript and Vite 7 ([ui/package.json](ui/package.json)).

## Install

```bash
git clone https://github.com/Raju-krish/WiFi-verse.git
cd WiFi-verse

scripts/setup.sh          # Python venv + packages, UI packages, and wmediumd (cloned, patched, built)
scripts/smoke-test.sh     # checks everything and prints the command for anything missing
```

`scripts/setup.sh` takes an optional step (`python`, `ui` or `wmediumd`) if you want to run only one part. wmediumd is cloned from [ramonfontes/wmediumd](https://github.com/ramonfontes/wmediumd) at a pinned commit and patched with [vendor/wmediumd-sniffer.patch](vendor/wmediumd-sniffer.patch) so that sniffers can hear traffic.

### The smoke test

`scripts/smoke-test.sh` is read-only: it installs nothing and does not need root. It checks the OS, the kernel module, namespaces, passwordless sudo, every required program and its version and features (SAE, OWE, FT, key logging), Python and Node, the virtualenv and UI packages, the wmediumd build and patch, leftovers from an earlier lab, and the ports. For every problem it prints what to run, collected into one list:

```
To fix what is missing:
  1. sudo apt update && sudo apt install -y hostapd wpasupplicant iw
  2. scripts/setup.sh python
  3. scripts/setup.sh wmediumd
```

Run it again until it ends with `Everything needed is in place`. With the API running, `scripts/smoke-test.sh --live` also runs the end-to-end API test ([tests/smoke_api.py](tests/smoke_api.py)).

## Run

Start the API first (it creates the access token the UI proxy needs), then the UI, in two terminals:

```bash
scripts/labd.sh                                  # API as root on 127.0.0.1:8787
cd ui && . ~/.nvm/nvm.sh && npm run dev          # UI on port 5173, on every address of the machine
```

Open <http://localhost:5173>, or `http://<any-ip-of-the-machine>:5173` from another computer, pick a lab on the dashboard, press **Start lab**. Stop the lab when you are done; the page header shows its state.

## Security notes

- The API runs **as root** and drives hostapd, wpa_supplicant, tcpdump and the kernel module. It listens on `127.0.0.1` only and requires a bearer token (`.token`, mode 600), a host check and an origin check. Every value that reaches a config file or command line is validated.
- The dev server proxy adds that token for the browser, and the UI has **no login**. The UI listens on **every address of the machine** (LAN, Tailscale, Docker bridges), so anyone who can reach port 5173 can control the lab as root. Use it on a trusted network. To keep it local, start it with `UI_HOST=127.0.0.1 npm run dev` and, from another machine, use an SSH tunnel: `ssh -L 5173:127.0.0.1:5173 user@host`. Access by IP address works; a hostname is refused by Vite's host check.
- Run directories (`runs/<timestamp>-<mode>/`) hold captures and daemon debug logs **including key material** (mode 600). Do not publish them.
- The lab never touches your real Wi-Fi interface. If NetworkManager is present, it adds `/etc/NetworkManager/conf.d/90-wifilab-unmanaged.conf` so that it ignores only the `mac80211_hwsim` radios.
- It refuses to start if `mac80211_hwsim` is already loaded by something else.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `mac80211_hwsim not found` | `sudo apt install -y linux-modules-extra-$(uname -r)`; with Secure Boot the signed module from the distribution loads fine. |
| "mac80211_hwsim is already loaded" | Something else uses it. `sudo modprobe -r mac80211_hwsim` if nothing needs it. |
| A lab did not stop cleanly | Stop it in the UI, or `sudo scripts/lab.sh down`. Then `ip netns list` and `lsmod \| grep mac80211_hwsim` should be empty. |
| `sudo: a password is required` | Set up passwordless sudo (above) or start `scripts/labd.sh` from a root shell. |
| UI fails with `.token` not found | Start `scripts/labd.sh` once first. |
| API ignores Ctrl+C while a browser is open | Stop the lab, then `sudo pkill -f 'uvicorn labd.api'` (repeat, then `-9` if needed). |
| Sniffers hear nothing | wmediumd is missing the patch: `scripts/setup.sh wmediumd`. |

## Command-line use

[scripts/lab.sh](scripts/lab.sh) runs the original command-line lab without the UI (2 APs, 1 client, a roam, measured from the capture):

```bash
sudo scripts/lab.sh demo ft        # or: demo psk | walk ft|psk | compare 3 walk | down
```

## Tests

```bash
scripts/smoke-test.sh                                   # environment
scripts/labd.sh                                         # in another terminal
.venv/bin/python tests/smoke_api.py ft                  # end-to-end API test (also: wpa2); the lab must be stopped
cd ui && npx tsc --noEmit && npm run build              # type-check and build the UI
```

## Project layout

```
labd/        FastAPI service: engine (lab lifecycle), frames (capture pipeline), keys, cli allow-list, models
tools/       analysis helpers (CCMP decryption, roam and connection metrics) and the wmediumd client
ui/          React + TypeScript + Vite front end (no UI framework)
scripts/     setup.sh, smoke-test.sh, labd.sh (start the API), lab.sh (CLI lab)
tests/       end-to-end API test
vendor/      wmediumd sniffer patch (the wmediumd source is cloned here by setup.sh)
runs/        per-run captures and logs (not committed)
```

For a deeper tour of the design and the problems already solved, read [AGENTS.md](AGENTS.md).

## Limits

- Topology changes (adding devices, channels, SSID, security) need a lab restart.
- 2.4 GHz channels 1, 6 and 11 only; OFDM rates only; at most 6 access points, 6 clients and 4 sniffers.
- The signal is a path-loss model, so trust ratios and frame counts more than absolute milliseconds.
- One root API process; local use on a trusted machine is the intended setup.

## Acknowledgements

[hostapd and wpa_supplicant](https://w1.fi/), [mac80211_hwsim](https://wireless.docs.kernel.org/en/latest/en/users/drivers/mac80211_hwsim.html), [wmediumd](https://github.com/ramonfontes/wmediumd) (Ramon Fontes' fork, originally by Bob Copeland) and [Wireshark](https://www.wireshark.org/).

## License

No license has been chosen yet. Add a `LICENSE` file before publishing.
