const STEPS = [
  {
    n: 1,
    title: 'Scan',
    frames: 'Beacons, Probe Request and Response',
    fails: 'No network in the scan matches what the client expects: a different security mode, a PMF requirement it cannot meet, a different SSID.',
    shows: 'Nothing. The client sends no Authentication frame, so there is no code. Only its own log says why.',
  },
  {
    n: 2,
    title: 'Authentication',
    frames: 'Authentication (open system), or SAE commit and confirm for WPA3',
    fails: 'The AP refuses: the client is blocked, a WPA3 password is wrong, the algorithm or the SAE curve is not supported, or the AP is too busy.',
    shows: 'A status code in the AP’s Authentication response. Status 0 is success.',
  },
  {
    n: 3,
    title: 'Association',
    frames: 'Association Request and Response',
    fails: 'The AP cannot take the client as it is: it is full, the client lacks required rates or features, or its security elements do not fit.',
    shows: 'A status code in the Association Response, for example 17 (AP full), 18 (rates) or 40 to 46 (security elements).',
  },
  {
    n: 4,
    title: '4-way handshake',
    frames: 'EAPOL-Key messages 1 to 4',
    fails: 'Both sides must prove they hold the same key. With a wrong WPA2 password message 2 fails its integrity check and the handshake never completes.',
    shows: 'No status code exists for this step. It simply stops, and after a timeout the AP sends a Deauthentication with a reason, usually 15.',
  },
  {
    n: 5,
    title: 'Connected, then ended',
    frames: 'Deauthentication or Disassociation',
    fails: 'Either side can end the connection at any time: an administrator, inactivity, an AP that restarted, a client that left, a steering request.',
    shows: 'A reason code in the Deauthentication or Disassociation frame, for example 3 (leaving), 4 (inactivity), 7 (AP forgot you).',
  },
]

export function ErrorsGuide() {
  return (
    <div className="eg">
      <ol className="eg-steps">
        {STEPS.map((s) => (
          <li key={s.n}>
            <span className="eg-n">{s.n}</span>
            <h4>{s.title}</h4>
            <small>{s.frames}</small>
            <p>
              <b>How it fails.</b> {s.fails}
            </p>
            <p>
              <b>What you see.</b> {s.shows}
            </p>
          </li>
        ))}
      </ol>
      <div className="eg-notes">
        <div className="code-card">
          <small>Status code</small>
          <b>The AP’s answer to a request</b>
          <span>It lives in Authentication and (Re)Association Response frames. 0 means yes; any other number is a refusal with a cause. Defined values run from 0 to 141 and grow with every amendment, from 802.11 in 1997 to Wi-Fi 7.</span>
        </div>
        <div className="code-card">
          <small>Reason code</small>
          <b>Why a connection is ending</b>
          <span>It lives in Deauthentication and Disassociation frames and either side can send it. It is not an answer; it is a goodbye with a cause. Defined values run from 1 to 71.</span>
        </div>
        <div className="code-card">
          <small>Why some failures show nothing</small>
          <b>Most mismatches never reach the air</b>
          <span>A modern client checks the beacon first. If the security does not match its profile, it never tries, and no frame carries a code. The log of the client is the only evidence, so this lab shows it too.</span>
        </div>
      </div>
    </div>
  )
}
