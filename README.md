<h1 align="center">Keet Channel 1.0</h1>

<p align="center">
  <img alt="status: not working with official Keet client" src="https://img.shields.io/badge/STATUS-1.0%20%C2%B7%20NOT%20WORKING%20WITH%20OFFICIAL%20KEET-red?style=for-the-badge">
</p>

> [!NOTE]
> Version 1.0 adds images, runtime ACL management, delivery updates, and a bounded
> 5-second shutdown. Protocol version is `1.1.0`. Text-only peers keep working;
> media is exchanged only with peers that understand the version-2 message body.
> The closed Keet app chat schema is still out of scope — see
> [docs/protocol-compatibility.md](docs/protocol-compatibility.md).
>
> **Cannot connect to the official Keet client:** Keet is closed-source and uses a different set of HyperDHT bootstrap nodes than the defaults used by this bridge. As a result, peers from this plugin and the official Keet desktop app cannot discover each other over the DHT, so live pairing with the official client is not possible. The bridge implementation itself is correct, but it cannot fulfill its stated goal of connecting to the official Keet messenger.

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
                                      ├── media store (atomic inbox, 10 MiB images)
                                      ├── delivery tracker (bounded update timers)
                                      └── Hyperswarm 4.17.2 (DHT + replication)
```

Text and images (PNG, JPEG, WebP, GIF up to 10 MiB decoded) share the same
encrypted Autobase room.

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
restart. The ACL can be changed while the bridge is running:

```text
acl_add     {identity, request_id}
acl_remove  {identity, request_id}
acl_list    {request_id}
```

`allowed.json` version 2 stores `{version, identities, revoked}`. A revoked
identity stays revoked even if it is listed in `KEET_ALLOWED_USERS`; re-adding it
through `acl_add` clears the revocation. Persistence happens atomically before
the in-memory policy changes, so a failed write leaves the old policy in place.
`KEET_ALLOW_ALL_USERS=true` is a development-only override that logs a warning
and is never persisted.

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
| `KEET_MEDIA_MAX_FILES` | Inbound inbox retention, file count | `512` |
| `KEET_MEDIA_MAX_AGE_MS` | Inbound inbox retention, age | 7 days |
| `KEET_DELIVERY_TTL_MS` | Queued-delivery update TTL | `60000` |
| `KEET_DELIVERY_MAX_PENDING` | Maximum tracked queued sends | `1024` |
| `KEET_NODE_PATH` | Explicit Node.js binary | `node` on `PATH` |

Inbound images are written to `<KEET_DATA_DIR>/media/inbox` with `0700`
directory and `0600` file permissions. The bridge accepts at most 10 MiB of
decoded image data and caps one stdio line at 21 MiB to cover Base64 overhead.
At most two media transfers run concurrently.

## Protocol

The adapter and bridge speak one JSON object per line. Every request carries a
unique `request_id`, and every terminal response echoes it exactly once.

Supported commands:

```text
send_message   send_image      status          get_identity
create_invite  join_invite     accept_pairing  decline_pairing
cancel_invite  pairing_list    acl_add         acl_remove
acl_list       join_room       connect_to_user send_welcome
shutdown
```

`send_image` takes `{mime_type, base64_data, caption?}`. MIME type is verified
against magic bytes, Base64 must be canonical, and the decoded size is capped at
10 MiB. `send_file`, `send_attachment`, `send_voice`, `send_video`, and
`send_animation` remain typed `unsupported_command` errors.

`send_message`, `send_welcome`, and `send_image` acknowledge only after the local
Autobase append is durable. With no connected peer the result has `queued: true`
and `replicated_peers: 0`; the entry replicates when a peer connects. For such
sends the bridge emits one terminal `delivery_update` (`replicated` or `expired`).
Replication means a peer was observed after the append — it is **not** a read
receipt. Full request, response, event, error, and readiness schemas are in
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
later connects can start a fresh bridge. `disconnect()` sends `shutdown` and
waits up to 5 seconds for the process to exit, then escalates to `terminate` and
finally `kill`; it suppresses restarts and fails any pending requests.

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
openspec validate production-ready-v1 --strict

# Live interop test (requires live Keet 4.24.0 client + human; not part of npm test)
# See docs/live-testing.md; writes live-test-report.json beside the data dir
node scripts/live-test.js --pairing-timeout 120 --cleanup-data

# Short soak smoke; see docs/soak-test.md for the 48-hour run
node scripts/soak.js --duration 10 --interval 1 --cleanup-data
```

Bridge tests use a loopback DHT and never contact a public network or live Keet
client. The live test (`scripts/live-test.js` / `docs/live-testing.md`) is the
only operator-facing automation that contacts a real Keet client; it is not
included in `npm test`, CI, or `soak.js`.

## Breaking changes from 0.1

- Invites are persistent `keet://chat/...` links created at startup; the old
  ephemeral invite flow is gone.
- `KEET_HOME_CHANNEL` is now the stable room key, not a discovery key.
- `KEET_INVITE_URL`, stderr scraping, the WebSocket/port-5335 transport, and the
  Pear runtime path were removed.
- Images are supported in 1.0; files, voice, video, and animations stay
  unsupported instead of failing silently.
- Access is denied by default; unset `KEET_ALLOWED_USERS` no longer means
  allow-all.

## More documentation

- [docs/protocol.md](docs/protocol.md) — stdio protocol and bridge environment
- [docs/protocol-compatibility.md](docs/protocol-compatibility.md) — Keet 4.24.0 baseline
- [docs/data-directory.md](docs/data-directory.md) — storage, backup, restart
- [docs/access-control.md](docs/access-control.md) — allowlist and pairing
- [docs/soak-test.md](docs/soak-test.md) — 48-hour resource soak
- [SPEC.md](SPEC.md) — implementation specification
