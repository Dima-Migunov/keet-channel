'use strict'

const { EventEmitter } = require('node:events')

const { createErrorClass } = require('./errors')

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_PENDING = 1024
const TTL_ENV = 'KEET_DELIVERY_TTL_MS'
const MAX_PENDING_ENV = 'KEET_DELIVERY_MAX_PENDING'

const DeliveryError = createErrorClass('DeliveryError')

function positiveInt (value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.floor(number)
}

function resolveLimit (value, env, key, fallback) {
  if (value !== undefined && value !== null) {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) {
      throw new DeliveryError('INVALID_LIMIT', `${key} must be a positive integer`)
    }
    return number
  }

  return positiveInt(env && env[key], fallback)
}

function requireString (value, field, code) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeliveryError(code, `${field} must be a non-empty string`)
  }
  return value
}

/**
 * Track locally appended messages that were acknowledged with `queued: true`
 * until a peer is observed or their TTL expires. Each record produces exactly
 * one terminal `delivery_update`; replicated is an approximation based on peer
 * presence, not a per-block acknowledgement or a read receipt.
 */
class DeliveryTracker extends EventEmitter {
  constructor (opts = {}) {
    super()

    const env = opts.env || process.env
    this.ttlMs = resolveLimit(opts.ttlMs, env, TTL_ENV, DEFAULT_TTL_MS)
    this.maxPending = resolveLimit(
      opts.maxPending === undefined ? opts.maxRecords : opts.maxPending,
      env,
      MAX_PENDING_ENV,
      DEFAULT_MAX_PENDING
    )
    this._now = opts.now || Date.now
    this._setTimeout = opts.setTimeout || setTimeout
    this._clearTimeout = opts.clearTimeout || clearTimeout
    this._log = opts.log || (() => {})
    this._records = new Map()
    this._closed = false
  }

  get size () {
    return this._records.size
  }

  has (messageId) {
    return this._records.has(messageId)
  }

  /**
   * Register a queued send. Re-registering the same message id is idempotent.
   * Returns a public snapshot, or null when the send was not queued or the
   * tracker has already been closed.
   */
  track (opts = {}) {
    if (this._closed) return null
    if (opts.queued === false) return null

    const messageId = requireString(opts.messageId, 'messageId', 'INVALID_MESSAGE_ID')
    const roomKey = requireString(opts.roomKey, 'roomKey', 'INVALID_ROOM_KEY')

    const existing = this._records.get(messageId)
    if (existing !== undefined) return snapshot(existing)

    while (this._records.size >= this.maxPending) {
      this._evictOldest()
    }

    const record = {
      messageId,
      roomKey,
      queuedAt: this._now(),
      timer: null
    }

    record.timer = this._setTimeout(() => this._expire(messageId), this.ttlMs)
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref()

    this._records.set(messageId, record)
    return snapshot(record)
  }

  /**
   * A room peer has been observed. Mark every pending record replicated and
   * emit one update per record in oldest-first order. Repeated observations
   * are no-ops once the records are gone.
   */
  observePeer (peerCount = 1) {
    if (this._closed) return []

    const count = Number.isFinite(peerCount) ? Math.max(0, Math.floor(peerCount)) : 0
    if (count < 1) return []

    const updates = []
    for (const record of [...this._records.values()]) {
      this._settle(record, 'replicated', count, updates)
    }
    return updates
  }

  close () {
    if (this._closed) return
    this._closed = true

    for (const record of this._records.values()) {
      this._clearTimer(record)
    }
    this._records.clear()
  }

  _evictOldest () {
    const oldest = this._records.values().next().value
    if (oldest === undefined) return
    this._log(`[delivery] expiring oldest queued message ${oldest.messageId} at capacity`)
    this._settle(oldest, 'expired', 0)
  }

  _expire (messageId) {
    if (this._closed) return
    const record = this._records.get(messageId)
    if (record === undefined) return
    this._settle(record, 'expired', 0)
  }

  _settle (record, status, peerCount, updates) {
    if (!this._records.has(record.messageId)) return

    this._clearTimer(record)
    this._records.delete(record.messageId)

    const update = {
      type: 'delivery_update',
      message_id: record.messageId,
      room_key: record.roomKey,
      status,
      peer_count: peerCount,
      timestamp: this._now()
    }

    if (updates !== undefined) updates.push(update)
    this.emit('update', update)
  }

  _clearTimer (record) {
    if (record.timer === null) return
    this._clearTimeout(record.timer)
    record.timer = null
  }
}

function snapshot (record) {
  return {
    message_id: record.messageId,
    room_key: record.roomKey,
    queued_at: record.queuedAt
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_PENDING,
  TTL_ENV,
  MAX_PENDING_ENV,
  DeliveryError,
  DeliveryTracker
}
