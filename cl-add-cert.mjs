#!/usr/bin/env node
/**
 * Add a SINGLE graded cert to a Card Ladder collection via the UI, using the
 * "Enter Graded Card Cert" flow (not the bulk CSV). Good for the trickle of new
 * certs the monitor finds each run — a few at a time stays under the throttle.
 *
 *   node cl-add-cert.mjs --cert 7633720 --grader PSA
 *   node cl-add-cert.mjs --cert 7633720 --grader PSA --collection ARBALL --headless
 *
 * Flow (per the UI): collection "+" → "Enter Graded Card Cert" → type cert →
 * select grader → Submit. Screens land in ./debug/add-*.png.
 */
import { mkdirSync } from 'node:fs'
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d }
const CERT = opt('--cert', null)
const GRADER = (opt('--grader', 'PSA')).toUpperCase()
const COLLECTION = opt('--collection', 'ARBALL')
const headless = args.includes('--headless')
if (!CERT) { console.error('Need --cert <number> (and optional --grader PSA).'); process.exit(1) }

mkdirSync('./debug', { recursive: true })
let shotN = 0
const shot = async (page, label) => {
  shotN++
  const p = `./debug/add-${String(shotN).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: p, fullPage: false }).catch(() => {})
  console.log(`  📸 ${p}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = await launchContext('./browser-state-context', { headless })
const page = ctx.pages()[0] ?? await ctx.newPage()
page.on('dialog', (d) => d.accept().catch(() => {}))

console.log(`Adding cert ${CERT} (${GRADER}) → collection "${COLLECTION}"`)
await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
await sleep(4000)
if (/\/login(\?|$)/i.test(page.url())) { console.error('Not logged in — run `node login.mjs`.'); await ctx.close(); process.exit(1) }
await shot(page, 'collection-loaded')

try {
  // ── Select the target collection (skip if already active) ─────────────────
  const alreadyActive = await page.getByText(COLLECTION, { exact: true }).first().isVisible().catch(() => false)
  if (alreadyActive) {
    console.log(`  "${COLLECTION}" already active — skipping switch.`)
  } else {
    await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 })
    await sleep(1200)
    await page.locator(`li:has(span:text-is("${COLLECTION}")):visible, li:has-text("${COLLECTION}"):visible`).first().click({ timeout: 6000 })
    await sleep(3000)
  }

  // ── Open the collection "+" and click "Enter Graded Card Cert" ────────────
  // Two "+" exist: global (top bar, "Add Sale") vs collection-header (y>90). Try
  // header first. Look for the "Enter Graded Card Cert" option in the modal.
  // The clickable card's heading is exactly "Enter Graded Card Cert" — click that
  // (the click bubbles to the card's handler).
  const certOption = page.getByText('Enter Graded Card Cert', { exact: true }).first()
  const closeModal = async () => {
    await page.locator('button.modal-close, button:has(i.material-icons:text-is("close"))').first().click({ timeout: 2000 }).catch(() => {})
    await sleep(400)
  }
  const addBtns = page.locator('button:has(i.material-icons:has-text("add_circle"))')
  const n = await addBtns.count()
  const order = []
  for (let i = 0; i < n; i++) { const b = await addBtns.nth(i).boundingBox().catch(() => null); order.push({ i, y: b?.y ?? 0 }) }
  order.sort((a, b) => (a.y > 90 ? 0 : 1) - (b.y > 90 ? 0 : 1))
  console.log(`  found ${n} + button(s)`)
  let opened = false
  for (const { i } of order) {
    await addBtns.nth(i).click({ timeout: 5000 }).catch(() => {})
    await sleep(1500)
    if (await certOption.count().catch(() => 0)) { opened = true; break }
    await closeModal()
  }
  await shot(page, 'add-modal')
  if (!opened) throw new Error('Could not find the "Enter Graded Card Cert" option after the + buttons.')

  console.log('Clicking "Enter Graded Card Cert"…')
  await certOption.click({ timeout: 6000 })
  await sleep(2000)
  await shot(page, 'cert-form')
  // Wait for the cert-entry form (an input) to actually render before filling.
  await page.locator('input:visible').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})

  // ── Fill the "Cert #" input — NOT the top search box (which opens autocomplete
  // and covers Submit). Target by its label, else the first non-search input.
  console.log('Filling Cert #…')
  let certInput = page.getByLabel(/cert\s*#?/i).first()
  if (!(await certInput.count().catch(() => 0))) {
    certInput = page.locator('input:visible:not([placeholder*="Search" i])').first()
  }
  await certInput.fill(String(CERT), { timeout: 6000 })
  await shot(page, 'cert-filled')

  // ── Grader — the inline dropdown (defaults to PSA). Set it if a <select> exists.
  const graderSelect = page.locator('select:visible').first()
  if (await graderSelect.count().catch(() => 0)) {
    await graderSelect.selectOption({ label: GRADER }).catch(async () => {
      await graderSelect.selectOption(GRADER).catch(() => {})
    })
  } else {
    // custom dropdown control near the "Grader" label
    const ctrl = page.locator(':is(button,[role="combobox"],.dropdown):visible').filter({ hasText: new RegExp(`${GRADER}|PSA|BGS|CGC|SGC`, 'i') }).first()
    if (await ctrl.count().catch(() => 0)) {
      await ctrl.click({ timeout: 3000 }).catch(() => {})
      await sleep(500)
      await page.locator(`:is(li,div,span,option):visible:text-is("${GRADER}")`).first().click({ timeout: 3000 }).catch(() => {})
    }
  }
  await sleep(400)
  await shot(page, 'grader-selected')

  // ── Submit ────────────────────────────────────────────────────────────────
  console.log('Clicking Submit…')
  await page.locator('button:has-text("Submit"):visible').first().click({ timeout: 6000 })
  console.log('Submitted — waiting for Card Ladder to fetch the cert…')
  await sleep(5000)
  await shot(page, 'submitted')

  // Card Ladder shows a toast: red "No information on this Cert" (not found) or a
  // success confirmation. Read it so callers know whether the add actually took.
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
  if (/No information on this Cert/i.test(bodyText)) {
    console.log(`\n⚠ NOT FOUND — Card Ladder has no data for cert ${CERT} (${GRADER}). Nothing added.`)
    await ctx.close().catch(() => {})
    process.exit(2) // distinct code so the monitor can stop retrying this cert
  }
  console.log(`\n✅ Added cert ${CERT} (${GRADER}) to "${COLLECTION}".`)
} catch (e) {
  console.error(`\n❌ Failed at step ${shotN}: ${e.message}`)
  await shot(page, 'error')
  console.error('Share ./debug/add-*.png and I\'ll fix the selectors.')
}

if (!process.env.NO_WAIT) { console.log('\nLeaving window open 20s to inspect…'); await sleep(20000) }
await ctx.close().catch(() => {})
process.exit(0)
