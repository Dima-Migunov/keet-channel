'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const blindPairing = require('blind-pairing-core')
const keetInvitation = require('./keet-invitation')

const { createErrorClass } = require('./errors')
const { KEY_BYTES, normalizeKey: normalizeProtocolKey } = require('./keys')

const INVITE_PREFIX = 'keet://chat/'
const KEET_FLAG_MASK = 0x60
const EXTENSION_MARKER = 148
const EXTENSION_BYTES = 33
const FORMATS = ['keet', 'standard']
const DEFAULT_FORMAT = 'keet'
const MAX_INVITE_BYTES = 65536
const MAX_INVITE_CHARS = Math.ceil((MAX_INVITE_BYTES * 8) / 5)
const MIN_STANDARD_BYTES = 34

const InviteError = createErrorClass('InviteError')

function normalizeKey (value, field) {
  return normalizeProtocolKey(value, field, InviteError)
}

function normalizeFormat (value) {
  if (value === undefined || value === null || value === '') return DEFAULT_FORMAT

  const format = String(value).trim().toLowerCase()

  if (!FORMATS.includes(format)) {
    throw new InviteError(
      'INVALID_FORMAT',
      `invite format must be one of: ${FORMATS.join(', ')}`
    )
  }

  return format
}

function resolveFormat (opts = {}, env = process.env) {
  return normalizeFormat(opts.format === undefined ? env.KEET_INVITE_FORMAT : opts.format)
}

function readPrefix (buffer) {
  const state = c.state(0, buffer.byteLength, buffer)

  try {
    const version = c.uint.decode(state)

    if (version !== 1) {
      throw new InviteError('INVALID_INVITE', 'unsupported invite version')
    }

    return { version, flags: c.uint.decode(state) }
  } catch (err) {
    if (err instanceof InviteError) throw err
    throw new InviteError('TRUNCATED_INVITE', 'invite is truncated or malformed')
  }
}

function withFlags (invite, mask) {
  const state = c.state(0, invite.byteLength, invite)

  c.uint.decode(state) // version, validated by blind-pairing-core
  const flagsStart = state.start
  const flags = c.uint.decode(state)
  const flagsEnd = state.start

  return b4a.concat([
    invite.subarray(0, flagsStart),
    c.encode(c.uint, flags | mask),
    invite.subarray(flagsEnd)
  ])
}

function encodeInviteUrl (invite) {
  if (!b4a.isBuffer(invite) && !(invite instanceof Uint8Array)) {
    throw new InviteError('INVALID_INVITE', 'invite must be a buffer')
  }

  if (invite.byteLength === 0 || invite.byteLength > MAX_INVITE_BYTES) {
    throw new InviteError('INVALID_INVITE', 'invite has an invalid length')
  }

  return INVITE_PREFIX + z32.encode(invite)
}

function createInvite (opts = {}) {
  const roomKey = normalizeKey(opts.roomKey, 'roomKey')
  const encryptionKey =
    opts.encryptionKey === undefined
      ? crypto.randomBytes(KEY_BYTES)
      : normalizeKey(opts.encryptionKey, 'encryptionKey')
  const format = resolveFormat(opts)
  const expires = opts.expires === undefined ? 0 : opts.expires

  if (!Number.isSafeInteger(expires) || expires < 0) {
    throw new InviteError('INVALID_EXPIRY', 'expires must be a non-negative epoch time in milliseconds')
  }

  const standard = blindPairing.createInvite(roomKey, {
    expires,
    seed:
      opts.seed === undefined ? undefined : normalizeKey(opts.seed, 'seed'),
    sensitive: opts.sensitive === true,
    testInvitation: opts.testInvitation === true,
    additionalNodes: opts.additionalNodes
  })
  const flags = readPrefix(standard.invite).flags

  let inviteBytes

  if (format === 'keet') {
    inviteBytes = b4a.concat([
      withFlags(standard.invite, KEET_FLAG_MASK),
      b4a.from([EXTENSION_MARKER]),
      encryptionKey
    ])
  } else {
    if ((flags & KEET_FLAG_MASK) !== 0) {
      throw new InviteError(
        'INVALID_FORMAT',
        'standard invite unexpectedly contains Keet envelope flag bits'
      )
    }
    inviteBytes = standard.invite
  }

  const decoded = blindPairing.decodeInvite(standard.invite)

  return {
    url: encodeInviteUrl(inviteBytes),
    format,
    invitationId: decoded.id.toString('hex'),
    inviteId: decoded.id,
    roomKey,
    roomKeyHex: roomKey.toString('hex'),
    encryptionKey,
    encryptionKeyHex: encryptionKey.toString('hex'),
    discoveryKey: decoded.discoveryKey,
    discoveryKeyHex: decoded.discoveryKey.toString('hex'),
    publicKey: standard.publicKey,
    expires: decoded.expires,
    sensitive: decoded.sensitive,
    testInvitation: decoded.testInvitation,
    flags,
    inviteBytes
  }
}

function decodeInvitePayload (inviteBytes, opts = {}) {
  if (!b4a.isBuffer(inviteBytes) && !(inviteBytes instanceof Uint8Array)) {
    throw new InviteError('INVALID_INVITE', 'invite must be a buffer')
  }
  if (inviteBytes.byteLength < MIN_STANDARD_BYTES) {
    throw new InviteError('TRUNCATED_INVITE', 'invite is truncated')
  }
  if (inviteBytes.byteLength > MAX_INVITE_BYTES) {
    throw new InviteError('INVITE_TOO_LARGE', 'invite is too large')
  }

  const { flags } = readPrefix(inviteBytes)
  let decoded

  try {
    decoded = blindPairing.decodeInvite(inviteBytes)
  } catch (err) {
    const detail = err && err.message ? err.message : ''

    if (/out of bounds/i.test(detail)) {
      throw new InviteError('TRUNCATED_INVITE', 'invite is truncated or malformed')
    }

    throw new InviteError('INVALID_INVITE', 'invite could not be decoded')
  }

  const state = c.state(0, inviteBytes.byteLength, inviteBytes)

  try {
    blindPairing.Invite.decode(state)
  } catch (err) {
    throw new InviteError('INVALID_INVITE', 'invite could not be decoded')
  }

  const used = state.start
  const remainder = inviteBytes.subarray(used)
  const hasKeetFlags = (flags & KEET_FLAG_MASK) !== 0
  let format
  let encryptionKey = null

  if (hasKeetFlags) {
    if ((flags & KEET_FLAG_MASK) !== KEET_FLAG_MASK) {
      throw new InviteError('INVALID_FLAGS', 'invite has an inconsistent Keet envelope')
    }
    if (remainder.byteLength < EXTENSION_BYTES) {
      throw new InviteError('TRUNCATED_INVITE', 'invite is missing its Keet extension')
    }
    if (remainder.byteLength > EXTENSION_BYTES) {
      throw new InviteError('INVALID_EXTENSION', 'invite has trailing bytes')
    }
    if (remainder[0] !== EXTENSION_MARKER) {
      throw new InviteError('INVALID_EXTENSION', 'invite has an invalid Keet extension')
    }

    format = 'keet'
    encryptionKey = b4a.from(remainder.subarray(1))
  } else {
    if (remainder.byteLength !== 0) {
      throw new InviteError('TRAILING_BYTES', 'invite has trailing bytes')
    }
    format = 'standard'
  }

  if (!decoded.discoveryKey) {
    throw new InviteError('MISSING_DISCOVERY_KEY', 'invite does not contain a discovery key')
  }

  const expectedDiscoveryKey =
    opts.expectedDiscoveryKey === undefined
      ? null
      : normalizeKey(opts.expectedDiscoveryKey, 'expectedDiscoveryKey')
  const expectedRoomKey =
    opts.roomKey === undefined ? null : normalizeKey(opts.roomKey, 'roomKey')

  if (
    expectedDiscoveryKey !== null &&
    !b4a.equals(decoded.discoveryKey, expectedDiscoveryKey)
  ) {
    throw new InviteError(
      'DISCOVERY_KEY_MISMATCH',
      'invite does not match the expected room'
    )
  }

  if (
    expectedRoomKey !== null &&
    !b4a.equals(decoded.discoveryKey, crypto.discoveryKey(expectedRoomKey))
  ) {
    throw new InviteError(
      'DISCOVERY_KEY_MISMATCH',
      'invite does not match the expected room'
    )
  }

  const now = opts.now === undefined ? Date.now() : opts.now

  if (opts.allowExpired !== true && decoded.expires !== 0 && decoded.expires <= now) {
    throw new InviteError('INVITE_EXPIRED', 'invite has expired')
  }

  return {
    format,
    flags,
    invite: decoded,
    invitationId: decoded.id.toString('hex'),
    inviteId: decoded.id,
    publicKey: crypto.keyPair(decoded.seed).publicKey,
    discoveryKey: decoded.discoveryKey,
    discoveryKeyHex: decoded.discoveryKey.toString('hex'),
    encryptionKey,
    encryptionKeyHex: encryptionKey === null ? null : encryptionKey.toString('hex'),
    expires: decoded.expires,
    sensitive: decoded.sensitive,
    testInvitation: decoded.testInvitation,
    additionalNodes: decoded.additionalNodes,
    inviteBytes: b4a.from(inviteBytes),
    standardInvite: b4a.from(inviteBytes.subarray(0, used))
  }
}

function decodeInviteUrl (url, opts = {}) {
  if (typeof url !== 'string') {
    throw new InviteError('INVALID_URL', 'invite URL must be a string')
  }
  if (!url.startsWith(INVITE_PREFIX)) {
    throw new InviteError(
      'INVALID_PREFIX',
      `invite URL must start with ${INVITE_PREFIX}`
    )
  }

  const payload = url.slice(INVITE_PREFIX.length)

  if (payload.length === 0) {
    throw new InviteError('INVALID_URL', 'invite URL has no payload')
  }
  if (payload.length > MAX_INVITE_CHARS) {
    throw new InviteError('INVITE_TOO_LARGE', 'invite is too large')
  }

  let inviteBytes

  try {
    inviteBytes = z32.decode(payload)
  } catch (err) {
    throw new InviteError('INVALID_ENCODING', 'invite payload is not valid z32')
  }

  return decodeInvitePayload(inviteBytes, opts)
}

module.exports = {
  INVITE_PREFIX,
  KEET_FLAG_MASK,
  EXTENSION_MARKER,
  EXTENSION_BYTES,
  FORMATS,
  DEFAULT_FORMAT,
  MAX_INVITE_BYTES,
  InviteError,
  normalizeFormat,
  resolveFormat,
  encodeInviteUrl,
  createInvite,
  decodeInvitePayload,
  decodeInviteUrl
}
