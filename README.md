<h1 align="center">🚧&nbsp; WORK IN PROGRESS &nbsp;🚧</h1>

<p align="center">
  <img alt="status: alpha — not production ready" src="https://img.shields.io/badge/STATUS-ALPHA%20%C2%B7%20NOT%20PRODUCTION--READY-orange?style=for-the-badge">
</p>

> [!CAUTION]
> **This project is under active development and is not ready for production use.**
>
> Interfaces, configuration, the wire protocol, and on-disk data formats may change
> without notice and without migration paths. Use it for evaluation, experiments, and
> development only — do not rely on it for real traffic or important data yet.

---

# Keet Channel for Hermes Agent

A Hermes Agent platform plugin for the [Keet](https://keet.io) P2P messenger. The
Python adapter spawns a Node.js bridge and exchanges newline-delimited JSON over
stdio:

```text
Hermes gateway
   │
   ▼
adapter.py  ──stdin/stdout JSON──▶  bridge/index.js
                                      │
                                      ├── blind-pairing 2.3.1 (invites, member/candidate)
                                      ├── Autobase 7.28.2 + Corestore 7.15.0 (room)
                                      └── Hyperswarm 4.17.2 (DHT + replication)
```

The bridge runs as a plain **Node.js** process. Pear/Bare is not used and is not
required.

## Requirements

- Node.js **>= 24** and npm
- Python 3.9+ for the adapter
- Linux may need `libatomic1` for `sodium-native`

## Install

```bash
npm install                 # root postinstall also installs bridge/node_modules
# or
bash scripts/setup.sh       # checks Node >= 24, installs deps, verifies the bridge
```

Enable the plugin:

```bash
hermes plugins enable keet-channel
hermes gateway restart
```

The bridge creates or reopens a persistent identity and room in
`KEET_DATA_DIR` (default `~/.keet-channel`). The first start also creates one
`keet://chat/...` invite.

## Access is denied by default

No identity can talk to the agent until it is authorized. Authorize contacts by
allowlist or by accepting their pairing request:

```bash
# Comma-separated 64-hex Keet identity public keys
export KEET_ALLOWED_USERS="<64-hex-identity>,<64-hex-identity>"
```

Pairing acceptance writes the candidate's stable identity to
`<KEET_DATA_DIR>/allowed.json`; both the bridge and the adapter enforce it after a
restart. `KEET_ALLOW_ALL_USERS=true` is a development-only override that logs a
warning and is never persisted.

See [docs/access-control.md](docs/access-control.md) for the full policy and
[docs/data-directory.md](docs/data-directory.md) for identity/room storage and
backup.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `KEET_DATA_DIR` | Identity, room, allowlist, Corestore | `~/.keet-channel` |
| `KEET_ALLOWED_USERS` | Comma-separated 64-hex identity keys; invalid entries are logged and skipped | unset (deny) |
| `KEET_ALLOW_ALL_USERS` | Development override; literal `true` only | unset |
| `KEET_ACL_FILE` | Persisted allowlist path | `<KEET_DATA_DIR>/allowed.json` |
| `KEET_HOME_CHANNEL` | Stable room key for cron/notifications (64 hex) | unset |
| `KEET_DHT_BOOTSTRAP` | Comma-separated `host:port` DHT bootstrap nodes | public DHT |
| `KEET_INVITE_FORMAT` | `keet` (`keet://chat/...`) or `standard` | `keet` |
| `KEET_PAIRING_TIMEOUT_MS` | Pending pairing request lifetime | 5 minutes |
| `KEET_NODE_PATH` | Explicit Node.js binary | `node` on `PATH` |

## Protocol

The adapter and bridge speak one JSON object per line. Every request carries a
unique `request_id`, and every terminal response echoes it exactly once.

Supported commands:

```text
send_message   status          get_identity   create_invite
join_invite    accept_pairing  decline_pairing cancel_invite
pairing_list   join_room       connect_to_user send_welcome
shutdown
```

`send_image`, `send_file`, `send_attachment`, `send_voice`, and `send_video`
return a typed `unsupported_command` error. **Attachments are not implemented**;
only text messages are supported.

`send_message` and `send_welcome` acknowledge only after the local Autobase append
is durable. With no connected peer the result has `queued: true` and
`replicated_peers: 0`; the entry replicates when a peer connects. Full request,
response, event, error, and readiness schemas are in
[docs/protocol.md](docs/protocol.md).

## Cron and standalone delivery

Set the home channel to the persisted **room key**, not an invite URL:

```bash
export KEET_HOME_CHANNEL="<64-hex-room-key>"
```

The standalone sender starts the bridge, waits for `welcome_room_ready`, sends,
awaits the correlated result, and disconnects in `finally`. A missing or unknown
home channel is a configuration error and is never reported as success.

## Restart and supervision

The adapter monitors the bridge. On an unexpected exit it marks itself
disconnected, fails pending requests, and restarts with backoff
`1, 2, 4, 8, 16, 30` seconds (capped at 30). A failed spawn, readiness timeout,
or startup exit also schedules the next attempt instead of ending supervision.
Backoff resets after 60 seconds of stable readiness. `connect()` and
`disconnect()` are serialized; a disconnect during startup aborts the start and
later connects can start a fresh bridge. `disconnect()` sends `shutdown`, waits
up to 15 seconds, force-kills if necessary, and suppresses restarts.

The same data directory restores the identity, room key, allowlist, and history.
Only one bridge may open a data directory at a time.

## Tests

```bash
# Bridge: identity, invite, message codec, pairing, room replication, stdio, lifecycle
cd bridge && npm test

# Adapter: protocol correlation, readiness, supervision, access control
python -m pip install -r requirements-dev.txt
python -m pytest tests/ -q

# OpenSpec change validation
openspec validate make-keet-channel-interoperable --strict
```

Bridge tests use a loopback DHT and never contact a public network or live Keet
client.

## Breaking changes from 0.1

- Invites are persistent `keet://chat/...` links created at startup; the old
  ephemeral invite flow is gone.
- `KEET_HOME_CHANNEL` is now the stable room key, not a discovery key.
- `KEET_INVITE_URL`, stderr scraping, the WebSocket/port-5335 transport, and the
  Pear runtime path were removed.
- Image sending is reported as unsupported instead of silently succeeding.
- Access is denied by default; unset `KEET_ALLOWED_USERS` no longer means
  allow-all.

## More documentation

- [docs/protocol.md](docs/protocol.md) — stdio protocol and bridge environment
- [docs/protocol-compatibility.md](docs/protocol-compatibility.md) — Keet 4.24.0 baseline
- [docs/data-directory.md](docs/data-directory.md) — storage, backup, restart
- [docs/access-control.md](docs/access-control.md) — allowlist and pairing
- [SPEC.md](SPEC.md) — implementation specification
