# Independent browser harness specification

## Status and purpose

This document is the implementation contract for replacing the existing browser
harness without copying or adapting its source. It is intended to be sufficient
for an implementer who has not inspected either:

- this repository's existing `emulation/harness/boot.js` or
  `emulation/harness/server.js`, including their Git history; or
- `checksummaster/mazda_emulation` or copies derived from that repository.

The new implementation must be written under new paths and from this behavioral
specification, contract tests, user-supplied firmware, and observable emulator
behavior. It must not be a translation, cleanup, or refactor of the existing
harness.

The specification author has reviewed the existing implementation. That person
may clarify behavior and maintain the acceptance tests, but should not be
represented as an unexposed clean-room implementer.

## Clean-room working protocol

For the strongest independent-implementation record, use these roles:

1. **Specification maintainer:** owns this document, protocol fixtures, and
   black-box acceptance tests. This role may have seen the old implementation.
2. **Implementer:** receives a sanitized source export with the old harness and
   Git history absent. This role must not inspect the prohibited sources above.
3. **Integration reviewer:** runs the completed implementation against the
   private firmware fixture and compares externally observable behavior. The
   implementer should not receive a source-to-source comparison.

Questions from the implementer must be answered by updating this specification
or a test fixture. Do not answer with excerpts, screenshots, pseudocode, naming,
or organizational details from the prohibited implementations.

Keep the following provenance records:

- the commit hash of this specification given to the implementer;
- a list of all permitted inputs and test fixtures;
- the implementer's written confirmation that prohibited sources were not
  consulted;
- dated implementation notes describing design decisions and observed firmware
  behavior; and
- the final acceptance results and license declaration.

If the same exposed developer implements the replacement, call it a
"ground-up rewrite" rather than a "clean-room implementation."

## System objective

The harness renders the stock Mazda Connect Gen 6 HMI in a modern desktop
browser while keeping the user-supplied firmware tree read-only. It has two
backend modes:

- **mock:** deterministic, fast protocol simulation for UI development; and
- **proxy:** fail-closed transport to the stock MMUI, AppSDK, and DBAPI services
  running in the generic ARM QEMU guest.

It is a development and regression environment. It does not emulate the Mazda
board, Vivante display hardware, physical CAN buses, or the safety properties of
a real CMU installation.

## Non-goals

The replacement must not:

- redistribute firmware, Mazda/JCI binaries, stock UI assets, or captured
  vehicle data;
- write to or patch the selected firmware root;
- duplicate the complete behavior of MMUI, AppSDK, or DBAPI;
- replace stock menu controllers, templates, input handlers, or navigation with
  emulator-owned UI;
- claim compatibility with firmware other than the explicitly tested v74
  baseline;
- fall back to mock behavior while proxy mode is selected; or
- depend on the removed harness at runtime, build time, or test time.

## Permitted implementation inputs

The implementer may use:

- this specification and its future reviewed revisions;
- a sanitized repository export containing a minimal emulator CLI, synthetic
  fixtures, and a black-box verifier, but no prior harness or source history;
- official Node.js, browser, WebSocket, HTTP, and QEMU documentation;
- a lawfully obtained, user-supplied firmware root for execution and observation;
- minimal black-box WebSocket traces supplied by the integration reviewer from
  stock services in the QEMU guest;
- test failures expressed only as expected versus observed behavior; and
- independently written protocol schemas and scenario fixtures.

Firmware source files may be inspected to determine interfaces and browser
compatibility requirements, but firmware content must not be copied into the
repository. Any resulting fixture must contain only the minimum functional
message fields needed by the test.

## Process and filesystem contract

### Inputs

The harness receives an extracted firmware root through `ROOTFS_PATH` or
`CMU_ROOTFS`. The selected directory is valid only when all of these conditions
hold:

- it is an existing directory;
- `jci/gui` is an existing directory beneath it; and
- `jci/gui/index.html` is an existing regular file.

Resolve the root to an absolute path before use. The harness must not create,
modify, rename, or delete anything beneath it.

When the selected root is the `root` directory of a validated disposable
overlay workspace, read-only diagnostic endpoints may also read that
workspace's `data` and `emulated` directories. They must not mutate them.

#### Overlay workspace format (format 2)

A workspace is the parent directory `W` of the selected root. The selected root
is a validated overlay workspace only when all of these hold at startup:

- the resolved root's final path component is `root`;
- `W/.overlay-workspace.json` is a regular file (not a symlink) containing a
  JSON object whose `kind` is the string `mazda-cmu-overlay-workspace` and
  whose `format` is the number `2`; and
- `W/data/integration` and `W/data/cmu-overlay` are existing directories.

Any read, parse, or check failure means "not an overlay workspace"; it is not a
startup error. Other formats are unsupported. The object's `overlay_id` string
is the overlay identifier; other members are not part of this contract.

The workspace's `root/data` is a symlink to `../data`; the harness does not
rely on it and must not follow it for the routes below.

Manager state lives in single-value text files. Read each one by its own path
(without following a symlink at that path), trim surrounding whitespace, and
use the fallback when it is missing, empty, non-regular, oversized, or
unreadable:

| Value | File | Fallback |
|---|---|---|
| Manager state | `W/data/cmu-overlay/state` | `factory` |
| Active transaction | `W/data/cmu-overlay/active-transaction` | `none` |
| Boot-attempt count | `W/data/cmu-overlay/boot-attempts` | `0` |
| Emulated mount state | `W/emulated/mount-state` | `unknown` |
| Emulated watchdog | `W/emulated/watchdog` | `unknown` |
| Journal | `W/data/cmu-overlay/journal.log` (LF or CRLF lines) | no lines |

Values are reported as strings exactly as read; the harness does not interpret
them. The integration override is `W/data/integration/developer_mode_GuiConfig.js`.

### Host and ports

Default listeners and WebSocket subprotocols are:

| Purpose | Default | WebSocket subprotocol |
|---|---:|---|
| HTTP frontend | 8080 | n/a |
| MMUI frontend | 2700 | `ihu-guiifm-protocol` |
| DBAPI frontend | 2766 | `ihu-dbapi-protocol` |
| AppSDK frontend | 2800 | `ihu-appsdk-protocol` |
| Native display control | 2990 | plain TCP control channel |

The default bind address is `127.0.0.1`. An explicit `HOST` setting may change
it. Validate every configured port as an integer from 1 through 65535 and reject
duplicate listener ports before opening any listener.

Proxy mode connects each frontend WebSocket to `QEMU_HOST`, defaulting to
`127.0.0.1`, on the corresponding frontend port plus 10000. Preserve the
negotiated subprotocol.

### Supported configuration

The first implementation must preserve these environment variables:

| Variable | Meaning |
|---|---|
| `ROOTFS_PATH`, `CMU_ROOTFS` | Selected extracted firmware root |
| `HOST` | Listener address; default loopback |
| `HTTP_PORT` | HTTP listener; default 8080 |
| `MMUI_PORT` | MMUI frontend; default 2700 |
| `DBAPI_PORT` | DBAPI frontend; default 2766 |
| `APPSDK_PORT` | AppSDK frontend; default 2800 |
| `PROXY_MODE` | `true` selects native proxy mode |
| `QEMU_HOST` | Native guest forwarding host |
| `DISPLAY_CONTROL_PORT` | Guest readiness/display control channel |
| `EMU_MMUI_READINESS_HOLD_MS` | Test-only delay after readiness notification |
| `EMU_FAIL_OVERLAY_APP_SCRIPT` | Test-only optional-script failure |
| `CAN_REPLAY_PATH` | Prevalidated receive-only CAN JSONL fixture |

Normal operation must not inherit an artificial readiness delay.

## HTTP frontend contract

### Stock file serving

`GET /` and `GET /index.html` (and any request path that normalizes to
`/index.html`) return the stock `jci/gui/index.html` with two
in-memory additions before the document finishes loading:

1. a small configuration object containing backend mode and frontend ports; and
2. the new browser compatibility script.

Do not write the modified HTML back to disk. All other stock paths are served
from `jci/gui` after decoding and normalization. Remove dot segments as
RFC 3986 does, never above the GUI root, so no spelling of a path can escape
it. Reject invalid percent-encodings, backslashes, NUL, and any request whose
real path leaves the GUI directory, including through a symlink.

Disable caching for transformed or injected responses. Static resources may use
correct MIME types but must not expose directory listings.

### Browser compatibility resources

The compatibility script is served from a new implementation-owned path. Its
public diagnostic result must be available as `window.__mazdaEmulator` with:

```text
backendMode       "mock" or "proxy"
syntheticBackend  true only in mock mode
debugEnabled      true only when explicitly requested
```

The object may contain additional version fields, but the three fields above
are stable contract fields.

### CSS compatibility

When a stock CSS file is served, translate these Opera-era constructs in memory:

- `@-o-keyframes` to standard keyframes;
- `-o-linear-gradient` to the standard function; and
- the `-o-` forms of transform, transition, animation, user-select, and
  text-overflow properties to their standard equivalents.

Do not perform a broad string replacement. Transform only recognized CSS
tokens, leave strings/comments intact, and add unit tests for false positives.

The v74 tree references these optional but absent stylesheets:

- `/apps/audiosettings/css/audiosettingsApp.css`
- `/apps/tutorial/css/tutorialApp.css`

Return a successful, empty CSS response for those exact paths and record the
request count. Other absent paths remain normal 404 responses.

### Overlay integration resource

`GET /data/integration/developer_mode_GuiConfig.js` returns the corresponding
regular file only when the selected root belongs to a validated overlay
workspace. Otherwise it returns a successful empty JavaScript resource.

Do not follow a symlink for this override. Do not allow arbitrary paths beneath
the emulated data volume to be fetched through this route.

### Test-only fault

When `EMU_FAIL_OVERLAY_APP_SCRIPT=true`, the exact Developer Diagnostics
application-script request returns an HTTP error. Record how many times the
fault was exercised. No other resource may be affected.

The application script is `GET /apps/system/js/developerdiagnosticsApp.js`
(the stock loader requests it relative to the GUI root as
`apps/system/js/developerdiagnosticsApp.js`). When the fault is enabled,
answer it with status 503, a short `text/plain` body, and caching disabled,
whether or not the file exists under the selected root. When the fault is
disabled the path is an ordinary stock file. The CSS file beside it is not
affected.

### Other routes

`GET /favicon.ico` returns an empty successful response. Unrecognized
`/__emu/*` routes return JSON 404 responses rather than stock files.

## Browser compatibility contract

The browser adapter exists only to bridge demonstrated Opera 12.10 versus
standards-browser differences. It must:

- expose the small subset of `window.opera` used by the stock HMI, including
  version reporting, error logging, script-language no-op behavior, and the
  `AfterEvent.load` alias;
- provide standard equivalents for Opera-prefixed style properties;
- map Opera transition/animation completion event names to standard browser
  events;
- expose an `ArrayBuffer.length` getter equivalent to `byteLength`, because the
  stock parser uses the former;
- route stock MMUI, AppSDK, and DBAPI WebSocket URIs to the configured frontend
  ports; and
- where the stock v74 WebSocket class calls firmware-defined global `_isStack`
  and `_delStack` helpers as methods, bind only those existing helpers to that
  prototype.

The adapter must not replace the stock WebSocket parser, commander handler,
menu controller, message queue, context router, or transition state machine.

In proxy mode it must never synthesize service connection success, startup
settings, contexts, focus, transitions, or menu availability.

In mock mode, deterministic localization defaults are North America, `en_US`,
US English keyboard, and 12-hour time. Prefer delivering these through the mock
protocol scenario. If stock v74 exposes no usable protocol path in a modern
browser, a narrowly scoped initialization adapter is permitted only when:

- the limitation is recorded in the implementation notes;
- it sets localization values and invokes the normal stock initialization once;
- it does not create HomeScreen, Applications, focus, or transition messages;
  and
- a test proves that proxy mode contains none of this behavior.

## WebSocket framing contract

The stock protocol can encode a JSON object followed by a one-byte sequence
suffix. Treat the payload as opaque bytes except where the mock scenario engine
must parse a JSON object.

Requirements:

- preserve text versus binary frame type in proxy mode;
- preserve payload bytes exactly in both directions;
- do not normalize, append, remove, or regenerate sequence bytes in proxy mode;
- reject invalid mock JSON without crashing other clients;
- bound diagnostic previews independently of forwarded frames; and
- never log an unbounded frame or arbitrary binary body.

Mock-generated context changes use a monotonically advancing nonzero sequence
value in the one-byte range and include the same value in `contextSeq`.

## Mock backend contract

### Design

The mock backend must be a generic scenario engine driven by reviewed data
files. Do not implement navigation as an event-name switch embedded in the
server entrypoint.

A versioned scenario contains:

- initial service state and localization;
- accepted inbound message shapes;
- state predicates and state transitions;
- ordered outbound messages;
- optional delays bounded by the scenario schema; and
- explicit fault actions such as disconnect, timeout, duplicate, reorder, and
  malformed response.

Reject unknown schema versions, unknown action types, invalid delays, and
messages that exceed configured limits. Scenario data must not contain copied
firmware code or bulk native traces.

### Required default behavior

The default v74 North American scenario must:

- accept all three stock frontend WebSocket connections;
- complete deterministic UI initialization;
- reach an idle `system/HomeScreen` with an empty framework message queue;
- publish availability for the menu applications needed by the stock main menu
  and Applications screen;
- respond to Home, Back, Applications, Entertainment, Communication,
  Navigation, and Settings selections;
- maintain a per-client context stack so Back returns to the preceding context;
- emit context change, focus stack, and transition completion in the order
  expected by the stock state machine; and
- permit the stock commander keyboard path to navigate Home to Applications and
  back without emulator-owned input handlers.

DBAPI and AppSDK may initially be connection-only mocks when the baseline UI
does not require responses. Their accepted messages and missing behaviors must
remain observable in diagnostics.

## Native proxy contract

Proxy mode is transport and narrowly scoped lifecycle bridging, not simulation.

### Fail-closed behavior

- No mock scenario may be loaded.
- No mock response may be emitted.
- A failed guest connection closes the corresponding frontend with an
  unavailable-service status.
- A frontend message may be queued only while its guest connection or required
  MMUI readiness is pending.
- Each connection queue is limited to 256 frames. Overflow closes the frontend
  and records the reason.

### MMUI readiness

The guest opening its forwarded MMUI port is not sufficient. MMUI traffic is
released only after the display-control listener receives the exact
`mmui-ready` notification from the guest startup monitor.

Readiness expires after five seconds without refresh. Losing the active MMUI
guest connection resets readiness. `EMU_MMUI_READINESS_HOLD_MS` delays release
after the marker only for deterministic race testing; it must be a finite,
nonnegative number.

Expiry withholds readiness from new MMUI sessions and clears
`nativeProxyReady`; it does not pause or close a session whose traffic has
already been released. Only losing that session's guest connection ends it.

### Native display lifecycle

The display bridge supplies only the hardware/display edges absent from the
headless guest. It must support this ordered lifecycle:

1. frontend reports `InitializeGuiComplete`;
2. bridge sends `StartIntroAnimation` to stock MMUI;
3. stock MMUI emits the `IntroAnimation` context;
4. guest control channel reports
   `splash-complete surface=TRANLOGO_SURFACE`;
5. bridge sends `FinishIntroAnimation` once;
6. bridge supplies the missing BLM `ShowDisclaimer` response once;
7. stock MMUI emits `Disclaimer`;
8. frontend sends `DisposeIntroVideo`;
9. stock MMUI processes its own timeout and emits `HomeScreen`; and
10. frontend sends `NotifyDisclaimerEnd`.

Duplicate splash completion is idempotent within one guest MMUI connection.
Losing that connection ends the lifecycle: a later splash notification belongs
to the next connection's lifecycle and must not be treated as a duplicate, even
when it arrives before that connection opens. Unsupported control notifications
are recorded as errors and do not produce lifecycle events.

In step 9 the frontend's stock code sends a `Timeout` event to the guest
before `HomeScreen`; the bridge forwards and records it but never generates it.

#### Synthetic lifecycle frames

`StartIntroAnimation`, `FinishIntroAnimation` and `ShowDisclaimer` are ordinary
GUI-to-MMUI event messages, encoded exactly as the stock frontend's own event
sender (`sendEventMsg` in the stock `framework/js/Websockets.js`) encodes an
event. Each is one text frame holding a JSON object with no sequence suffix:

| Member | Value |
|---|---|
| `msgType` | `"event"` |
| `eventId` | the event name |
| `uiaId` | `"system"` |
| `params` | the string `"{}"` (a string, not an object) |
| `fromVui` | `false` |
| `currentUiaId` | `"system"` |
| `currentContextId` | `"IntroAnimation"` (for all three) |

Send them only on the active MMUI guest connection, never to a frontend.
`StartIntroAnimation` is sent at most once per guest connection, after the
frontend's `InitializeGuiComplete` has been forwarded. `FinishIntroAnimation`
is sent once when both the splash notification and that connection are
present, whichever arrives last. `ShowDisclaimer` follows it after about
100 ms, if the connection is still open.

### Display-control channel framing

The guest startup monitor connects from inside QEMU's user network to the
host's `DISPLAY_CONTROL_PORT`. Each TCP connection carries exactly one
notification: ASCII text, normally terminated by one LF, after which the guest
closes its side.

- Read until the peer ends the stream, then trim surrounding whitespace. The
  result is the whole notification; there are no fields beyond its text.
- Bound input to 1024 bytes per connection; destroy a connection that exceeds
  it without producing a notification.
- An empty result is ignored. `mmui-ready` is the readiness marker. The only
  other supported notification is `splash-complete surface=TRANLOGO_SURFACE`;
  any other text is an unsupported notification.
- The harness never writes to this channel.
- The guest repeats `mmui-ready` on a new connection about every two seconds
  while MMUI is up; each repetition refreshes readiness. Splash completion is
  sent once per splash.

## Diagnostic HTTP APIs

All diagnostic responses are JSON, disable caching, and enforce bounded file
and response sizes.

### `GET /__emu/health`

Required top-level fields are:

| Field | Meaning |
|---|---|
| `ok` | Harness process is healthy enough to answer |
| `mode` | `mock` or `proxy` |
| `nativeProxyReady` | All frontend/guest services connected and MMUI ready |
| `rootfs` | Resolved selected root |
| `guiPath` | Resolved stock GUI path |
| `ports` | HTTP, MMUI, DBAPI, and AppSDK frontend ports |
| `overlayWorkspace` | Selected root is a validated overlay workspace |
| `canReplay` | Availability and bounded frame counts |
| `stats` | Mock, HTTP compatibility, client, and message counters |
| `proxy` | Proxy details in proxy mode; otherwise null |

Per-service proxy details must expose connection state, attempt and active
connection counts, text/binary counters in both directions, bounded recent
message metadata, bounded control-message metadata, queue depth, timestamps,
and last error.

MMUI readiness details must expose readiness, notification count, queued early
message count, configured test hold, last marker, and timestamp. Native display
details must expose notification and lifecycle-event counts, the last
notification, and last error.

Message diagnostics may include parsed field summaries and a bounded textual
preview. They must not include complete unbounded messages or binary payloads.

#### Contract field names

The acceptance verifier and the Developer Diagnostics app read the names below,
so they are fixed. Every other name inside `stats` and `proxy` is the
implementer's choice, provided every item listed above is present.

```text
mode, nativeProxyReady, overlayWorkspace       top-level, as in the table
canReplay.available                            boolean
canReplay.frameCount                           total validated frames (0 if none)
stats.httpCompatibility.injectedFailures.overlayAppScript.enabled   boolean
stats.httpCompatibility.injectedFailures.overlayAppScript.requests  integer
proxy.mockFallbackMessages                     always 0 in a correct proxy
proxy.backends.guiifm | .dbapi | .appsdk       one object per service (MMUI,
                                               DBAPI, AppSDK); no other keys
  .status                                      connection state string
  .activeConnections                           integer
  .frontendToGuestMessages, .guestToFrontendMessages              text frames
  .frontendToGuestBinaryMessages, .guestToFrontendBinaryMessages  binary frames
  .lastError                                   string or null
  .controlMessages[]                           oldest first
    .direction   "frontend-to-guest" | "guest-to-frontend" |
                 "native-display-to-guest"
    .summary     null when the frame is not a JSON object; otherwise an
                 object that includes "eventId" and "ctxtId" copied from
                 the message when present
proxy.mmuiReadiness
  .ready, .notifications, .queuedFrontendMessages
  .lastNotification                            last marker text or null
  .lastNotificationAt                          ISO 8601 UTC string or null
proxy.nativeDisplay
  .notifications                               splash/unsupported notifications
                                               (not mmui-ready)
  .startEvents, .finishEvents, .showDisclaimerEvents, .frontendDisposeEvents
  .lastNotification                            string or null
  .lastError                                   string or null; reset to null
                                               when the lifecycle completes
```

`controlMessages` is bounded, but it must retain the whole intro, disclaimer
and Home lifecycle of the current guest connection until Home is reached.
Synthetic `StartIntroAnimation`, `FinishIntroAnimation` and `ShowDisclaimer`
frames are recorded with direction `native-display-to-guest`.

### `GET /__emu/overlay`

Return 404 with `available:false` unless the selected root belongs to a
validated overlay workspace of the supported format.

For a valid workspace, return:

- overlay identifier;
- manager state;
- active transaction or `none`;
- boot-attempt count;
- emulated mount state;
- emulated watchdog state; and
- at most the last 40 nonempty journal lines.

Only regular files of at most 65536 bytes may be read. Missing, oversized,
non-regular, and unreadable files use safe fallback values.

Field names: `available` (true), `overlayId` (`unknown` when the metadata has
none), `managerState`, `activeTransaction`, `bootAttempts`, `mountState`,
`watchdog` (all strings, from the format table above), and `journal` (array of
strings, oldest first). The 404 body is `available:false` plus an `error`
string.

### `GET /__emu/can`

Without replay data, return `available:false`, mode `unavailable`, zero counts,
and an empty frame list.

With replay data, return schema `mazda-cmu-vim-can-v1`, mode `replay`, total,
public, and private counts, and no more than the last 200 validated frames.
Field names are `available`, `mode`, `schema` (replay only), `frameCount`,
`publicFrames`, `privateFrames`, and `frames`; each frame is the validated
JSONL record as accepted, at least `channel`, `idHex`, `length`, and `data`.
`canReplay` in health uses the same `available`, `frameCount`,
`publicFrames`, and `privateFrames` names, without the frame list. The Python
CLI remains the authoritative input validator; the Node process must
still reject a missing, non-regular, oversized, empty, or malformed input.

The first implementation retains these bounds:

- capture file: 16 MiB;
- frames: 100000;
- payload length: 0 through 64 bytes;
- public IDs: `0x100` through `0x17f`, port 1;
- private IDs: `0x180` through `0x1ff`, port 0; and
- ID `0x160` excluded as a readiness notification.

## Reliability and shutdown

- Open listeners transactionally. If any listener fails, close those already
  opened and exit nonzero.
- Handle SIGINT and SIGTERM by closing WebSocket clients and all listeners.
- One malformed request, frame, state file, or control notification must not
  terminate unrelated connections.
- Bound queues, message previews, control input, JSONL input, journal reads, and
  scenario delays.
- Do not expose the harness beyond loopback unless the developer explicitly
  configures another host.
- Log mode, resolved GUI path, and listener addresses without logging firmware
  file contents.

## Required test package

The specification maintainer should give the implementer a sanitized test
package that contains no old harness source or history. It should provide:

- unit tests for configuration, path confinement, CSS token transformation,
  framing, scenario validation, mock state, queue limits, and diagnostic bounds;
- protocol fixtures containing only minimal synthetic messages;
- a command that launches the candidate harness through `emulate.py ui`; and
- the existing headless verifier as an executable black box. The implementer
  need not inspect the verifier's source.

The private integration reviewer supplies the firmware root and QEMU guest.

## Acceptance matrix

Every row is required before cutover:

| Mode | Setup | Required proof |
|---|---|---|
| Static | Candidate source only | Node syntax and unit tests pass |
| Firmware safety | User-supplied root | No file metadata or content beneath root changes |
| Mock baseline | `emulate.py ui` | Idle HomeScreen, three sockets, empty queue, commander navigation, 800x480 screenshot, no runtime errors |
| Overlay app | Installed disposable workspace | Developer Diagnostics opens, reports enabled manager, captures observed GUI input, Back works |
| Optional fault | Overlay workspace plus test fault | One failed optional script request, application removed, no partial instance or queued retry, stock UI recovers |
| CAN replay | Overlay app plus synthetic fixture | Validated public/private frames appear in diagnostics |
| Native proxy | Running verified system guest | All three native services connected, bidirectional MMUI text traffic, no mock fallback, ordered intro/disclaimer/Home lifecycle |
| Startup race | Proxy with readiness hold | At least one early frontend message queues and is released only after explicit guest readiness |
| Failure cases | Mock and proxy | Bad ports, traversal, malformed scenarios, queue overflow, guest loss, and unsupported control messages fail safely |

The existing commands remain the user-facing acceptance interface:

```sh
python3 emulate.py ui
python3 emulate.py verify-ui --expect-mode mock

python3 emulate.py ui --root scratch/overlay-workspace/root
python3 emulate.py verify-ui --expect-overlay-app

python3 emulate.py ui --root scratch/overlay-workspace/root \
  --fail-overlay-app-script
python3 emulate.py verify-ui --expect-overlay-app-fallback

python3 emulate.py ui --root scratch/overlay-workspace/root \
  --can-replay emulation/fixtures/can/public-private-sample.jsonl
python3 emulate.py verify-ui --expect-overlay-app --expect-can-replay

python3 emulate.py system
python3 emulate.py ui --proxy
python3 emulate.py verify-ui --expect-mode proxy
```

The race regression additionally launches proxy mode with
`EMU_MMUI_READINESS_HOLD_MS=3000` and verification with
`EMU_REQUIRE_QUEUED_STARTUP=true`.

## Implementation milestones and estimate

| Milestone | Deliverable | Estimate |
|---|---|---:|
| 0 | Sanitized starter export, frozen specification, provenance record | 0.5–1 day |
| 1 | Contract/unit tests and minimal protocol fixtures | 1–2 days |
| 2 | Read-only HTTP frontend and browser compatibility adapter | 1 day |
| 3 | Versioned scenario engine and default mock behavior | 1–2 days |
| 4 | Strict native proxy, readiness gate, and display bridge | 1–2 days |
| 5 | Overlay, CAN, health, and fault diagnostics | 1 day |
| 6 | Full acceptance matrix, documentation, and cutover patch | 1 day |

Expected implementation effort is 7–10 engineering days. Maintaining strict
role separation and preparing the sanitized test package may add 2–4 person
days, but does not require real CMU hardware.

## Definition of done

The replacement is complete only when:

- it lives entirely under new paths and shares no source with the prohibited
  implementations;
- the implementer provides the provenance confirmation and license declaration;
- all acceptance-matrix rows pass from a fresh clone;
- the selected firmware root is proven unchanged;
- the old harness files are deleted from the current tree;
- `emulate.py ui` and `npm` entrypoints select only the new implementation;
- documentation no longer recommends preserving or modernizing the old
  implementation; and
- the integration reviewer approves the result before the public-history rewrite.
