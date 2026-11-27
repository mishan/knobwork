# Harness design: state, actions, invariants

The specification is normative; this file records how the code meets it: the
state each stateful part can be in, every action on that state and the test
that covers it, the invariants checked generically, and the decisions made
where the specification is silent.

## Stateful parts

Everything else (config, HTTP routing, access policy, CSS, CAN, overlay reads)
is computed per request from read-only inputs and holds no state beyond
counters.

### Proxy session (`lib/proxy.js`), one per frontend WebSocket

| State | Meaning |
|---|---|
| `waiting` | MMUI only: frontend open, readiness not yet released, no guest socket |
| `connecting` | guest socket created, handshake pending |
| `open` | guest open, `released`, queue flushed; frames flow both ways |
| `closed` | terminal; frontend closed, guest closed or its handshake aborted, queue empty |

`queue` is non-empty only in `waiting` and `connecting`.

| Act | Precondition | Leaves | Told |
|---|---|---|---|
| handshake with a disallowed Host or Origin | - | refused (HTTP 403) | `rejectedHosts` / `rejectedOrigins` |
| handshake at 32 live sessions for the service | - | refused (HTTP 503) | `rejectedCapacity` |
| handshake without the service subprotocol | - | refused (HTTP 400) | `protocolMismatches` |
| MMUI frontend connects while another MMUI session exists | - | the older session goes to `closed` (frontend 1001); the new one proceeds | `replacedFrontends` |
| frontend connects | - | `waiting` (MMUI) or `connecting` | backend `status`, `activeConnections` |
| readiness released | `waiting` | `connecting` | `connectionAttempts` |
| guest open | `connecting` | `open`; queue forwarded in order, then a pending splash applied | `guestConnections`; bridge `attachGuest`, `finishIfPending` (MMUI) |
| guest fails to open | `connecting` | `closed`, frontend 1013 | `lastError`, `lastCloseReason` |
| guest lost | `open` | `closed`, frontend 1013 | `lastError`; readiness `reset` (MMUI, unexpected loss only); bridge `detachGuest` |
| frontend frame | `waiting`/`connecting`, under 256 frames and 16 MiB | same, frame queued | `queueDepth`; readiness `queuedFrontendMessages` (MMUI) |
| frontend frame | `waiting`/`connecting`, at either limit | `closed`, frontend 1008 | `queueOverflows`, `lastError` |
| frontend or guest frame | `open` | `open`, frame sent to the other side; reading from the sender pauses while the receiver has over 4 MiB buffered, resumes below 1 MiB | counters; bridge `frontendMessage` / `guestMessage` (MMUI text) |
| synthetic frame | `open` (MMUI) | `open`, frame sent to guest | counters as `native-display-to-guest` |
| frontend closes | any but `closed` | `closed`; readiness waiter canceled; an in-flight guest handshake aborted | `activeConnections` |
| shutdown | any | `closed`, frontend 1001 | - |

### MMUI readiness gate (`lib/readiness.js`), one per process

State: `lastAt` (last marker, monotonic clock, or null), `readySince`, waiter
set, one timer. `ready` = `lastAt` within 5000 ms. `released` = `ready` and
`holdMs` elapsed since `readySince`.

| Act | Leaves | Told |
|---|---|---|
| `mmui-ready` notification | `lastAt = now`; `readySince = now` if it was not ready; each waiter runs once, when released | `notifications`, `lastNotification(At)` |
| time passes 5000 ms without a marker | not ready (computed) | - |
| active MMUI guest lost unexpectedly | `lastAt = null` | `resets` |
| waiter added | runs at once if released, else queued; a timer (at most 2^31-1 ms) wakes it when the hold ends | - |

### Display lifecycle bridge (`lib/display.js`), one per process

State: `sender` (active MMUI guest connection or null), `splashPending`,
per-connection `phase` (`startSent`, `finishSent`, `homeSeen`,
`disclaimerEndSeen`, `complete`).

| Act | Precondition | Effect | Told |
|---|---|---|---|
| guest attaches | - | `sender` set, new `phase` | - |
| queue flushed (`finishIfPending`) | `splashPending` | Finish | - |
| guest detaches | it is still the active sender | `sender = null` | - |
| frontend `InitializeGuiComplete` (forwarded) | `!startSent` | send Start | `startEvents` |
| splash notification | `!finishSent` on this connection | `splashPending`; Finish if a sender exists | `notifications`, `lastNotification` |
| Finish | sender, `!finishSent` | send Finish; ShowDisclaimer after 100 ms if the sender is unchanged | `finishEvents`, later `showDisclaimerEvents` |
| unsupported notification | - | nothing sent | `notifications`, `unsupportedNotifications`, `lastError` |
| HomeScreen seen and `NotifyDisclaimerEnd` forwarded, either order | - | `complete` | `lastError = null` |

### Mock scenario session (`lib/scenario.js`), one per frontend WebSocket

State: rendered `state` object, context `stack` (depth <= 64), `sequence`
(1..127), pending output (<= 256, ordered by due time, one timer for the head,
monotonic clock), `cursor` (earliest due time for the next output), `closed`.

| Act | Effect | Told |
|---|---|---|
| connect | `onConnect` actions | `connections`, `activeConnections` |
| frame over the scenario's `maxInboundBytes` | connection closed 1009 by the WebSocket layer | - |
| text frame, not a JSON object / binary | dropped | `invalid` / `receivedBinary` |
| text frame matching a rule | actions planned in order, outputs emitted no earlier than earlier outputs | `handled`, `ruleHits`, `accepted` |
| text frame matching nothing | dropped | `unhandled` |
| pending output limit reached | frontend closed 1011, nothing further emitted | `faults` |
| close | pending output dropped | `activeConnections` |

## Action inventory and test map

| Action | Tests |
|---|---|
| config parse and validation, exposure warning | unit: `config: *` |
| Host/Origin policy | unit: `access: Host and Origin allowlist`; integration: `access: HTTP and WebSocket requests...` |
| path confinement, symlink swaps | unit: `paths: *`; integration: `http: index injection...`, `http: a file swapped for an outside symlink...`, `http: an index.html symlink...`; property P1 |
| index injection, routes on decoded paths | integration: `http: index injection...`, `http: special routes match the decoded path` |
| CSS translation | unit: `css: *`; property P2 |
| optional stylesheets, favicon, unknown `/__emu`, 405 | integration: `http: index injection...` |
| aborted downloads | integration: `http: an aborted static download releases its file descriptor` |
| integration override, app-script fault | integration: `http: overlay workspace...`, `http: integration override refuses a symlink` |
| `/__emu/overlay`, workspace detection, FIFO safety | unit: `overlay: *`; integration |
| `/__emu/can`, CAN load | unit: `can: *`; integration |
| `/__emu/health` and its bound | integration: field checks; `proxy: diagnostics stay under the health bound...`; property P6 |
| transactional listen, shutdown | integration: `listeners: open transactionally...`, `shutdown: *`; abuse: `stop releases everything...` |
| mock frames, rules, faults, limits | scenario: `scenario: *`; integration: `mock: *` |
| proxy forwarding, early queue, guest failure and loss | integration: `proxy: *`; properties P3, P4 |
| MMUI replacement, readiness reset rules | integration: `proxy: a newer MMUI frontend replaces...`, `proxy: a frontend that leaves does not reset readiness...` |
| backpressure | integration: `proxy: a slow receiver pauses the sender...` |
| session and control-connection caps | integration: `frontends: sessions per service and control connections are capped` |
| readiness | unit: `readiness: *`; integration (release with hold) |
| lifecycle bridge | unit: `display: *`; integration (full lifecycle, queued-frame ordering) |
| control channel | integration: `proxy: display-control input is bounded...`, `proxy: an oversized control connection is closed...` |
| hostile peers on every socket | abuse: `abuse: *` |
| browser adapter (`public/compat.js`) | none automated; covered by `verify-ui` |

## Invariants and their generic checks

| Invariant | Check |
|---|---|
| The selected root and workspace are never modified | P5: tree snapshot around every integration test |
| No request serves a file whose real path is outside the GUI tree | P1, and the symlink-swap race test |
| CSS translation touches only recognized tokens | P2 |
| Proxy frames are byte-exact | P3 |
| Proxy mode never synthesizes toward a frontend | P4 |
| Diagnostics stay bounded | P6, and the hostile-traffic health test |
| No peer can crash the process | `test/abuse.test.js`: garbage, protocol violations, and resets on every frontend, guest, control, and HTTP socket in both modes |
| Stopping releases everything the harness opened | `test/abuse.test.js`: process resources return to their baseline after `stop()` |

## Decisions

- Proxy mode serves one MMUI frontend at a time, and the newest wins: a new
  MMUI frontend closes the active one with 1001 and its guest connection, and
  is counted in `replacedFrontends`. (Refusing the newcomer broke reloads,
  whose new socket can arrive before the old one closes.) Readiness is reset
  only when the active guest connection is lost unexpectedly, not when the
  harness closes it because its frontend left or was replaced.
- Requests must name an allowed Host: `localhost`, a loopback address, the
  configured HOST, or (when HOST is a wildcard) any IP literal; WebSocket
  handshakes must also carry no Origin or the harness page's own origin.
  Others get 403. Browsers let any page open WebSockets to 127.0.0.1 and DNS
  rebinding can aim an attacker's hostname at it; without this a page in the
  developer's browser could replace the MMUI session, talk to the guest, and
  read diagnostics. (Hardening beyond the specification, chosen by the
  repository owner.)
- Resource caps: at most 32 WebSocket sessions per service (503 beyond) and
  16 open display-control connections; in mock mode the WebSocket layer
  refuses frames larger than the scenario's `maxInboundBytes` (1009). A
  non-loopback HOST logs a warning naming what becomes reachable.
- Forwarding applies backpressure: when one side's send buffer passes 4 MiB,
  the harness stops reading from the other side and resumes below 1 MiB, so
  a stalled peer pushes back over TCP instead of growing harness memory.
  Bytes and order are unaffected.
- The early queue is bounded at 256 frames (specification) and 16 MiB.
- Stock files are opened once, non-blocking, and checked through the open
  descriptor (`/proc/self/fd`), so a file swapped for a symlink after the path
  check cannot be read; responses are chunked so a changing file cannot
  corrupt the framing.
- Only MMUI pins control messages until HomeScreen (limit 1000); DBAPI and
  AppSDK keep the most recent 200. Control characters in summary strings are
  replaced so a hostile frame cannot inflate health past its 4 MiB bound.
- A WebSocket handshake that does not offer the service's subprotocol is
  refused with HTTP 400 and counted in `stats.clients.protocolMismatches`.
- Backend `status` is derived from all of that backend's sessions:
  `connected` if any is, else `connecting`, else `waiting-for-mmui-ready`,
  else `closed`/`idle`.
- Only one variable beyond the specification exists: `EMU_SCENARIO`, which
  selects another mock scenario file. Debug output is requested by the page
  (`?emuDebug=1`).

## Property checks (`test/properties.test.js`)

Invariants fixed before the first run. Each check uses a seeded generator; the
seed and run count are printed so a failure can be replayed with
`PROP_SEED=<seed>`.

One change since: P2 (b) originally said only `-o-` prefixes change.
Converting legacy gradient directions (the v74 stock CSS uses `top` and
`left`) also rewrites a gradient's first argument, so (b) now allows exactly
that. Before the change, 20 seeds x 300 runs ended with no failure only
because the generator never produced a convertible direction; the generator
now produces them.

| Check | Invariant (must hold on every generated case) |
|---|---|
| P1 confinement | For any raw request path over a tree with internal and escaping symlinks, a 200 response's body is the content of a file whose real path is inside the GUI tree; the outside secret is never returned. |
| P2 CSS | (a) `t(t(x)) = t(x)`; (b) removing every `-o-`, and every gradient's first argument, from input and output gives the same text; (c) the number of removed `-o-` equals `changes`; (d) every string and comment fragment appears verbatim, in order, in the output. |
| P3 byte-exact proxy | Every frame sent by the frontend arrives at the guest, and every frame sent by the guest arrives at the frontend, with identical bytes, type, and order, for random text (including invalid UTF-8) and binary payloads of 0..65536 bytes. |
| P4 no synthesis toward a frontend | In P3 and in the lifecycle test, the sequence a frontend receives equals the sequence the guest sent. |
| P5 read-only | Every integration test's root and workspace trees (names, sizes, mtimes, modes) are identical before and after the test. |
| P6 bounded diagnostics | After flooding every backend in both directions and the HTTP routes, the health response is under 1 MiB and each per-backend message list is within its limit. |
