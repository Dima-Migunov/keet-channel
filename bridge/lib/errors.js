'use strict'

/**
 * Build one protocol error class. Room, pairing, message, and invite errors
 * share the same shape: a stable `code`, a human-readable message, and an
 * optional `cause` for wrapped low-level failures.
 */
function createErrorClass (name) {
  return class ProtocolError extends Error {
    constructor (code, message, cause) {
      super(message)
      this.name = name
      this.code = code
      if (cause !== undefined) this.cause = cause
    }
  }
}

module.exports = { createErrorClass }
