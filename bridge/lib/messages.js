'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const MESSAGE_VERSION = 1
const MAX_TEXT_BYTES = 4096
const DEFAULT_SEEN_LIMIT = 10000
const SIGNATURE_BYTES = 64

const { createErrorClass } = require('./errors')
const { KEY_BYTES, normalizeKey: normalizeProtocolKey } = require('./keys')

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

const messageBody = {
  preencode (state, message) {
    c.uint.preencode(state, message.version)
    c.fixed32.preencode(state, normalizeKey(message.roomKey, 'roomKey'))
    c.fixed32.preencode(state, normalizeKey(message.messageId, 'messageId'))
    c.fixed32.preencode(state, normalizeKey(message.sender, 'sender'))
    c.uint64.preencode(state, validateTimestamp(message.timestamp))
    textEncoding.preencode(state, message.text)
  },
  encode (state, message) {
    c.uint.encode(state, message.version)
    c.fixed32.encode(state, normalizeKey(message.roomKey, 'roomKey'))
    c.fixed32.encode(state, normalizeKey(message.messageId, 'messageId'))
    c.fixed32.encode(state, normalizeKey(message.sender, 'sender'))
    c.uint64.encode(state, validateTimestamp(message.timestamp))
    textEncoding.encode(state, message.text)
  },
  decode (state) {
    const version = c.uint.decode(state)

    if (version !== MESSAGE_VERSION) {
      throw new MessageError(
        'UNSUPPORTED_VERSION',
        `unsupported message version ${version}`
      )
    }

    return {
      version,
      roomKey: c.fixed32.decode(state),
      messageId: c.fixed32.decode(state),
      sender: c.fixed32.decode(state),
      timestamp: c.uint64.decode(state),
      text: textEncoding.decode(state),
      signature: null
    }
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

function encodeMessageBody (message) {
  if (!message || typeof message !== 'object') {
    throw new MessageError('INVALID_MESSAGE', 'message must be an object')
  }

  const version = message.version === undefined ? MESSAGE_VERSION : message.version

  if (version !== MESSAGE_VERSION) {
    throw new MessageError('UNSUPPORTED_VERSION', `unsupported message version ${version}`)
  }

  return c.encode(messageBody, {
    version,
    roomKey: message.roomKey,
    messageId: message.messageId,
    sender: message.sender,
    timestamp: message.timestamp,
    text: message.text
  })
}

function signMessage (message, signer) {
  const keyPair = resolveKeyPair(signer)
  const sender = normalizeKey(message.sender, 'sender')

  if (!b4a.equals(sender, keyPair.publicKey)) {
    throw new MessageError('SIGNER_MISMATCH', 'signer does not match message sender')
  }

  const roomKey = normalizeKey(message.roomKey, 'roomKey')
  const messageId = normalizeKey(message.messageId, 'messageId')
  const timestamp = validateTimestamp(message.timestamp)
  const body = encodeMessageBody({
    version: MESSAGE_VERSION,
    roomKey,
    messageId,
    sender,
    timestamp,
    text: message.text
  })

  return {
    version: MESSAGE_VERSION,
    roomKey,
    messageId,
    sender,
    timestamp,
    text: message.text,
    signature: crypto.sign(body, keyPair.secretKey)
  }
}

function createMessage (fields, signer) {
  if (!fields || typeof fields !== 'object') {
    throw new MessageError('INVALID_MESSAGE', 'message fields must be an object')
  }

  const keyPair = resolveKeyPair(signer)
  const message = {
    version: MESSAGE_VERSION,
    roomKey: fields.roomKey,
    messageId:
      fields.messageId === undefined ? crypto.randomBytes(KEY_BYTES) : fields.messageId,
    sender: keyPair.publicKey,
    timestamp: fields.timestamp === undefined ? Date.now() : fields.timestamp,
    text: fields.text
  }

  return signMessage(message, keyPair)
}

function verifyMessage (message) {
  const signature = normalizeSignature(message && message.signature)
  const sender = normalizeKey(message.sender, 'sender')
  const body = encodeMessageBody({
    version: message.version,
    roomKey: message.roomKey,
    messageId: message.messageId,
    sender,
    timestamp: message.timestamp,
    text: message.text
  })

  return crypto.verify(body, signature, sender)
}

function encodeMessage (message) {
  const signature = normalizeSignature(message && message.signature)
  const body = encodeMessageBody(message)
  return b4a.concat([body, signature])
}

function decodeMessage (buffer, opts = {}) {
  if (!b4a.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new MessageError('INVALID_MESSAGE', 'message must be a buffer')
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
