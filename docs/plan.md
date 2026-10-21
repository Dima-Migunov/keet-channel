# Plan: Keet Channel for Hermes Agent

## Context

**Keet** is a P2P messenger built on Hypercore, Hyperswarm, and HyperDHT. It has
no public bot API or HTTP gateway: all communication is peer-to-peer.

**Hermes Agent** exposes a gateway plugin architecture. The adapter lives in the
plugin directory and is enabled with `hermes plugins enable keet-channel`.

The plugin uses only open Holepunch primitives — `keet-identity-key`,
`blind-pairing`, `blind-pairing-core`, `hyperswarm`, `corestore`, and
`autobase`. Keet's closed application-level chat schema is explicitly out of
scope, so the bridge implements its own signed room log rather than claiming
wire compatibility with the official app.

## Architecture

```text
┌─────────────────────┐   stdio JSON     ┌──────────────────────────┐
│  Hermes gateway     │ ◄──────────────► │  Keet bridge             │
│  adapter.py         │  one object/line │  bridge/index.js         │
└─────────────────────┘                  │  (plain Node.js >= 24)   │
                                          │                          │
                                          │  identity  (persistent)  │
                                          │  Autobase room           │
                                          │  blind-pairing           │
                                          │  Hyperswarm replication  │
                                          └────────────┬─────────────┘
                                                       │ P2P
                                          ┌────────────▼─────────────┐
                                          │  Keet client / peer      │
                                          └──────────────────────────┘
```

Two components:

1. **Keet bridge** (`bridge/`) — Node.js process owning identity, room,
   pairing, invites, and replication.
2. **Hermes plugin** (`adapter.py`, `plugin.yaml`) — Python platform adapter,
   process supervision, ACL, and cron delivery.

The bridge is not a Pear terminal app and does not listen on a WebSocket port.
It communicates with the adapter exclusively over stdin/stdout.

## Bridge

### Modules

| Module | Responsibility |
| --- | --- |
| `bridge/index.js` | Lifecycle: identity → Corestore → room → pairing → swarm → readiness |
| `bridge/lib/identity.js` | `keet-identity-key` mnemonic load/generate, atomic writes, permissions |
| `bridge/lib/room.js` | Encrypted Autobase, `messages`/`members` views, append, replication |
| `bridge/lib/pairing.js` | `BlindPairing` member/candidate, pending requests, allowlist |
| `bridge/lib/messages.js` | `compact-encoding` codecs, canonical Ed25519 signing, dedupe |
| `bridge/lib/invite.js` | Keet invite envelope encode/decode, `keet://chat/<z32>` |
| `bridge/lib/stdio.js` | Command router, `request_id` correlation, typed errors |

### Responsibilities

- Load or create one persistent identity per data directory.
- Open one encrypted Autobase room at the persisted room key.
- Create one `keet://chat/...` invite at startup and expose it through the
  protocol.
- Accept candidate pairing requests, validate `userData`, add the writer, and
  confirm or deny.
- Replicate the room over Hyperswarm and report peer counts truthfully.
- Keep stdout protocol-only; send all diagnostics to stderr.
- Shut down cleanly on `shutdown`, `SIGINT`, and `SIGTERM`.

### Invite format

The default invite wraps a standard `blind-pairing-core` invite: flags are
preserved and OR'd with `0x60`, then a 33-byte `[148, encryptionKey]` extension
is appended and the buffer is z32-encoded as `keet://chat/<z32>`.
`KEET_INVITE_FORMAT=standard` emits the unmodified invite for diagnosis. Only
one invite is active at a time; creating a new one replaces it.

### Room and messages

Autobase nodes are `register`, `add-writer`, and `message`. A message carries a
version, room key, random `messageId`, sender identity, millisecond timestamp,
UTF-8 text up to 4096 bytes, and a detached Ed25519 signature over the canonical
fields. The apply function accepts a message only when the writer is mapped to
the same identity in `members`; malformed entries are logged and skipped.

Sends are acknowledged after the durable local append. Zero connected peers
yields `queued: true` with `replicated_peers: 0`; the entry replicates later.
There is no retry queue.

## Hermes Plugin

```text
plugin.yaml       # name: keet-channel, version 0.4.0
__init__.py       # register(ctx)
adapter.py        # KeetAdapter(BasePlatformAdapter)
```

Adapter responsibilities:

- Locate and spawn the bridge, installing missing npm dependencies.
- Wait for `welcome_room_ready`; never report connected before it.
- Correlate requests by `request_id` with a pending-future map and timeout.
- Dispatch messages, pairing events, invite events, and member events.
- Supervise the process: fail pending requests on exit and restart with
  backoff `1, 2, 4, 8, 16, 30` seconds, reset after 60 seconds stable.
- Apply default-deny access policy from `KEET_ALLOWED_USERS` and
  `allowed.json`; filter self-messages by the readiness identity.
- Return `unsupported_command` for `send_image` and other attachments without
  calling the bridge.
- Provide standalone/cron delivery through the same durable send path.

## Data Directory

```text
<KEET_DATA_DIR or ~/.keet-channel>/
  identity.json   # mnemonic/seed, never logged (0600)
  room.json       # room key, encryption key, writer key (0600)
  allowed.json    # accepted identities
  corestore/      # Hypercore/Autobase storage
```

The directory is `0700`; writes are atomic. The same directory restores
identity, room key, invite, allowlist, and history after restart. Only one
bridge may open it at a time.

## Phases

### Phase 1: Research — complete

- Read the Keet/Holepunch open modules and the legacy bridge.
- Identify `blind-pairing`, `blind-pairing-core`, `keet-identity-key`,
  `autobase`, `corestore`, and `hyperswarm` as the supported surface.
- Record that the official app-level chat schema is closed and unsupported.
- Write the protocol compatibility baseline in
  `docs/protocol-compatibility.md`.

### Phase 2: Bridge — complete

- Persistent identity and data directory with permissions and atomic writes.
- Encrypted Autobase room with `messages` and `members` views.
- Versioned message codec, canonical signatures, validation, dedupe.
- Keet invite envelope with standard-format debugging switch.
- Blind-pairing member/candidate flows, pending requests, allowlist
  auto-confirm.
- Hyperswarm replication on the room discovery key.
- Correlated stdio router, truthful status, single readiness event, shutdown.
- `node:test` suites for identity, invite, messages, room, pairing, stdio, and
  the spawned bridge.

### Phase 3: Hermes plugin — complete

- `plugin.yaml`, `__init__.py`, `adapter.py`.
- Readiness handshake, correlated requests, event dispatch.
- Send path with durable/queued results; attachments rejected as unsupported.
- Supervision, bounded restart, idempotent disconnect.
- Default-deny ACL, allowlist persistence, self-message filtering.
- Standalone/cron send with a stable room-key home channel.
- Python contract tests covering protocol, readiness, supervision, ACL, and
  standalone delivery.

### Phase 4: Live integration — pending

- Execute the two-host checklist against Keet 4.24.0: display the invite, pair
  a candidate, exchange messages, test denial and expiry.
- Record the tested client build and result in
  `docs/protocol-compatibility.md`, or leave the check marked pending without
  changing the automated result.

### Phase 5: Documentation and CI — complete

- README, SPEC, `docs/spec.md`, `docs/plan.md`, `docs/protocol.md`,
  `docs/access-control.md`, `docs/data-directory.md`, and `AGENTS.md` describe
  the stdio/Autobase architecture.
- `scripts/setup.sh` requires Node >= 24, installs dependencies, and has no
  Pear prompt.
- CI installs root and bridge dependencies and runs both test suites.
- OpenSpec change `make-keet-channel-interoperable` validates strictly.

## Breaking Changes from 0.1

- Transport is stdio only; the WebSocket listener on port 5335 is gone.
- The bridge runs under Node.js; Pear/Bare is no longer a runtime path.
- Invites are persistent `keet://chat/...` links created at startup.
- `KEET_HOME_CHANNEL` is a stable room key, not a discovery key.
- `KEET_INVITE_URL` and stderr scraping are removed.
- Access is denied by default; unset `KEET_ALLOWED_USERS` no longer means
  allow-all.
- Images and attachments return `unsupported_command` instead of appearing to
  succeed.

## Risks

| Risk | Mitigation |
| --- | --- |
| Keet app-level schema is closed | Target only verified open primitives; document the boundary |
| Invite flags/extension are inferred | Keep the standard prefix decodable; `KEET_INVITE_FORMAT=standard`; record uncertainty |
| DHT/NAT prevents connectivity | Hyperswarm holepunching, `KEET_DHT_BOOTSTRAP`, DHT diagnostics in `status`, manual two-host check |
| Mnemonic at rest is sensitive | `0700`/`0600`, atomic writes, never log the mnemonic |
| Autobase writer/indexer bugs | Add writer before confirmation, validate `base.writable`, explicit `not_writable` error |
| No live client in CI | Loopback tests as CI gate; live checklist as release gate |
| Breaking change for existing users | Ship adapter and bridge together at 0.4.0; document new invite and home channel |

## Verification

```bash
npm ci
cd bridge && npm ci && npm test
cd ..
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q
openspec validate make-keet-channel-interoperable --strict
```

The bridge suite uses a loopback DHT and never contacts a public network or a
live Keet client.
