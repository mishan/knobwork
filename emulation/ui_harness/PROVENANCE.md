# Independent implementation provenance

The implementer must complete this file before handoff.

## Implementer

- Name: Claude Code (model `claude-opus-5-5`), operated by the repository owner
- Contact: repository owner
- Implementation start date: 2026-11-26
- Implementation completion date: 2026-11-27 for this workspace; the native
  proxy and startup-race rows await the integration reviewer
- Commit range: commits after `f113646e52e042b512b347a5f886adb715deb74a` on branch `independent-ui-harness`

## Specification

- Specification SHA-256 as originally handed off:
  `c0515f532d0195cd817e73a58a3f381bec59db55eec34e502d6991be848992b6`
- Intermediate revision (overlay, fault, framing, and field-name
  clarifications, 2026-11-26):
  `ec29ca6118808d557036bf64ac4fe3a13f7fd4428ec38b993121f3fe55471516`
- Revision adding "Synthetic lifecycle frames":
  `be7ff1600ee548460260e32e2a3476e0bce2b1899e1b61d8fdbad903c969121f`
- Current revision (after the integration review: readiness expiry, splash
  after guest loss, index path normalization):
  `8f9f19e1b585ea1c93dbacb2aedd3af70d1d10e1d7decdbebf2f5a49ed2347b2`
- Sanitized export root commit: `f113646e52e042b512b347a5f886adb715deb74a`

## Independence declaration

Confirm each statement by replacing `[ ]` with `[x]`:

- [x] I did not inspect the previous private `boot.js` or `server.js`.
- [x] I did not inspect their Git history, deleted copies, diffs, or patches.
- [x] I did not inspect `checksummaster/mazda_emulation` or a derivative.
- [x] I did not search sibling workspace directories for harness source.
- [x] I implemented from the specification, permitted synthetic fixtures,
      official platform documentation, and observable firmware/service behavior.
- [x] I did not copy firmware content, stock UI assets, vendor binaries, or
      vehicle captures into this repository.
- [x] I kept the selected firmware tree read-only.

Note on the black-box verifier: an early batch `cat` of the export's files
included `contract/verify_ui.js`. The tool spilled that output to a file, and
only the first lines of `README.md` were shown. The spilled output was never
opened. The verifier's source was not read or used, and it has only been run
as a black box (one run with no server, to confirm it executes).

## Permitted materials actually consulted

| Date | Material | Purpose |
|---|---|---|
| 2026-11-26 | Specification revisions `c0515f53...`, `ec29ca61...`, and `be7ff160...` | Normative behavior |
| 2026-11-27 | Specification revision `8f9f19e1...`; integration review of `913db9b` (expected vs observed results only) | Defects to fix and clarified behavior |
| 2026-11-27 | Specification revision `005a3f77...` (maintainer, after acceptance of `c77689b`): traversal wording aligned with RFC 3986 dot-segment removal | Record only; no code change |
| 2026-11-26 | `emulate.py`, `emulation/can_replay.py`, its test, README/AGENTS/manifest files | CLI boundary, CAN bounds |
| 2026-11-26 | `emulation/fixtures/can/public-private-sample.jsonl` | CAN replay tests |
| 2026-11-26 | User-supplied root `cmu150_NA_74.00.324A_update/root` (v74.00.324A NA), read-only | Interface observation only, see below |
| 2026-11-26 | Received: disposable overlay workspace `scratch/overlay-workspace` (format 2, overlay `developer-diagnostics-example-v7`, `usb/` bundle omitted), git-ignored, read-only | Overlay, optional-fault, and CAN acceptance rows only |
| 2026-11-26 | `python3 emulate.py verify-ui` (black box; first with no server, then for the acceptance rows) | Acceptance results |
| 2026-11-26 | Node.js `http`, `net`, `fs`, and `node:test` documentation; `ws` 8 API; RFC 6455 close codes | Platform behavior |

Interface facts observed in the user-supplied firmware GUI, recorded in my own
words. No code was copied.

- The stock GUI derives its WebSocket host from the page URL and uses ports
  2700, 2766, and 2800 with the three subprotocols in the specification.
- On MMUI, `ctxtChg`, `focusStack`, and `transition` frames carry one trailing
  sequence character. The client releases them in that order when they share
  a sequence value. The client reads the payload length through
  `ArrayBuffer.length`.
- Before `Global.InitGui`, the client delivers only `msg` frames whose `uiaId`
  is `syssettings`. The settings app sets localization from the `Region`,
  `LanguageSupported`, `KeyboardLanguage`, `TimeFormat`, `Temperature`,
  `Distance`, and `VehicleType` messages. Once all of them are set, the
  framework sends `Global.InitGui` on its own. So a protocol path exists, and
  no initialization adapter is used.
- Outbound GUI events use the `{msgType:"event", eventId, uiaId, params, ...}`
  shape. Main-menu selections send `Select*` events, Back sends
  `Global.GoBack`, Home sends `Global.IntentHome`, and menu availability uses
  `StatusMenu {appName, appStatus}`.
- Opera-specific usage: `window.opera.version()`, the `OTransitionEnd` and
  `oTransitionEnd` listeners, and the `style.OTransform`/`OTransition`
  properties.

The default scenario contains only the identifiers and field names needed to
drive these interfaces. It contains no firmware code or traces.

## Design record

- **Architecture:** one Node process, composed in `lib/harness.js`. The
  modules are config, rootfs confinement, HTTP, CSS, frames, scenario,
  frontends, proxy, readiness, display, overlay, and CAN. Mock and proxy are
  built from separate objects; in proxy mode no scenario object exists.
- **HTTP:** a plain `http` server with an exact route table. Index injection
  and CSS translation happen in memory with `no-store`. Path confinement
  decodes once and rejects NUL, backslash, and `..` segments. It then resolves
  the real path and requires it to stay under the real GUI directory. The file
  is then opened once, non-blocking, and checked again through the open
  descriptor (`/proc/self/fd`), so a file swapped for a symlink in between
  cannot be read; all reads come from that descriptor and responses are
  chunked. Routes match the percent-decoded path. Directory requests return
  404.
- **Access:** every HTTP request and WebSocket handshake must name an allowed
  Host; WebSocket handshakes must also carry no Origin or the harness page's
  own origin. Each WebSocket service accepts at most 32 sessions and the
  display-control port at most 16 connections.
- **CSS:** a single-pass scanner that copies comments, strings, and unquoted
  `url()` bodies verbatim. It rewrites only whole identifier and at-keyword
  tokens that are in a fixed allow-list. A legacy `-o-linear-gradient`
  direction (`top`, `left`, ...; an angle) is converted to the standard
  syntax (`to bottom`, ...; `90deg` minus the angle), since the v74 stock CSS
  uses the legacy side keywords.
- **Scenario format:** see `emulation/ui_harness/README.md`.
  - Version 1, first-match rules, a small predicate language, and explicit
    fault actions.
  - Delayed output waits in one queue per session, ordered by due time and
    served by a single timer on the monotonic clock, so output order never
    depends on timer order.
  - Each session is limited to 256 pending outputs and a context stack depth
    of 64. `duplicate` and `reorder` cannot nest.
  - Mock sequence values run from 1 through 127 so the suffix stays one byte
    in a UTF-8 text frame.
- **Proxy:**
  - `ws` with `skipUTF8Validation` on both sides, so text frames that carry a
    non-UTF-8 sequence byte are forwarded unchanged.
  - The MMUI guest connection opens only after readiness has been released;
    until then frontend frames queue, up to 256 frames and 16 MiB.
  - Overflow closes the frontend with 1008. A failed or lost guest connection
    closes it with 1013 (Try Again Later).
  - Forwarding applies backpressure: reading from one side pauses while the
    other side has more than 4 MiB buffered.
  - A newer MMUI frontend replaces the active one (1001). Readiness is reset
    only when the active guest connection is lost unexpectedly.
- **Display lifecycle:** observed and bridged as in steps 1-10 of the
  specification. The synthetic frames follow "Synthetic lifecycle frames":
  - stock event encoding, with `params` as the string `"{}"` and
    `currentUiaId`/`currentContextId` set to `system`/`IntroAnimation`;
  - no sequence suffix, and sent only on the active MMUI guest connection;
  - `StartIntroAnimation` at most once per guest connection, after
    `InitializeGuiComplete` has been forwarded;
  - `FinishIntroAnimation` once both a pending splash notification and a
    guest connection are present, whichever arrives last;
  - `ShowDisclaimer` 100 ms later, dropped if that connection has closed or
    been replaced in the meantime.

  A repeated splash on the same connection does nothing.
- **Clarifications received:**
  - revision `ec29ca61...`: overlay workspace format 2, the Developer
    Diagnostics script path and its 503 fault, display-control framing, the
    `Timeout` event in step 9, and the contract field names;
  - revision `be7ff160...`: the wire form and timing of the synthetic lifecycle
    frames. This replaced my earlier interpretation, which had empty
    `currentUiaId`/`currentContextId`, an object for `params`, and Finish
    waiting for the `IntroAnimation` context;
  - revision `8f9f19e1...`: readiness expiry does not pause a released
    session; losing the guest MMUI connection ends its lifecycle, so a later
    splash (even one arriving before the next connection opens) finishes the
    next connection; and every request path that normalizes to `/index.html`
    gets the injection. Request paths now have dot segments removed as in
    RFC 3986, clamped at the root, before routing and confinement.

## Deviations and limitations

- **Additions beyond the specification:**
  - `EMU_SCENARIO` selects another mock scenario file.
  - Proxy mode serves one MMUI frontend at a time; the newest replaces the
    active one, so a reload works.
  - WebSocket handshakes without the service subprotocol are refused.
  - Host and Origin allowlist (403), 32 sessions per WebSocket service, 16
    display-control connections, mock frames limited to the scenario's
    `maxInboundBytes`, and a warning when HOST is not loopback.
  - Proxy backpressure, and a 16 MiB byte bound on the early queue in
    addition to the 256-frame limit.
  - Only MMUI pins control messages until HomeScreen; DBAPI and AppSDK keep
    the most recent 200.

  These were decided by the repository owner on 2026-11-26 and 2026-11-27
  (see `emulation/ui_harness/DESIGN.md`).
- **Open questions for the specification maintainer:**
  - `PROXY_MODE=1` selects proxy mode and values other than `true`, `false`,
    `1`, `0` are startup errors. The specification names only `true`.
- **Symlink swaps on non-Linux hosts:** stock files are checked through the
  open descriptor's path in `/proc/self/fd`. Where that is unavailable (for
  example macOS), the path check before opening is the only guard, and a
  file swapped for a symlink in between could still be read.
- **Ephemeral ports on the implementation host:** its
  `net.ipv4.ip_local_port_range` is 1024-65535, so loopback connections made
  by the test suite can take the harness's default ports as source ports.
  Until those connections leave TIME-WAIT (about a minute), the harness
  cannot bind its defaults there and exits as designed. Run `verify-ui`
  after outbound connections to those ports have cleared, or narrow the
  range.
- **Mock Navigation and Settings targets:** they map to `emnavi/NaviLoading`
  and `syssettings/DevicesTab`. The specification does not name destination
  contexts. Both were checked in Chromium on 2026-11-26: each renders its stock
  template, reaches idle with an empty queue, and Back returns to HomeScreen.
- **`window.opera` "script-language":** the specification does not name a
  method, and the v74 GUI calls only `version()`. No-op stubs are provided for
  `setOverrideHistoryNavigationMode`, `defineMagicVariable`, and
  `defineMagicFunction`.
- **Not yet run:** the native-proxy and startup-race acceptance rows. They
  need the QEMU guest (`emulate.py system`), which is not part of this export.
  The integration reviewer will run them and rerun the overlay rows.
- **Not applicable in this export:** deleting the old harness files and
  switching over the private repository.

## Verification

- Node 24.22.3:
  - `npm test` passes 99 tests: unit, scenario, lifecycle bridge,
    integration, property (P1-P6, seeded), and abuse tests, against synthetic
    roots and fake guest WebSocket and control services. Eight parallel runs
    of the suite pass.
  - `npm run check` passes.
  - Every test added during hardening was shown to fail against the code
    before its fix, or against a deliberate break of the behavior it covers.
- Node 14.16.1: `main.js` starts all listeners on the v74 root, and the index,
  a stock stylesheet, and `/__emu/health` return 200.
- Mutation testing (Stryker 10, per module group, at commit `97c21d6`):
  1537 of 1839 mutants killed (1232 of 1959 before hardening). Each of the
  302 survivors was classified as non-contract diagnostics, an equivalent
  mutant, a structural guarantee no test can stage, or a boundary the
  specification leaves loose.
- Reviews: two fresh-context correctness reviews (the second not shown the
  first) and a fresh-context security review. Their defects were fixed with
  tests; their remaining points are recorded above.
- Mock baseline (Node 24.22.3, Chromium from Debian): `python3 emulate.py
  verify-ui --expect-mode mock` exits 0 with `ok: true`. It reports an idle
  `system/HomeScreen`, one socket each for MMUI, AppSDK, and DBAPI, an empty
  queue, an 800x480 screenshot, and the stack helpers bound.
- Commander keyboard path (scratch CDP driver, stock keys only): Navigation,
  Settings, and Applications each open, and Back returns to HomeScreen. No
  runtime exceptions.
- `shotbox` 0.12.0 (pip) screenshot of HomeScreen inside a sealed session
  matches the verifier's screenshot.
- Integration review of `913db9b` (2026-11-27): every acceptance row passed
  against the real firmware, overlay workspace, and QEMU guest, with the
  firmware unchanged. Its two blocking defects (a client that reset after a
  refused WebSocket upgrade crashed the harness; a splash after guest loss
  was ignored) were fixed with tests shown to fail first. The crash test runs
  the harness as its own process, since the failure is that process exiting.
- The mock, overlay, optional-fault, and CAN rows below were rerun on
  2026-11-27 after those fixes, with the same results.
- Overlay app (`ui --root scratch/overlay-workspace/root`,
  `verify-ui --expect-overlay-app`): exit 0, `ok: true`. Developer Diagnostics
  is listed and opened, reports manager state `enabled`, and captures stock
  MMUI input. Back leaves the framework idle at HomeScreen with an empty queue.
- Optional fault (`--fail-overlay-app-script`,
  `--expect-overlay-app-fallback`): exit 0, `ok: true`.
  - The script load is classified as an optional failure, and the
    application is not installed.
  - The UI returns to an idle HomeScreen with an empty queue.
  - Harness health afterwards shows
    `injectedFailures.overlayAppScript = {enabled: true, requests: 1}`
    (exactly one request, no retry).
- CAN replay (`--can-replay emulation/fixtures/can/public-private-sample.jsonl`,
  `--expect-overlay-app --expect-can-replay`): exit 0, `ok: true`. Developer
  Diagnostics shows 4 captured CAN frames (2 public, 2 private).
- Firmware safety: metadata listings (path, size, mtime, mode, type) were taken
  before any harness run and compared after all runs. Both are identical: the
  10101 entries under the v74 root and the 10170 entries under the overlay
  workspace. Content hashes were not computed.

## License declaration

The repository owner licenses this harness under the MIT License; see
[`LICENSE`](LICENSE). It applies to `emulation/ui_harness/` only. The rest of
the repository keeps its own license declarations.
