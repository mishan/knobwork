# Independent browser harness

Entrypoint: `main.js`. Normative contract:
[`docs/browser-harness-independent-spec.md`](../../docs/browser-harness-independent-spec.md).

```sh
python3 emulate.py ui --root /path/to/extracted/root          # mock
python3 emulate.py ui --root /path/to/root --proxy            # native proxy
npm test                                                      # Node >= 18
npm run check        # syntax, plain-ASCII source, every test file under Stryker
npm run test:stress  # the suite six times in parallel (STRESS_RUNS=n)
npm run mutate       # Stryker on every module group; reports in $TMPDIR/stryker
```

The runtime works on Node 14 or later. The tests use `node:test`, so they need
Node 18 or later.

## Modules

| Path | Responsibility |
|---|---|
| `lib/config.js` | Environment parsing, port validation, duplicate-port rejection, exposure warning |
| `lib/access.js` | Host and Origin allowlist for HTTP and WebSocket requests |
| `lib/rootfs.js` | Root validation, request-path confinement, descriptor-checked opens, no-follow small-file reads, overlay workspace detection |
| `lib/http.js` | Read-only HTTP frontend, index injection, CSS translation, fault injection, diagnostic routes |
| `lib/css.js` | Single-pass, token-aware `-o-` translation |
| `lib/frames.js` | Opaque-payload helpers: bounded previews, sequence-suffix parsing for diagnostics and the mock |
| `lib/scenario.js` | Versioned scenario schema validation and per-client engine |
| `lib/frontends.js` | WebSocket listeners for MMUI, DBAPI, and AppSDK; mock attachment |
| `lib/proxy.js` | Fail-closed byte-exact proxy, bounded early queue, backpressure, newest-wins MMUI, per-backend diagnostics |
| `lib/readiness.js` | `mmui-ready` gate: 5 s expiry, reset on unexpected guest loss, test hold |
| `lib/display.js` | Display-control TCP listener and intro/disclaimer lifecycle bridge |
| `lib/overlay.js` | `/__emu/overlay` (format 2) |
| `lib/can.js` | Receive-only CAN replay validation and `/__emu/can` |
| `lib/harness.js` | Composition, transactional listener startup, health, shutdown |
| `public/compat.js` | Browser adapter served at `/__emu/compat.js` |
| `scenarios/v74-na-default.json` | Default synthetic mock scenario |

Mock and proxy are built from separate code paths. In proxy mode no scenario
is loaded and the mock attachment is never reached. `DESIGN.md` records the
state model, the test map, the invariants, and the decisions made where the
specification is silent.

## Access

Every listener binds to `HOST` (default `127.0.0.1`). HTTP requests and
WebSocket handshakes must name an allowed `Host` (`localhost`, a loopback
address, the configured `HOST`, or any IP literal when `HOST` is a wildcard),
and WebSocket handshakes must carry no `Origin` or the harness page's own
origin; anything else gets 403. A non-loopback `HOST` logs a warning naming
what becomes reachable. Each WebSocket service accepts at most 32 sessions and
the display-control port at most 16 connections.

## Scenario format (version 1)

```json
{
  "schema": "mazda-cmu-ui-scenario",
  "version": 1,
  "name": "...",
  "limits": { "maxDelayMs": 2000, "maxInboundBytes": 65536,
              "maxOutboundBytes": 65536, "maxActionsPerMessage": 64 },
  "initialState": { "...": "..." },
  "contexts": { "Name": { "uiaId": "...", "ctxtId": "...", "focus": ["..."], "params": {} } },
  "services": {
    "mmui":   { "onConnect": [], "rules": [] },
    "dbapi":  { "onConnect": [], "rules": [] },
    "appsdk": { "onConnect": [], "rules": [] }
  }
}
```

- **Rule:** `{ "id", "match": { "dotted.path": scalar }, "when"?: predicate, "actions": [...] }`.
  The first matching rule wins. Inbound messages that match no rule are
  counted and listed in health diagnostics.
- **Predicates:** `contextIs`, `contextIsNot`, `stackDepthAtLeast`,
  `stateEquals {path, value}`, `all`, `any`, `not`.
- **Actions:** each action may take an optional `delayMs`, from 0 through
  `limits.maxDelayMs` (the schema maximum is 10000).
  - `send {message, sequence?: none|current|next}`
  - `pushContext {context}`, `popContext`, `resetContext {context}`
  - `setState {path, value}`
  - Faults: `disconnect {code?, reason?}`, `timeout`, `duplicate {action}`,
    `reorder {actions}`, `malformed {text}`. The actions inside `duplicate`
    and `reorder` must produce frames now: no `disconnect`, `timeout`,
    `duplicate`, `reorder`, or `delayMs` inside them.
- **Placeholders:** a value `{"$state": "dotted.path"}` is replaced with the
  current state value.
- **Context frames:** a context change emits `ctxtChg`, `focusStack`, and
  `transition {enabled:false}` in that order. All three carry the same
  sequence suffix byte, and `contextSeq` equals that byte. The value advances
  from 1 through 127 and then wraps, so the suffix stays one byte in a UTF-8
  text frame.

Unknown versions, action types, predicate keys, services, contexts, and
out-of-range delays or limits are rejected at load time.
