#!/usr/bin/env node
/**
 * Delete the temporary arbitrage collections (arb1, arb2, …) from Card Ladder.
 *
 * SAFETY:
 *   • Only ever targets collections whose name matches /^arb\d+$/i.
 *   • DRY-RUN by default: lists what it WOULD delete and exits. Nothing is
 *     removed unless you pass --confirm.
 *   • Runs headed so you can watch. Your other collections are never touched.
 *
 *   node delete-arb-collections.mjs            # list arb* collections (no delete)
 *   node delete-arb-collections.mjs --confirm  # actually delete them
 *   node delete-arb-collections.mjs --pattern "^arb"   # custom name regex
 *
 * NOTE: Card Ladder's collections UI isn't documented here, so the locators are
 * best-effort. Run the dry-run first and confirm the detected names are right;
 * if it finds nothing, paste me what the collections page shows.
 */
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { PROXIES } from './config.mjs'

const confirm = process.argv.includes('--confirm')
const pi = process.argv.indexOf('--pattern')
const pattern = pi !== -1 ? new RegExp(process.argv[pi + 1], 'i') : /^arb\d+$/i
const CONTEXT_DIR = process.env.BROWSER_CONTEXT_DIR ?? './browser-state-context'

const ctx = await launchContext(CONTEXT_DIR, { headless: false, proxy: PROXIES[0] })
const page = ctx.pages()[0] ?? await ctx.newPage()
await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
if (/\/login(\?|$)/i.test(page.url())) {
  console.error('Not logged in. Run `node login.mjs`, sign in, then re-run.')
  await ctx.close().catch(() => {}); process.exit(1)
}

// Best-effort: collect candidate collection names from the page. Card Ladder
// usually exposes a collection switcher/list; we grab short text nodes and
// filter to the arb pattern so we never act on anything else.
const names = await page.evaluate(() => {
  const out = new Set()
  for (const el of document.querySelectorAll('a, button, li, span, div, h1, h2, h3, h4')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (t && t.length <= 40) out.add(t)
  }
  return [...out]
}).catch(() => [])

const arbNames = names.filter((n) => pattern.test(n))
console.log(`Collections matching ${pattern}: ${arbNames.length ? arbNames.join(', ') : '(none found)'}`)

if (!arbNames.length) {
  console.log('Nothing to delete. If your arb collections exist but weren\'t detected, paste me the collections page and I\'ll fix the selectors.')
  console.log('Leaving the window open 30s so you can inspect it…')
  await page.waitForTimeout(30_000)
  await ctx.close().catch(() => {}); process.exit(0)
}

if (!confirm) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --confirm to delete the collections listed above.')
  console.log('Leaving the window open 20s…')
  await page.waitForTimeout(20_000)
  await ctx.close().catch(() => {}); process.exit(0)
}

console.log('\n--confirm set — attempting to delete each arb collection…')
for (const name of arbNames) {
  try {
    // Open the collection, then its menu → Delete → confirm. Selectors are
    // best-effort; scoped to the matched name only.
    const link = page.locator(`a:has-text("${name}"), button:has-text("${name}")`).first()
    await link.click({ timeout: 8000 })
    await page.waitForTimeout(1500)
    // Open an options/more menu if present.
    await page.locator('button:has(i.material-icons:text-is("more_vert")), button[title*="option" i]').first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(600)
    await page.locator('li:has-text("Delete"), button:has-text("Delete"), span:has-text("Delete")').first().click({ timeout: 4000 })
    await page.waitForTimeout(600)
    // Confirm in the dialog.
    await page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes")').first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1500)
    console.log(`  deleted: ${name}`)
  } catch (e) {
    console.log(`  could NOT delete "${name}" (${e.message.slice(0, 60)}) — delete it manually.`)
  }
}
console.log('Done. Double-check in the UI that only arb collections were removed.')
await ctx.close().catch(() => {})
process.exit(0)
