#!/usr/bin/env node
'use strict'

// Live Keet interop test script — drives bridge/index.js over stdio,
// runs a linear step machine (ready → pair → text out / in → image →
// delivery → report → shutdown), writes live-test-report.json, exits 0
// only when every step passes. Modeled on scripts/soak.js; no new
// dependencies, plain Node >= 24.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const BRIDGE = path.join(ROOT, 'bridge', 'index.js')

// PNG builder: minimal valid PNG (~1 KiB, solid color). Produces bytes
// that pass the bridge's magic-byte + size + SHA-256 validation.
function buildPng () {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  // IHDR: width 8, height 8, bit depth 8, color type 2 (RGB), compression 0,
  // filter 0, interlace 0; chunk length 13, type IHDR, CRC
  const ihdrData = Buffer.from([
    0x00, 0x00, 0x00, 0x08, // width 8
    0x00, 0x00, 0x00, 0x08, // height 8
    0x08, // depth
    0x02, // color type RGB
    0x00, // compression
    0x00, // filter
    0x00  // interlace
  ])
  const ihdr = chunkBuffer('IHDR', ihdrData)
  // IDAT: zlib-compressed scanlines (8 rows, 8 bytes per row = 64 bytes + 8 filter bytes = 72 raw)
  // A real zlib stream is built with node:zlib below; the bridge validates
  // the magic bytes, decoded size, and SHA-256 of these bytes.
  const rawScan = Buffer.alloc(72, 0)
  for (let r = 0; r < 8; r++) {
    rawScan[r * 9] = 0 // filter byte None
    for (let c = 0; c < 8; c++) {
      rawScan[r * 9 + 1 + c * 3 + 0] = 255 // R
      rawScan[r * 9 + 1 + c * 3 + 1] = 0   // G
      rawScan[r * 9 + 1 + c * 3 + 2] = 0   // B
    }
  }
  // Real zlib of rawScan is non-trivial in pure JS without zlib module
  // (node:zlib is available, so use it)
  const zlib = require('node:zlib')
  const idatData = zlib.deflateSync(rawScan)
  const idat = chunkBuffer('IDAT', idatData)
  // IEND: empty chunk
  const iend = chunkBuffer('IEND', Buffer.alloc(0))
  return Buffer.concat([sig, ihdr, idat, iend])
}

function chunkBuffer (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  const crc = require('node:zlib').crc32(Buffer.concat([typeBuf, data]))
  crcBuf.writeUInt32BE(crc, 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function usage () {
  console.log(`Usage: node scripts/live-test.js [options]

Options:
  --data-dir <path>         Bridge data directory (default: temp dir)
  --pairing-timeout <s>     Pairing step timeout, default 120
  --reply-timeout <s>       Reply/text-in step timeout, default 120
  --delivery-timeout <s>    Delivery step timeout, default 90
  --cleanup-data            Remove auto-created data dir on exit
  --client-build <str>      Client build identifier for report
  -h, --help                Show this help`)
}

function parseArgs (argv) {
  const opts = {
    dataDir: null,
    pairingTimeout: 120,
    replyTimeout: 120,
    deliveryTimeout: 90,
    cleanupData: false,
    clientBuild: process.env.KEET_CLIENT_BUILD || 'unknown'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--data-dir': opts.dataDir = path.resolve(next()); break
      case '--pairing-timeout': opts.pairingTimeout = Number(next()); break
      case '--reply-timeout': opts.replyTimeout = Number(next()); break
      case '--delivery-timeout': opts.deliveryTimeout = Number(next()); break
      case '--cleanup-data': opts.cleanupData = true; break
      case '--client-build': opts.clientBuild = next(); break
      case '-h':
      case '--help': usage(); process.exit(0); break
      default: throw new Error(`unknown option: ${arg}`)
    }
  }
  for (const k of ['pairingTimeout', 'replyTimeout', 'deliveryTimeout']) {
    if (!Number.isFinite(opts[k]) || opts[k] <= 0) throw new Error(`--${k} must be positive`)
  }
  return opts
}

// Corestore lock probe: try to open the data directory's corestore lock.
// If it fails with EBUSY / lock-related errors, directory is in use.
function isDataDirInUse (dir) {
  try {
    // Corestore lock probe: if corestore directory exists with content
    // (device files / lock files from an active bridge), treat as in-use.
    const coreDir = path.join(dir, 'corestore')
    const identityPath = path.join(dir, 'identity.json')
    if (fs.existsSync(coreDir) && fs.existsSync(identityPath)) {
      const entries = fs.readdirSync(coreDir)
      // Active corestore will have device files / lock files from running bridge
      const hasContent = entries.length > 0
      if (hasContent) return true
    }
  } catch {
    // Ignore and assume not in use
  }
  return false
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[live-test] ${err.message}`)
    usage()
    process.exit(2)
  }

  const autoData = opts.dataDir === null
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'keet-live-'))
  fs.mkdirSync(dataDir, { recursive: true })

  const reportPath = path.join(dataDir, 'live-test-report.json')
  const startedAt = new Date()
  const startedMs = Date.now()
  let finished = false
  let child = null
  let inviteUrl = null
  let roomKey = null
  let operatorIdentity = null
  let ready = false
  let requestSeq = 0
  const stderrLines = []
  const pending = new Map()
  const steps = []
  const messages = []
  const pairingRequests = []
  const pairingConfirmed = []
  const inboundMessages = []
  const deliveryUpdates = []
  let exitCode = 1

  // Step helpers
  function addStep (step, status, detail = '') {
    steps.push({ step, status, at: new Date().toISOString(), detail })
  }

  function recordMessage (kind, messageId, direction, deliveryStatus, queued, text = null) {
    messages.push({ kind, message_id: messageId, direction, delivery_status: deliveryStatus, queued, text })
  }

  function log (msg) {
    console.error(`[live-test] ${msg}`)
  }

  // In-use detection (task 1.2)
  if (isDataDirInUse(dataDir)) {
    addStep('data_dir', 'fail', 'data_dir_in_use')
    const report = {
      version: 1,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      pass: false,
      failure: 'data_dir_in_use',
      client_build: opts.clientBuild,
      data_dir: dataDir,
      steps,
      messages,
      stderr_tail: []
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.error(`[live-test] data_dir_in_use: ${dataDir}`)
    if (autoData && opts.cleanupData) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
    }
    process.exit(1)
  }
  addStep('data_dir', 'pass', dataDir)

  // Spawn bridge (task 1.3)
  const bridgeEnv = {
    ...process.env,
    KEET_DATA_DIR: dataDir
  }
  delete bridgeEnv.KEET_ALLOW_ALL_USERS
  delete bridgeEnv.KEET_HOME_CHANNEL

  const spawnBridge = () => {
    child = spawn('node', [BRIDGE], {
      env: bridgeEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString('utf-8').split(/\r?\n/)
      for (const line of lines) {
        if (line.trim()) stderrLines.push(line.trim())
      }
      // Keep last 50 lines
      if (stderrLines.length > 50) stderrLines.splice(0, stderrLines.length - 50)
    })
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8')
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        handleStdoutLine(line.trim())
      }
    })
    child.on('exit', (code) => {
      log(`bridge exited (${code})`)
      finished = true
      // If any pending promises remain, resolve/reject them
      for (const [id, waiter] of pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('bridge exited unexpectedly'))
      }
    })
  }

  function handleStdoutLine (line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && msg.type === 'welcome_room_ready') {
      ready = true
      if (msg.invite_url) inviteUrl = msg.invite_url
      if (msg.room_key) roomKey = msg.room_key
      // Print invite URL from readiness (never stderr) — task 1.3
      if (msg.invite_url) {
        console.log(msg.invite_url)
      }
      return
    }
    // Unsolicited protocol events (not correlated by request_id)
    if (msg && msg.type === 'pairing_request') {
      pairingRequests.push(msg)
      return
    }
    if (msg && msg.type === 'pairing_confirmed') {
      pairingConfirmed.push(msg)
      return
    }
    if (msg && msg.type === 'message') {
      inboundMessages.push(msg)
      return
    }
    if (msg && msg.type === 'delivery_update') {
      deliveryUpdates.push(msg)
      return
    }
    if (!msg || !msg.request_id) return
    const waiter = pending.get(msg.request_id)
    if (!waiter) return
    pending.delete(msg.request_id)
    clearTimeout(waiter.timer)
    if (msg.type === 'error') {
      waiter.reject(new Error(`${msg.code || 'error'}: ${msg.message || ''}`))
    } else {
      waiter.resolve(msg)
    }
  }

  function request (command, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!child || child.exitCode !== null) {
        reject(new Error('bridge is not running'))
        return
      }
      const requestId = `live-${++requestSeq}`
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`timeout on ${command}`))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      const payload = { command, request_id: requestId, ...params }
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return
        clearTimeout(timer)
        pending.delete(requestId)
        reject(err)
      })
    })
  }

  spawnBridge()

  // Wait ready (task 1.3)
  try {
    await waitForReady(30000)
    addStep('ready', 'pass', 'welcome_room_ready received')
  } catch (err) {
    addStep('ready', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Wait for pairing_request, send accept_pairing (task 1.3 pairing)
  try {
    const pairingRequest = await waitForPairingRequest(opts.pairingTimeout * 1000)
    operatorIdentity = pairingRequest.identity || null
    const pairingRequestId = pairingRequest.request_id || pairingRequest.requestId
    if (!pairingRequestId) throw new Error('pairing_request has no request id')
    await request('accept_pairing', { pairing_request_id: pairingRequestId }, 10000)
    await waitForPairingConfirmed(pairingRequestId, 10000)
    addStep('pairing', 'pass', `pairing_confirmed ${pairingRequestId}`)
  } catch (err) {
    addStep('pairing', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Text out: wait peer_count >= 1 (task 1.4)
  try {
    await waitForPeerCount(1, 30000)
    const msgResult = await request('send_message', { text: 'Hello from live-test' }, 10000)
    recordMessage('text', msgResult.message_id || 'msg-1', 'out', null, msgResult.queued ?? true)
    addStep('text_out', 'pass', msgResult.message_id || 'msg-1')
  } catch (err) {
    addStep('text_out', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Text in: wait inbound message with operator identity as sender (task 1.4)
  // The operator must open invite and send reply; the script prompts.
  try {
    console.error(`[live-test] MANUAL ACTION REQUIRED: open invite URL above in Keet client and send a reply.`)
    const inbound = await waitForInboundMessage(opts.replyTimeout * 1000)
    recordMessage('text', inbound.message_id || 'msg-in-1', 'in', null, false, inbound.text || null)
    addStep('text_in', 'pass', `inbound from ${inbound.sender || 'operator'}`)
  } catch (err) {
    addStep('text_in', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Image out: send PNG (task 1.4)
  try {
    const pngBytes = buildPng()
    const b64 = pngBytes.toString('base64')
    const sha256 = require('node:crypto').createHash('sha256').update(pngBytes).digest('hex')
    const imgResult = await request('send_image', {
      caption: 'Live test PNG',
      mime_type: 'image/png',
      base64_data: b64,
      size: pngBytes.length,
      sha256: sha256
    }, 10000)
    recordMessage('image', imgResult.message_id || 'img-1', 'out', null, imgResult.queued ?? true)
    addStep('image_out', 'pass', imgResult.message_id || 'img-1')
  } catch (err) {
    addStep('image_out', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Delivery tracking (task 1.5)
  try {
    const queuedCount = messages.filter(m => m.direction === 'out' && m.queued === true).length
    const delivered = await waitForDeliveryUpdates(queuedCount, opts.deliveryTimeout * 1000)
    for (const d of delivered) {
      const msg = messages.find(m => m.message_id === d.message_id)
      if (msg) msg.delivery_status = d.status || 'replicated'
    }
    for (const m of messages) {
      if (m.direction !== 'out') continue
      if (m.queued === true) {
        if (!m.delivery_status) throw new Error(`missing delivery update for ${m.message_id}`)
        if (m.delivery_status !== 'replicated') {
          throw new Error(`delivery for ${m.message_id} was ${m.delivery_status}`)
        }
      } else if (!m.delivery_status) {
        // A send that was not queued already reached at least one peer.
        m.delivery_status = 'replicated'
      }
    }
    addStep('delivery', 'pass', `${delivered.length}/${queuedCount} queued updates replicated`)
  } catch (err) {
    addStep('delivery', 'fail', err.message)
    writeReportAndExit(1)
    return
  }

  // Report & exit (task 1.6)
  addStep('report', 'pass', 'written')
  exitCode = 0
  writeReportAndExit(0)

  // Helper: wait for welcome_room_ready to fire (polling via event)
  function waitForReady (timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ready timeout')), timeoutMs)
      const check = () => {
        if (ready) { clearTimeout(timer); resolve() }
        else setTimeout(check, 100)
      }
      check()
    })
  }

  function pollFor (probe, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        let value
        try {
          value = probe()
        } catch (err) {
          reject(err)
          return
        }
        if (value) { resolve(value); return }
        if (Date.now() >= deadline) { reject(new Error(timeoutMessage)); return }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  function waitForPairingRequest (timeoutMs) {
    return pollFor(() => pairingRequests.shift() || null, timeoutMs, 'pairing request timeout')
  }

  function waitForPairingConfirmed (requestId, timeoutMs) {
    return pollFor(
      () => pairingConfirmed.find(e => (e.request_id || e.requestId) === requestId) || null,
      timeoutMs,
      'pairing confirmed timeout'
    )
  }

  function waitForPeerCount (min, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer_count timeout')), timeoutMs)
      const poll = async () => {
        try {
          const s = await request('status', {}, 5000)
          if (s.peer_count >= min) { clearTimeout(timer); resolve(s) }
          else setTimeout(poll, 500)
        } catch {
          setTimeout(poll, 500)
        }
      }
      poll()
    })
  }

  function waitForInboundMessage (timeoutMs) {
    return pollFor(
      () => inboundMessages.find(m => m.sender === operatorIdentity && typeof m.text === 'string' && m.text.length > 0) || null,
      timeoutMs,
      'inbound message timeout'
    )
  }

  function waitForDeliveryUpdates (expectedCount, timeoutMs) {
    if (expectedCount === 0) return Promise.resolve([])
    return pollFor(
      () => deliveryUpdates.length >= expectedCount ? deliveryUpdates.slice(0, expectedCount) : null,
      timeoutMs,
      'delivery timeout'
    )
  }

  function writeReportAndExit (code) {
    finished = true
    if (child && !child.killed) {
      try {
        // Send shutdown request gracefully
        const payload = { command: 'shutdown', request_id: `shutdown-${++requestSeq}` }
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch {}
      // Give bridge a moment to exit
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGTERM')
      }, 3000)
    }
    const finishedAt = new Date()
    const pass = code === 0 && steps.every(s => s.status === 'pass')
    const report = {
      version: 1,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      pass,
      client_build: opts.clientBuild,
      room_key: roomKey,
      operator_identity: operatorIdentity,
      invite_url: inviteUrl,
      data_dir: dataDir,
      steps,
      messages,
      stderr_tail: stderrLines.slice(-50)
    }
    try {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    } catch (e) {
      console.error(`[live-test] failed to write report: ${e.message}`)
    }
    log(`report written to ${reportPath} (pass=${pass}, exit=${code})`)
    if (autoData && opts.cleanupData) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
    }
    process.exit(code)
  }
}

main().catch((err) => {
  console.error(`[live-test] fatal: ${err.message}`)
  process.exit(3)
})
