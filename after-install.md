## Keet Channel — Next Steps

✅ Plugin installed successfully.

The bridge runs as a plain Node.js subprocess. Pear is **not** required.

### 1. Enable the plugin and restart the gateway

```bash
hermes plugins enable keet-channel
hermes gateway restart
```

The bridge starts automatically and creates (or reopens) the persistent room.

### 2. Authorize contacts — access is denied by default

Nothing gets through until an identity is authorized. Either configure an
allowlist:

```bash
# 64-hex Keet identity public keys, comma-separated
hermes config set env_KEET_ALLOWED_USERS "<64-hex-identity>,<64-hex-identity>"
```

or start the bridge, share the invite, and accept the pairing request with
`accept_pairing`. Accepted identities are stored in
`~/.keet-channel/allowed.json` and stay authorized across restarts.

`KEET_ALLOW_ALL_USERS=true` is a development-only override. It is never
persisted.

### 3. Find the bridge identity, room, and invite

```bash
hermes log -n 50 | grep -E "\[bridge\] (identity|room|invite)"
```

- **Identity** is the stable public key used for access control.
- **Room key** is the stable `KEET_HOME_CHANNEL` value for cron delivery.
- **Invite** (`keet://chat/...`) is what a contact uses to pair.

Invites are also available through the adapter's `get_invite_url()` and the
bridge `status` response.

### 4. Cron delivery

Set the home channel to the **room key** (64 hex), not the invite URL:

```bash
hermes config set env_KEET_HOME_CHANNEL "<64-hex-room-key>"
```

Standalone delivery opens the same `KEET_DATA_DIR`, waits for readiness, sends,
awaits the durable acknowledgement, and disconnects.

---

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Bridge fails to start | Run `bash scripts/setup.sh`; it installs dependencies and verifies Node >= 24 |
| Node.js not found or too old | Install Node.js >= 24: https://nodejs.org/en/download/ |
| Messages are dropped | Access is denied by default: configure `KEET_ALLOWED_USERS` or accept the pairing request |
| Cron reports a configuration error | `KEET_HOME_CHANNEL` must be the persisted 64-hex room key |
| Image send fails | Attachments are not implemented; only text is supported |
