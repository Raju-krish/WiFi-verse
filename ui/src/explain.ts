// Plain-language notes for common fields, keyed by tshark field name. Clause numbers are from IEEE 802.11-2020/2024.
const EXPLAIN: Record<string, string> = {
  'wlan.fc': 'Frame Control: two bytes that say what kind of frame this is (type and subtype) plus flags such as Retry and Protected. 802.11 clause 9.2.4.1.',
  'wlan.fc.type': 'Type: 0 management (beacons, authentication, association), 1 control (ACK, RTS), 2 data.',
  'wlan.fc.subtype': 'Subtype within the type. For management frames: 0 association request, 2 reassociation request, 8 beacon, 11 authentication, 12 deauthentication.',
  'wlan.fc.type_subtype': 'Type and subtype together, for example 0x000b is Authentication and 0x0008 is a Beacon.',
  'wlan.fc.protected': 'Protected Frame: 1 means the body is encrypted (CCMP here). The lab decrypts these with the keys from the hostapd and wpa_supplicant logs.',
  'wlan.fc.retry': 'Retry: set when this frame is a retransmission of an earlier one.',
  'wlan.fc.tods': 'To DS: set on frames a client sends to its AP.',
  'wlan.fc.fromds': 'From DS: set on frames an AP sends to a client.',
  'wlan.duration': 'Duration/ID: how long, in microseconds, other stations must stay quiet (the NAV).',
  'wlan.ra': 'Receiver address: the radio that should receive this frame next.',
  'wlan.ta': 'Transmitter address: the radio that sent this frame.',
  'wlan.da': 'Destination address: the final recipient of the frame.',
  'wlan.sa': 'Source address: who originally sent the frame.',
  'wlan.bssid': 'BSSID: identifies the AP\'s network. It is the AP radio\'s MAC address.',
  'wlan.seq': 'Sequence number: lets a receiver spot duplicates and reorder fragments.',
  'wlan.frag': 'Fragment number: 0 unless the frame was split into fragments.',
  'wlan.fixed.auth.alg': 'Authentication algorithm: 0 = Open System, 2 = Fast BSS Transition (802.11r), 3 = SAE (WPA3). Seeing 2 here means this roam used 802.11r.',
  'wlan.fixed.auth_seq': 'Authentication sequence: 1 is the request, 2 is the response.',
  'wlan.fixed.status_code': 'Status code: 0 means success. Anything else is the reason the request was refused.',
  'wlan.fixed.reason_code': 'Reason code: why a deauthentication or disassociation happened. 3 = the sender is leaving.',
  'wlan.fixed.capabilities': 'Capability information: what the network supports, such as ESS and privacy (encryption) bits.',
  'wlan.fixed.beacon': 'Beacon interval in time units of 1.024 ms. 100 TU is about 102.4 ms.',
  'wlan.fixed.current_ap': 'Current AP address, sent in a reassociation request so the new AP knows where the client came from.',
  'wlan.fixed.listen_ival': 'Listen interval: how many beacons a sleeping client may skip.',
  'wlan.ssid': 'SSID: the network name.',
  'wlan.rsn': 'RSN element: the security the AP offers, including ciphers and key management (AKM) suites. Clause 9.4.2.24.',
  'wlan.rsn.akms.type': 'AKM suite: 2 = WPA2-PSK, 4 = FT-PSK (802.11r with a pre-shared key), 8 = SAE.',
  'wlan.rsn.pcs.type': 'Pairwise cipher: 4 = CCMP (AES), the cipher used for unicast data.',
  'wlan.mobility_domain': 'Mobility Domain element: APs with the same MDID form an 802.11r domain a client can fast-roam within. Clause 9.4.2.45.',
  'wlan.ft': 'Fast BSS Transition element: carries the nonces and key holder names that let the key exchange ride inside authentication and reassociation. Clause 9.4.2.46.',
  'wlan.tag': 'Information element: a type, a length and a value. Beacons and association frames are mostly a list of these.',
  'wlan.ds.current_channel': 'The channel the AP says it is operating on.',
  'wlan_radio.channel': 'Channel the frame was heard on.',
  'wlan_radio.signal_dbm': 'Signal strength at the receiver, from the wmediumd path-loss model.',
  'radiotap.dbm_antsignal': 'Received signal strength in dBm, added by the capturing radio.',
  'radiotap.channel.freq': 'Frequency the frame was received on, in MHz.',
  'radiotap.datarate': 'Data rate the frame was sent at.',
  'wlan_rsna_eapol.keydes.msgnr': 'Which message of the 4-way handshake this is (1 to 4). FT roams have none.',
  'wlan_rsna_eapol.keydes.nonce': 'Nonce: a random value each side contributes so the session keys are fresh.',
  'wlan_rsna_eapol.keydes.mic': 'Message integrity code: proves the sender knows the key, without revealing it.',
  'eapol': 'EAPOL-Key frame: part of the 4-way handshake that installs the session keys.',
  'llc': 'Logical link control header: says which protocol follows, such as IP or ARP.',
  'arp': 'ARP: asks who owns an IP address, or answers.',
  'ip.src': 'Source IP address.',
  'ip.dst': 'Destination IP address.',
  'icmp.type': 'ICMP type: 8 is an echo request (ping), 0 is the reply.',
}

export function explain(key: string): string | undefined {
  if (EXPLAIN[key]) return EXPLAIN[key]
  const parts = key.split('.')
  for (let i = parts.length - 1; i > 1; i--) {
    const hit = EXPLAIN[parts.slice(0, i).join('.')]
    if (hit) return hit
  }
  return undefined
}
