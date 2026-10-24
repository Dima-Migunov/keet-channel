'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')

const b4a = require('b4a')
const BlindPairing = require('blind-pairing')
const crypto = require('hypercore-crypto')

const { createInvite, decodeInviteUrl } = require('./invite')
const {
  StorageError,
  dataPaths,
  ensureMode,
  readJsonFile,
  writeJsonAtomic
} = require('./identity')
const { createErrorClass } = require('./errors')
const { KEY_BYTES, isKeyHex, normalizeKey } = require('./keys')

const PAIRING_VERSION = 1
const USER_DATA_VERSION = 1
const ALLOWLIST_VERSION = 2
const MAX_USER_DATA_BYTES = 1024
const MAX_DISPLAY_NAME_BYTES = 256
const DEFAULT_PENDING_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_JOIN_TIMEOUT_MS = 60 * 1000
const DEFAULT_CHECK_INTERVAL_MS = 1000
const MAX_PAIRING_HISTORY = 200
const MAX_PAIRING_REQUESTS = 128

const PairingError = createErrorClass('PairingError')

function toKey (value, field) {
  return normalizeKey(value, field, PairingError)
}

function normalizeDisplayName (value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new PairingError('INVALID_DISPLAY_NAME', 'displayName must be a string')
  }
  if (b4a.byteLength(value, 'utf-8') > MAX_DISPLAY_NAME_BYTES) {
    throw new PairingError(
      'INVALID_DISPLAY_NAME',
      `displayName must be at most ${MAX_DISPLAY_NAME_BYTES} UTF-8 bytes`
    )
  }
  return value
}

function encodeUserData (fields) {
  if (!fields || typeof fields !== 'object') {
    throw new PairingError('INVALID_USER_DATA', 'user data fields must be an object')
  }

  const value = {
    version: USER_DATA_VERSION,
    identityKey: toKey(fields.identityKey, 'identityKey').toString('hex'),
    writerKey: toKey(fields.writerKey, 'writerKey').toString('hex')
  }
  const displayName = normalizeDisplayName(fields.displayName)

  if (displayName !== '') value.displayName = displayName

  const buffer = b4a.from(JSON.stringify(value), 'utf-8')

  if (buffer.byteLength > MAX_USER_DATA_BYTES) {
    throw new PairingError(
      'USER_DATA_TOO_LARGE',
      `user data must be at most ${MAX_USER_DATA_BYTES} bytes`
    )
  }

  return buffer
}

function decodeUserData (buffer) {
  if (!b4a.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new PairingError('INVALID_USER_DATA', 'user data must be a buffer')
  }
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_USER_DATA_BYTES) {
    throw new PairingError('INVALID_USER_DATA', 'user data has an invalid length')
  }

  let value

  try {
    value = JSON.parse(b4a.toString(buffer, 'utf-8'))
  } catch {
    throw new PairingError('INVALID_USER_DATA', 'user data is not valid JSON')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PairingError('INVALID_USER_DATA', 'user data must be a JSON object')
  }
  if (value.version !== USER_DATA_VERSION) {
    throw new PairingError('INVALID_USER_DATA', 'user data has an unsupported version')
  }
  if (!isKeyHex(value.identityKey)) {
    throw new PairingError('INVALID_USER_DATA', 'user data identityKey is invalid')
  }
  if (!isKeyHex(value.writerKey)) {
    throw new PairingError('INVALID_USER_DATA', 'user data writerKey is invalid')
  }

  let displayName

  try {
    displayName = normalizeDisplayName(value.displayName)
  } catch (err) {
    throw new PairingError('INVALID_USER_DATA', `user data ${err.message}`)
  }

  return {
    version: USER_DATA_VERSION,
    identityKey: value.identityKey,
    identityKeyHex: value.identityKey,
    writerKey: value.writerKey,
    writerKeyHex: value.writerKey,
    displayName
  }
}

// Accepts a comma-separated list, trims and lowercases entries, and reports
// invalid entries instead of silently granting them.
function parseAllowedUsers (value) {
  if (value === undefined || value === null) return { identities: [], invalid: [] }
  if (typeof value !== 'string') {
    return { identities: [], invalid: [String(value)] }
  }

  const identities = []
  const invalid = []

  for (const entry of value.split(',')) {
    const normalized = entry.trim().toLowerCase()

    if (normalized === '') continue
    if (!isKeyHex(normalized)) {
      invalid.push(entry.trim())
      continue
    }
    if (!identities.includes(normalized)) identities.push(normalized)
  }

  return { identities, invalid }
}

function resolveAclFile (opts = {}) {
  if (opts.aclFile) return path.resolve(opts.aclFile)
  if (opts.env && opts.env.KEET_ACL_FILE) return path.resolve(opts.env.KEET_ACL_FILE)
  if (opts.dataDir) return dataPaths(path.resolve(opts.dataDir)).allowedFile
  return null
}

function normalizeAclState (value, file) {
  let identities
  let revoked = []

  if (Array.isArray(value)) {
    identities = value
  } else if (value && typeof value === 'object' && Array.isArray(value.identities)) {
    if (value.version !== undefined && value.version !== 1 && value.version !== ALLOWLIST_VERSION) {
      throw new StorageError(
        'INVALID_ALLOWLIST',
        `Invalid allowlist at ${file}: unsupported version ${value.version}`
      )
    }
    identities = value.identities
    if (value.revoked !== undefined) {
      if (!Array.isArray(value.revoked)) {
        throw new StorageError(
          'INVALID_ALLOWLIST',
          `Invalid allowlist at ${file}: revoked must be an array`
        )
      }
      revoked = value.revoked
    }
  } else {
    throw new StorageError(
      'INVALID_ALLOWLIST',
      `Invalid allowlist at ${file}: expected an identities array`
    )
  }

  const allowed = []
  const denied = []

  for (const record of identities) {
    if (isKeyHex(record) && !allowed.includes(record)) allowed.push(record)
  }
  for (const record of revoked) {
    if (isKeyHex(record) && !denied.includes(record)) denied.push(record)
  }

  return {
    identities: allowed.sort(),
    revoked: denied.sort()
  }
}

function loadAcl (opts = {}) {
  const file = resolveAclFile(opts)

  if (file === null) return { identities: [], revoked: [] }

  let value

  try {
    value = readJsonFile(file, 'allowlist')
  } catch (err) {
    if (err.code === 'ENOENT') return { identities: [], revoked: [] }
    throw err
  }

  return normalizeAclState(value, file)
}

function saveAcl (state, opts = {}) {
  const file = resolveAclFile(opts)

  if (file === null) {
    throw new PairingError('ACL_FILE_REQUIRED', 'an allowlist file path or data directory is required')
  }

  const normalized = normalizeAclState(
    {
      version: ALLOWLIST_VERSION,
      identities: Array.isArray(state) ? state : state && state.identities,
      revoked: state && !Array.isArray(state) ? state.revoked || [] : []
    },
    file
  )

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeJsonAtomic(file, {
    version: ALLOWLIST_VERSION,
    identities: normalized.identities,
    revoked: normalized.revoked
  })
  ensureMode(file, 0o600)

  return normalized
}

function loadAllowedIdentities (opts = {}) {
  return loadAcl(opts).identities
}

function saveAllowedIdentities (identities, opts = {}) {
  const current = loadAcl(opts)
  const next = new Set(current.identities)

  for (const identity of identities) {
    next.add(toKey(identity, 'identityKey').toString('hex'))
  }

  return saveAcl(
    {
      identities: [...next],
      revoked: current.revoked
    },
    opts
  ).identities
}

function publicRequest (entry) {
  return {
    request_id: entry.requestId,
    requestId: entry.requestId,
    invitation_id: entry.invitationId,
    identity: entry.identity,
    writer_key: entry.writerKey,
    display_name: entry.displayName,
    created_at: entry.createdAt,
    expires_at: entry.expiresAt,
    status: entry.status
  }
}

class Pairing extends EventEmitter {
  constructor (opts = {}) {
    super()

    this.swarm = opts.swarm || null
    this.identity = opts.identity || null
    this.room = opts.room || null

    const env = opts.env || process.env
    this.env = env

    this.dataDir = opts.dataDir
      ? path.resolve(opts.dataDir)
      : opts.room
        ? path.resolve(opts.room.dataDir)
        : null
    this.aclFile = resolveAclFile({ dataDir: this.dataDir, aclFile: opts.aclFile, env })
    this.allowAll =
      opts.allowAll === undefined
        ? env.KEET_ALLOW_ALL_USERS === 'true'
        : opts.allowAll === true
    this.pendingTimeoutMs = positiveInt(
      opts.pendingTimeoutMs !== undefined ? opts.pendingTimeoutMs : env.KEET_PAIRING_TIMEOUT_MS,
      DEFAULT_PENDING_TIMEOUT_MS
    )
    this.joinTimeoutMs = positiveInt(
      opts.joinTimeoutMs !== undefined ? opts.joinTimeoutMs : env.KEET_PAIRING_JOIN_TIMEOUT_MS,
      DEFAULT_JOIN_TIMEOUT_MS
    )
    this.checkIntervalMs = positiveInt(
      opts.checkIntervalMs,
      Math.max(10, Math.min(DEFAULT_CHECK_INTERVAL_MS, this.pendingTimeoutMs))
    )
    this.poll = opts.poll
    this.format = opts.format
    this.now = typeof opts.now === 'function' ? opts.now : Date.now
    this.log =
      typeof opts.log === 'function'
        ? opts.log
        : (message) => console.error(`[pairing] ${message}`)

    this._blind = null
    this._invites = new Map()
    this._pending = new Map()
    this._history = new Map()
    this._timer = null
    this._closed = false
    this._allowAllWarned = false
    this._configured = new Set()
    this._persisted = new Set()
    this._revoked = new Set()
    this._allowed = new Set()
    this._aclQueue = Promise.resolve()
    this._releasedCandidates = new WeakSet()

    this._loadAllowed(opts.allowedUsers !== undefined ? opts.allowedUsers : env.KEET_ALLOWED_USERS)
  }

  get inviteUrl () {
    for (const entry of this._invites.values()) return entry.invite.url
    return null
  }

  get pendingCount () {
    return this._pending.size
  }

  invites () {
    return [...this._invites.values()].map((entry) => ({
      invitationId: entry.invite.invitationId,
      invitation_id: entry.invite.invitationId,
      url: entry.invite.url,
      room_key: entry.invite.roomKeyHex,
      expires: entry.invite.expires,
      format: entry.invite.format
    }))
  }

  _loadAllowed (configured) {
    const { identities, invalid } = parseAllowedUsers(configured)

    for (const entry of invalid) {
      this.log(`ignoring invalid KEET_ALLOWED_USERS entry: ${JSON.stringify(entry).slice(0, 80)}`)
    }

    let persisted = { identities: [], revoked: [] }

    try {
      persisted = loadAcl({ aclFile: this.aclFile, dataDir: this.dataDir })
    } catch (err) {
      this.log(`could not load the persisted allowlist: ${err.message}`)
    }

    this._configured = new Set(identities)
    this._persisted = new Set(persisted.identities)
    this._revoked = new Set(persisted.revoked)
    this._rebuildAllowed()
    return this._allowed
  }

  _rebuildAllowed () {
    const allowed = new Set([...this._configured, ...this._persisted])

    for (const identity of this._revoked) allowed.delete(identity)

    this._allowed = allowed
    return allowed
  }

  reloadAllowed () {
    return this._loadAllowed(this.env.KEET_ALLOWED_USERS)
  }

  isAllowed (identityKey) {
    return this._allowed.has(toKey(identityKey, 'identityKey').toString('hex'))
  }

  _enqueueAcl (operation) {
    const run = this._aclQueue.then(operation, operation)

    this._aclQueue = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  _aclIdentity (value) {
    try {
      return toKey(value, 'identityKey').toString('hex')
    } catch (err) {
      throw new PairingError('INVALID_IDENTITY', err.message)
    }
  }

  _aclEntry (identity) {
    const revoked = this._revoked.has(identity)
    const configured = this._configured.has(identity)

    return {
      identity,
      source: configured ? 'config' : 'runtime',
      revoked,
      authorized: !revoked && this._allowed.has(identity)
    }
  }

  _aclSnapshot () {
    const known = new Set([...this._configured, ...this._persisted, ...this._revoked])
    const entries = [...known].sort().map((identity) => this._aclEntry(identity))

    return {
      entries,
      identities: [...this._allowed].sort(),
      revoked: [...this._revoked].sort(),
      count: this._allowed.size
    }
  }

  _saveAclState (identities, revoked) {
    try {
      saveAcl({ identities, revoked }, { aclFile: this.aclFile })
    } catch (err) {
      const error = new PairingError(
        'ACL_PERSIST_FAILED',
        `could not persist the allowlist: ${err.message}`
      )
      error.cause = err
      throw error
    }
  }

  async aclAdd (value) {
    const identity = this._aclIdentity(value)

    return this._enqueueAcl(async () => {
      const identities = new Set(this._persisted)
      const revoked = new Set(this._revoked)

      identities.add(identity)
      revoked.delete(identity)
      this._saveAclState([...identities].sort(), [...revoked].sort())

      this._persisted = identities
      this._revoked = revoked
      this._rebuildAllowed()

      return this._aclEntry(identity)
    })
  }

  async aclRemove (value) {
    const identity = this._aclIdentity(value)

    return this._enqueueAcl(async () => {
      const identities = new Set(this._persisted)
      const revoked = new Set(this._revoked)

      identities.delete(identity)
      revoked.add(identity)
      this._saveAclState([...identities].sort(), [...revoked].sort())

      this._persisted = identities
      this._revoked = revoked
      this._rebuildAllowed()

      return this._aclEntry(identity)
    })
  }

  async aclList () {
    return this._enqueueAcl(async () => this._aclSnapshot())
  }

  async _persistApproved (identity) {
    return this._enqueueAcl(async () => {
      const identities = new Set(this._persisted)
      const revoked = new Set(this._revoked)

      identities.add(identity)
      revoked.delete(identity)
      this._saveAclState([...identities].sort(), [...revoked].sort())

      this._persisted = identities
      this._revoked = revoked
      this._rebuildAllowed()
    })
  }

  async start (opts = {}) {
    if (this._closed) {
      throw new PairingError('PAIRING_CLOSED', 'pairing has been closed')
    }

    if (this._blind === null) {
      if (this.swarm === null) {
        throw new PairingError('SWARM_REQUIRED', 'pairing requires a Hyperswarm instance')
      }

      const blind = this._createBlindPairing()

      try {
        await blind.ready()
      } catch (err) {
        try {
          await blind.close()
        } catch (closeError) {
          this.log(`failed to close blind pairing after a failed start: ${closeError.message}`)
        }
        throw err
      }

      this._blind = blind
    }

    if (this._timer === null) {
      this._timer = setInterval(() => this._expirePending(), this.checkIntervalMs)
      if (typeof this._timer.unref === 'function') this._timer.unref()
    }

    if (this.room !== null && this._invites.size === 0) {
      return this.createInvite(opts)
    }

    return null
  }

  _createBlindPairing () {
    return new BlindPairing(this.swarm, { poll: this.poll })
  }

  async createInvite (opts = {}) {
    if (this._closed) {
      throw new PairingError('PAIRING_CLOSED', 'pairing has been closed')
    }
    if (this.room === null) {
      throw new PairingError('ROOM_REQUIRED', 'creating an invite requires a room')
    }

    if (this._blind === null) {
      await this.start()
    }

    // blind-pairing allows one active member per discovery key.
    await this.cancelInvite(undefined, 'replaced')

    const invite = createInvite({
      roomKey: this.room.key,
      encryptionKey: this.room.encryptionKey,
      expires: opts.expires,
      format: opts.format === undefined ? this.format : opts.format,
      seed: opts.seed,
      sensitive: opts.sensitive,
      testInvitation: opts.testInvitation,
      additionalNodes: opts.additionalNodes
    })

    const member = this._blind.addMember({
      discoveryKey: invite.discoveryKey,
      onadd: (request) => this._onRequest(request, invite)
    })

    try {
      await member.ready()
    } catch (err) {
      try {
        await member.close()
      } catch (closeError) {
        this.log(`failed to close an invite listener after a failed start: ${closeError.message}`)
      }
      throw err
    }

    const entry = { invite, member }
    this._invites.set(invite.invitationId, entry)

    const result = {
      invitationId: invite.invitationId,
      invitation_id: invite.invitationId,
      url: invite.url,
      roomKey: invite.roomKeyHex,
      room_key: invite.roomKeyHex,
      discoveryKey: invite.discoveryKeyHex,
      discovery_key: invite.discoveryKeyHex,
      expires: invite.expires,
      format: invite.format
    }

    this.emit('invite_created', result)

    return result
  }

  async cancelInvite (invitationId, reason = 'cancelled') {
    const entries = []

    if (invitationId === undefined || invitationId === null) {
      for (const entry of this._invites.values()) entries.push(entry)
    } else {
      const entry = this._invites.get(invitationId)
      if (entry === undefined) {
        throw new PairingError('UNKNOWN_INVITE', 'unknown invitation id')
      }
      entries.push(entry)
    }

    for (const entry of entries) {
      this._invites.delete(entry.invite.invitationId)
      let denied = 0

      for (const pending of [...this._pending.values()]) {
        if (pending.invitationId !== entry.invite.invitationId) continue
        await this._settleDenied(pending, reason, 1)
        denied++
      }

      // Let the denial responses reach the candidates before the member
      // listener (and its channels) is torn down.
      if (denied > 0) await delay(100)

      try {
        await entry.member.close()
      } catch (err) {
        this.log(`failed to close an invite listener: ${err.message}`)
      }

      this.emit('invite_cancelled', {
        invitationId: entry.invite.invitationId,
        invitation_id: entry.invite.invitationId,
        reason
      })
    }

    return entries.length
  }

  list () {
    const records = []

    for (const entry of this._pending.values()) records.push(publicRequest(entry))
    for (const record of this._history.values()) records.push({ ...record })

    return records
  }

  pending () {
    return [...this._pending.values()].map(publicRequest)
  }

  async accept (requestId) {
    const entry = this._pending.get(requestId)

    if (entry === undefined) {
      throw new PairingError('UNKNOWN_PAIRING_REQUEST', 'unknown or already resolved pairing request')
    }

    this._pending.delete(requestId)

    let record

    try {
      record = await this._confirm(entry.request, entry, {
        persist: true,
        reason: 'accepted'
      })
    } finally {
      entry.resolveDecision()
    }

    if (record.status !== 'accepted') {
      throw new PairingError(
        record.reason === 'not_writable' ? 'NOT_WRITABLE' : 'PAIRING_FAILED',
        record.message || 'the candidate could not be confirmed'
      )
    }

    return { ...record }
  }

  async decline (requestId) {
    const entry = this._pending.get(requestId)

    if (entry === undefined) {
      throw new PairingError('UNKNOWN_PAIRING_REQUEST', 'unknown or already resolved pairing request')
    }

    return this._settleDenied(entry, 'declined', 1)
  }

  _recordHistory (record) {
    this._history.set(record.requestId, record)

    while (this._history.size > MAX_PAIRING_HISTORY) {
      const oldest = this._history.keys().next().value
      this._history.delete(oldest)
    }
  }

  async _settleDenied (entry, reason, status) {
    this._pending.delete(entry.requestId)

    try {
      entry.request.deny({ status })
    } catch (err) {
      this.log(`failed to deny a pairing request: ${err.message}`)
    }

    entry.resolveDecision()

    const record = {
      request_id: entry.requestId,
      requestId: entry.requestId,
      invitation_id: entry.invitationId,
      identity: entry.identity,
      writer_key: entry.writerKey,
      display_name: entry.displayName,
      status: reason === 'expired' ? 'expired' : reason === 'cancelled' ? 'cancelled' : 'declined',
      reason,
      resolved_at: this.now()
    }

    this._recordHistory(record)
    this.emit(reason === 'expired' ? 'pairing_expired' : 'pairing_declined', record)

    return { ...record }
  }

  async _onRequest (request, invite) {
    let userData

    if (!this._invites.has(invite.invitationId)) {
      try {
        request.deny({ status: 1 })
      } catch {}
      return
    }

    try {
      request.open(invite.publicKey)
      userData = decodeUserData(request.userData)
    } catch (err) {
      try {
        request.deny({ status: 1 })
      } catch {}

      const rejection = {
        reason: err.code || 'INVALID_USER_DATA',
        message: err.message
      }

      this.log(`rejected a candidate: ${rejection.message}`)
      this.emit('pairing_rejected', rejection)
      return
    }

    const entry = {
      requestId: request.id.toString('hex'),
      invitationId: invite.invitationId,
      request,
      identity: userData.identityKeyHex,
      writerKey: userData.writerKeyHex,
      displayName: userData.displayName,
      createdAt: this.now(),
      expiresAt: 0,
      status: 'pending',
      resolveDecision: null
    }

    const pendingExpiry = entry.createdAt + this.pendingTimeoutMs
    const inviteExpiry = invite.expires === 0 ? Infinity : invite.expires

    entry.expiresAt = Math.min(pendingExpiry, inviteExpiry)

    if (this._allowed.has(entry.identity)) {
      return this._confirm(request, entry, {
        persist: false,
        reason: 'allowlisted'
      })
    }

    if (this.allowAll && !this._revoked.has(entry.identity)) {
      this._warnAllowAll()
      return this._confirm(request, entry, {
        persist: false,
        reason: 'allow_all'
      })
    }

    entry.decision = new Promise((resolve) => { entry.resolveDecision = resolve })
    this._pending.set(entry.requestId, entry)
    this.emit('pairing_request', publicRequest(entry))

    await entry.decision
  }

  async _confirm (request, entry, opts) {
    if (this.room === null || !this.room.writable) {
      return this._rejectConfirmation(entry, request, 'not_writable')
    }

    try {
      await this.room.addWriter({
        writerKey: entry.writerKey,
        identityKey: entry.identity,
        displayName: entry.displayName
      })
    } catch (err) {
      this.log(`could not add the candidate writer: ${err.message}`)
      return this._rejectConfirmation(entry, request, 'add_writer_failed', err.message)
    }

    request.confirm({
      key: this.room.key,
      encryptionKey: this.room.encryptionKey
    })

    if (opts.persist) {
      try {
        await this._persistApproved(entry.identity)
      } catch (err) {
        this.log(`could not persist the accepted identity: ${err.message}`)
      }
    }

    const record = {
      request_id: entry.requestId,
      requestId: entry.requestId,
      invitation_id: entry.invitationId,
      identity: entry.identity,
      writer_key: entry.writerKey,
      display_name: entry.displayName,
      status: 'accepted',
      reason: opts.reason,
      persisted: opts.persist === true,
      accepted_at: this.now()
    }

    this._recordHistory(record)
    this.emit('pairing_confirmed', record)

    return record
  }

  _rejectConfirmation (entry, request, reason, message) {
    try {
      request.deny({ status: 1 })
    } catch {}

    const record = {
      request_id: entry.requestId,
      requestId: entry.requestId,
      invitation_id: entry.invitationId,
      identity: entry.identity,
      writer_key: entry.writerKey,
      display_name: entry.displayName,
      status: 'declined',
      reason,
      message,
      resolved_at: this.now()
    }

    this._recordHistory(record)
    this.emit('pairing_declined', record)

    return record
  }

  _warnAllowAll () {
    if (this._allowAllWarned) return
    this._allowAllWarned = true
    this.log(
      'WARNING: KEET_ALLOW_ALL_USERS=true is active; any identity can pair and send messages. This development override is never persisted.'
    )
  }

  _expirePending () {
    if (this._pending.size === 0) return

    const now = this.now()

    for (const entry of [...this._pending.values()]) {
      if (entry.expiresAt > now) continue
      this._settleDenied(entry, 'expired', 3).catch((err) => {
        this.log(`failed to expire a pairing request: ${err.message}`)
      })
    }
  }

  async joinInvite (url, opts = {}) {
    if (this._closed) {
      throw new PairingError('PAIRING_CLOSED', 'pairing has been closed')
    }
    if (this.identity === null) {
      throw new PairingError('IDENTITY_REQUIRED', 'joining an invite requires an identity')
    }
    if (this._blind === null) {
      await this.start()
    }

    const invite = decodeInviteUrl(url, {
      now: this.now(),
      roomKey: opts.expectedRoomKey
    })
    const writerKey = toKey(opts.writerKey, 'writerKey')
    const timeoutMs = positiveInt(opts.timeoutMs, this.joinTimeoutMs)
    const userData = encodeUserData({
      identityKey: this.identity.publicKey,
      writerKey,
      displayName: opts.displayName
    })

    let candidate = null
    let paired = false

    try {
      try {
        candidate = this._blind.addCandidate({
          invite: invite.standardInvite,
          userData
        })
        await candidate.ready()
      } catch (err) {
        throw new PairingError('PAIRING_FAILED', `could not start candidate pairing: ${err.message}`)
      }

      const auth = await this._awaitCandidate(candidate, timeoutMs)

      if (!auth || !auth.key) {
        throw new PairingError('PAIRING_FAILED', 'candidate pairing returned no room key')
      }
      if (!b4a.equals(cryptoDiscoveryKey(auth.key), invite.discoveryKey)) {
        throw new PairingError('DISCOVERY_KEY_MISMATCH', 'the paired room does not match the invite')
      }
      if (!auth.encryptionKey || auth.encryptionKey.byteLength !== KEY_BYTES) {
        throw new PairingError('ENCRYPTION_KEY_MISSING', 'the paired room returned no encryption key')
      }
      if (
        invite.encryptionKey !== null &&
        !b4a.equals(invite.encryptionKey, auth.encryptionKey)
      ) {
        throw new PairingError(
          'ENCRYPTION_KEY_MISMATCH',
          'the paired room encryption key does not match the invite'
        )
      }

      paired = true

      return {
        invitationId: invite.invitationId,
        invitation_id: invite.invitationId,
        discoveryKey: invite.discoveryKey,
        discovery_key: invite.discoveryKeyHex,
        roomKey: auth.key,
        room_key: auth.key.toString('hex'),
        encryptionKey: auth.encryptionKey,
        encryption_key: auth.encryptionKey.toString('hex'),
        data: auth.data,
        writerKey,
        writer_key: writerKey.toString('hex')
      }
    } finally {
      if (candidate !== null && !paired) {
        await this._closeCandidate(candidate)
      }
    }
  }

  async _closeCandidate (candidate) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      this._releasedCandidates.has(candidate)
    ) {
      return
    }

    this._releasedCandidates.add(candidate)

    try {
      await candidate.close()
    } catch (err) {
      this.log(`failed to close a pairing candidate: ${err.message}`)
    }
  }

  _awaitCandidate (candidate, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false

      const finish = (err, auth) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        candidate.request.removeListener('rejected', onRejected)

        if (err) reject(err)
        else resolve(auth)
      }

      const onRejected = (err) => {
        finish(pairingErrorFor(err))
      }

      const timer = setTimeout(() => {
        finish(new PairingError('PAIRING_TIMEOUT', 'candidate pairing timed out'))
      }, timeoutMs)

      if (typeof timer.unref === 'function') timer.unref()

      candidate.request.once('rejected', onRejected)

      candidate.pairing.then(
        (auth) => finish(null, auth),
        (err) => finish(pairingErrorFor(err))
      )
    })
  }

  async close () {
    if (this._closed) return
    this._closed = true

    if (this._timer !== null) {
      clearInterval(this._timer)
      this._timer = null
    }

    for (const entry of [...this._pending.values()]) {
      await this._settleDenied(entry, 'cancelled', 1)
    }

    for (const entry of [...this._invites.values()]) {
      this._invites.delete(entry.invite.invitationId)
      try {
        await entry.member.close()
      } catch (err) {
        this.log(`failed to close an invite listener: ${err.message}`)
      }
    }

    if (this._blind !== null) {
      try {
        await this._blind.close()
      } catch (err) {
        this.log(`failed to close blind pairing: ${err.message}`)
      }
      this._blind = null
    }
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveInt (value, fallback) {
  const number = typeof value === 'string' ? Number(value) : value

  if (!Number.isSafeInteger(number) || number <= 0) return fallback

  return number
}

function cryptoDiscoveryKey (key) {
  return crypto.discoveryKey(key)
}

function pairingErrorFor (err) {
  const code = err && err.code

  if (code === 'PAIRING_REJECTED' || code === 'INVITE_EXPIRED' || code === 'INVITE_USED') {
    return new PairingError(code, err.message)
  }

  return new PairingError(
    'PAIRING_FAILED',
    err && err.message ? `candidate pairing failed: ${err.message}` : 'candidate pairing failed'
  )
}

module.exports = {
  PAIRING_VERSION,
  USER_DATA_VERSION,
  ALLOWLIST_VERSION,
  MAX_USER_DATA_BYTES,
  MAX_DISPLAY_NAME_BYTES,
  DEFAULT_PENDING_TIMEOUT_MS,
  DEFAULT_JOIN_TIMEOUT_MS,
  PairingError,
  Pairing,
  encodeUserData,
  decodeUserData,
  parseAllowedUsers,
  resolveAclFile,
  loadAcl,
  saveAcl,
  loadAllowedIdentities,
  saveAllowedIdentities
}
