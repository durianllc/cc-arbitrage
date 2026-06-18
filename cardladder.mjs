/**
 * CARDLADDER-APP-2: Drive app.cardladder.com "Search Sales by Cert #" and read
 * the Card Ladder value for a graded cert. Selectors verified live 2026-06-10.
 *
 * Flow (matches the real UI):
 *   sales-history → click the "#" (tag) icon → fill cert → pick grader →
 *   Submit → read "CL Value" (the .value next to the Card Ladder logo).
 *
 * Auth: relies on the persistent logged-in session created by the desktop
 * app's "Log in to Card Ladder" (browser.mjs + login.mjs). The worker does NOT
 * auto-login — Cloudflare blocks headless credential login, and an interactive
 * human login (handling 2FA/captcha) is what gets the cf_clearance cookie that
 * these headless runs reuse. If the session is missing/expired we throw a clear
 * "log in again" error instead of silently failing.
 *
 * The app is a Vue SPA that keeps many hidden duplicate modals in the DOM, so
 * every interactive locator is scoped with :visible to hit the live one.
 */

const BASE = process.env.CARD_LADDER_BASE ?? 'https://app.cardladder.com'
const SALES_URL = `${BASE}/sales-history?direction=desc&sort=date`

/** CARDLADDER-RELOGIN-1: thrown when the persisted session is missing/expired.
 *  The worker recognizes the code and tells the desktop app, which stops sync
 *  and walks the user to the interactive login. */
function authRequiredError() {
  const e = new Error('Not logged in to Card Ladder — open the Sync app and click "Log in to Card Ladder", then retry.')
  e.code = 'AUTH_REQUIRED'
  return e
}

/**
 * CARDLADDER-RELOGIN-1: is the persisted Card Ladder session still valid?
 * Same signal the lookup uses — a logged-out session client-side-redirects
 * to /login. Used by the worker at boot so an expired session surfaces
 * immediately instead of 30s into the first cashier lookup.
 */
export async function checkSession(page) {
  await page.goto(SALES_URL, { waitUntil: 'domcontentloaded' })
  // Wait for the logged-out bounce rather than sleeping a fixed interval — on a
  // slow load a fixed sleep can report "session OK" right before the redirect
  // lands. Timing out here means the bounce never came: session looks valid.
  try {
    await page.waitForURL(/\/login(\?|$)/i, { timeout: 3500 })
    return false
  } catch {
    return true
  }
}

// BoosterBin grader code → the label Card Ladder shows in its Grader dropdown.
// Card Ladder only grades PSA / Beckett / SGC / CGC — ACE/Other aren't supported.
const CL_GRADER = { PSA: 'PSA', BGS: 'BECKETT', CGC: 'CGC', SGC: 'SGC' }

/**
 * Look up one cert. Returns { value, cardName, url }.
 *   value    — Card Ladder value in dollars (number)
 *   cardName — the resolved card profile name (best-effort)
 *   url      — the results deep-link (grader|grade|profileId) for "View on CL"
 */
export async function lookupCardLadder(page, args) {
  const { certNumber, grader } = args
  const cert = String(certNumber ?? '').trim()
  if (!cert) throw new Error('No cert number provided')

  const clGrader = CL_GRADER[grader]
  if (!clGrader) {
    throw new Error(`Card Ladder doesn't support grader "${grader}" (only PSA, BGS, CGC, SGC).`)
  }

  // Fresh load each lookup — guarantees no stale value from a prior search.
  await page.goto(SALES_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // Auth check: a logged-out session bounces to /login.
  if (/\/login(\?|$)/i.test(page.url())) {
    throw authRequiredError()
  }

  // Open "Search Sales by Cert #" (the "#"/tag icon by the search box).
  await page.getByRole('button', { name: 'tag', exact: true }).first().click()

  const certInput = page.locator('input[type="text"][maxlength="300"]:visible')
  await certInput.waitFor({ state: 'visible', timeout: 15_000 })
  await certInput.fill(cert)

  // Set the grader if it isn't already the one we want.
  const graderControl = page.locator('div.input:has(label:text-is("Grader"))').first()
  const current = (await graderControl.locator('.value').first().textContent().catch(() => '') ?? '')
    .trim().toUpperCase()
  if (current !== clGrader) {
    await graderControl.click()
    await page.waitForTimeout(400)
    await page.locator('li:visible')
      .filter({ hasText: new RegExp(`^\\s*${clGrader}\\s*$`, 'i') })
      .first()
      .click()
    await page.waitForTimeout(300)
  }

  // Submit the cert search.
  await page.locator('button[type="submit"]:visible').click()

  // Read the CL value — the .value div immediately after the Card Ladder logo,
  // which separates it from sale-row prices (those sit under a "Price" label).
  const valueLoc = page.locator('div.value-logo + div.value:visible').first()
  try {
    await valueLoc.waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    throw new Error('No Card Ladder value found — double-check the cert number and that the grader is correct.')
  }
  const raw = (await valueLoc.textContent()) ?? ''
  const value = parseMoney(raw)
  if (value == null) {
    throw new Error(`Card Ladder returned no parseable value (saw "${raw.trim()}")`)
  }

  const url = page.url()

  // Best-effort card name: the results header reads
  //   "N results · Grade: 10, Grader: PSA, Profile: <card name> (Pop N)".
  // Pick the SMALLEST element that contains both "Profile:" and "(Pop" so we
  // grab the header line, not a parent container or the profileId slug.
  const cardName = await page.evaluate(() => {
    let best = null
    for (const el of document.querySelectorAll('div, p, span, h1, h2, h3, h4')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (t.length > 300 || !/Profile:/.test(t) || !/\(Pop/i.test(t)) continue
      if (!best || t.length < best.length) best = t
    }
    if (!best) return null
    const m = best.match(/Profile:\s*(.+?)\s*\(Pop/i)
    return m ? m[1].trim().slice(0, 200) : null
  }).catch(() => null)

  return { value, cardName, url }
}

/** "$1,375.00" → 1375; "—"/"n/a"/"$0"/negatives → null (bad scrape, not $0). */
function parseMoney(s) {
  const cleaned = (s || '').replace(/[^0-9.]/g, '')
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) && n > 0 ? n : null
}
