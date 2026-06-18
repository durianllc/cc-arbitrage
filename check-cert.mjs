/**
 * Debug a single Card Ladder lookup in a visible window — no cache, no queue.
 *
 *   node check-cert.mjs <cert> <grader> [profileIndex]
 *   node check-cert.mjs 71779122 PSA
 *   node check-cert.mjs 71779122 PSA 0      # use proxy profile 0's session
 *
 * Watch the window and read the result / error. This isolates the lookup from
 * the whole pipeline so we can see exactly what Card Ladder shows.
 */
import { PROXIES } from './config.mjs'
import { launchContext } from './browser.mjs'
import { lookupCardLadder, checkSession } from './cardladder.mjs'

const [cert, grader = 'PSA', profileArg] = process.argv.slice(2)
if (!cert) { console.error('Usage: node check-cert.mjs <cert> <grader> [profileIndex]'); process.exit(1) }

const BASE = process.env.BROWSER_CONTEXT_DIR ?? './browser-state-context'
const pi = profileArg != null ? Number(profileArg) : null
const contextDir = pi != null ? `${BASE}-${pi}` : BASE
const proxy = pi != null ? PROXIES[pi] : PROXIES[0]

console.log(`Looking up cert ${cert} (${grader}) using ${contextDir}${proxy ? ` via ${proxy.server}` : ''}`)
const ctx = await launchContext(contextDir, { headless: false, proxy })
const page = ctx.pages()[0] ?? await ctx.newPage()

console.log('Session valid?', await checkSession(page))

try {
  const res = await lookupCardLadder(page, { certNumber: cert, grader })
  console.log('\n✅ SUCCESS:', res)
} catch (e) {
  console.log('\n❌ FAILED:', e.code ? `[${e.code}] ` : '', e.message)
}

console.log('\nLeaving the window open 30s so you can inspect it…')
await page.waitForTimeout(30_000)
await ctx.close().catch(() => {})
process.exit(0)
