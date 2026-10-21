# Keet Bridge Protocol Specification v1.0

## Overview

Keet uses Hypercore/Hyperswarm for P2P communication. This document
describes the protocol used by the Keet Bridge Daemon to participate in
the Keet P2P network and exchange messages.

## Identity

Keet uses BIP-48 (SLIP-48) hierarchical deterministic key derivation
with BIP-39 mnemonics.

- **Type**: `5338` (KEET_TYPE constant)
- **Identity key**: `m/48'/5338'/0'/0'`
- **Discovery key**: `m/48'/5338'/0'/1'`
- **Encryption**: SLIP-21 symmetric keys derived from the identity

```javascript
// From keet-identity-key
const identityPath = [48, 5338, 0, 0, 0]    // SLIP-48 wallet
const discoveryPath = [48, 5338, 0, 0, 1]
const encryptionPath = ['SLIP-0021', 'keet-identity-key', <hex>, 'encryption key']
```

## P2P Network

### Discovery (HyperDHT)
- Peers are identified by their public key (Ed25519)
- HyperDHT maps public keys to IP:port for NAT traversal
- Supports hole-punching for direct connections

### Swarm (Hyperswarm)
- Hyperswarm groups peers by topic (a discovery key derived from a room key)
- `topic = crypto.discoveryKey(roomKey)`
- Swarm maintains connections to all peers sharing the same topic
- Automatic reconnection on disconnect

## Autobase Room

Each bridge instance owns one room stored in a Corestore at
`<dataDir>/corestore`. The room is an Autobase opened with the persisted room
key and encryption key; it is not a bare Hypercore.

```text
room key        Autobase key; identifies the room (32 bytes, hex in room.json)
encryption key  Autobase encryption key (32 bytes, hex in room.json)
writer key      local writer Hypercore key for this bridge (32 bytes, hex in room.json)
discovery key   crypto.discoveryKey(roomKey); the Hyperswarm topic
```

The Autobase exposes two views:

| view | storage | contents |
| --- | --- | --- |
| `messages` | append-only Hypercore | encoded message bodies (see below) |
| `members` | append-only Hypercore | writer-to-identity member records |

### Room nodes

Every block appended to the Autobase is a node encoded with
`compact-encoding`:

| field | encoding | notes |
| --- | --- | --- |
| `version` | uint | `1` |
| `type` | uint | `1` register, `2` add-writer, `3` message |

`register` and `add-writer` nodes continue with `writerKey` (fixed 32 bytes),
`identityKey` (fixed 32 bytes), and a length-prefixed UTF-8 `displayName` of at
most 256 bytes. A `message` node carries one length-prefixed message body.

The sender of a `register` node must be the writer it registers. An
`add-writer` node is honored only when its sender is already a mapped member;
applying it calls `host.addWriter(writerKey, { indexer: true })` and records the
writer-to-identity mapping in the `members` view.

### Message fields

A message body is encoded with `compact-encoding` and followed by a detached
64-byte Ed25519 signature over the canonical body encoding:

| field | encoding | notes |
| --- | --- | --- |
| `version` | uint | `1` |
| `roomKey` | fixed 32 bytes | must equal the room key |
| `messageId` | fixed 32 bytes | random per message; the duplicate key |
| `sender` | fixed 32 bytes | Ed25519 identity public key |
| `timestamp` | uint | milliseconds since the Unix epoch |
| `text` | uint length + UTF-8 bytes | at most 4096 UTF-8 bytes |

Decoding rejects truncated bodies, trailing bytes, a wrong room key, invalid
UTF-8, oversized text, and a signature that does not verify against `sender`.
A message is applied only when its writer has a member record and the recorded
identity equals the message `sender`; otherwise it is discarded and logged.
Malformed nodes and malformed message bodies are likewise discarded during
apply and never crash the room.

### Duplicate handling

Message ids are deduplicated with a bounded FIFO that remembers the most recent
10,000 ids. A duplicate message block is still appended to the `messages` view,
but the room emits its `message` event only once.

### Zero-peer queue semantics

`send` always appends the message to the local Autobase first. Its
acknowledgement is:

| field | meaning |
| --- | --- |
| `messageId` | 32-byte id, hex encoded |
| `roomKey` | room key, hex encoded |
| `timestamp` | message timestamp in milliseconds |
| `replicatedPeers` | connected peers at acknowledgement time |
| `queued` | `true` when `replicatedPeers` is `0` |

`queued: true` means no peer was connected when the message was acknowledged;
the append is already durable and will replicate when a peer connects. There is
no separate retry queue.

`status().queuedMessages` counts local appends whose message id is not yet
visible in the linearized view (for example, while a writer is pending).
`flush()` waits until the local Autobase has updated; after it resolves, the
queued count is `0` and the message is included in `status().messageCount`.


## Pairing and authorization

Pairing uses `blind-pairing` over the bridge's Hyperswarm instance. The bridge is
the member (invite owner) for its own room and can also act as a candidate when
an operator asks it to join someone else's invite. There is no UI: approvals
arrive through the adapter commands below.

### Member flow

1. `create_invite` creates a `keet://chat/...` invite for the room and starts a
   `blind-pairing` member listener.
2. A candidate connects and submits `userData` containing its identity key, its
   writer key, and an optional display name.
3. The bridge opens the request with the invite public key, validates the user
   data, and then either confirms it immediately or queues it as pending.
4. Confirming first appends an `add-writer` node for the candidate writer, then
   returns the room key and encryption key to the candidate. The candidate is
   writable only after it replicates that node.
5. Declining, invite expiry, pending timeout, or `cancel_invite` denies the
   request; the candidate receives no room key.

An identity is confirmed immediately when it is in the persisted allowlist
(`allowed.json`, overridable with `KEET_ACL_FILE`) or in
`KEET_ALLOWED_USERS`. `KEET_ALLOW_ALL_USERS=true` also confirms immediately and
logs a warning, but never persists the identity. Every other candidate stays
pending until the owner accepts it.

### Pending requests

Pending requests are held in memory with a temporary `request_id`, the candidate
identity, writer key, display name, creation time, and expiry. They expire after
`KEET_PAIRING_TIMEOUT_MS` (default 5 minutes) or when the invite expires,
whichever comes first. `pairing_list` returns pending and resolved records so an
adapter can recover the list of requests that are still actionable after a
restart; unresolved pending requests themselves are not durable and are denied
when the bridge restarts. Accepting a request writes the candidate identity to
the allowlist.

Resolved records are kept in memory for inspection through `pairing_list`. Only
the 200 most recent terminal outcomes (accepted, declined, expired, or
cancelled) are retained; the oldest record is evicted when the limit is reached.
Eviction affects the resolved history only: pending requests and `allowed.json`
are untouched.

### Commands

| command | fields | result |
| --- | --- | --- |
| `create_invite` | optional `expires` (epoch milliseconds) | `invitation_id`, `invite_url`, `room_key`, `expires`, `format` |
| `join_invite` | `invite_url`, `writer_key`, optional `display_name` | `invitation_id`, `room_key`, `writer_key` |
| `accept_pairing` | `pairing_request_id` | resolved pairing record with `status: "accepted"` |
| `decline_pairing` | `pairing_request_id` | resolved pairing record with `status: "declined"` |
| `cancel_invite` | optional `invitation_id`; all invites when omitted | `cancelled` count |
| `pairing_list` | none | `{ requests: [...] }` with pending and resolved records |

### Events

Every event is one JSON object on stdout.

| event | fields |
| --- | --- |
| `invite_created` | `invitation_id`, `invite_url`, `room_key`, `expires`, `format` |
| `invite_cancelled` | `invitation_id`, `reason` |
| `pairing_request` | `request_id`, `invitation_id`, `identity`, `writer_key`, `display_name`, `created_at`, `expires_at` |
| `pairing_confirmed` | `request_id`, `identity`, `writer_key`, `display_name`, `reason`, `persisted`, `accepted_at` |
| `pairing_declined` | `request_id`, `identity`, `reason` |
| `pairing_expired` | `request_id`, `identity`, `reason` |
| `pairing_rejected` | `reason`, `message` (invalid or unreadable candidate user data) |

`reason` on a confirmation is one of `accepted`, `allowlisted`, or `allow_all`.
On a denial it is `declined`, `expired`, or `cancelled`.

## Stdio protocol

The adapter spawns `node bridge/index.js` and talks to it over newline-delimited
JSON. One JSON object per line, UTF-8, no pretty printing.

- **stdin**: command requests from the adapter.
- **stdout**: readiness event, bridge events, and exactly one terminal response
  per command.
- **stderr**: diagnostics only. The bridge never writes logs to stdout, and the
  adapter never parses stderr as protocol.

A request line is:

```json
{"command":"status","request_id":"7f4d3a2e-6b1c-4f0a-9d2e-5c8b1a0f9e33"}
```

`request_id` is required and must be a non-empty string or a finite number. The
bridge echoes it on the one terminal response for that request. Requests longer
than 1 MiB, or lines that are not valid JSON, receive an `error` response with a
`null` request id.

`request_id` is reserved for correlation and is never passed to a command
handler. To act on a pending pairing request, `accept_pairing` and
`decline_pairing` take `pairing_request_id`, which is the `request_id` field of
the corresponding `pairing_request` event.

### Output backpressure

The bridge writes stdout through one ordered queue. Each event is serialized
once as a single line, written in call order, and the writer waits for the
stream's `drain` event when a write returns `false`. Buffered output is capped at
8 MiB; producers wait for capacity instead of dropping or reordering lines, so a
slow consumer applies backpressure without ever corrupting the framing or
interleaving a terminal response with an event.

`shutdown` awaits the protocol writer's `flush()` before exiting. The
`shutdown_result` line is therefore delivered before the process exits even when
the consumer is slow, while the existing 15-second force timer still bounds a
consumer that never drains at all.

### Readiness

The bridge emits `welcome_room_ready` exactly once, after the identity, Corestore,
room, swarm, pairing listener, and first invite exist. Nothing is emitted before
it except stderr diagnostics.

```json
{"type":"welcome_room_ready","protocol_version":"1.0.0","identity":"644a4493bf85751f138a0a956129dac362b5f58a9141caf0b923ffb4532340d4","room_key":"7a08b58b2aa071c5078fe0e1166e39bbf5df6111934e3644d696ed2a19d764c4","invite_url":"keet://chat/yfowspfz9iowrptnnow5mc3xkpkk5ex5gd8gupemydxbkje5b9rd5cue4ciyanrtcdkj661wgstqwapzej3nmftroceknmh4e176h1kyc6kbsqio6az3atjsika3pdgk5gwpe88za6aewa3xsgrm74maz39ur6e","started_at":"2026-10-21T06:24:27.391Z","started_at_ms":1792563867391}
```

| field | type | meaning |
| --- | --- | --- |
| `protocol_version` | string | stdio protocol version, `1.0.0` |
| `identity` | 64-hex string | persistent Ed25519 identity public key |
| `room_key` | 64-hex string | persisted Autobase room key |
| `invite_url` | string or `null` | current `keet://chat/...` invite |
| `started_at` | ISO-8601 string | bridge start time |
| `started_at_ms` | number | the same instant in epoch milliseconds |

### Commands

Every supported command produces one terminal response unless it fails, in which
case it produces `error`. The response type is `<command>_result`, except
`send_message`, which returns `send_result`, and `get_identity`, which returns
`identity_result`. The bridge also includes camelCase aliases for some pairing
records; the snake_case names below are canonical.

| command | request fields | result fields |
| --- | --- | --- |
| `send_message` | `text` (required, non-empty); optional `room_key` or `chat_id` | `message_id`, `room_key`, `chat_id`, `replicated_peers`, `queued`, `timestamp` |
| `send_welcome` | `text` (or `message`), optional `room_key`/`chat_id` | same as `send_message` |
| `status` | none | see below |
| `get_identity` | none | `identity`, `public_key`, `room_key`, `writer_key`, `protocol_version` |
| `create_invite` | optional `expires` (epoch milliseconds) | `invitation_id`, `invite_url`, `room_key`, `discovery_key`, `expires`, `format` |
| `join_invite` | `invite_url` (or `url`), optional `display_name`, `timeout_ms` | `invitation_id`, `room_key`, `discovery_key`, `encryption_key`, `writer_key`, `joined` |
| `accept_pairing` | `pairing_request_id` | resolved pairing record, `status: "accepted"` |
| `decline_pairing` | `pairing_request_id` | resolved pairing record, `status: "declined"` |
| `cancel_invite` | optional `invitation_id`; omit to cancel the active invite | `cancelled`, `invitation_id`, `invite_url` |
| `pairing_list` | none | `requests`, `pending`, `pending_count` |
| `join_room` | `room_key` (or `chat_id`), 64 hex | `joined`, `status`, `room_key`, `peer_count`, `writable` |
| `connect_to_user` | optional `room_key`/`chat_id` | `status`, `room_key`, `connected`, plus `join_room` fields when connected |
| `shutdown` | none | `status: "stopped"`, `exit_code: 0` |

`send_message` always appends locally first. With no connected peer the result has
`queued: true` and `replicated_peers: 0`; the append is durable and replicates
later. The bridge acknowledges only after the append is accepted, so
`send_welcome` uses the same path.

`status` returns:

| field | type | meaning |
| --- | --- | --- |
| `status` | string | `online` or `offline` |
| `online` | boolean | not shut down |
| `mode` | string | always `autobase` |
| `protocol_version` | string | stdio protocol version |
| `identity` | 64-hex string | persistent identity public key |
| `room_key` | 64-hex string | persisted room key |
| `writer_key` | 64-hex string | local writer key |
| `invite_url` | string or `null` | current invite |
| `peer_count` | number | connected room peers |
| `queued_messages` | number | local appends not yet in the linearized view |
| `message_count` | number | linearized messages |
| `member_count` | number | known writers |
| `writable` | boolean | local writer is writable |
| `home_channel` | 64-hex string or `null` | configured `KEET_HOME_CHANNEL` |
| `home_channel_matches` | boolean or `null` | home channel equals the active room |
| `uptime_ms` | number | milliseconds since start |
| `started_at` | ISO-8601 string | bridge start time |
| `dht` | object or `null` | `host`, `port`, `firewalled`, `public_key` |

`join_invite` joins another bridge's room and confirms the candidate pairing. The
result's `joined` is `true` when the returned room key equals this bridge's active
room. `join_room` only accepts the persisted room; any other key returns
`ROOM_NOT_PERSISTED` and the adapter should use `join_invite` with an invite.

`shutdown` flushes storage, closes pairing, the room, and the swarm, writes the
result, then exits `0`. Once shutdown starts the router stops reading stdin, so a
second command is ignored. `SIGINT` and `SIGTERM` perform the same shutdown and
also exit `0`; a forced exit after 15 seconds is an error path.

### Unsupported commands

`send_image`, `send_file`, `send_attachment`, `send_voice`, and `send_video` are
recognized but unsupported. They return a typed error and never touch the room:

```json
{"type":"error","request_id":"b6a1c0d4-3e2f-4a8b-9c7d-1e0f2a3b4c5d","code":"unsupported_command","message":"Command is not supported: send_image","operation":"send_image"}
```

Any other command is also `unsupported_command`; the bridge never replies with an
`unknown_command` type or code.

### Errors

```json
{"type":"error","request_id":"1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a6b7","code":"INVALID_TEXT","message":"send_message requires a non-empty text field","operation":"send_message"}
```

| code | cause |
| --- | --- |
| `invalid_json` | request line is not JSON; `request_id` is `null` |
| `invalid_request` | missing `command` or `request_id` |
| `line_too_large` | request exceeds 1 MiB; `request_id` is `null` |
| `timeout` | handler did not finish within the router timeout (10 s default) |
| `unsupported_command` | command is not implemented |
| `command_failed` | unclassified handler failure |
| `INVALID_TEXT` | empty `send_message` text |
| `ROOM_MISMATCH` | request names a room other than the active one |
| `NOT_READY` | command needs an initialized room or pairing |
| `PAIRING_REQUEST_ID_REQUIRED` | `accept_pairing`/`decline_pairing` without `pairing_request_id` |
| `INVITE_REQUIRED` | `join_invite` without an invite URL |
| `ROOM_KEY_REQUIRED` | `join_room` without a room key |
| `INVALID_ROOM_KEY` | `join_room` key is not 64 hex characters |
| `ROOM_NOT_PERSISTED` | `join_room` names a room this bridge does not own |
| `INVALID_BOOTSTRAP` | malformed `KEET_DHT_BOOTSTRAP` |
| `UNKNOWN_PAIRING_REQUEST` | unknown or already resolved pairing request |

Bridge-originated codes are uppercase. Router-originated codes are lowercase.

### Events

Events are unsolicited stdout lines and never carry `request_id`. Each is one
JSON object.

| event | fields |
| --- | --- |
| `welcome_room_ready` | `protocol_version`, `identity`, `room_key`, `invite_url`, `started_at`, `started_at_ms` |
| `invite_created` | `invitation_id`, `invite_url`, `room_key`, `discovery_key`, `expires`, `format` |
| `invite_cancelled` | `invitation_id`, `reason` |
| `pairing_request` | `request_id`, `invitation_id`, `identity`, `writer_key`, `display_name`, `created_at`, `expires_at`, `status: "pending"` |
| `pairing_confirmed` | `request_id`, `invitation_id`, `identity`, `writer_key`, `display_name`, `status: "accepted"`, `reason`, `persisted`, `accepted_at` |
| `pairing_declined` | `request_id`, `invitation_id`, `identity`, `writer_key`, `status` (`declined` or `cancelled`), `reason` |
| `pairing_expired` | `request_id`, `invitation_id`, `identity`, `writer_key`, `status: "expired"`, `reason: "expired"` |
| `pairing_rejected` | `reason`, `message` |
| `message` | `chat_id`, `room_key`, `message_id`, `from`, `sender`, `text`, `timestamp`, `ts` |

```json
{"type":"pairing_request","request_id":"9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b","invitation_id":"4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4321","identity":"644a4493bf85751f138a0a956129dac362b5f58a9141caf0b923ffb4532340d4","writer_key":"7a08b58b2aa071c5078fe0e1166e39bbf5df6111934e3644d696ed2a19d764c4","display_name":"Alice","created_at":1792563867391,"expires_at":1792564167391,"status":"pending"}
```

```json
{"type":"message","chat_id":"7a08b58b2aa071c5078fe0e1166e39bbf5df6111934e3644d696ed2a19d764c4","room_key":"7a08b58b2aa071c5078fe0e1166e39bbf5df6111934e3644d696ed2a19d764c4","message_id":"3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4","from":"644a4493bf85751f138a0a956129dac362b5f58a9141caf0b923ffb4532340d4","sender":"644a4493bf85751f138a0a956129dac362b5f58a9141caf0b923ffb4532340d4","text":"hello","timestamp":1792563867391,"ts":1792563867391}
```

`message_id` is the deduplication key. `from` and `sender` are the same identity
public key. `ts` is a millisecond timestamp kept for older adapters.

Pairing `reason` is `accepted`, `allowlisted`, or `allow_all` on confirmation and
`declined`, `expired`, or `cancelled` on denial. `pairing_rejected` means the
candidate's user data was malformed or could not be opened, so no decision was
possible; the candidate is denied.

## Bridge environment

| variable | meaning |
| --- | --- |
| `KEET_DATA_DIR` | data directory, default `~/.keet-channel` |
| `KEET_ALLOWED_USERS` | comma-separated 64-hex identities; invalid entries are logged and skipped |
| `KEET_ALLOW_ALL_USERS` | literal `true` confirms every pairing request; development only, logs a warning, never persisted |
| `KEET_ACL_FILE` | allowlist file override, default `<dataDir>/allowed.json` |
| `KEET_HOME_CHANNEL` | expected stable room key (64 hex) |
| `KEET_DHT_BOOTSTRAP` | comma-separated `host:port` DHT bootstrap nodes |
| `KEET_INVITE_FORMAT` | `keet` (default) or `standard` |
| `KEET_PAIRING_TIMEOUT_MS` | pending request lifetime, default 5 minutes |
| `KEET_PAIRING_JOIN_TIMEOUT_MS` | candidate join timeout |

The bridge runs under Node.js 24 or newer. It does not use the Pear/Bare runtime
and has no WebSocket listener; the only adapter transport is stdio.
