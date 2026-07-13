#!/usr/bin/env node
/**
 * Cross-platform 15-minute loop for monitor.mjs (Windows/Linux/macOS).
 * Spawns a fresh `node monitor.mjs` each cycle (clean process, no lock buildup),
 * waits for it to finish, then sleeps 15 minutes. Passes through any extra args.
 *
 *   node monitor-loop.mjs
 *   node monitor-loop.mjs --threshold 0.75 --max-add 40
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// Minutes between cycles (default 5). Override with INTERVAL_MIN env var.
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN) || 5
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000
const extra = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runOnce() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, 'monitor.mjs'), ...extra], { cwd: HERE, stdio: 'inherit' })
    p.on('exit', (code) => resolve(code))
    p.on('error', (e) => { console.error('spawn error:', e.message); resolve(1) })
  })
}

console.log(`monitor-loop started — every ${INTERVAL_MS / 60000} min. Ctrl+C to stop.`)
// eslint-disable-next-line no-constant-condition
while (true) {
  const code = await runOnce()
  console.log(`--- cycle exited (${code}); sleeping ${INTERVAL_MIN} min at ${new Date().toISOString()} ---`)
  await sleep(INTERVAL_MS)
}
