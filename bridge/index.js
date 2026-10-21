#!/usr/bin/env node
'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')

const Hyperswarm = require('hyperswarm')

const { Identity, resolveDataDir } = require('./lib/identity')
const { Room } = require('./lib/room')
const { Pairing } = require('./lib/pairing')
const StdioRouter = require('./lib/stdio')
const { PROTOCOL_VERSION } = require('./lib/stdio')

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000

class BridgeError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function envInt (env, key, fallback) {
  const raw = env && env[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function parseBootstrap (value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined

  const nodes = []
  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const separator = trimmed.lastIndexOf(':')
    if (separator === -1) throw new BridgeError('INVALID_BOOTSTRAP', `Invalid DHT bootstrap node: ${trimmed}`)
    const host = trimmed.slice(0, separator)
    const port = Number(trimmed.slice(separator + 1))
    if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new BridgeError('INVALID_BOOTSTRAP', `Invalid DHT bootstrap node: ${trimmed}`)
    }
    nodes.push({ host, port })
  }

  return nodes.length > 0 ? nodes : undefined
}

function dhtInfo (swarm) {
  const dht = swarm && swarm.dht
  if (!dht) return null
  return {
    host: dht.host || null,
    port: typeof dht.port === 'number' ? dht.port : null,
    firewalled: typeof dht.firewalled === 'boolean' ? dht.firewalled : null,
    public_key: dht.publicKey ? dht.publicKey.toString('hex') : null
  }
}

class KeetBridge extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.env = opts.env || process.env
    this.dataDir = opts.dataDir ? path.resolve(opts.dataDir) : resolveDataDir(this.env)
    this.log = opts.log || ((message) => console.error(message))
    this.identity = null
    this.room = null
    this.pairing = null
    this.swarm = null
    this.router = null
    this.startedAt = null
    this._welcomed = false
    this._started = false
    this._startPromise = null
    this._shutdownPromise = null
    this._closed = false
    this._roomMessageHandler = (message) => this._forwardMessage(message)
    this._pairingHandlers = new Map()
    this._homeChannel = typeof this.env.KEET_HOME_CHANNEL === 'string' && this.env.KEET_HOME_CHANNEL.trim() !== ''
      ? this.env.KEET_HOME_CHANNEL.trim().toLowerCase()
      : null
    this._bootstrap = opts.bootstrap || parseBootstrap(this.env.KEET_DHT_BOOTSTRAP)
  }

  get roomKey () {
    return this.room ? this.room.keyHex : null
  }

  get identityKey () {
    return this.identity ? this.identity.publicKeyHex : null
  }

  get inviteUrl () {
    return this.pairing ? this.pairing.inviteUrl : null
  }

  async start () {
    if (this._started) return this
    if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'the bridge has been shut down')
    if (this._startPromise !== null) return this._startPromise

    this._startPromise = this._start()

    try {
      return await this._startPromise
    } finally {
      this._startPromise = null
    }
  }

  async _start () {
    this.startedAt = Date.now()

    this.log(`[bridge] starting (data directory: ${this.dataDir})`)

    try {
      // 1. Persistent identity.
      this.identity = await Identity.loadOrCreate({ dataDir: this.dataDir, env: this.env })
      this.log(`[bridge] identity ${this.identity.publicKeyHex}`)

      // 2. Room storage (Autobase + Corestore), re-opening persisted history.
      this.room = await Room.open({ dataDir: this.dataDir, identity: this.identity, env: this.env })
      this.log(`[bridge] room ${this.room.keyHex} (writer ${this.room.writerKeyHex})`)

      // 3. DHT transport.
      this.swarm = new Hyperswarm({ bootstrap: this._bootstrap })
      await this.swarm.dht.ready()

      // 4. Replicate the room over the swarm.
      await this.room.join(this.swarm)

      // 5. Pairing listener and the first invite. The invite must exist before
      //    readiness is announced.
      this.pairing = new Pairing({
        swarm: this.swarm,
        identity: this.identity,
        room: this.room,
        dataDir: this.dataDir,
        env: this.env,
        format: this.env.KEET_INVITE_FORMAT,
        pendingTimeoutMs: envInt(this.env, 'KEET_PAIRING_TIMEOUT_MS', undefined),
        log: (message) => this.log(message)
      })
      await this.pairing.start()
      this.log(`[bridge] invite ${this.pairing.inviteUrl || '(none)'}`)

      // 6. Command router. Diagnostics never go to stdout.
      this.router = new StdioRouter(this, { protocolVersion: PROTOCOL_VERSION })
      this._attachEvents()
      this.router.start()

      // 7. Readiness is emitted exactly once, after room and invite exist.
      await this._emitWelcome()
    } catch (err) {
      await this._releaseStartResources()
      throw err
    }

    this._started = true
    this.emit('ready', this._welcomePayload())
    return this
  }

  async _releaseStartResources () {
    this._detachEvents()

    if (this.router) {
      try {
        this.router.stop()
      } catch (err) {
        this.log(`[bridge] router cleanup failed: ${err.message}`)
      }
      this.router = null
    }

    if (this.pairing) {
      try {
        await this.pairing.close()
      } catch (err) {
        this.log(`[bridge] pairing cleanup failed: ${err.message}`)
      }
      this.pairing = null
    }

    if (this.room) {
      try {
        await this.room.close()
      } catch (err) {
        this.log(`[bridge] room cleanup failed: ${err.message}`)
      }
      this.room = null
    }

    if (this.swarm) {
      try {
        await this.swarm.destroy()
      } catch (err) {
        this.log(`[bridge] swarm cleanup failed: ${err.message}`)
      }
      this.swarm = null
    }

    if (this.identity && typeof this.identity.clear === 'function') {
      try {
        this.identity.clear()
      } catch (err) {
        this.log(`[bridge] identity cleanup failed: ${err.message}`)
      }
    }

    this.identity = null
    this._welcomed = false
  }

  _welcomePayload () {
    return {
      type: 'welcome_room_ready',
      protocol_version: PROTOCOL_VERSION,
      identity: this.identityKey,
      room_key: this.roomKey,
      invite_url: this.inviteUrl,
      started_at: new Date(this.startedAt).toISOString(),
      started_at_ms: this.startedAt
    }
  }

  async _emitWelcome () {
    if (this._welcomed) return
    this._welcomed = true
    await this.router.send(this._welcomePayload())
  }

  _forward (event) {
    if (!this.router || !this.router.started) return
    this.router.send(event).catch((err) => {
      this.log(`[bridge] failed to forward protocol event: ${err && err.message}`)
    })
  }

  _attachEvents () {
    if (this.room) this.room.on('message', this._roomMessageHandler)

    if (!this.pairing) return

    const forward = (type) => (record) => {
      if (!this.router || !this.router.started) return
      this.router.send({ ...record, type }).catch((err) => {
        this.log(`[bridge] failed to forward pairing event: ${err && err.message}`)
      })
    }

    const handlers = {
      invite_created: (record) => {
        if (!this.router || !this.router.started) return
        this.router.send({
          ...record,
          type: 'invite_created',
          invite_url: record.url || record.invite_url || null
        }).catch((err) => {
          this.log(`[bridge] failed to forward invite event: ${err && err.message}`)
        })
      },
      invite_cancelled: forward('invite_cancelled'),
      pairing_request: forward('pairing_request'),
      pairing_confirmed: forward('pairing_confirmed'),
      pairing_declined: forward('pairing_declined'),
      pairing_expired: forward('pairing_expired'),
      pairing_rejected: forward('pairing_rejected')
    }

    for (const [event, handler] of Object.entries(handlers)) {
      this.pairing.on(event, handler)
      this._pairingHandlers.set(event, handler)
    }
  }

  _detachEvents () {
    if (this.room) this.room.off('message', this._roomMessageHandler)
    if (this.pairing) {
      for (const [event, handler] of this._pairingHandlers) this.pairing.off(event, handler)
    }
    this._pairingHandlers.clear()
  }

  _forwardMessage (message) {
    this._forward({
      type: 'message',
      chat_id: message.roomKey,
      room_key: message.roomKey,
      message_id: message.messageId,
      from: message.sender,
      sender: message.sender,
      text: message.text,
      timestamp: message.timestamp,
      ts: message.timestamp
    })
  }

  // --- command handlers -------------------------------------------------

  async sendMessage (params = {}) {
    const text = params.text
    if (typeof text !== 'string' || text.length === 0) {
      throw new BridgeError('INVALID_TEXT', 'send_message requires a non-empty text field')
    }

    this._assertRoom(params.room_key || params.chat_id)

    const ack = await this.room.send(text)
    return {
      message_id: ack.messageId,
      room_key: ack.roomKey,
      chat_id: ack.roomKey,
      replicated_peers: ack.replicatedPeers,
      queued: ack.queued,
      timestamp: ack.timestamp
    }
  }

  async sendWelcome (params = {}) {
    const text = params.text === undefined ? params.message : params.text
    return this.sendMessage({ ...params, text })
  }

  status () {
    const roomStatus = this.room ? this.room.status() : null
    const dht = dhtInfo(this.swarm)
    const uptimeMs = this.startedAt === null ? 0 : Date.now() - this.startedAt

    return {
      status: this._closed ? 'offline' : 'online',
      online: !this._closed,
      mode: 'autobase',
      protocol_version: PROTOCOL_VERSION,
      identity: this.identityKey,
      room_key: this.roomKey,
      writer_key: this.room ? this.room.writerKeyHex : null,
      invite_url: this.inviteUrl,
      peer_count: this.room ? this.room.peerCount : 0,
      queued_messages: this.room ? this.room.queuedMessages : 0,
      message_count: roomStatus ? roomStatus.messageCount : 0,
      member_count: roomStatus ? roomStatus.memberCount : 0,
      writable: this.room ? this.room.writable : false,
      home_channel: this._homeChannel,
      home_channel_matches: this._homeChannel === null ? null : this._homeChannel === this.roomKey,
      uptime_ms: uptimeMs,
      started_at: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
      dht
    }
  }

  getIdentity () {
    return {
      identity: this.identityKey,
      public_key: this.identityKey,
      room_key: this.roomKey,
      writer_key: this.room ? this.room.writerKeyHex : null,
      protocol_version: PROTOCOL_VERSION
    }
  }

  async createInvite (params = {}) {
    if (!this.pairing) throw new BridgeError('NOT_READY', 'the bridge is not ready')
    const result = await this.pairing.createInvite({ expires: params.expires })
    return {
      ...result,
      invite_url: result.invite_url || result.url
    }
  }

  async joinInvite (params = {}) {
    const url = params.invite_url || params.url
    if (typeof url !== 'string' || url.length === 0) {
      throw new BridgeError('INVITE_REQUIRED', 'join_invite requires an invite_url field')
    }
    if (!this.pairing || !this.room) throw new BridgeError('NOT_READY', 'the bridge is not ready')

    const result = await this.pairing.joinInvite(url, {
      writerKey: this.room.writerKeyHex,
      displayName: params.display_name,
      timeoutMs: params.timeout_ms
    })

    return {
      invitation_id: result.invitation_id,
      room_key: result.room_key,
      discovery_key: result.discovery_key,
      encryption_key: result.encryption_key,
      writer_key: result.writer_key,
      joined: result.room_key === this.roomKey
    }
  }

  async acceptPairing (params = {}) {
    const requestId =
      params.pairing_request_id || params.pairingRequestId || params.request_id || params.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new BridgeError(
        'PAIRING_REQUEST_ID_REQUIRED',
        'accept_pairing requires a pairing_request_id'
      )
    }
    return this.pairing.accept(requestId)
  }

  async declinePairing (params = {}) {
    const requestId =
      params.pairing_request_id || params.pairingRequestId || params.request_id || params.requestId
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new BridgeError(
        'PAIRING_REQUEST_ID_REQUIRED',
        'decline_pairing requires a pairing_request_id'
      )
    }
    return this.pairing.decline(requestId)
  }

  async cancelInvite (params = {}) {
    const invitationId = params.invitation_id || params.invitationId
    const cancelled = await this.pairing.cancelInvite(invitationId, params.reason || 'cancelled')
    return {
      cancelled,
      invitation_id: invitationId || null,
      invite_url: this.inviteUrl
    }
  }

  async pairingList () {
    return {
      requests: this.pairing ? this.pairing.list() : [],
      pending: this.pairing ? this.pairing.pending() : [],
      pending_count: this.pairing ? this.pairing.pendingCount : 0
    }
  }

  async joinRoom (params = {}) {
    const requested = params.room_key || params.chat_id
    if (requested === undefined || requested === null || requested === '') {
      throw new BridgeError('ROOM_KEY_REQUIRED', 'join_room requires a room_key')
    }
    if (typeof requested !== 'string' || !/^[0-9a-f]{64}$/i.test(requested)) {
      throw new BridgeError('INVALID_ROOM_KEY', 'room_key must be 64 hexadecimal characters')
    }
    const roomKey = requested.toLowerCase()

    if (roomKey !== this.roomKey) {
      throw new BridgeError(
        'ROOM_NOT_PERSISTED',
        'This bridge only has the persisted room; use join_invite to join another room'
      )
    }

    return {
      joined: true,
      status: 'joined',
      room_key: this.roomKey,
      peer_count: this.room.peerCount,
      writable: this.room.writable
    }
  }

  async connectToUser (params = {}) {
    const requested = params.room_key || params.chat_id
    if (requested === undefined || requested === null || requested === '') {
      return { status: 'needs_invite', room_key: null, connected: false }
    }

    try {
      const result = await this.joinRoom({ room_key: requested })
      return { ...result, connected: true }
    } catch (err) {
      if (err.code === 'ROOM_NOT_PERSISTED') {
        return { status: 'needs_invite', room_key: null, connected: false }
      }
      throw err
    }
  }

  _assertRoom (roomKey) {
    if (roomKey === undefined || roomKey === null || roomKey === '') return
    if (typeof roomKey !== 'string' || roomKey.toLowerCase() !== this.roomKey) {
      throw new BridgeError('ROOM_MISMATCH', 'The requested room is not the active room')
    }
  }

  shutdown () {
    if (this._shutdownPromise !== null) return this._shutdownPromise

    this._shutdownPromise = (async () => {
      this.log('[bridge] shutting down')
      this._closed = true

      if (this._startPromise !== null) {
        try {
          await this._startPromise
        } catch (err) {
          this.log(`[bridge] in-flight startup failed during shutdown: ${err.message}`)
        }
      }

      this._detachEvents()

      // Stop accepting commands but leave queued output in place; the protocol
      // writer is flushed by the caller before the process exits.
      if (this.router) this.router.stop()

      if (this.pairing) {
        try {
          await this.pairing.close()
        } catch (err) {
          this.log(`[bridge] pairing close failed: ${err.message}`)
        }
        this.pairing = null
      }

      if (this.room) {
        try {
          await this.room.flush()
        } catch (err) {
          this.log(`[bridge] room flush failed: ${err.message}`)
        }
        try {
          await this.room.close()
        } catch (err) {
          this.log(`[bridge] room close failed: ${err.message}`)
        }
        this.room = null
      }

      if (this.swarm) {
        try {
          await this.swarm.destroy()
        } catch (err) {
          this.log(`[bridge] swarm destroy failed: ${err.message}`)
        }
        this.swarm = null
      }

      if (this.identity && typeof this.identity.clear === 'function') {
        try {
          this.identity.clear()
        } catch (err) {
          this.log(`[bridge] identity cleanup failed: ${err.message}`)
        }
      }
      this.identity = null
      this._started = false

      this.log('[bridge] stopped')
      return { status: 'stopped', exit_code: 0 }
    })()

    return this._shutdownPromise
  }
}

function flushAndExit (router, code) {
  if (!router) {
    process.exit(code)
    return Promise.resolve()
  }
  return router.flush().then(
    () => process.exit(code),
    (err) => {
      console.error(`[bridge] protocol flush failed: ${err.message}`)
      process.exit(code)
    }
  )
}

async function main () {
  const bridge = new KeetBridge()
  let shuttingDown = false

  const shutdown = async (code) => {
    if (shuttingDown) return
    shuttingDown = true
    const force = setTimeout(() => process.exit(1), DEFAULT_SHUTDOWN_TIMEOUT_MS)
    if (typeof force.unref === 'function') force.unref()
    try {
      await bridge.shutdown()
      if (bridge.router) bridge.router.stop()
      await flushAndExit(bridge.router, code)
      clearTimeout(force)
    } catch (err) {
      clearTimeout(force)
      console.error(`[bridge] shutdown failed: ${err.message}`)
      process.exit(1)
    }
  }

  process.once('SIGINT', () => { shutdown(0) })
  process.once('SIGTERM', () => { shutdown(0) })

  try {
    await bridge.start()
  } catch (err) {
    console.error(`[bridge] fatal startup error: ${err && err.stack ? err.stack : err}`)
    await bridge.shutdown().catch(() => {})
    process.exit(1)
    return
  }

  bridge.router.once('shutdown', () => {
    if (typeof bridge.router.input.pause === 'function') bridge.router.input.pause()
    shutdown(0)
  })

  bridge.on('ready', (payload) => {
    console.error(`[bridge] ready: ${payload.room_key}`)
  })
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[bridge] fatal:', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = KeetBridge
module.exports.KeetBridge = KeetBridge
module.exports.BridgeError = BridgeError
module.exports.parseBootstrap = parseBootstrap
module.exports.main = main
