'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Autobase = require('autobase')
const Corestore = require('corestore')

const {
  createMessage,
  encodeMessage,
  decodeMessage,
  MessageDeduplicator
} = require('./messages')
const { MediaStore } = require('./media')
const {
  StorageError,
  dataPaths,
  ensureDataDir,
  ensureMode,
  readJsonFile,
  writeJsonAtomic,
  resolveDataDir
} = require('./identity')
const { createErrorClass } = require('./errors')
const { KEY_BYTES, isKeyHex, normalizeKey } = require('./keys')

const ROOM_VERSION = 1
const NODE_VERSION = 1
const MEMBER_VERSION = 1
const KEY_FIELDS = ['roomKey', 'encryptionKey', 'writerKey']
const MAX_DISPLAY_NAME_BYTES = 256

const NODE_TYPES = {
  REGISTER: 1,
  ADD_WRITER: 2,
  MESSAGE: 3
}

const NODE_TYPE_NAMES = {
  1: 'register',
  2: 'add-writer',
  3: 'message'
}

const RoomError = createErrorClass('RoomError')

function normalizeRoomMetadata (value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageError('INVALID_ROOM_METADATA', `Invalid room metadata at ${file}: expected a JSON object`)
  }
  if (value.version !== ROOM_VERSION) {
    throw new StorageError(
      'INVALID_ROOM_METADATA',
      `Invalid room metadata at ${file}: unsupported version ${String(value.version)}`
    )
  }
  for (const field of KEY_FIELDS) {
    if (!isKeyHex(value[field])) {
      throw new StorageError(
        'INVALID_ROOM_METADATA',
        `Invalid room metadata at ${file}: ${field} must be 64 lowercase hex characters`
      )
    }
  }
  return {
    version: ROOM_VERSION,
    roomKey: value.roomKey,
    encryptionKey: value.encryptionKey,
    writerKey: value.writerKey
  }
}

function createRoomMetadata (opts = {}) {
  return {
    version: ROOM_VERSION,
    roomKey: (opts.roomKey || crypto.randomBytes(32)).toString('hex'),
    encryptionKey: (opts.encryptionKey || crypto.randomBytes(32)).toString('hex'),
    writerKey: (opts.writerKey || crypto.randomBytes(32)).toString('hex')
  }
}

// Returns null when no room metadata exists yet (first start).
function readRoomMetadata (dataDir) {
  const { roomFile } = dataPaths(dataDir)
  let value
  try {
    value = readJsonFile(roomFile, 'room metadata')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return normalizeRoomMetadata(value, roomFile)
}

// Strict read for commands that require an already initialized room.
function loadRoomMetadata (dataDir) {
  const metadata = readRoomMetadata(dataDir)
  if (metadata === null) {
    const { roomFile } = dataPaths(dataDir)
    throw new StorageError(
      'ROOM_METADATA_NOT_FOUND',
      `Room metadata not found at ${roomFile}. Initialize this data directory with the bridge first or set KEET_DATA_DIR to an existing keet-channel data directory.`
    )
  }
  return metadata
}

function saveRoomMetadata (dataDir, metadata) {
  ensureDataDir(dataDir)
  const { roomFile } = dataPaths(dataDir)
  const normalized = normalizeRoomMetadata(metadata, roomFile)
  writeJsonAtomic(roomFile, normalized)
  ensureMode(roomFile, 0o600)
  return normalized
}

// The Autobase local writer is the Corestore core named "local" for every
// room, so its key can be computed before the room key is known (pairing).
async function resolveWriterKey (dataDir) {
  const resolved = path.resolve(dataDir)
  ensureDataDir(resolved)
  const store = new Corestore(dataPaths(resolved).corestoreDir)

  try {
    const core = store.get({ name: 'local' })
    await core.ready()
    return core.key
  } finally {
    await store.close()
  }
}

function toKey (value, field) {
  return normalizeKey(value, field, RoomError)
}

function normalizeDisplayName (value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new RoomError('INVALID_DISPLAY_NAME', 'display name must be a string')
  }
  if (b4a.byteLength(value, 'utf-8') > MAX_DISPLAY_NAME_BYTES) {
    throw new RoomError(
      'INVALID_DISPLAY_NAME',
      `display name must be at most ${MAX_DISPLAY_NAME_BYTES} UTF-8 bytes`
    )
  }
  return value
}

function nodeTypeNumber (type) {
  if (typeof type === 'number') return type
  if (typeof type === 'string') return NODE_TYPES[type.toUpperCase()]

  return undefined
}

function encodeNode (node) {
  const type = nodeTypeNumber(node && node.type)

  if (!Object.values(NODE_TYPES).includes(type)) {
    throw new RoomError('INVALID_NODE', 'unknown room node type')
  }

  const state = c.state()

  c.uint.preencode(state, NODE_VERSION)
  c.uint.preencode(state, type)

  if (type === NODE_TYPES.MESSAGE) {
    if (!b4a.isBuffer(node.message) && !(node.message instanceof Uint8Array)) {
      throw new RoomError('INVALID_NODE', 'message node must carry a buffer')
    }
    c.buffer.preencode(state, node.message)
  } else {
    c.fixed32.preencode(state, toKey(node.writerKey, 'writerKey'))
    c.fixed32.preencode(state, toKey(node.identityKey, 'identityKey'))
    c.utf8.preencode(state, normalizeDisplayName(node.displayName))
  }

  state.buffer = b4a.allocUnsafe(state.end)

  c.uint.encode(state, NODE_VERSION)
  c.uint.encode(state, type)

  if (type === NODE_TYPES.MESSAGE) {
    c.buffer.encode(state, node.message)
  } else {
    c.fixed32.encode(state, toKey(node.writerKey, 'writerKey'))
    c.fixed32.encode(state, toKey(node.identityKey, 'identityKey'))
    c.utf8.encode(state, normalizeDisplayName(node.displayName))
  }

  return state.buffer
}

function decodeNode (buffer) {
  if (!b4a.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new RoomError('INVALID_NODE', 'room node must be a buffer')
  }

  const state = c.state(0, buffer.byteLength, buffer)
  let version
  let type

  try {
    version = c.uint.decode(state)
    type = c.uint.decode(state)
  } catch (err) {
    throw new RoomError('INVALID_NODE', 'room node is truncated')
  }

  if (version !== NODE_VERSION) {
    throw new RoomError('INVALID_NODE', `unsupported room node version ${version}`)
  }
  if (!Object.values(NODE_TYPES).includes(type)) {
    throw new RoomError('INVALID_NODE', `unknown room node type ${type}`)
  }

  let node

  try {
    if (type === NODE_TYPES.MESSAGE) {
      node = {
        type,
        message: b4a.from(c.buffer.decode(state))
      }
    } else {
      const writerKey = b4a.from(c.fixed32.decode(state))
      const identityKey = b4a.from(c.fixed32.decode(state))
      const displayName = c.utf8.decode(state)

      if (b4a.byteLength(displayName, 'utf-8') > MAX_DISPLAY_NAME_BYTES) {
        throw new RoomError('INVALID_NODE', 'display name is too long')
      }

      node = {
        type,
        writerKey,
        writerKeyHex: writerKey.toString('hex'),
        identityKey,
        identityKeyHex: identityKey.toString('hex'),
        displayName
      }
    }
  } catch (err) {
    if (err instanceof RoomError) throw err
    throw new RoomError('INVALID_NODE', 'room node is truncated')
  }

  if (state.start !== state.end) {
    throw new RoomError('INVALID_NODE', 'room node has trailing bytes')
  }

  return node
}

function encodeMember (member) {
  const state = c.state()

  c.uint.preencode(state, MEMBER_VERSION)
  c.uint.preencode(state, member.kind)
  c.fixed32.preencode(state, toKey(member.writerKey, 'writerKey'))
  c.fixed32.preencode(state, toKey(member.identityKey, 'identityKey'))
  c.utf8.preencode(state, normalizeDisplayName(member.displayName))

  state.buffer = b4a.allocUnsafe(state.end)

  c.uint.encode(state, MEMBER_VERSION)
  c.uint.encode(state, member.kind)
  c.fixed32.encode(state, toKey(member.writerKey, 'writerKey'))
  c.fixed32.encode(state, toKey(member.identityKey, 'identityKey'))
  c.utf8.encode(state, normalizeDisplayName(member.displayName))

  return state.buffer
}

function decodeMember (buffer) {
  if (!b4a.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new RoomError('INVALID_MEMBER', 'member record must be a buffer')
  }

  const state = c.state(0, buffer.byteLength, buffer)
  let version
  let kind

  try {
    version = c.uint.decode(state)
    kind = c.uint.decode(state)
  } catch (err) {
    throw new RoomError('INVALID_MEMBER', 'member record is truncated')
  }

  if (version !== MEMBER_VERSION) {
    throw new RoomError('INVALID_MEMBER', `unsupported member version ${version}`)
  }
  if (!Object.values(NODE_TYPES).includes(kind)) {
    throw new RoomError('INVALID_MEMBER', `unknown member kind ${kind}`)
  }

  let writerKey
  let identityKey
  let displayName

  try {
    writerKey = b4a.from(c.fixed32.decode(state))
    identityKey = b4a.from(c.fixed32.decode(state))
    displayName = c.utf8.decode(state)
  } catch (err) {
    throw new RoomError('INVALID_MEMBER', 'member record is truncated')
  }

  if (state.start !== state.end) {
    throw new RoomError('INVALID_MEMBER', 'member record has trailing bytes')
  }
  if (b4a.byteLength(displayName, 'utf-8') > MAX_DISPLAY_NAME_BYTES) {
    throw new RoomError('INVALID_MEMBER', 'display name is too long')
  }

  return {
    kind,
    writerKey,
    writerKeyHex: writerKey.toString('hex'),
    identityKey,
    identityKeyHex: identityKey.toString('hex'),
    displayName
  }
}

class Room extends EventEmitter {
  constructor (opts) {
    super()
    this.dataDir = opts.dataDir
    this.paths = opts.paths
    this.identity = opts.identity
    this.encryptionKey = opts.encryptionKey
    this.requestedRoomKey = opts.roomKey || null
    this.store = null
    this.session = null
    this.base = null
    this.key = null
    this.keyHex = null
    this.discoveryKey = null
    this.discoveryKeyHex = null
    this.writerKey = null
    this.writerKeyHex = null
    this.metadata = null
    this._members = new Map()
    this._membersLength = 0
    this._membersDirty = false
    this._pendingMessages = new Set()
    this._seen = new MessageDeduplicator()
    this.mediaStore = opts.mediaStore || null
    this._ownsMediaStore = opts.mediaStore === undefined || opts.mediaStore === null
    this._swarm = null
    this._discovery = null
    this._onConnection = null
    this._peers = new Set()
    this._closed = false
  }

  static async open (opts = {}) {
    if (!opts.identity || !opts.identity.publicKey || !opts.identity.keyPair) {
      throw new RoomError(
        'IDENTITY_REQUIRED',
        'room requires a persistent identity with a public key and signing key pair'
      )
    }

    const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : resolveDataDir(opts.env)
    const paths = dataPaths(dataDir)

    ensureDataDir(dataDir)

    const metadata = readRoomMetadata(dataDir)
    const requestedRoomKey =
      opts.roomKey === undefined || opts.roomKey === null
        ? null
        : toKey(opts.roomKey, 'roomKey')
    const requestedEncryptionKey =
      opts.encryptionKey === undefined || opts.encryptionKey === null
        ? null
        : toKey(opts.encryptionKey, 'encryptionKey')

    if (metadata !== null) {
      const persistedRoomKey = b4a.from(metadata.roomKey, 'hex')
      const persistedEncryptionKey = b4a.from(metadata.encryptionKey, 'hex')

      if (requestedRoomKey !== null && !b4a.equals(requestedRoomKey, persistedRoomKey)) {
        throw new RoomError(
          'ROOM_KEY_MISMATCH',
          'The persisted room key does not match the requested room key'
        )
      }
      if (
        requestedEncryptionKey !== null &&
        !b4a.equals(requestedEncryptionKey, persistedEncryptionKey)
      ) {
        throw new RoomError(
          'ENCRYPTION_KEY_MISMATCH',
          'The persisted room encryption key does not match the requested encryption key'
        )
      }
    } else if (requestedRoomKey !== null && requestedEncryptionKey === null) {
      throw new RoomError(
        'ENCRYPTION_KEY_REQUIRED',
        'Joining an existing room by key requires its encryption key'
      )
    }

    const roomKey = metadata !== null ? b4a.from(metadata.roomKey, 'hex') : requestedRoomKey
    const encryptionKey =
      metadata !== null
        ? b4a.from(metadata.encryptionKey, 'hex')
        : requestedEncryptionKey || crypto.randomBytes(KEY_BYTES)

    const room = new Room({
      dataDir,
      paths,
      identity: opts.identity,
      roomKey,
      encryptionKey,
      mediaStore: opts.mediaStore || new MediaStore({ dataDir, env: opts.env })
    })

    try {
      await room._open()
    } catch (err) {
      // Release the Corestore and its data-directory lock before reporting the
      // failure so a corrected retry can open the same directory.
      await room.close()
      throw err
    }

    return room
  }

  async _open () {
    if (this.mediaStore !== null) {
      await this.mediaStore.open()
    }

    this.store = new Corestore(this.paths.corestoreDir)
    this.session = this.store.session()

    this.base = new Autobase(this.session, this.requestedRoomKey, {
      encryptionKey: this.encryptionKey,
      open: (viewStore) => ({
        messages: viewStore.get('messages'),
        members: viewStore.get('members')
      }),
      apply: (nodes, view, host) => this._apply(nodes, view, host)
    })

    await this.base.ready()

    this.key = this.base.key
    this.keyHex = this.key.toString('hex')
    this.discoveryKey = this.base.discoveryKey
    this.discoveryKeyHex = this.discoveryKey.toString('hex')
    this.writerKey = this.base.local.key
    this.writerKeyHex = this.writerKey.toString('hex')

    if (this.requestedRoomKey !== null && !b4a.equals(this.requestedRoomKey, this.key)) {
      throw new RoomError(
        'ROOM_KEY_MISMATCH',
        'The opened room does not match the requested room key'
      )
    }

    this._saveMetadata()
    await this.base.update()
    await this._refreshMembers(this.base.view)

    if (this.base.writable) {
      const existing = this._members.get(this.writerKeyHex)

      if (existing === undefined) {
        await this.register()
      } else if (!b4a.equals(existing.identityKey, this.identity.publicKey)) {
        throw new RoomError(
          'IDENTITY_MISMATCH',
          'The persisted writer is registered to a different identity'
        )
      }
    }
  }

  _saveMetadata () {
    this.metadata = saveRoomMetadata(this.dataDir, {
      version: ROOM_VERSION,
      roomKey: this.keyHex,
      encryptionKey: this.encryptionKey.toString('hex'),
      writerKey: this.writerKeyHex
    })
  }

  _log (message, err) {
    const suffix = err && err.message ? `: ${err.message}` : ''
    console.error(`[room] ${message}${suffix}`)
  }

  async _refreshMembers (view) {
    if (!view || !view.members) return
    if (!this._membersDirty && view.members.length === this._membersLength) return

    const members = new Map()

    for (let i = 0; i < view.members.length; i++) {
      let member
      try {
        member = decodeMember(await view.members.get(i))
      } catch (err) {
        this._log('discarding malformed member record', err)
        continue
      }
      members.set(member.writerKeyHex, member)
    }

    this._members = members
    this._membersLength = view.members.length
    this._membersDirty = false
  }

  async _apply (nodes, view, host) {
    await this._refreshMembers(view)

    for (const node of nodes) {
      if (node.value === null) continue

      let decoded
      try {
        decoded = decodeNode(node.value)
      } catch (err) {
        this._log('discarding malformed room node', err)
        continue
      }

      const fromKey = node.from && node.from.key ? node.from.key : null

      if (fromKey === null) {
        this._log('discarding room node without a writer')
        continue
      }

      const fromHex = fromKey.toString('hex')

      if (decoded.type === NODE_TYPES.REGISTER) {
        if (!b4a.equals(decoded.writerKey, fromKey)) {
          this._log('discarding register node for a different writer')
          continue
        }

        const existing = this._members.get(decoded.writerKeyHex)

        if (existing !== undefined) {
          if (!b4a.equals(existing.identityKey, decoded.identityKey)) {
            this._log('discarding register node that conflicts with an existing identity')
          }
          continue
        }

        try {
          await view.members.append(encodeMember({ kind: NODE_TYPES.REGISTER, ...decoded }))
        } catch (err) {
          this._log('failed to append member record', err)
          continue
        }

        this._members.set(decoded.writerKeyHex, decoded)
        this._membersLength = view.members.length
        this._membersDirty = true
        this.emit('member', {
          action: 'registered',
          writerKey: decoded.writerKeyHex,
          identity: decoded.identityKeyHex,
          displayName: decoded.displayName
        })
        continue
      }

      if (decoded.type === NODE_TYPES.ADD_WRITER) {
        if (!this._members.has(fromHex)) {
          this._log('discarding add-writer node from an unmapped writer')
          continue
        }

        const existing = this._members.get(decoded.writerKeyHex)

        if (existing !== undefined && !b4a.equals(existing.identityKey, decoded.identityKey)) {
          this._log('discarding add-writer node that conflicts with an existing identity')
          continue
        }

        try {
          await host.addWriter(decoded.writerKey, { indexer: true })
        } catch (err) {
          this._log('failed to add room writer', err)
          continue
        }

        if (existing === undefined) {
          try {
            await view.members.append(encodeMember({ kind: NODE_TYPES.ADD_WRITER, ...decoded }))
          } catch (err) {
            this._log('failed to append member record', err)
            continue
          }

          this._members.set(decoded.writerKeyHex, decoded)
          this._membersLength = view.members.length
          this._membersDirty = true
          this.emit('member', {
            action: 'added',
            writerKey: decoded.writerKeyHex,
            identity: decoded.identityKeyHex,
            displayName: decoded.displayName
          })
        }
        continue
      }

      if (decoded.type === NODE_TYPES.MESSAGE) {
        let message

        try {
          message = decodeMessage(decoded.message, { roomKey: this.key })
        } catch (err) {
          this._log('discarding malformed message', err)
          continue
        }

        const messageId = message.messageId.toString('hex')

        try {
          const member = this._members.get(fromHex)

          if (member === undefined) {
            this._log('discarding message from an unmapped writer')
            continue
          }
          if (!b4a.equals(member.identityKey, message.sender)) {
            this._log('discarding message whose signer does not match the writer identity')
            continue
          }

          if (this._seen.has(message.messageId)) {
            this._log('discarding duplicate message')
            continue
          }

          let storedMedia = null

          if (message.media !== undefined) {
            if (this.mediaStore === null) {
              this._log('discarding message with media but no media store')
              continue
            }

            try {
              const stored = await this.mediaStore.store({
                messageId,
                mimeType: message.media.mimeType,
                size: message.media.size,
                sha256: message.media.sha256,
                bytes: message.media.bytes
              })
              const verified = await this.mediaStore.verify({
                path: stored.path,
                mimeType: stored.mimeType,
                size: stored.size,
                sha256: stored.sha256
              })

              storedMedia = {
                path: verified.path,
                mime_type: verified.mimeType,
                size: verified.size,
                sha256: verified.sha256
              }
            } catch (err) {
              this._log('discarding message with unstorable media', err)
              continue
            }
          }

          try {
            await view.messages.append(decoded.message)
          } catch (err) {
            if (storedMedia !== null) {
              try {
                await this.mediaStore.remove(storedMedia.path)
              } catch (removeErr) {
                this._log('failed to remove media for a rejected message', removeErr)
              }
            }
            this._log('failed to append message to the room view', err)
            continue
          }

          if (this._seen.add(message.messageId)) {
            const event = {
              messageId,
              roomKey: this.keyHex,
              sender: message.sender.toString('hex'),
              timestamp: message.timestamp,
              text: message.text
            }

            if (storedMedia !== null) {
              event.media = storedMedia
            }

            this.emit('message', event)
          }
        } finally {
          // The entry has been observed, whether it was accepted or rejected,
          // so it is no longer waiting to replicate.
          this._pendingMessages.delete(messageId)
        }
        continue
      }

      this._log(`discarding room node with unknown type ${String(decoded.type)}`)
    }
  }

  get writable () {
    return this.base !== null && this.base.writable
  }

  get peerCount () {
    return this._swarm !== null ? this._swarm.connections.size : this._peers.size
  }

  get queuedMessages () {
    return this._pendingMessages.size
  }

  members () {
    return [...this._members.values()].map((member) => ({
      writerKey: member.writerKeyHex,
      identity: member.identityKeyHex,
      displayName: member.displayName
    }))
  }

  isMember (identityKey) {
    const hex = toKey(identityKey, 'identityKey').toString('hex')
    for (const member of this._members.values()) {
      if (member.identityKeyHex === hex) return true
    }
    return false
  }

  status () {
    return {
      mode: 'autobase',
      roomKey: this.keyHex,
      discoveryKey: this.discoveryKeyHex,
      peerCount: this.peerCount,
      queuedMessages: this.queuedMessages,
      messageCount: this.base && this.base.view ? this.base.view.messages.length : 0,
      memberCount: this._members.size,
      writable: this.writable
    }
  }

  async register (opts = {}) {
    if (!this.writable) {
      throw new RoomError('NOT_WRITABLE', 'This bridge is not an authorized writer in the room')
    }

    const node = {
      type: NODE_TYPES.REGISTER,
      writerKey: this.writerKey,
      identityKey: this.identity.publicKey,
      displayName: opts.displayName
    }

    await this.base.append(encodeNode(node))
    await this.base.update()

    return {
      writerKey: this.writerKeyHex,
      identity: this.identity.publicKey.toString('hex'),
      displayName: normalizeDisplayName(opts.displayName)
    }
  }

  async addWriter (opts = {}) {
    if (!this.writable) {
      throw new RoomError('NOT_WRITABLE', 'This bridge is not an authorized writer in the room')
    }

    const writerKey = toKey(opts.writerKey, 'writerKey')
    const identityKey = toKey(opts.identityKey, 'identityKey')
    const displayName = normalizeDisplayName(opts.displayName)
    const node = {
      type: NODE_TYPES.ADD_WRITER,
      writerKey,
      identityKey,
      displayName
    }

    await this.base.append(encodeNode(node))
    await this.base.update()

    return {
      writerKey: writerKey.toString('hex'),
      identity: identityKey.toString('hex'),
      displayName
    }
  }

  async send (text, opts = {}) {
    if (!this.writable) {
      throw new RoomError('NOT_WRITABLE', 'This bridge is not an authorized writer in the room')
    }

    const fields = {
      roomKey: this.key,
      text,
      timestamp: opts.timestamp,
      messageId: opts.messageId
    }

    if (opts.media !== undefined && opts.media !== null) {
      fields.media = opts.media
    }

    const message = createMessage(fields, this.identity)
    const messageId = message.messageId.toString('hex')

    this._pendingMessages.add(messageId)

    try {
      await this.base.append(encodeNode({ type: NODE_TYPES.MESSAGE, message: encodeMessage(message) }))
    } catch (err) {
      this._pendingMessages.delete(messageId)
      const detail = err && err.message ? `: ${err.message}` : ''
      throw new RoomError('APPEND_FAILED', `Failed to append the message to the room${detail}`, err)
    }

    const replicatedPeers = this.peerCount

    return {
      messageId,
      roomKey: this.keyHex,
      timestamp: message.timestamp,
      replicatedPeers,
      queued: replicatedPeers === 0
    }
  }

  async flush () {
    if (this.base === null) return
    await this.base.flush()
    await this.base.update()
  }

  async join (swarm) {
    if (swarm === undefined || swarm === null) {
      throw new RoomError('SWARM_REQUIRED', 'room requires a Hyperswarm instance')
    }
    if (this._swarm !== null) return this._discovery

    const onConnection = (connection) => {
      this._replicate(connection)
      this.emit('peer', { peerCount: this.peerCount })
    }

    let discovery = null

    try {
      swarm.on('connection', onConnection)
      this._swarm = swarm
      this._onConnection = onConnection

      // Pairing may have opened connections before the room was known; they are
      // still usable for room replication.
      for (const connection of swarm.connections) {
        this._replicate(connection)
      }

      discovery = swarm.join(this.discoveryKey, { server: true, client: true })
      this._discovery = discovery
      await discovery.flushed()
    } catch (err) {
      swarm.off('connection', onConnection)
      this._swarm = null
      this._onConnection = null
      this._discovery = null

      if (discovery !== null) {
        try {
          await swarm.leave(this.discoveryKey)
        } catch (leaveErr) {
          this._log('failed to roll back the room topic subscription', leaveErr)
        }
      }

      throw err
    }

    return discovery
  }

  _replicate (connection) {
    try {
      const stream = this.store.replicate(connection)

      if (stream && typeof stream.on === 'function') {
        stream.on('error', (err) => {
          this._log('room replication stream failed', err)
        })
      }
    } catch (err) {
      this._log('failed to replicate room over a connection', err)
    }
  }

  async close () {
    if (this._closed) return
    this._closed = true

    if (this._swarm !== null && this._onConnection !== null) {
      this._swarm.off('connection', this._onConnection)
    }

    if (this._swarm !== null && this._discovery !== null) {
      try {
        await this._swarm.leave(this.discoveryKey)
      } catch (err) {
        this._log('failed to leave the room topic', err)
      }
    }

    this._peers.clear()

    if (this.base !== null) {
      try {
        await this.base.close()
      } catch (err) {
        this._log('failed to close the Autobase', err)
      }
    }

    if (this.store !== null) {
      try {
        await this.store.close()
      } catch (err) {
        this._log('failed to close the room store', err)
      }
    }

    this.store = null
    this.session = null
    this.base = null
    this._swarm = null
    this._discovery = null
    this._onConnection = null

    if (this._ownsMediaStore && this.mediaStore !== null) {
      try {
        await this.mediaStore.close()
      } catch (err) {
        this._log('failed to close the media store', err)
      }
      this.mediaStore = null
    }
  }
}

module.exports = {
  ROOM_VERSION,
  NODE_VERSION,
  MEMBER_VERSION,
  NODE_TYPES,
  NODE_TYPE_NAMES,
  RoomError,
  Room,
  encodeNode,
  decodeNode,
  encodeMember,
  decodeMember,
  createRoomMetadata,
  normalizeRoomMetadata,
  readRoomMetadata,
  loadRoomMetadata,
  saveRoomMetadata,
  resolveWriterKey
}
