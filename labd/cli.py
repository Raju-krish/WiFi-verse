"""Read-only hostapd_cli / wpa_cli commands the UI terminal may run. Anything not listed here is refused, and
arguments must match their pattern exactly, so no user text ever reaches a command line unchecked."""
import re
from typing import Optional

MAC = r"[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}"

# (usage shown to the user, fixed words and argument patterns after the verb, what it tells you)
COMMANDS = {
    "ap": [
        ("status", [], "The BSS: SSID, channel, key management, number of stations."),
        ("all_sta", [], "Every associated station: flags such as [AUTHORIZED], PTK state, cipher, key management."),
        ("list_sta", [], "MAC addresses of the associated stations."),
        ("sta <mac>", [MAC], "One station in full, including whether its keys are installed."),
        ("get_config", [], "The running security configuration (WPA version, key management, ciphers)."),
        ("mib", [], "Management counters of the BSS."),
        ("pmksa", [], "The PMKSA cache: pairwise master keys kept for reuse."),
        ("ping", [], "Check that hostapd answers."),
        ("ft_cache", [], "LAB COMMAND, not part of hostapd_cli: the FT PMK-R1 entries this AP holds (pushed, pulled or derived), read from its log."),
    ],
    "sta": [
        ("status", [], "Connection state, BSSID, key management, ciphers and the client's addresses."),
        ("status verbose", ["verbose"], "Same with more detail."),
        ("signal_poll", [], "Current RSSI, noise and link speed."),
        ("scan_results", [], "The access points last seen, with signal and flags."),
        ("list_networks", [], "The configured network profiles."),
        ("bss <mac>", [MAC], "What the client learned about one access point."),
        ("pmksa", [], "The PMKSA cache: pairwise master keys kept for reuse."),
        ("mib", [], "Management counters of the supplicant, including the 4-way handshake state."),
        ("get_capability key_mgmt", ["key_mgmt"], "Key management suites the client supports."),
        ("get_capability pairwise", ["pairwise"], "Pairwise ciphers the client supports."),
        ("get_capability group", ["group"], "Group ciphers the client supports."),
        ("get_network 0 key_mgmt", ["0", "key_mgmt"], "Key management of the profile."),
        ("get_network 0 ieee80211w", ["0", "ieee80211w"], "Management frame protection setting."),
        ("ping", [], "Check that wpa_supplicant answers."),
        ("ft_cache", [], "LAB COMMAND, not part of wpa_cli: the FT PMK-R1 entries the client derived, read from its log."),
    ],
}


LAB_COMMANDS = {"ft_cache"}  # answered by the lab itself, never passed to hostapd_cli or wpa_cli


def catalog() -> dict:
    return {kind: [{"usage": u, "help": h} for u, _, h in items] for kind, items in COMMANDS.items()}


def parse(kind: str, command: str) -> Optional[list]:
    """The argv tail for an allowed command, or None."""
    words = command.split()
    for usage, patterns, _ in COMMANDS.get(kind, []):
        if words[:1] == usage.split()[:1] and len(words) - 1 == len(patterns) and all(re.fullmatch(p, w) for p, w in zip(patterns, words[1:])):
            return words
    return None
