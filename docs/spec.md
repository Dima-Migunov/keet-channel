# Technical Specification: Keet Channel Plugin for Hermes Agent

Version 1.0.0 | Protocol version 1.1.0 | Author: migunov

## 1. Overview

Keet Channel (`keet-channel`) is a Hermes Agent platform adapter for the Keet
P2P messenger. The adapter (`adapter.py`) spawns a local Node.js bridge
(`bridge/index.js`) and exchanges newline-delimited JSON over stdio. The bridge
owns the persistent Keet identity, the Autobase room, invitations, pairing, and
P2P replication; the adapter owns the Hermes platform contract, request
correlation, supervision, and access policy.

There is no HTTP or WebSocket service, no port 5335, and no Pear/Bare runtime
requirement. Node.js **>= 24** is required.

## 2. Architecture

```text
Hermes gateway
   │
   ▼
adapter.py  ── stdin/stdout JSON lines ──▶  bridge/index.js
                                              │
                                              ├── lib/identity.js  keet-identity-key
                                              ├── lib/room.js      Autobase + Corestore
                                              ├── lib/pairing.js   blind-pairing
                                              ├── lib/messages.js  compact-encoding + Ed25519
                                              ├── lib/media.js     10 MiB images + inbox
                                              ├── lib/delivery.js  bounded delivery updates
                                              ├── lib/invite.js    keet://chat/<z32>
                                              └── lib/stdio.js     command router
```

| Component | Path | Description |
| --- | --- | --- |
| Plugin manifest | `plugin.yaml` | Hermes metadata, version 1.0.0 |
| Python adapter | `adapter.py` | Process lifecycle, protocol, ACL, cron |
| Bridge entrypoint | `bridge/index.js` | Startup ordering, media ownership, shutdown |
| Bridge modules | `bridge/lib/*.js` | Identity, room, pairing, messages, media, delivery, invite, stdio |
| Soak runner | `scripts/soak.js` | 48-hour RSS, fd, queue, media, inbox sampling |
| Bridge tests | `bridge/test/*.test.js` | `node:test` suites, loopback DHT only |
| Adapter tests | `tests/test_adapter.py` | `pytest` + `pytest-asyncio` |
| Protocol | `docs/protocol.md` | Exact command/response/event schemas |

Startup order in the bridge is: identity → media store → Corestore → room → swarm →
pairing listener → first invite → exactly one `welcome_room_ready` event. No protocol
output is emitted before readiness, and all diagnostics go to stderr. The
adapter validates the readiness identity, room key, protocol version, and home
channel before it reports the connection as ready.

## 3. Functional Requirements

### 3.1 Bridge detection and startup

- The adapter locates `bridge/` relative to `adapter.py`; the user does not
  specify a bridge path.
- The bridge is started as `node <plugin>/bridge/index.js` (or the binary from
  `KEET_NODE_PATH`).
- On `connect()`, missing bridge dependencies are installed with `npm install`
  before spawning. Setup runs under the lifecycle lock with a five-minute bound,
  and concurrent connects share one setup attempt.
- `check_requirements()` verifies the Node.js major version is at least 24 and
  that bridge dependencies are present. Pear is not checked or required.

### 3.2 Identity and persistence

- One data directory per bridge: `KEET_DATA_DIR`, default `~/.keet-channel`.
- On first start, `keet-identity-key` generates a BIP-39 mnemonic and derives
  the identity; later starts load the same identity.
- `room.json` persists the room key, encryption key, and local writer key.
- `allowed.json` v2 (`{version, identities, revoked}`) persists accepted and
  revoked identities and is overridable with `KEET_ACL_FILE`.
- Inbound images live in `media/inbox/` (`0700`, files `0600`); writes use a
  `.tmp-*` file, `fsync`, and `rename`, and temp files are removed at startup
  and shutdown.
- Directory mode is `0700`; secret files are `0600`; writes are atomic.
- A restart with the same data directory restores identity, room key, invite,
  allowlist, and message history. Only one bridge may open a directory at a
  time.

### 3.3 Message send and receive

- Incoming room messages are decoded, signature-checked, deduplicated by
  `messageId`, and delivered to the adapter as `message` events.
- The adapter emits a Hermes `MessageEvent` only for identities allowed by its
  policy.
- `send_message`, `send_welcome`, and `send_image` append a signed entry to the
  local Autobase and acknowledge only after the durable append.
- With no connected peer, the result is a successful queued send:
  `queued: true`, `replicated_peers: 0`. The entry replicates when a peer
  connects; there is no separate retry queue. Each queued send emits exactly one
  terminal `delivery_update` (`replicated` or `expired`).
- Maximum text length is **4096 UTF-8 bytes**.
- Images: PNG, JPEG, WebP, or GIF, at most **10 MiB** decoded. MIME is detected
  from magic bytes, Base64 must be canonical, and size/SHA-256 are verified.
  Inbound files are persisted atomically before the message enters the view.
  One stdio line is capped at **21 MiB** and at most two media transfers run at
  once.
- Message format is plain text plus an optional single image; markdown is not
  rendered and other attachments are unsupported.

### 3.4 Invitations and pairing

- The bridge creates one `keet://chat/<z32>` invite at startup and exposes it in
  readiness and `status`.
- The invite preserves the standard `blind-pairing-core` flags, ORs in the Keet
  `0x60` bits, and appends `[148, encryptionKey]`;
  `KEET_INVITE_FORMAT=standard` disables the extension for diagnosis.
- Candidates pair through `BlindPairing` with `userData` containing identity key,
  writer key, and optional display name.
- The member validates the request, adds the candidate writer to the Autobase,
  and confirms with the room and encryption keys.
- Unknown candidates stay pending until `accept_pairing` or `decline_pairing`.
  Pending requests expire after `KEET_PAIRING_TIMEOUT_MS` (default 5 minutes) or
  with the invite, and are not durable across restarts. The incoming request
  queue is bounded at 128 entries; the oldest is evicted and the event is logged
  with the `keet_pairing_request` tag.
- Allowlisted identities and `KEET_ALLOW_ALL_USERS=true` are confirmed
  automatically; allow-all logs a warning and is never persisted.
- Creating a new invite replaces the previous active invite.

### 3.5 Access control

- **Default deny.** With neither an allowlist nor allow-all configured, incoming
  messages are dropped and a startup warning names the variables to set.
- `KEET_ALLOWED_USERS` is a comma-separated list of 64-hex identity keys.
  Entries are trimmed and lowercased; invalid entries are logged and skipped.
- Accepted pairing identities are persisted to `allowed.json` and enforced by
  both the bridge and adapter after restart.
- `acl_add`, `acl_remove`, and `acl_list` manage the ACL at runtime. Mutations
  are serialized, persisted atomically before memory changes, and reported back
  to the adapter. Revocation overrides `KEET_ALLOWED_USERS`; re-adding an
  identity clears its revocation.
- `KEET_ALLOW_ALL_USERS` is true only for the literal `true`; it is a
  development-only override with no persistence.
- Room membership and `member_joined` events never authorize an identity.
- Self-messages are filtered by the readiness identity, not by a connection id.
- The legacy connection-scoped pubkey fallback is removed.

### 3.6 Cron and notifications

- `KEET_HOME_CHANNEL` is the stable 64-hex room key, not an invite URL or
  discovery key.
- Cron delivery starts the bridge, waits for readiness, sends, awaits the
  correlated result, and disconnects in `finally`.
- A missing or unknown home channel returns a configuration error and never
  reports success.
- Cron reports the real `queued` / `replicated_peers` outcome of the send.

### 3.7 Bridge lifecycle and supervision

- The adapter monitors the bridge process and correlates every request by
  `request_id` with a pending-future map and timeout.
- On unexpected exit, pending requests fail with a disconnect error and the
  adapter restarts the bridge with delays `1, 2, 4, 8, 16, 30` seconds (capped
  at 30, reset after 60 seconds of stable readiness).
- `disconnect()` sends `shutdown`, waits up to 5 seconds for process exit, then
  escalates to `terminate` and `kill`, is idempotent, and suppresses restart.
  Pending requests are failed and futures cleared.
- The bridge `shutdown` handler is idempotent: it flushes room storage, clears
  delivery timers, removes media temp files, closes media, pairing, room,
  swarm/DHT, and Corestore, flushes the terminal response, and exits 0 within
  5 seconds. `SIGINT` and `SIGTERM` take the same path; a second signal during
  shutdown is a no-op, and a hung close still exits via the deadline.

## 4. Protocol Summary

One JSON object per line. `stdin` carries commands; `stdout` carries events and
exactly one terminal response per command; `stderr` is diagnostics only. Every
request carries a `request_id`, echoed on its terminal response.

Supported commands:

```text
send_message   send_image      send_welcome    status
get_identity   create_invite   join_invite     accept_pairing
decline_pairing cancel_invite   pairing_list    acl_add
acl_remove     acl_list        join_room       connect_to_user
shutdown
```

`send_image` accepts `{mime_type, base64_data, caption?}`. `send_file`,
`send_attachment`, `send_voice`, `send_video`, and `send_animation` return a
typed `unsupported_command` error without touching the room. Any other unknown
command uses the same code. Readiness is a single
`welcome_room_ready` event containing `protocol_version`, `identity`,
`room_key`, `invite_url`, `started_at`, and `started_at_ms`.

Full field-level schemas, error codes, and event definitions are in
[docs/protocol.md](protocol.md).

## 5. Non-Functional Requirements

| Requirement | Value |
| --- | --- |
| Hermes compatibility | Any installation method |
| Node.js | >= 24 |
| Python | >= 3.9 |
| Linux dependency | `libatomic1` may be needed by `sodium-native` |
| Transport | stdio, newline-delimited JSON |
| Protocol version | 1.1.0 |
| Max message length | 4096 UTF-8 bytes |
| Message format | Plain text, optional single PNG/JPEG/WebP/GIF image |
| Max decoded image | 10 MiB |
| Max stdio line | 21 MiB |
| Media concurrency | 2 |
| Inbox retention | 512 files / 7 days |
| Shutdown deadline | 5 seconds, exit 0 |
| Bridge tests | `cd bridge && npm test` |
| Adapter tests | `python -m pytest tests/ -q` |
| PII safety | Identity keys are public; mnemonic never logged |

## 6. Configuration

### Required environment variables

None. The plugin starts without mandatory configuration, but access is denied by
default until an allowlist is set or a pairing request is accepted.

### Optional environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `KEET_DATA_DIR` | Identity, room, allowlist, Corestore | `~/.keet-channel` |
| `KEET_ALLOWED_USERS` | Comma-separated 64-hex identity keys | unset (deny) |
| `KEET_ALLOW_ALL_USERS` | Development override, literal `true` only | unset |
| `KEET_ACL_FILE` | Persisted allowlist path | `<data>/allowed.json` |
| `KEET_HOME_CHANNEL` | Stable 64-hex room key for cron | unset |
| `KEET_HOME_CHANNEL_NAME` | Human label for the home channel | unset |
| `KEET_DHT_BOOTSTRAP` | Comma-separated `host:port` DHT nodes | public DHT |
| `KEET_INVITE_FORMAT` | `keet` or `standard` | `keet` |
| `KEET_PAIRING_TIMEOUT_MS` | Pending pairing lifetime | 5 minutes |
| `KEET_MEDIA_MAX_FILES` | Inbox file-count retention | `512` |
| `KEET_MEDIA_MAX_AGE_MS` | Inbox age retention | 7 days |
| `KEET_DELIVERY_TTL_MS` | Queued-delivery update TTL | `60000` |
| `KEET_DELIVERY_MAX_PENDING` | Tracked queued sends | `1024` |
| `KEET_NODE_PATH` | Explicit Node.js binary | `node` from `PATH` |

## 7. Installation

```bash
npm install
# or
bash scripts/setup.sh

hermes plugins enable keet-channel
hermes gateway restart
```

The first start creates the identity, room, and one invite in
`KEET_DATA_DIR`. Authorize contacts with `KEET_ALLOWED_USERS` or by accepting a
pairing request. See [README.md](../README.md),
[docs/access-control.md](access-control.md), and
[docs/data-directory.md](data-directory.md).

## 8. Unsupported Surface

- App-level wire compatibility with the closed Keet chat schema.
- Files, attachments, voice, video, and animations (images are supported).
- Multi-device identity attestation, key rotation, and account recovery.
- Group administration, moderation, and a pairing UI.
- WebSocket transport, port 5335, and the Pear/Bare runtime.
- Legacy ephemeral invites and discovery-key `KEET_HOME_CHANNEL` values.

The compatibility boundary and its verification status are recorded in
[docs/protocol-compatibility.md](protocol-compatibility.md).

## 9. Verification

```bash
cd bridge && npm test
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q
openspec validate production-ready-v1 --strict
node scripts/soak.js --duration 10 --interval 1 --cleanup-data
```

Bridge tests use a loopback DHT; neither suite requires a public network or a
live Keet client. The manual two-host Keet 4.24.0 checklist is tracked as task
12.5 and marked pending until executed. The 48-hour resource soak and its
thresholds are documented in [docs/soak-test.md](soak-test.md).

## 10. Roadmap

| Phase | Status | Description |
| --- | --- | --- |
| Phase 1 | ✅ | Research: Keet, Hypercore/Hyperswarm, blind-pairing |
| Phase 2 | ✅ | Bridge and adapter at 1.0.0, protocol 1.1.0 |
| Phase 3 | ⬜ | Manual integration test with live Keet 4.24.0 |
| Phase 4 | ✅ | Documentation, CI, and OpenSpec change |
