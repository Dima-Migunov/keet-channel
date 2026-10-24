# AGENTS.md

Hermes Agent platform plugin (`keet-channel`) for the Keet P2P messenger. A Python
adapter spawns a Node.js bridge and exchanges newline-delimited JSON over stdio:

```text
Hermes gateway -> adapter.py -> node bridge/index.js -> Hyperswarm / Autobase
```

The bridge runs as a plain **Node.js >= 24** process. Pear/Bare is not used and is not
required. There is no WebSocket listener, no HTTP server, and no port 5335.

## Entrypoints and layout

- `adapter.py` — the plugin. `register(ctx)` is the Hermes entrypoint.
  `KeetAdapter.connect()` installs missing npm dependencies, spawns the bridge, and waits
  up to its readiness timeout for `welcome_room_ready`. Connect and disconnect are
  serialized by a lifecycle lock; one supervisor task owns process exit detection and
  bounded restarts. It also owns request correlation, the ACL, and standalone/cron
  delivery.
- `bridge/index.js` — the bridge orchestrator (`KeetBridge`). Startup order is identity →
  media store → Corestore → room → swarm → pairing → first invite → exactly one readiness
  event. It owns the shutdown deadline and the bridge-owned media store.
- `bridge/lib/identity.js` — `keet-identity-key` mnemonic load/generate, data-directory
  layout, atomic writes, file permissions.
- `bridge/lib/room.js` — encrypted Autobase over Corestore, `messages`/`members` views,
  writer membership, durable append, queued count, Hyperswarm replication.
- `bridge/lib/pairing.js` — `BlindPairing` member and candidate flows, pending requests,
  allowlist auto-confirm, invite cancellation.
- `bridge/lib/messages.js` — versioned `compact-encoding` message codecs, canonical
  Ed25519 signing/verification, validation, deduplication.
- `bridge/lib/media.js` — magic-byte MIME detection, strict Base64, 10 MiB limit,
  SHA-256 verification, atomic inbox writes, temp cleanup, retention pruning.
- `bridge/lib/delivery.js` — bounded `delivery_update` tracker for `queued: true`
  sends, one terminal `replicated`/`expired` record, timers cleared on close.
- `bridge/lib/keys.js`, `bridge/lib/errors.js` — shared key normalization and the
  protocol error class factory used by room, pairing, messages, and invite.
- `bridge/lib/invite.js` — Keet invite envelope encode/decode, `keet://chat/<z32>`.
- `bridge/lib/stdio.js` — command router: one JSON object per line, `request_id`
  correlation, exactly one terminal response, typed errors, bounded stderr diagnostics,
  and one ordered output writer that honors stream backpressure.
  It is the only `lib/` module imported directly by `index.js`.
- `plugin.yaml` — Hermes manifest (`name: keet-channel`, version 1.0.0, protocol 1.1.0).
  `__init__.py` re-exports `register`.
- `bridge/test/*.test.js` — bridge suite (identity, invite, messages, room, pairing,
  media, delivery, stdio, lifecycle, spawned bridge, smoke).
- `scripts/soak.js` — 48-hour resource runner; see `docs/soak-test.md`.
- `scripts/live-test.js` / `docs/live-testing.md` — live Keet interop test; not
  part of `npm test`; requires live client + human operator.
- `tests/test_adapter.py` — the only Python tests; they never start Node or the bridge.

## Commands

```bash
# All deps: root postinstall runs `cd bridge && npm install`
npm install

# Setup checks Node >= 24, installs deps, verifies the bridge (no Pear prompt)
bash scripts/setup.sh

# Bridge only
cd bridge && npm install
cd bridge && npm test          # node --test test/*.test.js

# Run the bridge manually (invite URL goes to stderr, JSON protocol to stdout)
node bridge/index.js

# Python tests
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q
python -m pytest tests/test_adapter.py::TestWelcomeOnFirstContact -q

# OpenSpec change validation
openspec validate production-ready-v1 --strict

# Short soak smoke (48 h run documented in docs/soak-test.md)
node scripts/soak.js --duration 10 --interval 1 --cleanup-data

# Live interop test (requires live Keet 4.24.0 client; not CI)
node scripts/live-test.js --pairing-timeout 120 --cleanup-data
```

There is no build step, linter, formatter, or typecheck config in this repo. Do not
invent commands for them.

## Hard constraints

- **stdout is reserved for the JSON protocol.** One JSON object per line. All bridge
  diagnostics must use `console.error` (stderr); a stray `console.log` corrupts the
  stream. The adapter never parses stderr as control data.
- **Buffers are bounded.** The adapter event queue holds at most 1024 events (oldest
  dropped, rate-limit logged), the welcome registry at most 4096 identities, and pairing
  history at most 200 terminal outcomes. The bridge output writer caps buffered bytes at
  8 MiB and honors `drain` instead of dropping or reordering events. Incoming pairing
  requests queue at most 128 entries (oldest evicted, tagged `keet_pairing_request`),
  delivery tracking at most 1024 records, media concurrency at 2, and the inbox at 512
  files / 7 days. One stdio line is capped at 21 MiB; decoded images at 10 MiB.
- **The protocol is correlated.** Every request has a non-empty string or finite numeric
  `request_id`; every terminal response echoes it exactly once. Unsupported operations
  return `{type:"error", code:"unsupported_command"}` — never `unknown_command`.
- **Readiness is emitted exactly once**, after identity, Corestore, room, swarm, pairing
  listener, and the first invite are ready. The adapter must not set `_connected` before
  it. Readiness carries `protocol_version` (`1.1.0`), `identity`, `room_key`,
  `invite_url`, `started_at`, `started_at_ms`.
- **Text and images are supported.** `send_image` accepts PNG/JPEG/WebP/GIF up to 10 MiB
  decoded, validates magic bytes, canonical Base64, and SHA-256, and persists inbound media
  atomically in `<KEET_DATA_DIR>/media/inbox`. `send_file`, `send_attachment`,
  `send_voice`, `send_video`, and `send_animation` return typed `unsupported_command`
  without touching the room.
- **One active invite.** Blind-pairing allows one active member per discovery key, so
  creating an invite replaces the previous one. The startup invite is included in
  readiness and `status`; it is never scraped from stderr.
- **Access is denied by default.** `KEET_ALLOWED_USERS` is a comma-separated list of
  64-hex identity keys. `KEET_ALLOW_ALL_USERS=true` is a development-only override that
  logs a warning and is never persisted. Room membership and `member_joined` do not
  authorize. Accepted pairing identities persist to `allowed.json` v2
  (`{version, identities, revoked}`). `acl_add`/`acl_remove`/`acl_list` mutate the ACL at
  runtime; mutations are serialized and persisted atomically before memory changes.
  Revocation overrides `KEET_ALLOWED_USERS`; re-adding clears it.
- **`KEET_HOME_CHANNEL` is a stable 64-hex room key**, not an invite URL and not a
  discovery key. A missing or unknown value is a configuration error, never a success.
- **One identity and one room per data directory.** `KEET_DATA_DIR` defaults to
  `~/.keet-channel`; `identity.json`, `room.json`, `allowed.json`, `media/inbox/`, and
  `corestore/` live there. Only one bridge may open a directory at a time.
- **The bridge must run under Node.js, not Pear/Bare.** `adapter.py` checks the Node major
  version is at least 24 and that bridge dependencies exist. `check_requirements()` does
  not require Pear. `KEET_USE_PEAR` has been removed.
- **`send_message`, `send_welcome`, and `send_image` acknowledge a durable local append.**
  With no peer connected they return `queued: true`, `replicated_peers: 0`; the entry
  replicates later. There is no retry queue. Each `queued: true` send produces exactly one
  terminal `delivery_update` (`replicated` or `expired`, TTL default 60 s); it is not a
  read receipt.
- **Shutdown is bounded and idempotent.** Flush the room, clear delivery timers, close
  media (removing `.tmp-*`), pairing, swarm/DHT, and identity, flush the terminal response,
  and exit 0 within 5 seconds. A SIGTERM during shutdown is a no-op; a hung close still
  exits via the process deadline.
- App-level compatibility with the closed Keet chat schema is not claimed. Only the invite
  envelope, blind-pairing handshake, identity, and our Autobase room are targeted.

## Testing notes

- Python tests add the repo root to `sys.path` and import `adapter.py` directly. Because
  the Hermes `gateway` package is absent, `adapter.py`'s `try/except ImportError` fallback
  provides local record classes. Keep that fallback so the suite runs standalone.
- Async tests use `@pytest.mark.asyncio` and require `pytest-asyncio`. Install
  `requirements-dev.txt` (`pytest==9.1.1`, `pytest-asyncio==1.4.0`) before running.
- Bridge tests use a loopback DHT and temporary data directories; they must not contact a
  public DHT or a live Keet client. `bridge/test/bridge.test.js` spawns the real bridge.
- Tests do not exercise a live Keet client. The manual two-host checklist is tracked as
  task 12.5 and recorded in `docs/protocol-compatibility.md`; keep it marked pending until
  it is actually executed.
- The live interop script (`scripts/live-test.js`, `docs/live-testing.md`) requires a
  live Keet 4.24.0 client and a human operator; it is not part of `npm test` or CI.
  It writes `live-test-report.json` beside the data directory on every exit.

## Environment

Node.js >= 24 and npm; Linux may need `libatomic1` for `sodium-native`. Python needs 3.9+
(built-in generics). Optional vars: `KEET_DATA_DIR`, `KEET_ALLOWED_USERS`,
`KEET_ALLOW_ALL_USERS`, `KEET_ACL_FILE`, `KEET_HOME_CHANNEL`, `KEET_HOME_CHANNEL_NAME`,
`KEET_DHT_BOOTSTRAP`, `KEET_INVITE_FORMAT`, `KEET_PAIRING_TIMEOUT_MS`,
`KEET_MEDIA_MAX_FILES`, `KEET_MEDIA_MAX_AGE_MS`, `KEET_DELIVERY_TTL_MS`,
`KEET_DELIVERY_MAX_PENDING`, `KEET_NODE_PATH`.

## Documentation

`README.md`, `SPEC.md`, `docs/spec.md`, `docs/plan.md`, and `docs/protocol.md` describe
the current stdio/Autobase architecture. `docs/access-control.md` covers the allowlist and
pairing policy; `docs/data-directory.md` covers storage, backup, and restart;
`docs/protocol-compatibility.md` records the Keet 4.24.0 baseline and verified/unverified
surface; `docs/soak-test.md` records resource-soak results. If you change the
architecture, update these together so they do not drift.
