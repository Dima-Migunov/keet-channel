'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { createErrorClass } = require('./errors')
const { normalizeKey } = require('./keys')
const { resolveDataDir } = require('./identity')

const MediaError = createErrorClass('MediaError')

const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILES = 512
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MEDIA_SUBDIR = path.join('media', 'inbox')
const MAX_FILES_ENV = 'KEET_MEDIA_MAX_FILES'
const MAX_AGE_ENV = 'KEET_MEDIA_MAX_AGE_MS'
const SHA256_HEX = /^[0-9a-f]{64}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

// A 10 MiB payload is about 13.4 MiB of Base64. Reject obviously oversized
// strings before allocating the decoded buffer.
const MAX_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const GIF87_SIGNATURE = Buffer.from('GIF87a', 'ascii')
const GIF89_SIGNATURE = Buffer.from('GIF89a', 'ascii')
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii')
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii')

function startsWith (buffer, signature) {
  if (buffer.byteLength < signature.byteLength) return false
  return buffer.subarray(0, signature.byteLength).equals(signature)
}

function isPng (buffer) {
  return startsWith(buffer, PNG_SIGNATURE)
}

function isJpeg (buffer) {
  return startsWith(buffer, JPEG_SIGNATURE)
}

function isGif (buffer) {
  return startsWith(buffer, GIF87_SIGNATURE) || startsWith(buffer, GIF89_SIGNATURE)
}

function isWebp (buffer) {
  return (
    buffer.byteLength >= 12 &&
    startsWith(buffer, RIFF_SIGNATURE) &&
    buffer.subarray(8, 12).equals(WEBP_SIGNATURE)
  )
}

const MIME_TYPES = new Map([
  ['image/png', { extension: 'png', detect: isPng }],
  ['image/jpeg', { extension: 'jpg', detect: isJpeg }],
  ['image/webp', { extension: 'webp', detect: isWebp }],
  ['image/gif', { extension: 'gif', detect: isGif }]
])

function toBuffer (value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new MediaError('INVALID_MEDIA', 'media bytes must be a buffer')
}

/**
 * Detect a supported image type from its magic bytes. Returns null when the
 * payload is not PNG, JPEG, WebP, or GIF.
 */
function detectMimeType (bytes) {
  const buffer = toBuffer(bytes)

  for (const [mimeType, type] of MIME_TYPES) {
    if (type.detect(buffer)) return mimeType
  }

  return null
}

function normalizeMimeType (value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MediaError('INVALID_MIME_TYPE', 'mimeType must be a non-empty string')
  }

  const mimeType = value.trim().toLowerCase()

  if (!MIME_TYPES.has(mimeType)) {
    throw new MediaError(
      'UNSUPPORTED_MIME_TYPE',
      `unsupported media type ${value}; expected image/png, image/jpeg, image/webp, or image/gif`
    )
  }

  return mimeType
}

/**
 * Strictly decode canonical Base64. Node's decoder accepts whitespace,
 * invalid characters, and non-zero trailing bits, so re-encoding and comparing
 * is the only portable way to reject a partial or non-canonical payload.
 */
function decodeBase64 (value) {
  if (typeof value !== 'string') {
    throw new MediaError('INVALID_BASE64', 'base64_data must be a string')
  }
  if (value.length === 0) {
    throw new MediaError('EMPTY_MEDIA', 'media payload must not be empty')
  }
  if (value.length > MAX_BASE64_LENGTH) {
    throw new MediaError('MEDIA_TOO_LARGE', `media must be at most ${MAX_MEDIA_BYTES} bytes`)
  }
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new MediaError('INVALID_BASE64', 'base64_data is not valid canonical Base64')
  }

  const bytes = Buffer.from(value, 'base64')

  if (bytes.byteLength === 0) {
    throw new MediaError('EMPTY_MEDIA', 'media payload must not be empty')
  }
  if (bytes.toString('base64') !== value) {
    throw new MediaError('INVALID_BASE64', 'base64_data has non-canonical padding or trailing bits')
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new MediaError('MEDIA_TOO_LARGE', `media must be at most ${MAX_MEDIA_BYTES} bytes`)
  }

  return bytes
}

function sha256Hex (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function normalizeDigest (value) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new MediaError('INVALID_DIGEST', 'sha256 must be 64 lowercase hex characters')
  }
  return value
}

/**
 * Validate a media descriptor or payload. Accepts either `mimeType` or
 * `mime_type`, and either `bytes` (buffer/Uint8Array) or `base64_data`
 * (canonical Base64 string). When a declared `size` or `sha256` is present it
 * must match the decoded bytes.
 */
function validateMedia (media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    throw new MediaError('INVALID_MEDIA', 'media must be an object')
  }

  const mimeType = normalizeMimeType(media.mimeType === undefined ? media.mime_type : media.mimeType)
  const raw = media.bytes === undefined ? media.base64_data : media.bytes
  const bytes = typeof raw === 'string' ? decodeBase64(raw) : toBuffer(raw)

  if (bytes.byteLength === 0) {
    throw new MediaError('EMPTY_MEDIA', 'media payload must not be empty')
  }
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new MediaError('MEDIA_TOO_LARGE', `media must be at most ${MAX_MEDIA_BYTES} bytes`)
  }

  const detected = detectMimeType(bytes)
  if (detected === null) {
    throw new MediaError('INVALID_IMAGE', 'media bytes are not PNG, JPEG, WebP, or GIF')
  }
  if (detected !== mimeType) {
    throw new MediaError(
      'MIME_MISMATCH',
      `declared media type ${mimeType} does not match detected type ${detected}`
    )
  }

  const sha256 = sha256Hex(bytes)
  const size = media.size === undefined ? bytes.byteLength : media.size

  if (!Number.isSafeInteger(size) || size < 0) {
    throw new MediaError('INVALID_SIZE', 'media size must be a non-negative safe integer')
  }
  if (size !== bytes.byteLength) {
    throw new MediaError(
      'SIZE_MISMATCH',
      `declared media size ${size} does not match ${bytes.byteLength} decoded bytes`
    )
  }

  if (media.sha256 !== undefined && media.sha256 !== null) {
    const declared = normalizeDigest(media.sha256)
    if (declared !== sha256) {
      throw new MediaError('DIGEST_MISMATCH', 'declared media digest does not match the decoded bytes')
    }
  }

  return {
    mimeType,
    extension: MIME_TYPES.get(mimeType).extension,
    bytes,
    size,
    sha256
  }
}

function normalizeMessageId (value) {
  try {
    return normalizeKey(value, 'messageId', MediaError).toString('hex')
  } catch {
    throw new MediaError(
      'INVALID_MESSAGE_ID',
      'messageId must be a 32-byte buffer or 64 lowercase hex characters'
    )
  }
}

function isInside (parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function parseLimit (value, fallback, name, allowZero) {
  if (value === undefined || value === null || value === '') return fallback

  const parsed = typeof value === 'number' ? value : Number(value)
  const minimum = allowZero ? 0 : 1

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new MediaError('INVALID_LIMIT', `${name} must be an integer >= ${minimum}`)
  }

  return parsed
}

function envLimit (value, fallback, name, allowZero) {
  if (value === undefined || value === null || value === '') return fallback

  const parsed = Number(value)
  const minimum = allowZero ? 0 : 1

  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
}

/**
 * Atomic, owner-only storage for inbound images. One store is shared by the
 * room and the bridge command handlers.
 */
class MediaStore {
  constructor (opts = {}) {
    const env = opts.env || process.env

    this.dataDir = path.resolve(opts.dataDir || resolveDataDir(env))
    this.inboxDir = path.join(this.dataDir, MEDIA_SUBDIR)
    this.maxFiles =
      opts.maxFiles === undefined
        ? envLimit(env[MAX_FILES_ENV], DEFAULT_MAX_FILES, 'maxFiles', false)
        : parseLimit(opts.maxFiles, DEFAULT_MAX_FILES, 'maxFiles', false)
    this.maxAgeMs =
      opts.maxAgeMs === undefined
        ? envLimit(env[MAX_AGE_ENV], DEFAULT_MAX_AGE_MS, 'maxAgeMs', true)
        : parseLimit(opts.maxAgeMs, DEFAULT_MAX_AGE_MS, 'maxAgeMs', true)
    this._fs = opts.fs || fs.promises
    this._now = typeof opts.now === 'function' ? opts.now : Date.now
    this._closed = false
    this._openPromise = null
    this._queue = Promise.resolve()
  }

  _run (fn) {
    const result = this._queue.then(fn)
    this._queue = result.then(() => {}, () => {})
    return result
  }

  async _ensureDir () {
    await this._fs.mkdir(this.inboxDir, { recursive: true, mode: 0o700 })
    await this._fs.chmod(this.inboxDir, 0o700)
  }

  async _syncDir () {
    let handle = null
    try {
      handle = await this._fs.open(this.inboxDir, 'r')
      await handle.sync()
    } catch {
      // Directory fsync is a durability nicety; some filesystems reject it.
    } finally {
      if (handle !== null) {
        try { await handle.close() } catch {}
      }
    }
  }

  async _cleanupTemp () {
    let names
    try {
      names = await this._fs.readdir(this.inboxDir)
    } catch (err) {
      if (err.code === 'ENOENT') return 0
      throw err
    }

    let removed = 0

    for (const name of names) {
      if (!name.startsWith('.tmp-')) continue
      try {
        await this._fs.unlink(path.join(this.inboxDir, name))
        removed++
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    return removed
  }

  async _prune () {
    let names
    try {
      names = await this._fs.readdir(this.inboxDir)
    } catch (err) {
      if (err.code === 'ENOENT') return 0
      throw err
    }

    const now = this._now()
    const files = []

    for (const name of names) {
      if (name.startsWith('.tmp-')) continue

      const file = path.join(this.inboxDir, name)
      let stat
      try {
        stat = await this._fs.lstat(file)
      } catch (err) {
        if (err.code === 'ENOENT') continue
        throw err
      }
      if (!stat.isFile()) continue
      files.push({ path: file, mtimeMs: stat.mtimeMs })
    }

    files.sort((a, b) => a.mtimeMs - b.mtimeMs)

    let removed = 0
    const survivors = []

    for (const file of files) {
      if (this.maxAgeMs > 0 && now - file.mtimeMs > this.maxAgeMs) {
        try {
          await this._fs.unlink(file.path)
          removed++
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
      } else {
        survivors.push(file)
      }
    }

    while (survivors.length > this.maxFiles) {
      const oldest = survivors.shift()
      try {
        await this._fs.unlink(oldest.path)
        removed++
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }

    return removed
  }

  /**
   * Create the inbox, remove temporary files from a previous process, and
   * apply retention. Safe to call more than once.
   */
  open () {
    if (!this._openPromise) {
      this._openPromise = this._run(async () => {
        await this._ensureDir()
        await this._cleanupTemp()
        await this._prune()
      })
    }
    return this._openPromise
  }

  /**
   * Persist validated bytes as `<messageId>.<ext>`. The temporary file is
   * created in the same directory, fsynced, and renamed into place, so readers
   * only ever observe a complete file.
   */
  async store (media) {
    if (this._closed) {
      throw new MediaError('STORE_CLOSED', 'media store is closed')
    }

    const validated = validateMedia(media)
    const messageId = normalizeMessageId(media && media.messageId)

    await this.open()

    return this._run(async () => {
      const filename = `${messageId}.${validated.extension}`
      const finalPath = path.join(this.inboxDir, filename)
      const tmpPath = path.join(
        this.inboxDir,
        `.tmp-${messageId}-${crypto.randomBytes(6).toString('hex')}`
      )
      let handle = null

      try {
        handle = await this._fs.open(tmpPath, 'wx', 0o600)
        await handle.writeFile(validated.bytes)
        await handle.sync()
        await handle.close()
        handle = null
        await this._fs.chmod(tmpPath, 0o600)
        await this._fs.rename(tmpPath, finalPath)
        await this._syncDir()
      } catch (err) {
        if (handle !== null) {
          try { await handle.close() } catch {}
        }
        try { await this._fs.unlink(tmpPath) } catch {}
        if (err instanceof MediaError) throw err
        throw new MediaError('STORE_FAILED', `failed to store media: ${err.message}`, err)
      }

      await this._prune()

      return {
        path: finalPath,
        messageId,
        mimeType: validated.mimeType,
        extension: validated.extension,
        size: validated.size,
        sha256: validated.sha256,
        filename
      }
    })
  }

  /**
   * Verify a stored file against declared MIME, size, and digest. The resolved
   * real path must remain inside the inbox, so a symlink cannot escape it.
   */
  async verify (media) {
    if (!media || typeof media !== 'object' || typeof media.path !== 'string') {
      throw new MediaError('INVALID_MEDIA', 'stored media must include a path')
    }

    const mimeType = normalizeMimeType(media.mimeType === undefined ? media.mime_type : media.mimeType)
    const size = media.size
    const digest = normalizeDigest(media.sha256)

    await this.open()

    let realInbox
    let realPath
    try {
      realInbox = await this._fs.realpath(this.inboxDir)
      realPath = await this._fs.realpath(path.resolve(media.path))
    } catch {
      throw new MediaError('NOT_FOUND', 'stored media file does not exist')
    }

    if (!isInside(realInbox, realPath)) {
      throw new MediaError('OUTSIDE_INBOX', 'stored media path is outside the media inbox')
    }

    let stat
    try {
      stat = await this._fs.stat(realPath)
    } catch {
      throw new MediaError('NOT_FOUND', 'stored media file does not exist')
    }

    if (!stat.isFile()) {
      throw new MediaError('NOT_A_FILE', 'stored media path is not a regular file')
    }

    const bytes = await this._fs.readFile(realPath)
    const detected = detectMimeType(bytes)

    if (detected !== mimeType) {
      throw new MediaError('MIME_MISMATCH', 'stored media type does not match its magic bytes')
    }
    if (bytes.byteLength !== size) {
      throw new MediaError('SIZE_MISMATCH', 'stored media size does not match the declared size')
    }
    if (sha256Hex(bytes) !== digest) {
      throw new MediaError('DIGEST_MISMATCH', 'stored media digest does not match the declared digest')
    }

    return { path: realPath, mimeType, size, sha256: digest }
  }

  /**
   * Remove one file, but only after resolving it inside the inbox.
   */
  async remove (file) {
    await this.open()

    let realInbox
    let realPath
    try {
      realInbox = await this._fs.realpath(this.inboxDir)
      realPath = await this._fs.realpath(path.resolve(file))
    } catch {
      throw new MediaError('NOT_FOUND', 'media file does not exist')
    }

    if (!isInside(realInbox, realPath)) {
      throw new MediaError('OUTSIDE_INBOX', 'refusing to remove a file outside the media inbox')
    }

    await this._fs.unlink(realPath)
  }

  async cleanupTemp () {
    await this.open()
    return this._run(() => this._cleanupTemp())
  }

  async prune () {
    await this.open()
    return this._run(() => this._prune())
  }

  async list () {
    await this.open()

    return this._run(async () => {
      const names = await this._fs.readdir(this.inboxDir)
      const files = []

      for (const name of names) {
        if (name.startsWith('.tmp-')) continue
        const file = path.join(this.inboxDir, name)
        let stat
        try {
          stat = await this._fs.lstat(file)
        } catch (err) {
          if (err.code === 'ENOENT') continue
          throw err
        }
        if (!stat.isFile()) continue
        files.push({ name, path: file, size: stat.size, mtimeMs: stat.mtimeMs })
      }

      return files
    })
  }

  async close () {
    this._closed = true
    if (!this._openPromise) return
    await this._run(() => this._cleanupTemp())
  }
}

module.exports = {
  MAX_MEDIA_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_AGE_MS,
  MEDIA_SUBDIR,
  MAX_FILES_ENV,
  MAX_AGE_ENV,
  MediaError,
  MIME_TYPES,
  detectMimeType,
  normalizeMimeType,
  decodeBase64,
  sha256Hex,
  validateMedia,
  normalizeMessageId,
  isInside,
  MediaStore
}
