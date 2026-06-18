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
 * Credential auto-fill: if CL_EMAIL / CL_PASSWORD are set (settings.txt or env),
 * we PRE-FILL the email + password fields for you so you only have to clear the
 * Cloudflare / 2FA human-check and submit. Fully hands-off login is impossible
 * here — Cloudflare's challenge is exactly what blocks a silent headless login,
 * which is why this window is visible. If the fields can't be found (the form
 * changed), we leave them blank and you just type them in — never blocks you.
 *
 * IMPORTANT: Chromium locks a persistent user-data-dir to a single process,
 * so the worker MUST be stopped while this runs. The Electron app enforces
 * that; if you run it by hand, stop `index.mjs` first.
 *
 * Usage:
 *   node login.mjs                # default single profile (./browser-state-context)
 *   node login.mjs --profile 0    # the Nth proxy's own profile, through that proxy
 *   node login.mjs --all          # walk through EVERY proxy profile, one window at a time
 *
 * Lifecycle (per window): launch → print CLW_LOGIN_READY → wait until the user
 * closes the window → print CLW_LOGIN_DONE → continue/exit. The Electron main
 * watches for those sentinels (and the process exit) to drive the UI.
 */

import { PROXIES } from './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'

const BROWSER_CONTEXT_DIR = process.env.BROWSER_CONTEXT_DIR ?? './browser-state-context'
const LOGIN_URL = process.env.CARD_LADDER_LOGIN_URL ?? `${CARD_LADDER_BASE}/login`

const EMAIL = process.env.CL_EMAIL || ''
const PASSWORD = process.env.CL_PASSWORD || ''

/**
 * Best-effort pre-fill of the email + password fields. The window is visible,
 * so if anything here misses (selector changed, slow load) the user can just
 * type manually — we swallow errors and never block the login.
 */
async function autofill(page) {
  if (!EMAIL && !PASSWORD) return
  try {
    if (EMAIL) {
      const email = page.locator(
        'input[type="email"]:visible, input[name="email" i]:visible, input[autocomplete="username"]:visible'
      ).first()
      await email.waitFor({ state: 'visible', timeout: 8000 })
      await email.fill(EMAIL)
    }
    if (PASSWORD) {
      const pass = page.locator(
        'input[type="password"]:visible, input[name="password" i]:visible, input[autocomplete="current-password"]:visible'
      ).first()
      await pass.waitFor({ state: 'visible', timeout: 8000 })
      await pass.fill(PASSWORD)
    }
    console.log('Pre-filled credentials — clear the human-check / 2FA and submit.')
  } catch {
    console.log('Could not auto-fill the login form — type your email/password manually.')
  }
}

/**
 * Open one login window for a profile and resolve once the user closes it.
 * Cookies are already persisted to `contextDir` by the time the window closes.
 */
async function loginProfile({ contextDir, proxy, label }) {
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

  await autofill(page)

  console.log(`CLW_LOGIN_READY${label ? ` ${label}` : ''}`)

  // Resolve when the user closes the browser (all windows) — cookies are already
  // persisted to contextDir by that point.
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    ctx.on('close', finish)
    // Belt-and-suspenders: if only the last page is closed, close the context too.
    page.on('close', () => { ctx.close().catch(() => {}) })
  })

  await ctx.close().catch(() => {})
  console.log(`CLW_LOGIN_DONE${label ? ` ${label}` : ''}`)
}

// ── Resolve which profile(s) to log in ──────────────────────────────────────
const all = process.argv.includes('--all')
const pi = process.argv.indexOf('--profile')
const profile = pi !== -1 ? Number(process.argv[pi + 1]) : null

if (all) {
  // Walk through every proxy profile in sequence, one window at a time. The
  // persistent dirs lock per-process, so we MUST finish (close) one before the
  // next. Same CL_EMAIL/CL_PASSWORD pre-fills each one.
  if (PROXIES.length === 0) {
    console.error('--all needs proxies in proxies.txt (each proxy = one profile). For a single login, run without --all.')
    process.exit(1)
  }
  console.log(`Logging in ${PROXIES.length} proxy profile(s) in sequence. Sign in + close each window to advance.`)
  for (let i = 0; i < PROXIES.length; i++) {
    console.log(`\n=== Profile ${i} via ${PROXIES[i].server} ===`)
    await loginProfile({ contextDir: `${BROWSER_CONTEXT_DIR}-${i}`, proxy: PROXIES[i], label: `p${i}` })
  }
  console.log('\nAll profiles done.')
  process.exit(0)
}

if (profile != null) {
  // `--profile N` logs into the Nth proxy's own browser profile, through that
  // proxy, so the cf_clearance cookie it earns is valid for that proxy's IP.
  if (!PROXIES[profile]) {
    console.error(`No proxy #${profile} in proxies.txt (found ${PROXIES.length}).`)
    process.exit(1)
  }
  console.log(`Logging in profile ${profile} via ${PROXIES[profile].server} (dir: ${BROWSER_CONTEXT_DIR}-${profile})`)
  await loginProfile({ contextDir: `${BROWSER_CONTEXT_DIR}-${profile}`, proxy: PROXIES[profile], label: `p${profile}` })
  process.exit(0)
}

// Default: single profile (or single-proxy mode if proxies.txt has one entry).
await loginProfile({ contextDir: BROWSER_CONTEXT_DIR, proxy: PROXIES[0] })
process.exit(0)
