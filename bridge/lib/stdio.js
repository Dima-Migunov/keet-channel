'use strict'

const { EventEmitter } = require('node:events')

const PROTOCOL_VERSION = '1.1.0'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_SEND_IMAGE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_LINE_BYTES = 21 * 1024 * 1024
const MAX_REQUEST_ID_PREFIX_BYTES = 64 * 1024
const DEFAULT_MAX_OUTBOUND_BYTES = 8 * 1024 * 1024

const REQUEST_ID_PATTERN = /"request_id"\s*:\s*("(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/

class RouterError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'RouterError'
    this.code = code
  }
}

/**
 * Response `type` for each supported command. The handler receives the parsed
 * request params and a context with `requestId`, `command`, and `router`.
 */
const COMMANDS = new Map([
  ['send_message', { type: 'send_result', handle: (bridge, params) => bridge.sendMessage(params) }],
  ['send_image', {
    type: 'send_image_result',
    timeoutMs: DEFAULT_SEND_IMAGE_TIMEOUT_MS,
    handle: (bridge, params) => bridge.sendImage(params)
  }],
  ['status', { type: 'status_result', handle: (bridge) => bridge.status() }],
  ['get_identity', { type: 'identity_result', handle: (bridge) => bridge.getIdentity() }],
  ['create_invite', { type: 'create_invite_result', handle: (bridge, params) => bridge.createInvite(params) }],
  ['join_invite', { type: 'join_invite_result', handle: (bridge, params) => bridge.joinInvite(params) }],
  ['accept_pairing', { type: 'accept_pairing_result', handle: (bridge, params) => bridge.acceptPairing(params) }],
  ['decline_pairing', { type: 'decline_pairing_result', handle: (bridge, params) => bridge.declinePairing(params) }],
  ['cancel_invite', { type: 'cancel_invite_result', handle: (bridge, params) => bridge.cancelInvite(params) }],
  ['pairing_list', { type: 'pairing_list_result', handle: (bridge, params) => bridge.pairingList(params) }],
  ['acl_add', { type: 'acl_add_result', handle: (bridge, params) => bridge.aclAdd(params) }],
  ['acl_remove', { type: 'acl_remove_result', handle: (bridge, params) => bridge.aclRemove(params) }],
  ['acl_list', { type: 'acl_list_result', handle: (bridge, params) => bridge.aclList(params) }],
  ['join_room', { type: 'join_room_result', handle: (bridge, params) => bridge.joinRoom(params) }],
  ['connect_to_user', { type: 'connect_to_user_result', handle: (bridge, params) => bridge.connectToUser(params) }],
  ['send_welcome', { type: 'send_welcome_result', handle: (bridge, params) => bridge.sendWelcome(params) }],
  ['shutdown', { type: 'shutdown_result', handle: (bridge) => bridge.shutdown() }]
])

const UNSUPPORTED_COMMANDS = new Set([
  'send_file',
  'send_attachment',
  'send_voice',
  'send_video',
  'send_animation'
])

function isRequestId (value) {
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
}

function extractRequestId (buffer) {
  const length = Math.min(buffer.length, MAX_REQUEST_ID_PREFIX_BYTES)
  const text = buffer.toString('utf-8', 0, length)
  const match = REQUEST_ID_PATTERN.exec(text)

  if (!match) return null

  try {
    const value = JSON.parse(match[1])
    return isRequestId(value) ? value : null
  } catch {
    return null
  }
}

function serialize (value) {
  return JSON.stringify(value) + '\n'
}

class StdioRouter extends EventEmitter {
  constructor (bridge, opts = {}) {
    super()
    this.bridge = bridge
    this.input = opts.input || process.stdin
    this.output = opts.output || process.stdout
    this.errorOutput = opts.errorOutput || process.stderr
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.maxLineBytes = Number.isFinite(opts.maxLineBytes) ? opts.maxLineBytes : DEFAULT_MAX_LINE_BYTES
    this.maxOutboundBytes = Number.isFinite(opts.maxOutboundBytes)
      ? opts.maxOutboundBytes
      : DEFAULT_MAX_OUTBOUND_BYTES
    this.protocolVersion = opts.protocolVersion || PROTOCOL_VERSION
    this._buffer = Buffer.alloc(0)
    this._bufferBytes = 0
    this._writeQueue = []
    this._writeBytes = 0
    this._writeWaiters = []
    this._flushWaiters = []
    this._pumping = false
    this._started = false
    this._stopped = false
    this._discarding = false
    this._onData = (data) => this._receive(data)
    this._onEnd = () => {
      this.log('[stdio] stdin closed')
      this.emit('input_end')
    }
    this._onError = (err) => this.log(`[stdio] stdin error: ${err.message}`)
  }

  get started () {
    return this._started && !this._stopped
  }

  start () {
    if (this._started) return
    this._started = true
    if (this.input && typeof this.input.on === 'function') {
      this.input.on('data', this._onData)
      this.input.on('end', this._onEnd)
      this.input.on('error', this._onError)
      if (typeof this.input.resume === 'function') this.input.resume()
    }
    this.log('[stdio] JSON stdio protocol ready')
  }

  /**
   * Queue one protocol event. Lines are written in call order, the number of
   * buffered bytes is bounded, and a write that returns false waits for drain.
   * The returned promise resolves to false instead of rejecting so callers can
   * fire-and-forget event forwarding safely.
   */
  async send (event) {
    if (!this.output || typeof this.output.write !== 'function') return false

    let line
    try {
      line = serialize(event)
    } catch (err) {
      this.log(`[stdio] failed to serialize protocol event: ${err.message}`)
      return false
    }

    const bytes = Buffer.byteLength(line, 'utf-8')
    await this._reserveWrite(bytes)

    return new Promise((resolve) => {
      this._writeQueue.push({ line, bytes, resolve })
      this._pump()
    })
  }

  /**
   * Resolve once every queued line has been written and the last write has
   * drained. Used before exiting so a terminal response is never truncated.
   */
  flush () {
    if (this._writesIdle()) return Promise.resolve()
    return new Promise((resolve) => this._flushWaiters.push(resolve))
  }

  /**
   * Diagnostics belong on stderr; the adapter keeps only a bounded tail.
   */
  log (message) {
    if (!this.errorOutput || typeof this.errorOutput.write !== 'function') return
    try {
      this.errorOutput.write(String(message) + '\n', 'utf-8')
    } catch {}
  }

  _writesIdle () {
    return this._writeQueue.length === 0 && !this._pumping && this._writeBytes === 0
  }

  _reserveWrite (bytes) {
    const hasCapacity = this._writeWaiters.length === 0 &&
      (this._writeBytes === 0 || this._writeBytes + bytes <= this.maxOutboundBytes)
    if (hasCapacity) {
      this._writeBytes += bytes
      return Promise.resolve()
    }
    return new Promise((resolve) => this._writeWaiters.push({ bytes, resolve }))
  }

  _releaseWrite (bytes) {
    this._writeBytes -= bytes
    if (this._writeBytes < 0) this._writeBytes = 0

    while (this._writeWaiters.length > 0) {
      const next = this._writeWaiters[0]
      if (this._writeBytes > 0 && this._writeBytes + next.bytes > this.maxOutboundBytes) break
      this._writeWaiters.shift()
      this._writeBytes += next.bytes
      next.resolve()
    }
  }

  async _pump () {
    if (this._pumping) return
    this._pumping = true

    try {
      while (this._writeQueue.length > 0) {
        const entry = this._writeQueue.shift()
        let ok = true
        try {
          const written = new Promise((resolve) => {
            const writable = this.output.write(entry.line, 'utf-8', () => resolve())
            if (writable === false && typeof this.output.once === 'function') {
              this.output.once('drain', resolve)
            }
          })
          await written
        } catch (err) {
          ok = false
          this.log(`[stdio] failed to write protocol event: ${err.message}`)
        } finally {
          entry.resolve(ok)
          this._releaseWrite(entry.bytes)
        }
      }
    } finally {
      this._pumping = false
      this._finishFlush()
    }
  }

  _finishFlush () {
    if (!this._writesIdle()) return
    const waiters = this._flushWaiters
    this._flushWaiters = []
    for (const resolve of waiters) resolve()
  }

  _receive (data) {
    if (this._stopped) return

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8')
    if (chunk.length === 0) return

    if (this._discarding) {
      const newline = chunk.indexOf(0x0a)
      if (newline === -1) return
      this._discarding = false
      this._receive(chunk.subarray(newline + 1))
      return
    }

    this._buffer = this._buffer.length === 0
      ? chunk
      : Buffer.concat([this._buffer, chunk], this._buffer.length + chunk.length)
    this._bufferBytes = this._buffer.length

    let start = 0
    let index = this._buffer.indexOf(0x0a, start)
    while (index !== -1) {
      const line = this._buffer.subarray(start, index)
      start = index + 1
      if (line.length > this.maxLineBytes) {
        this._lineTooLarge(line)
      } else if (line.length > 0) {
        const text = line.toString('utf-8')
        if (text.trim()) this._ingest(text)
      }
      index = this._buffer.indexOf(0x0a, start)
    }

    if (start > 0) {
      this._buffer = this._buffer.subarray(start)
      this._bufferBytes = this._buffer.length
    }

    if (this._bufferBytes > this.maxLineBytes) {
      this._lineTooLarge(this._buffer)
      this._buffer = Buffer.alloc(0)
      this._bufferBytes = 0
      this._discarding = true
    }
  }

  _lineTooLarge (buffer) {
    this._sendError(
      extractRequestId(buffer),
      'line_too_large',
      `Request exceeds ${this.maxLineBytes} bytes`,
      null
    )
  }

  _ingest (line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log('[stdio] received invalid JSON')
      this._sendError(null, 'invalid_json', 'Request line is not valid JSON', null)
      return
    }

    this._handleCommand(message).catch((err) => {
      // Every command path handles its own errors; this is a last-resort guard
      // so a bug cannot take down the reader.
      this.log(`[stdio] unhandled command error: ${err && err.message}`)
    })
  }

  async _handleCommand (message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      await this._sendError(null, 'invalid_request', 'Request must be a JSON object', null)
      return
    }

    const { command } = message
    const requestId = message.request_id

    if (typeof command !== 'string' || command.length === 0) {
      await this._sendError(requestId, 'invalid_request', 'Request is missing a command', null)
      return
    }

    if (!isRequestId(requestId)) {
      await this._sendError(requestId, 'invalid_request', 'Request is missing a valid request_id', command)
      return
    }

    const definition = COMMANDS.get(command)
    if (!definition) {
      await this._sendError(requestId, 'unsupported_command', `Command is not supported: ${command}`, command)
      return
    }

    const params = { ...message }
    delete params.command
    delete params.request_id

    let result
    try {
      result = await this._runHandler(definition, params, requestId, command)
    } catch (err) {
      if (err && err.code === 'timeout') {
        await this._sendError(requestId, 'timeout', err.message, command)
      } else {
        const code = err && typeof err.code === 'string' ? err.code : 'command_failed'
        const text = err && err.message ? err.message : 'Command failed'
        this.log(`[stdio] ${command} failed: ${text}`)
        await this._sendError(requestId, code, text, command)
      }
      return
    }

    const response = { ...(result || {}), type: definition.type, request_id: requestId }
    await this.send(response)

    if (command === 'shutdown') this.emit('shutdown', response)
  }

  _runHandler (definition, params, requestId, command) {
    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(definition.timeoutMs)
        ? definition.timeoutMs
        : this.timeoutMs
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new RouterError('timeout', `Command timed out after ${timeoutMs}ms: ${command}`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      let pending
      try {
        pending = Promise.resolve(definition.handle(this.bridge, params, { requestId, command, router: this }))
      } catch (err) {
        pending = Promise.reject(err)
      }

      pending.then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }, (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  _sendError (requestId, code, message, operation) {
    return this.send({
      type: 'error',
      request_id: isRequestId(requestId) ? requestId : null,
      code,
      message,
      operation: operation || null
    })
  }

  stop () {
    if (this._stopped) return
    this._stopped = true
    this._discarding = false
    this._buffer = Buffer.alloc(0)
    this._bufferBytes = 0
    if (this.input && typeof this.input.removeListener === 'function') {
      this.input.removeListener('data', this._onData)
      this.input.removeListener('end', this._onEnd)
      this.input.removeListener('error', this._onError)
    }
    // Queued output is deliberately preserved; main() flushes it before exit.
  }
}

module.exports = StdioRouter
module.exports.StdioRouter = StdioRouter
module.exports.RouterError = RouterError
module.exports.COMMANDS = COMMANDS
module.exports.UNSUPPORTED_COMMANDS = UNSUPPORTED_COMMANDS
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION
module.exports.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS
module.exports.DEFAULT_SEND_IMAGE_TIMEOUT_MS = DEFAULT_SEND_IMAGE_TIMEOUT_MS
module.exports.DEFAULT_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES
module.exports.DEFAULT_MAX_OUTBOUND_BYTES = DEFAULT_MAX_OUTBOUND_BYTES
