'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const MESSAGE_VERSION = 1
const MEDIA_MESSAGE_VERSION = 2
const MAX_TEXT_BYTES = 4096
const DEFAULT_SEEN_LIMIT = 10000
const SIGNATURE_BYTES = 64

const { createErrorClass } = require('./errors')
const { KEY_BYTES, normalizeKey: normalizeProtocolKey } = require('./keys')
const { MAX_MEDIA_BYTES, validateMedia } = require('./media')

const MessageError = createErrorClass('MessageError')

function normalizeKey (value, field) {
  return normalizeProtocolKey(value, field, MessageError)
}

function normalizeSignature (signature) {
  let buffer

  if (b4a.isBuffer(signature)) {
    buffer = signature
  } else if (signature instanceof Uint8Array) {
    buffer = b4a.from(signature)
  } else {
    throw new MessageError('INVALID_SIGNATURE', 'signature must be a buffer')
  }

  if (buffer.byteLength !== SIGNATURE_BYTES) {
    throw new MessageError(
      'TRUNCATED_SIGNATURE',
      `signature must be exactly ${SIGNATURE_BYTES} bytes`
    )
  }

  return buffer
}

function validateText (text) {
  if (typeof text !== 'string') {
    throw new MessageError('INVALID_TEXT', 'text must be a string')
  }

  const bytes = b4a.from(text, 'utf-8')

  if (bytes.byteLength > MAX_TEXT_BYTES) {
    throw new MessageError(
      'TEXT_TOO_LARGE',
      `text must be at most ${MAX_TEXT_BYTES} UTF-8 bytes`
    )
  }

  // Lone surrogates are replaced during encoding and would not round-trip.
  if (b4a.toString(bytes, 'utf-8') !== text) {
    throw new MessageError('INVALID_TEXT', 'text must be valid UTF-8 without unpaired surrogates')
  }

  return bytes
}

function validateTimestamp (timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new MessageError(
      'INVALID_TIMESTAMP',
      'timestamp must be a non-negative safe integer in milliseconds'
    )
  }
  return timestamp
}

function resolveKeyPair (signer) {
  if (signer && signer.secretKey) {
    return { publicKey: normalizeKey(signer.publicKey, 'sender'), secretKey: signer.secretKey }
  }
  if (signer && signer.keyPair && signer.keyPair.secretKey) {
    return {
      publicKey: normalizeKey(signer.keyPair.publicKey, 'sender'),
      secretKey: signer.keyPair.secretKey
    }
  }
  throw new MessageError('INVALID_SIGNER', 'signer must expose a public key and a secret key')
}

const textEncoding = {
  preencode (state, text) {
    const bytes = validateText(text)
    c.uint.preencode(state, bytes.byteLength)
    state.end += bytes.byteLength
  },
  encode (state, text) {
    // compact-encoding always runs preencode first, which validates the text
    // and reserves the bytes. Encoding only needs to copy the UTF-8 payload.
    const bytes = b4a.from(text, 'utf-8')
    c.uint.encode(state, bytes.byteLength)
    state.buffer.set(bytes, state.start)
    state.start += bytes.byteLength
  },
  decode (state) {
    const length = c.uint.decode(state)

    if (length > MAX_TEXT_BYTES) {
      throw new MessageError(
        'TEXT_TOO_LARGE',
        `text must be at most ${MAX_TEXT_BYTES} UTF-8 bytes`
      )
    }
    if (state.end - state.start < length) {
      throw new MessageError('TRUNCATED', 'message text is truncated')
    }

    const bytes = state.buffer.subarray(state.start, (state.start += length))
    const text = b4a.toString(bytes, 'utf-8')

    if (!b4a.equals(b4a.from(text, 'utf-8'), bytes)) {
      throw new MessageError('INVALID_TEXT', 'text must be valid UTF-8')
    }

    return text
  }
}

/**
 * Normalize a media descriptor into the exact signed shape. Validation is
 * shared with the inbox policy so an invalid payload is rejected the same way
 * whether it arrives through a command, a message, or a file.
 */
function normalizeMedia (media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    throw new MessageError('INVALID_MEDIA', 'media must be an object')
  }

  try {
    const validated = validateMedia(media)
    return {
      mimeType: validated.mimeType,
      size: validated.size,
      sha256: validated.sha256,
      bytes: validated.bytes
    }
  } catch (err) {
    if (err instanceof MessageError) throw err
    throw new MessageError(err.code || 'INVALID_MEDIA', err.message, err)
  }
}

const mediaEncoding = {
  preencode (state, media) {
    const normalized = normalizeMedia(media)
    c.string.preencode(state, normalized.mimeType)
    c.uint.preencode(state, normalized.size)
    c.fixed32.preencode(state, b4a.from(normalized.sha256, 'hex'))
    c.uint.preencode(state, normalized.bytes.byteLength)
    state.end += normalized.bytes.byteLength
  },
  encode (state, media) {
    const normalized = normalizeMedia(media)
    c.string.encode(state, normalized.mimeType)
    c.uint.encode(state, normalized.size)
    c.fixed32.encode(state, b4a.from(normalized.sha256, 'hex'))
    c.uint.encode(state, normalized.bytes.byteLength)
    state.buffer.set(normalized.bytes, state.start)
    state.start += normalized.bytes.byteLength
  },
  decode (state) {
    const mimeType = c.string.decode(state)
    const size = c.uint.decode(state)
    const sha256 = c.fixed32.decode(state).toString('hex')
    const length = c.uint.decode(state)

    if (length > MAX_MEDIA_BYTES) {
      throw new MessageError('MEDIA_TOO_LARGE', `media must be at most ${MAX_MEDIA_BYTES} bytes`)
    }
    if (state.end - state.start < length) {
      throw new MessageError('TRUNCATED', 'message media is truncated')
    }

    const bytes = b4a.from(state.buffer.subarray(state.start, (state.start += length)))

    try {
      const validated = validateMedia({ mimeType, size, sha256, bytes })
      return {
        mimeType: validated.mimeType,
        size: validated.size,
        sha256: validated.sha256,
        bytes: validated.bytes
      }
    } catch (err) {
      throw new MessageError(err.code || 'INVALID_MEDIA', err.message, err)
    }
  }
}

const messageBody = {
  preencode (state, message) {
    c.uint.preencode(state, message.version)
    c.fixed32.preencode(state, normalizeKey(message.roomKey, 'roomKey'))
    c.fixed32.preencode(state, normalizeKey(message.messageId, 'messageId'))
    c.fixed32.preencode(state, normalizeKey(message.sender, 'sender'))
    c.uint64.preencode(state, validateTimestamp(message.timestamp))
    textEncoding.preencode(state, message.text)
    if (message.version === MEDIA_MESSAGE_VERSION) {
      mediaEncoding.preencode(state, message.media)
    }
  },
  encode (state, message) {
    c.uint.encode(state, message.version)
    c.fixed32.encode(state, normalizeKey(message.roomKey, 'roomKey'))
    c.fixed32.encode(state, normalizeKey(message.messageId, 'messageId'))
    c.fixed32.encode(state, normalizeKey(message.sender, 'sender'))
    c.uint64.encode(state, validateTimestamp(message.timestamp))
    textEncoding.encode(state, message.text)
    if (message.version === MEDIA_MESSAGE_VERSION) {
      mediaEncoding.encode(state, message.media)
    }
  },
  decode (state) {
    const version = c.uint.decode(state)

    if (version !== MESSAGE_VERSION && version !== MEDIA_MESSAGE_VERSION) {
      throw new MessageError(
        'UNSUPPORTED_VERSION',
        `unsupported message version ${version}`
      )
    }

    const message = {
      version,
      roomKey: c.fixed32.decode(state),
      messageId: c.fixed32.decode(state),
      sender: c.fixed32.decode(state),
      timestamp: c.uint64.decode(state),
      text: textEncoding.decode(state),
      signature: null
    }

    if (version === MEDIA_MESSAGE_VERSION) {
      message.media = mediaEncoding.decode(state)
    }

    return message
  }
}

function wrapDecodeError (err) {
  if (err instanceof MessageError) return err

  const detail = err && err.message ? err.message : ''

  if (/out of bounds|incorrect buffer size|safe integer/i.test(detail)) {
    return new MessageError('TRUNCATED', 'message is truncated or malformed')
  }

  return new MessageError('INVALID_MESSAGE', 'message could not be decoded')
}

function messageVersion (message) {
  if (message.version !== undefined) return message.version
  return message.media === undefined || message.media === null
    ? MESSAGE_VERSION
    : MEDIA_MESSAGE_VERSION
}

function assertVersion (version) {
  if (version !== MESSAGE_VERSION && version !== MEDIA_MESSAGE_VERSION) {
    throw new MessageError('UNSUPPORTED_VERSION', `unsupported message version ${version}`)
  }
}

function encodeMessageBody (message) {
  if (!message || typeof message !== 'object') {
    throw new MessageError('INVALID_MESSAGE', 'message must be an object')
  }

  const version = messageVersion(message)
  assertVersion(version)

  const hasMedia = message.media !== undefined && message.media !== null

  if (version === MESSAGE_VERSION && hasMedia) {
    throw new MessageError('INVALID_MESSAGE', 'version 1 messages cannot carry media')
  }
  if (version === MEDIA_MESSAGE_VERSION && !hasMedia) {
    throw new MessageError('INVALID_MEDIA', 'version 2 messages require a media descriptor')
  }

  const body = {
    version,
    roomKey: message.roomKey,
    messageId: message.messageId,
    sender: message.sender,
    timestamp: message.timestamp,
    text: message.text
  }

  if (hasMedia) body.media = normalizeMedia(message.media)

  return c.encode(messageBody, body)
}

function signMessage (message, signer) {
  const keyPair = resolveKeyPair(signer)
  const sender = normalizeKey(message.sender, 'sender')

  if (!b4a.equals(sender, keyPair.publicKey)) {
    throw new MessageError('SIGNER_MISMATCH', 'signer does not match message sender')
  }

  const version = messageVersion(message)
  assertVersion(version)

  const hasMedia = message.media !== undefined && message.media !== null

  if (version === MESSAGE_VERSION && hasMedia) {
    throw new MessageError('INVALID_MESSAGE', 'version 1 messages cannot carry media')
  }
  if (version === MEDIA_MESSAGE_VERSION && !hasMedia) {
    throw new MessageError('INVALID_MEDIA', 'version 2 messages require a media descriptor')
  }

  const roomKey = normalizeKey(message.roomKey, 'roomKey')
  const messageId = normalizeKey(message.messageId, 'messageId')
  const timestamp = validateTimestamp(message.timestamp)
  const signed = {
    version,
    roomKey,
    messageId,
    sender,
    timestamp,
    text: message.text
  }

  if (hasMedia) signed.media = normalizeMedia(message.media)

  const body = encodeMessageBody(signed)
  signed.signature = crypto.sign(body, keyPair.secretKey)

  return signed
}

function createMessage (fields, signer) {
  if (!fields || typeof fields !== 'object') {
    throw new MessageError('INVALID_MESSAGE', 'message fields must be an object')
  }

  const keyPair = resolveKeyPair(signer)
  const hasMedia = fields.media !== undefined && fields.media !== null
  const version = fields.version === undefined
    ? (hasMedia ? MEDIA_MESSAGE_VERSION : MESSAGE_VERSION)
    : fields.version
  const message = {
    version,
    roomKey: fields.roomKey,
    messageId:
      fields.messageId === undefined ? crypto.randomBytes(KEY_BYTES) : fields.messageId,
    sender: keyPair.publicKey,
    timestamp: fields.timestamp === undefined ? Date.now() : fields.timestamp,
    text: fields.text
  }

  if (hasMedia) message.media = fields.media

  return signMessage(message, keyPair)
}

function verifyMessage (message) {
  const signature = normalizeSignature(message && message.signature)
  const sender = normalizeKey(message.sender, 'sender')
  const version = messageVersion(message)
  const body = {
    version,
    roomKey: message.roomKey,
    messageId: message.messageId,
    sender,
    timestamp: message.timestamp,
    text: message.text
  }

  if (message.media !== undefined && message.media !== null) {
    body.media = message.media
  }

  return crypto.verify(encodeMessageBody(body), signature, sender)
}

function encodeMessage (message) {
  const signature = normalizeSignature(message && message.signature)
  const body = encodeMessageBody(message)
  return b4a.concat([body, signature])
}

function peekVersion (buffer) {
  try {
    const state = c.state(0, buffer.byteLength, buffer)
    return c.uint.decode(state)
  } catch {
    throw new MessageError('TRUNCATED', 'message is truncated or malformed')
  }
}

function decodeMessage (buffer, opts = {}) {
  if (!b4a.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new MessageError('INVALID_MESSAGE', 'message must be a buffer')
  }

  // Reject an unknown version before interpreting any other field. Callers
  // that only understand version 1 can pass `version: 1` to get the same
  // safe rejection without parsing a version-2 media payload.
  const version = peekVersion(buffer)
  assertVersion(version)

  if (opts.version !== undefined && opts.version !== version) {
    throw new MessageError(
      'UNSUPPORTED_VERSION',
      `unsupported message version ${version}`
    )
  }

  const expectedRoomKey =
    opts.roomKey === undefined || opts.roomKey === null
      ? null
      : normalizeKey(opts.roomKey, 'roomKey')
  const verify = opts.verify !== false
  const state = c.state(0, buffer.byteLength, buffer)
  let message

  try {
    message = messageBody.decode(state)
  } catch (err) {
    throw wrapDecodeError(err)
  }

  const remaining = state.end - state.start

  if (remaining < SIGNATURE_BYTES) {
    throw new MessageError('TRUNCATED_SIGNATURE', 'message signature is truncated')
  }
  if (remaining > SIGNATURE_BYTES) {
    throw new MessageError('TRAILING_BYTES', 'message has trailing bytes')
  }

  message.signature = state.buffer.subarray(state.start, state.end)

  if (expectedRoomKey !== null && !b4a.equals(message.roomKey, expectedRoomKey)) {
    throw new MessageError('WRONG_ROOM', 'message belongs to a different room')
  }

  if (verify && !verifyMessage(message)) {
    throw new MessageError('INVALID_SIGNATURE', 'message signature is invalid')
  }

  return message
}

class MessageDeduplicator {
  constructor (opts = {}) {
    const max = opts.max === undefined ? DEFAULT_SEEN_LIMIT : opts.max

    if (!Number.isSafeInteger(max) || max < 1) {
      throw new MessageError('INVALID_LIMIT', 'max must be a positive integer')
    }

    this.max = max
    this.seen = new Set()
    this.order = []
  }

  add (messageId) {
    const id = normalizeKey(messageId, 'messageId').toString('hex')

    if (this.seen.has(id)) return false

    this.seen.add(id)
    this.order.push(id)

    if (this.order.length > this.max) {
      this.seen.delete(this.order.shift())
    }

    return true
  }

  has (messageId) {
    return this.seen.has(normalizeKey(messageId, 'messageId').toString('hex'))
  }

  clear () {
    this.seen.clear()
    this.order.length = 0
  }

  get size () {
    return this.seen.size
  }
}

// Decodes a room entry, validates it, and returns null for an already seen id.
class MessageReceiver {
  constructor (opts = {}) {
    this.roomKey =
      opts.roomKey === undefined || opts.roomKey === null
        ? null
        : normalizeKey(opts.roomKey, 'roomKey')
    this.seen = new MessageDeduplicator({ max: opts.maxSeen })
  }

  receive (buffer) {
    const message = decodeMessage(buffer, { roomKey: this.roomKey })

    if (!this.seen.add(message.messageId)) return null

    return message
  }
}

module.exports = {
  MESSAGE_VERSION,
  MEDIA_MESSAGE_VERSION,
  MAX_TEXT_BYTES,
  DEFAULT_SEEN_LIMIT,
  MessageError,
  normalizeKey,
  normalizeSignature,
  createMessage,
  signMessage,
  verifyMessage,
  encodeMessageBody,
  encodeMessage,
  decodeMessage,
  MessageDeduplicator,
  MessageReceiver
}
