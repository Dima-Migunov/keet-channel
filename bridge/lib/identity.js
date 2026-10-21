'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const crypto = require('hypercore-crypto')
const IdentityKey = require('keet-identity-key')

const DATA_DIR_ENV = 'KEET_DATA_DIR'
const IDENTITY_VERSION = 1

class StorageError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

function resolveDataDir (env = process.env) {
  const override = env && env[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim())
  }
  return path.join(os.homedir(), '.keet-channel')
}

function dataPaths (dataDir) {
  return {
    dir: dataDir,
    identityFile: path.join(dataDir, 'identity.json'),
    roomFile: path.join(dataDir, 'room.json'),
    allowedFile: path.join(dataDir, 'allowed.json'),
    corestoreDir: path.join(dataDir, 'corestore')
  }
}

function ensureMode (target, mode) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
  if ((stat.mode & 0o777) !== mode) fs.chmodSync(target, mode)
  return true
}

function ensureDataDir (dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  ensureMode(dataDir, 0o700)
  const { corestoreDir } = dataPaths(dataDir)
  fs.mkdirSync(corestoreDir, { recursive: true, mode: 0o700 })
  ensureMode(corestoreDir, 0o700)
  return dataDir
}

function writeJsonAtomic (file, value, opts = {}) {
  const mode = opts.mode === undefined ? 0o600 : opts.mode
  const dir = path.dirname(file)
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  )
  const data = JSON.stringify(value, null, 2) + '\n'

  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    fs.writeFileSync(fd, data, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }

  fs.chmodSync(file, mode)

  let dirFd = null
  try {
    dirFd = fs.openSync(dir, 'r')
    fs.fsyncSync(dirFd)
  } catch {
    // Directory fsync is a durability nicety; some filesystems reject it.
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd) } catch {}
    }
  }
}

function readJsonFile (file, label) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StorageError('ENOENT', `${label} not found at ${file}`)
    }
    throw new StorageError('READ_FAILED', `Cannot read ${label} at ${file}: ${err.message}`)
  }

  try {
    return JSON.parse(raw)
  } catch {
    throw new StorageError('INVALID_JSON', `Invalid ${label} at ${file}: file is not valid JSON`)
  }
}

function readIdentityFile (file) {
  const value = readJsonFile(file, 'identity file')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageError('INVALID_IDENTITY', `Invalid identity file at ${file}: expected a JSON object`)
  }
  if (value.version !== IDENTITY_VERSION) {
    throw new StorageError(
      'INVALID_IDENTITY',
      `Invalid identity file at ${file}: unsupported version ${String(value.version)}`
    )
  }
  if (typeof value.mnemonic !== 'string' || value.mnemonic.trim() === '') {
    throw new StorageError('INVALID_IDENTITY', `Invalid identity file at ${file}: missing mnemonic`)
  }
  return value
}

class Identity {
  constructor ({ dataDir, identityKey, created = false }) {
    this.dataDir = dataDir
    this.identityKey = identityKey
    this.created = created
  }

  static async loadOrCreate (opts = {}) {
    const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : resolveDataDir(opts.env)
    ensureDataDir(dataDir)
    const { identityFile } = dataPaths(dataDir)

    let stored = null
    try {
      stored = readIdentityFile(identityFile)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    if (stored) {
      ensureMode(identityFile, 0o600)
      let identityKey
      try {
        identityKey = await IdentityKey.from({ mnemonic: stored.mnemonic })
      } catch {
        throw new StorageError(
          'INVALID_IDENTITY',
          `Invalid identity file at ${identityFile}: mnemonic could not be loaded`
        )
      }
      return new Identity({ dataDir, identityKey, created: false })
    }

    const mnemonic = IdentityKey.generateMnemonic()
    const identityKey = await IdentityKey.from({ mnemonic })
    writeJsonAtomic(identityFile, { version: IDENTITY_VERSION, mnemonic })

    return new Identity({ dataDir, identityKey, created: true })
  }

  get publicKey () {
    return this.identityKey.identityPublicKey
  }

  get publicKeyHex () {
    return this.publicKey.toString('hex')
  }

  get keyPair () {
    return this.identityKey.identityKeyPair
  }

  get signingKeyPair () {
    return this.identityKey.identityKeyPair
  }

  sign (message) {
    return crypto.sign(message, this.keyPair.secretKey)
  }

  clear () {
    this.identityKey.clear()
  }
}

module.exports = {
  DATA_DIR_ENV,
  IDENTITY_VERSION,
  StorageError,
  Identity,
  resolveDataDir,
  dataPaths,
  ensureDataDir,
  ensureMode,
  writeJsonAtomic,
  readJsonFile
}
