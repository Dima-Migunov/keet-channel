'use strict'

const b4a = require('b4a')

const KEY_BYTES = 32
const KEY_HEX = /^[0-9a-f]{64}$/

function isKeyHex (value) {
  return typeof value === 'string' && KEY_HEX.test(value)
}

/**
 * Normalize a 32-byte key from a Buffer, Uint8Array, or 64-character lowercase
 * hex string. The supplied error class keeps each module's typed error while
 * sharing the accepted formats and messages.
 */
function normalizeKey (value, field, ErrorClass) {
  let buffer

  if (b4a.isBuffer(value)) {
    buffer = value
  } else if (value instanceof Uint8Array) {
    buffer = b4a.from(value)
  } else if (isKeyHex(value)) {
    buffer = b4a.from(value, 'hex')
  } else {
    throw new ErrorClass(
      'INVALID_KEY',
      `${field} must be a ${KEY_BYTES}-byte buffer or 64 lowercase hex characters`
    )
  }

  if (buffer.byteLength !== KEY_BYTES) {
    throw new ErrorClass('INVALID_KEY', `${field} must be exactly ${KEY_BYTES} bytes`)
  }

  return buffer
}

module.exports = {
  KEY_BYTES,
  KEY_HEX,
  isKeyHex,
  normalizeKey
}
