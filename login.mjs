#!/usr/bin/env node
/**
 * CARDLADDER-APP-1: Interactive Card Ladder login.
 *
 * Opens a REAL (headed) Chromium window on the SAME persistent user-data-dir
 * the worker uses, navigates to the Card Ladder login page, and waits for the
 * human to sign in — handling 2FA / captcha / "verify it's you" that a
 * headless worker can't. Cookies persist to disk automatically via the
 * persistent context, so the worker reuses the session on its next run.
 *
 * IMPORTANT: Chromium locks a persistent user-data-dir to a single process,
 * so the worker MUST be stopped while this runs. The Electron app enforces
 * that; if you run it by hand, stop `index.mjs` first.
 *
 * Lifecycle: launch → print CLW_LOGIN_READY → wait until the user closes the
 * window → print CLW_LOGIN_DONE → exit. The Electron main watches for those
 * sentinels (and the process exit) to drive the UI.
 */

import { PROXIES } from './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'

const BROWSER_CONTEXT_DIR = process.env.BROWSER_CONTEXT_DIR ?? './browser-state-context'
const LOGIN_URL = process.env.CARD_LADDER_LOGIN_URL ?? `${CARD_LADDER_BASE}/login`

// `--profile N` logs into the Nth proxy's own browser profile, through that
// proxy, so the cf_clearance cookie it earns is valid for that proxy's IP.
// Without --profile we use the default single profile (./browser-state-context).
const pi = process.argv.indexOf('--profile')
const profile = pi !== -1 ? Number(process.argv[pi + 1]) : null
let contextDir = BROWSER_CONTEXT_DIR
let proxy
if (profile != null) {
  if (!PROXIES[profile]) {
    console.error(`No proxy #${profile} in proxies.txt (found ${PROXIES.length}).`)
    process.exit(1)
  }
  contextDir = `${BROWSER_CONTEXT_DIR}-${profile}`
  proxy = PROXIES[profile]
  console.log(`Logging in profile ${profile} via ${proxy.server} (dir: ${contextDir})`)
} else {
  proxy = PROXIES[0] // single-proxy mode (or undefined for direct)
}

let ctx
try {
  // CARDLADDER-APP-2: real Chrome + anti-automation flags to clear Cloudflare.
  ctx = await launchContext(contextDir, { headless: false, proxy })
} catch (e) {
  // Most common cause: the worker is still running and holds the context lock.
  console.error(`CLW_LOGIN_ERROR ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const page = ctx.pages()[0] ?? await ctx.newPage()
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {
  // Non-fatal — the user can still navigate manually if the URL changed.
})

console.log('CLW_LOGIN_READY')

// Resolve when the user closes the browser (all windows) — cookies are already
// persisted to BROWSER_CONTEXT_DIR by that point.
await new Promise((resolve) => {
  let done = false
  const finish = () => { if (!done) { done = true; resolve() } }
  ctx.on('close', finish)
  // Belt-and-suspenders: if only the last page is closed, close the context too.
  page.on('close', () => { ctx.close().catch(() => {}) })
})

await ctx.close().catch(() => {})
console.log('CLW_LOGIN_DONE')
process.exit(0)
