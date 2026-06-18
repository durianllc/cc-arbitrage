/**
 * CARDLADDER-APP-2: Shared Chromium launcher tuned to get past Card Ladder's
 * Cloudflare bot challenge.
 *
 * Card Ladder (app.cardladder.com) sits behind Cloudflare's "Verifying you are
 * human" interstitial. Playwright's bundled Chromium is fingerprinted as
 * automation and gets stuck on that page forever.
 *
 * Mitigations applied here (verified working 2026-06-10, headless + headed):
 *   • channel: 'chrome'  — drive the user's REAL installed Google Chrome, not
 *     Playwright's bundled Chromium. Falls back to bundled Chromium if absent.
 *   • ignoreDefaultArgs: ['--enable-automation'] — drop the automation switch.
 *   • --disable-blink-features=AutomationControlled — removes navigator.webdriver.
 *   • De-"Headless" user-agent — headless Chrome reports a "HeadlessChrome" UA
 *     that Cloudflare flags even with a valid cf_clearance cookie. We strip the
 *     "Headless" token so the headless worker presents as a normal browser. This
 *     was THE fix that made the invisible (no-window) worker pass Cloudflare.
 *
 * Login and the worker MUST use this same launcher + the same user-data-dir so
 * the cf_clearance cookie earned during interactive login carries over to the
 * worker's headless runs.
 *
 * Escape hatch: set CARD_LADDER_UA to a full UA string to override entirely.
 * If Cloudflare ever tightens to a fully-managed Turnstile, the next levers are
 * a stealth plugin (playwright-extra + puppeteer-extra-plugin-stealth) or
 * driving Card Ladder through Electron's own Chromium. See README.
 */

import { chromium } from 'playwright'

export const CARD_LADDER_BASE = process.env.CARD_LADDER_BASE ?? 'https://app.cardladder.com'

// Optional residential proxy. A per-launch `proxy` object ({server, username,
// password}) takes priority; otherwise we fall back to PROXY_SERVER env vars.
// Recommended when running on a server whose IP Cloudflare flags.
// Format: http://host:port  or  socks5://host:port
function proxyOptsFrom(proxy) {
  const server = proxy?.server ?? process.env.PROXY_SERVER
  if (!server) return {}
  const p = { server }
  const username = proxy?.username ?? process.env.PROXY_USERNAME
  const password = proxy?.password ?? process.env.PROXY_PASSWORD
  if (username) p.username = username
  if (password) p.password = password
  console.log(`[browser] using proxy: ${server}`)
  return { proxy: p }
}

function baseOpts(headless, userAgent, proxy) {
  return {
    headless,
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    ...(userAgent ? { userAgent } : {}),
    ...proxyOptsFrom(proxy),
  }
}

async function launch(contextDir, opts) {
  try {
    return await chromium.launchPersistentContext(contextDir, { ...opts, channel: 'chrome' })
  } catch (e) {
    console.warn(
      `[browser] Google Chrome not available (${e instanceof Error ? e.message : e}); ` +
      `falling back to Playwright's bundled Chromium (more likely to hit the Cloudflare challenge).`,
    )
    return chromium.launchPersistentContext(contextDir, opts)
  }
}

export async function launchContext(contextDir, { headless, proxy } = {}) {
  const override = process.env.CARD_LADDER_UA || undefined
  let ctx = await launch(contextDir, baseOpts(headless, override, proxy))

  // Headless reports "HeadlessChrome" in the UA → Cloudflare challenge. When no
  // explicit override is set, transparently relaunch with the SAME UA minus the
  // "Headless" token (correct Chrome version, no staleness). Persistent contexts
  // lock the user-data-dir, so we must fully close before relaunching.
  if (headless && !override) {
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '')
    if (/headless/i.test(ua)) {
      await ctx.close().catch(() => {})
      ctx = await launch(contextDir, baseOpts(headless, ua.replace(/Headless/gi, ''), proxy))
    }
  }
  return ctx
}
