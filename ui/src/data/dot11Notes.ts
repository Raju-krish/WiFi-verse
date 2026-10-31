import type { Fault, Security } from '../types'

export interface LabHint {
  label: string
  fault: Fault
  security: Security
}

export interface Note {
  plain: string
  from?: 'AP' | 'client' | 'either'
  /** What reproduces it in this lab. */
  labs?: LabHint[]
}

const WRONG_WPA2: LabHint = { label: 'Wrong password, WPA2', fault: 'wrong_password', security: 'wpa2-psk' }
const WRONG_WPA3: LabHint = { label: 'Wrong password, WPA3', fault: 'wrong_password', security: 'wpa3-sae' }
const BLOCKED: LabHint = { label: 'MAC address blocked', fault: 'mac_blocked', security: 'open' }
const PMF: LabHint = { label: 'PMF mismatch', fault: 'pmf_mismatch', security: 'wpa2-psk' }
const MISMATCH: LabHint = { label: 'Security mismatch', fault: 'security_mismatch', security: 'wpa3-sae' }

// Status codes travel in Authentication and (Re)Association Response frames: the AP's answer to a request.
export const STATUS_NOTES: Record<number, Note> = {
  0: { from: 'AP', plain: 'Success. The only code that means the request was accepted.' },
  1: { from: 'AP', plain: "The AP's catch-all refusal, with no detail. In this lab hostapd answers with it when a MAC filter blocks the client, and when the password of a WPA3 (SAE) client is wrong.", labs: [BLOCKED, WRONG_WPA3] },
  10: { from: 'AP', plain: 'The client asked for capabilities (in the Capability Information field) that the AP cannot provide.' },
  11: { from: 'AP', plain: 'Reassociation refused because the AP cannot confirm that the client was associated before. Seen when a roam arrives without the previous association known.' },
  12: { from: 'AP', plain: 'Refused for a reason outside the standard, such as local policy. The code gives no hint of the cause; look in the AP log.' },
  13: { from: 'AP', plain: 'The AP does not support the authentication algorithm the client used (open system, shared key, SAE, fast transition). Example: a client trying SAE against a WPA2-only AP.', labs: [MISMATCH] },
  14: { from: 'AP', plain: 'An Authentication frame arrived out of order, for example a confirm before a commit.' },
  15: { from: 'AP', plain: 'Challenge failure in shared-key authentication: the WEP challenge was answered with the wrong key. Historic; WEP is obsolete.' },
  16: { from: 'AP', plain: 'The AP waited too long for the next frame of a multi-frame authentication and gave up.' },
  17: { from: 'AP', plain: 'The AP is full: it cannot take another client (hostapd max_num_sta, a hardware limit, or an admin limit).' },
  18: { from: 'AP', plain: 'The client does not support all the basic rates the BSS requires, for example an old 802.11b-only client on a network that requires OFDM rates.' },
  19: { from: 'AP', plain: 'The client does not support short preamble. A 802.11b-era limit.' },
  22: { from: 'AP', plain: 'Spectrum management (802.11h) is required and the client does not offer it.' },
  23: { from: 'AP', plain: 'The Power Capability element of the client is unacceptable (802.11h).' },
  24: { from: 'AP', plain: 'The Supported Channels element of the client is unacceptable (802.11h).' },
  25: { from: 'AP', plain: 'The client does not support short slot time (802.11g).' },
  27: { from: 'AP', plain: 'The client does not support HT (802.11n) and the AP requires it.' },
  28: { from: 'AP', plain: "R0KH unreachable: during a fast transition the AP could not reach the key holder that owns the client's PMK-R0 (pull key distribution)." },
  30: { from: 'AP', plain: 'Refused temporarily, try again later. The AP gives a comeback time, for example while it checks with an SA Query that the old association is really dead (protected management frames).' },
  31: { from: 'AP', plain: 'Robust management frame policy violation: the AP requires protected management frames (PMF) and the client did not offer them. Modern clients refuse such a network before sending anything, as this lab shows.', labs: [PMF] },
  37: { from: 'AP', plain: 'The request was declined.' },
  38: { from: 'AP', plain: 'The request failed because one or more parameters had invalid values.' },
  40: { from: 'AP', plain: 'An information element in the request is invalid: it does not follow the format of the standard.' },
  41: { from: 'AP', plain: 'The group cipher in the RSN element is not one the AP allows.' },
  42: { from: 'AP', plain: 'The pairwise cipher in the RSN element is not one the AP allows, for example a TKIP-only client on a CCMP-only AP.' },
  43: { from: 'AP', plain: 'The key management suite (AKM) in the RSN element is not one the AP allows, for example PSK against an SAE-only AP.' },
  44: { from: 'AP', plain: 'The RSN element has a version the AP does not support.' },
  45: { from: 'AP', plain: 'The RSN capabilities (such as PMF capable and required) are invalid or do not fit the AP.' },
  46: { from: 'AP', plain: 'Cipher suite rejected because of the security policy of the AP.' },
  51: { from: 'AP', plain: 'The listen interval the client asked for is longer than the AP accepts.' },
  52: { from: 'AP', plain: 'Invalid FT Action frame count (802.11r).' },
  53: { from: 'AP', plain: "Invalid PMKID: the client offered a cached key identifier the AP does not know, for example after the AP restarted. The client should fall back to a full authentication." },
  54: { from: 'AP', plain: 'Invalid mobility domain element (MDE): the APs are not in the same mobility domain (802.11r).' },
  55: { from: 'AP', plain: 'Invalid fast transition element (FTE) in the request (802.11r).' },
  72: { from: 'AP', plain: 'The contents of the RSN element are invalid in a way not covered by the more specific codes.' },
  76: { from: 'AP', plain: 'SAE anti-clogging token required: the AP is busy and asks the client to repeat its commit together with a token, which proves the client can receive frames at its address (WPA3).' },
  77: { from: 'AP', plain: "SAE group not supported: the client offered an elliptic curve (finite cyclic group) the AP does not support. The client should retry with another group; group 19 (P-256) is the one every WPA3 device supports." },
  82: { from: 'AP', plain: 'Rejected with a suggested BSS transition (802.11v): the AP says "not here, try that AP".' },
  92: { from: 'AP', plain: '(Re)association refused for an external reason, typically a decision made by a controller or server.' },
  93: { from: 'AP', plain: '(Re)association refused because the AP is out of memory.' },
  112: { from: 'AP', plain: 'Authentication rejected because FILS (fast initial link setup) failed.' },
  123: { from: 'AP', plain: 'The SAE password identifier is unknown: the client named an identifier that the AP does not have a password for.' },
  126: { from: 'either', plain: 'Not an error. In an SAE commit it announces that the password element is derived with hash-to-element (H2E) instead of the older looping method. You may see it in WPA3 captures.' },
}

// Reason codes travel in Deauthentication and Disassociation frames: one side ends the relationship.
export const REASON_NOTES: Record<number, Note> = {
  1: { from: 'either', plain: 'No particular reason. The catch-all.' },
  2: { from: 'either', plain: "The earlier authentication is no longer valid: the sender discarded its state (a timeout or a restart) or wants the other side to authenticate again." },
  3: { from: 'either', plain: 'Normal and harmless: the sender is leaving the network. wpa_cli disconnect sends it, and an AP sends it when it is shutting down or when an administrator removes a client.' },
  4: { from: 'either', plain: 'Disassociated because of inactivity. An AP sends it to a client that has been silent too long (ap_max_inactivity). A client that stops hearing the AP\'s beacons, for example after walking out of range, reports it locally.' },
  5: { from: 'AP', plain: 'The AP is overloaded and cannot handle all the clients it has.' },
  6: { from: 'AP', plain: 'Class 2 frame from a non-authenticated station: the AP got an association request (or similar) from a client it has no authentication for, typically after the AP restarted. It tells the client to start again.' },
  7: { from: 'AP', plain: 'Class 3 frame from a non-associated station: the AP got data from a client it does not consider associated. The classic "the AP forgot you", for example after an AP reboot.' },
  8: { from: 'either', plain: 'Disassociated because the sender is leaving the BSS. The disassociation twin of reason 3.' },
  9: { from: 'AP', plain: 'The station requesting (re)association is not authenticated with the AP.' },
  10: { from: 'AP', plain: 'Disassociated because the Power Capability information is unacceptable (802.11h).' },
  11: { from: 'AP', plain: 'Disassociated because the Supported Channels information is unacceptable (802.11h).' },
  12: { from: 'AP', plain: 'Disassociated because of BSS transition management (802.11v): the AP asked the client to move to another AP and removed it when it did not.' },
  13: { from: 'either', plain: 'Invalid information element: one defined by the standard but with content that breaks its format.' },
  14: { from: 'either', plain: 'Message integrity code (MIC) failure. With TKIP, two of these within a minute trigger countermeasures: the AP blocks the client.' },
  15: { from: 'AP', plain: "4-way handshake timeout: the handshake never finished. By far the most common cause is a wrong password: the client's MIC in message 2 does not verify, so the AP gets no valid answer, repeats message 1 and gives up.", labs: [WRONG_WPA2] },
  16: { from: 'AP', plain: 'Group key handshake timeout: the client did not answer the group key update.' },
  17: { from: 'either', plain: 'An element in the 4-way handshake differs from the one in the (re)association request or beacon. Downgrade protection: it can mean someone tampered with the security settings.' },
  18: { from: 'either', plain: 'Invalid group cipher.' },
  19: { from: 'either', plain: 'Invalid pairwise cipher.' },
  20: { from: 'either', plain: 'Invalid AKMP (key management suite).' },
  21: { from: 'either', plain: 'Unsupported RSN element version.' },
  22: { from: 'either', plain: 'Invalid RSN element capabilities.' },
  23: { from: 'AP', plain: 'IEEE 802.1X authentication failed: the RADIUS or EAP server rejected the credentials or certificate.' },
  24: { from: 'either', plain: 'Cipher suite rejected because of the security policy.' },
  25: { from: 'either', plain: 'TDLS direct-link teardown because the peer is unreachable on the direct link.' },
  26: { from: 'either', plain: 'TDLS direct-link teardown for an unspecified reason.' },
  34: { from: 'AP', plain: 'Disassociated because too many frames need to be acknowledged but are not: poor channel conditions or a client that is too weak.' },
  46: { from: 'AP', plain: 'Disassociated because the authorized access limit was reached.' },
  47: { from: 'AP', plain: 'Disassociated because of external service requirements.' },
  48: { from: 'AP', plain: 'Invalid FT Action frame count (802.11r).' },
  49: { from: 'AP', plain: 'Invalid PMKID: the key identifier the client used is not one the AP has.' },
  50: { from: 'AP', plain: 'Invalid mobility domain element (802.11r).' },
  51: { from: 'AP', plain: 'Invalid fast transition element (802.11r).' },
  71: { from: 'AP', plain: 'Disassociated because of poor RSSI: the AP removes a client whose signal is too weak so that it moves to a better AP.' },
}

export interface Group {
  name: string
  test: (code: number) => boolean
}

const range = (a: number, b: number) => (c: number) => c >= a && c <= b
const any = (...fns: ((c: number) => boolean)[]) => (c: number) => fns.some((f) => f(c))

export const STATUS_GROUPS: Group[] = [
  { name: 'Basics', test: any((c) => c === 0, (c) => c === 1, range(10, 17), range(37, 38), (c) => c === 92 || c === 93) },
  { name: 'Rates and radio features', test: any(range(18, 19), range(22, 27), (c) => c === 51, (c) => c === 104) },
  { name: 'Security (RSN, SAE)', test: any(range(40, 46), (c) => c === 72, range(76, 77), (c) => c === 123 || c === 126, (c) => c === 5) },
  { name: 'Protected management frames', test: range(30, 31) },
  { name: 'Fast transition and roaming', test: any((c) => c === 28, range(52, 55), (c) => c === 82) },
  { name: 'QoS and TSPEC', test: any(range(32, 35), range(39, 39), range(47, 50), range(56, 58), range(73, 75), range(79, 81), range(83, 84), range(97, 98)) },
  { name: 'Hotspot 2.0 and GAS', test: any(range(59, 65), range(67, 68), (c) => c === 95 || c === 120) },
  { name: 'TDLS, FST and others', test: any(range(2, 3), (c) => c === 6 || c === 7, range(85, 89), range(96, 96), range(99, 103), range(105, 111), range(114, 119), range(121, 122), (c) => c === 124 || c === 125) },
  { name: 'FILS', test: range(112, 113) },
  { name: 'Wi-Fi 7 (multi-link)', test: range(128, 141) },
]

export const REASON_GROUPS: Group[] = [
  { name: 'Leaving and timeouts', test: any(range(1, 5), range(8, 8)) },
  { name: 'State out of step', test: range(6, 7) },
  { name: 'Handshake and security', test: any(range(13, 24), range(9, 9)) },
  { name: 'Capabilities', test: range(10, 11) },
  { name: 'Roaming and steering', test: any((c) => c === 12, range(48, 51), (c) => c === 71) },
  { name: 'QoS, direct links and SSP', test: any(range(25, 26), range(27, 39)) },
  { name: 'Mesh', test: range(52, 66) },
  { name: 'Alternative channel', test: range(67, 68) },
]

export function groupOf(groups: Group[], code: number): string {
  return groups.find((g) => g.test(code))?.name ?? 'Other'
}

export interface FieldCase {
  symptom: string
  codes: string
  why: string
}

// The causes people meet most, from the lab and from real networks.
export const FIELD_GUIDE: FieldCase[] = [
  { symptom: 'Wrong password on WPA2-Personal', codes: 'Reason 15 from the AP', why: 'The 4-way handshake times out because message 2 fails its integrity check.' },
  { symptom: 'Wrong password on WPA3-Personal', codes: 'Status 1 in the SAE confirm', why: 'The SAE exchange ends in a rejected Authentication frame, before any association.' },
  { symptom: 'The AP blocks the client (MAC filter)', codes: 'Status 1 (or 12) in Authentication', why: 'hostapd refuses the first Authentication frame.' },
  { symptom: 'The client and the AP disagree on security', codes: 'Nothing on the air', why: 'The client sees no network matching its profile and never sends an Authentication frame. The proof is in the client log.' },
  { symptom: 'The AP requires PMF, the client does not do it', codes: 'Status 31, or nothing on the air', why: 'Older stacks send the request and are refused with 31; modern ones skip the network.' },
  { symptom: 'The AP is full', codes: 'Status 17 in the association response', why: 'The AP has reached its maximum number of clients.' },
  { symptom: 'An old client on a modern network', codes: 'Status 18, 27 or 104', why: 'It lacks the basic rates, HT or VHT the BSS requires.' },
  { symptom: 'The AP restarted and the client carries on', codes: 'Reason 6 or 7 from the AP', why: 'The AP has no state for the client and tells it to start again.' },
  { symptom: 'Client walks out of range, or stays silent', codes: 'Reason 4', why: 'Inactivity or beacon loss.' },
  { symptom: 'An administrator removes the client, or an AP shuts down', codes: 'Reason 3 or 8 (or whatever was chosen)', why: 'A deliberate deauthentication or disassociation.' },
  { symptom: 'Steering a client to a better AP', codes: 'Reason 12, or status 82', why: '802.11v BSS transition management.' },
  { symptom: 'The RADIUS server rejects the login', codes: 'Reason 23', why: 'IEEE 802.1X authentication failed.' },
  { symptom: 'A cached key is no longer valid', codes: 'Status 53 or reason 49', why: 'The client offered a PMKID the AP does not know; it must authenticate in full.' },
]
