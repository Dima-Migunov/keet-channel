#!/usr/bin/env node
'use strict'

// 48-hour soak runner for the Keet bridge.
//
// Spawns bridge/index.js on an isolated data directory, waits for readiness,
// then samples process RSS, open file descriptors, queue depth, media slot
// usage, pending delivery records, and inbox file count until the requested
// duration elapses. Writes a JSON report plus a CSV sample log and exits
// non-zero when any threshold is crossed.
//
// Short smoke:  node scripts/soak.js --duration 10 --interval 1
// Full soak:    node scripts/soak.js --duration 172800 --interval 60

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const BRIDGE = path.join(ROOT, 'bridge', 'index.js')

function usage () {
  console.log(`Usage: node scripts/soak.js [options]

Options:
  --duration <seconds>      Run length (default: 172800, i.e. 48 hours)
  --interval <seconds>      Sampling interval (default: 60)
  --data-dir <path>         Bridge data directory (default: a new temp dir)
  --report <path>           JSON report path (default: soak-report.json)
  --rss-limit-mb <n>        Absolute RSS limit, per sample (default: 512)
  --rss-growth-mb <n>       Allowed RSS growth from baseline (default: 256)
  --fd-limit <n>            Absolute open file descriptor limit (default: 256)
  --max-queued <n>          Max queued_messages (default: 16)
  --max-delivery <n>        Max pending delivery records (default: 64)
  --max-inbox <n>           Max persisted inbox files (default: 512)
  --keep-data               Keep an auto-created data directory (default: keep)
  --cleanup-data            Remove the auto-created data directory on exit
  -h, --help                Show this help`)
}

function parseArgs (argv) {
  const opts = {
    duration: 172800,
    interval: 60,
    dataDir: null,
    report: 'soak-report.json',
    rssLimitMb: 512,
    rssGrowthMb: 256,
    fdLimit: 256,
    maxQueued: 16,
    maxDelivery: 64,
    maxInbox: 512,
    cleanupData: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--duration': opts.duration = Number(next()); break
      case '--interval': opts.interval = Number(next()); break
      case '--data-dir': opts.dataDir = path.resolve(next()); break
      case '--report': opts.report = path.resolve(next()); break
      case '--rss-limit-mb': opts.rssLimitMb = Number(next()); break
      case '--rss-growth-mb': opts.rssGrowthMb = Number(next()); break
      case '--fd-limit': opts.fdLimit = Number(next()); break
      case '--max-queued': opts.maxQueued = Number(next()); break
      case '--max-delivery': opts.maxDelivery = Number(next()); break
      case '--max-inbox': opts.maxInbox = Number(next()); break
      case '--keep-data': opts.cleanupData = false; break
      case '--cleanup-data': opts.cleanupData = true; break
      case '-h':
      case '--help': usage(); process.exit(0); break
      default: throw new Error(`unknown option: ${arg}`)
    }
  }
  for (const key of ['duration', 'interval']) {
    if (!Number.isFinite(opts[key]) || opts[key] <= 0) {
      throw new Error(`--${key} must be a positive number`)
    }
  }
  return opts
}

function readRssMb (pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)
    return match ? Math.round(Number(match[1]) / 1024 * 10) / 10 : null
  } catch {
    return null
  }
}

function countFileDescriptors (pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return null
  }
}

function countInboxFiles (dataDir) {
  try {
    return fs.readdirSync(path.join(dataDir, 'media', 'inbox'))
      .filter((name) => !name.startsWith('.tmp-')).length
  } catch {
    return 0
  }
}

function removeDataDir (dataDir) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[soak] failed to remove ${dataDir}: ${err.message}`)
  }
}

async function main () {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[soak] ${err.message}`)
    usage()
    process.exit(2)
  }

  const autoData = opts.dataDir === null
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'keet-soak-'))
  fs.mkdirSync(dataDir, { recursive: true })

  const reportBase = opts.report.replace(/\.json$/i, '')
  const csvPath = `${reportBase}.csv`
  const startedAt = new Date()
  const startedMs = Date.now()
  let samplingStartMs = null
  const samples = []
  const stderrLines = []
  const pending = new Map()
  let errors = 0
  let child = null
  let finished = false
  let ready = false
  let requestSeq = 0
  let sampleTimer = null

  const bridgeEnv = {
    ...process.env,
    KEET_DATA_DIR: dataDir
  }
  delete bridgeEnv.KEET_ALLOW_ALL_USERS
  delete bridgeEnv.KEET_HOME_CHANNEL

  function log (message) {
    console.error(`[soak] ${message}`)
  }

  function request (command, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!child || child.exitCode !== null) {
        reject(new Error(`bridge is not running (${command})`))
        return
      }
      const requestId = `soak-${++requestSeq}`
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`timeout waiting for ${command}`))
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

  function handleLine (line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message && message.type === 'welcome_room_ready') {
      ready = true
      return
    }
    if (!message || !message.request_id) return
    const waiter = pending.get(message.request_id)
    if (!waiter) return
    pending.delete(message.request_id)
    clearTimeout(waiter.timer)
    if (message.type === 'error') {
      waiter.reject(new Error(`${message.code || 'error'}: ${message.message || ''}`))
    } else {
      waiter.resolve(message)
    }
  }

  function takeSample () {
    const rss = readRssMb(child.pid)
    const fds = countFileDescriptors(child.pid)
    return {
      at: new Date().toISOString(),
      elapsed_s: Math.round((Date.now() - (samplingStartMs || startedMs)) / 1000),
      rss_mb: rss,
      open_fds: fds,
      queued_messages: null,
      media_active: null,
      delivery_pending: null,
      inbox_files: countInboxFiles(dataDir),
      peer_count: null,
      message_count: null
    }
  }

  async function sampleOnce () {
    const sample = takeSample()
    try {
      const status = await request('status')
      sample.queued_messages = status.queued_messages
      sample.media_active = status.media_active
      sample.delivery_pending = status.delivery_pending
      sample.peer_count = status.peer_count
      sample.message_count = status.message_count
    } catch (err) {
      errors += 1
      log(`status sample failed: ${err.message}`)
    }
    samples.push(sample)
    log(
      `t=${sample.elapsed_s}s rss=${sample.rss_mb}MB fds=${sample.open_fds} ` +
      `queued=${sample.queued_messages} media=${sample.media_active} ` +
      `delivery=${sample.delivery_pending} inbox=${sample.inbox_files}`
    )
  }

  function summarize () {
    const max = (key) => samples.reduce((best, sample) => {
      const value = sample[key]
      return typeof value === 'number' && value > best ? value : best
    }, -Infinity)
    const firstRss = samples.find((sample) => typeof sample.rss_mb === 'number')
    const rssValues = samples.filter((sample) => typeof sample.rss_mb === 'number')
    const baselineRss = firstRss ? firstRss.rss_mb : 0
    const peakRss = max('rss_mb')
    const baselineFds = samples.length > 0 ? samples[0].open_fds : 0
    const peakFds = max('open_fds')
    return {
      samples: samples.length,
      baseline_rss_mb: baselineRss,
      peak_rss_mb: Number.isFinite(peakRss) ? peakRss : null,
      rss_growth_mb: rssValues.length > 0 && Number.isFinite(peakRss)
        ? Math.round((peakRss - baselineRss) * 10) / 10
        : null,
      baseline_open_fds: baselineFds,
      peak_open_fds: Number.isFinite(peakFds) ? peakFds : null,
      fds_growth: Number.isFinite(peakFds) && typeof baselineFds === 'number'
        ? peakFds - baselineFds
        : null,
      peak_queued_messages: max('queued_messages'),
      peak_media_active: max('media_active'),
      peak_delivery_pending: max('delivery_pending'),
      peak_inbox_files: max('inbox_files')
    }
  }

  function evaluate (summary) {
    const failures = []
    if (errors > 0) failures.push(`${errors} sampling or bridge error(s)`)
    if (summary.peak_rss_mb !== null && summary.peak_rss_mb > opts.rssLimitMb) {
      failures.push(`RSS ${summary.peak_rss_mb}MB > ${opts.rssLimitMb}MB`)
    }
    if (summary.rss_growth_mb !== null && summary.rss_growth_mb > opts.rssGrowthMb) {
      failures.push(`RSS growth ${summary.rss_growth_mb}MB > ${opts.rssGrowthMb}MB`)
    }
    if (summary.peak_open_fds !== null && summary.peak_open_fds > opts.fdLimit) {
      failures.push(`file descriptors ${summary.peak_open_fds} > ${opts.fdLimit}`)
    }
    if (Number.isFinite(summary.peak_queued_messages) && summary.peak_queued_messages > opts.maxQueued) {
      failures.push(`queued messages ${summary.peak_queued_messages} > ${opts.maxQueued}`)
    }
    if (Number.isFinite(summary.peak_delivery_pending) && summary.peak_delivery_pending > opts.maxDelivery) {
      failures.push(`delivery records ${summary.peak_delivery_pending} > ${opts.maxDelivery}`)
    }
    if (Number.isFinite(summary.peak_media_active) && summary.peak_media_active > 2) {
      failures.push(`media slots ${summary.peak_media_active} > 2`)
    }
    if (Number.isFinite(summary.peak_inbox_files) && summary.peak_inbox_files > opts.maxInbox) {
      failures.push(`inbox files ${summary.peak_inbox_files} > ${opts.maxInbox}`)
    }
    return failures
  }

  function writeReport (summary, failures, exitCode) {
    const finishedAt = new Date()
    const report = {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_requested_s: opts.duration,
      duration_elapsed_s: Math.round((Date.now() - (samplingStartMs || startedMs)) / 1000),
      interval_s: opts.interval,
      data_dir: dataDir,
      bridge_pid: child ? child.pid : null,
      ready,
      pass: failures.length === 0 && exitCode === 0,
      exit_code: exitCode,
      failures,
      thresholds: {
        rss_limit_mb: opts.rssLimitMb,
        rss_growth_mb: opts.rssGrowthMb,
        fd_limit: opts.fdLimit,
        max_queued: opts.maxQueued,
        max_delivery: opts.maxDelivery,
        max_media_active: 2,
        max_inbox: opts.maxInbox
      },
      summary,
      stderr_tail: stderrLines.slice(-50)
    }
    fs.mkdirSync(path.dirname(opts.report), { recursive: true })
    fs.writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`)
    const header = [
      'at', 'elapsed_s', 'rss_mb', 'open_fds', 'queued_messages',
      'media_active', 'delivery_pending', 'inbox_files', 'peer_count', 'message_count'
    ]
    const rows = samples.map((sample) => header.map((key) => sample[key]).join(','))
    fs.writeFileSync(csvPath, `${header.join(',')}\n${rows.join('\n')}\n`)
    log(`report: ${opts.report}`)
    log(`samples: ${csvPath}`)
    log(`result: ${report.pass ? 'PASS' : 'FAIL'}`)
    if (failures.length > 0) {
      for (const failure of failures) log(`failure: ${failure}`)
    }
    return report
  }

  async function shutdown () {
    if (!child || child.exitCode !== null) return
    try {
      await request('shutdown', {}, 10000)
    } catch (err) {
      log(`shutdown request failed: ${err.message}`)
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 10000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async function finish (exitCode) {
    if (finished) return
    finished = true
    if (sampleTimer) clearTimeout(sampleTimer)
    const summary = summarize()
    const failures = evaluate(summary)
    await shutdown()
    writeReport(summary, failures, failures.length === 0 ? exitCode : 1)
    if (autoData && opts.cleanupData) removeDataDir(dataDir)
    process.exit(failures.length === 0 ? exitCode : 1)
  }

  child = spawn(process.execPath, [BRIDGE], {
    env: bridgeEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf-8')
  let stdoutBuffer = ''
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let index
    while ((index = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, index)
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      handleLine(line)
    }
  })

  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      stderrLines.push(line)
      if (/unhandled|uncaught|fatal/i.test(line)) {
        errors += 1
        log(`bridge error: ${line}`)
      }
    }
  })

  child.on('exit', (code, signal) => {
    if (finished) return
    errors += 1
    log(`bridge exited early code=${code} signal=${signal}`)
    finish(1)
  })

  const readyDeadline = Date.now() + 60000
  while (!ready) {
    if (child.exitCode !== null) {
      finish(1)
      return
    }
    if (Date.now() > readyDeadline) {
      errors += 1
      log('bridge did not become ready within 60s')
      await finish(1)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  samplingStartMs = Date.now()
  log(`bridge ready pid=${child.pid} data_dir=${dataDir}`)
  log(`sampling every ${opts.interval}s for ${opts.duration}s`)

  const loop = async () => {
    if (finished) return
    await sampleOnce()
    if (finished) return
    if (Date.now() - samplingStartMs >= opts.duration * 1000) {
      await finish(0)
      return
    }
    sampleTimer = setTimeout(loop, opts.interval * 1000)
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`${signal} received; stopping`)
      finish(1)
    })
  }

  await loop()
}

main().catch((err) => {
  console.error(`[soak] fatal: ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
