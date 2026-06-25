#!/usr/bin/env node
/**
 * Automate Card Ladder bulk cert upload + export via Playwright (no native
 * dialogs, no rate limit). v1 does ONE file end-to-end, headed, screenshotting
 * each step to ./debug/ so we can verify/fix the selectors.
 *
 *   node cl-bulk.mjs                      # uploads cert-upload/arb2.csv
 *   node cl-bulk.mjs cert-upload/arb3.csv
 *   node cl-bulk.mjs --collection ARB     # target collection name (default ARB)
 *
 * Steps: open /collection → select-or-create the target collection →
 * + (Add Card) → Cert CSV → set the file input → Upload → wait → gear → Export
 * CSV (capture download) → save to cert-upload/exports/.
 *
 * Selectors are best-effort (CL's collection UI isn't documented here). Screens
 * land in ./debug/NN-step.png — share them if a step misbehaves.
 */
import { mkdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { PROXIES } from './config.mjs'

const args = process.argv.slice(2)
const ci = args.indexOf('--collection')
const file = args.find((a) => a.endsWith('.csv')) ?? 'cert-upload/arb2.csv'
const filePath = resolve(file)
// Default the collection name to the file's base (arb2.csv → "arb2").
const COLLECTION = ci !== -1 ? args[ci + 1] : basename(file, '.csv')

mkdirSync('./debug', { recursive: true })
mkdirSync('./cert-upload/exports', { recursive: true })
let shotN = 0
const shot = async (page, label) => {
  shotN++
  const p = `./debug/${String(shotN).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: p, fullPage: false }).catch(() => {})
  console.log(`  📸 ${p}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = await launchContext('./browser-state-context', { headless: false, proxy: PROXIES[0] })
const page = ctx.pages()[0] ?? await ctx.newPage()

console.log(`Target collection: "${COLLECTION}" | file: ${filePath}`)
await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
await sleep(4000)
if (/\/login(\?|$)/i.test(page.url())) { console.error('Not logged in — run `node login.mjs`.'); await ctx.close(); process.exit(1) }
await shot(page, 'collection-loaded')

try {
  // ── Create a new collection named COLLECTION ────────────────────────────
  console.log(`Creating new collection "${COLLECTION}"…`)
  // 1. Open the collection switcher (chevron next to the collection title).
  await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 })
  await sleep(1200)
  await shot(page, 'switcher-open')
  // 2. Click "Create New Collection".
  await page.locator(':text("Create New Collection")').first().click({ timeout: 6000 })
  await sleep(1000)
  await shot(page, 'create-dialog')
  // 3. Name it + Create — SCOPED TO THE DIALOG so we don't type into the global
  //    search bar (which would navigate to Sales). The dialog has the heading
  //    "Create New Collection", a "Collection Name" input, and a Create button.
  const dialog = page.locator('[role="dialog"]:visible, .modal:visible').filter({ hasText: 'Create New Collection' }).first()
  const nameInput = dialog.locator('input:visible').first()
  await nameInput.fill(COLLECTION)
  await shot(page, 'name-filled')
  await dialog.locator('button:has-text("Create")').first().click({ timeout: 5000 })
  await sleep(2500)
  await shot(page, 'collection-created')
  // Safety: make sure we didn't get bounced to Sales.
  if (!/\/collection/i.test(page.url())) {
    await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
    await sleep(3000)
  }

  // ── Open the collection's "+" → Cert CSV ────────────────────────────────
  // Two "+" exist: the GLOBAL one in the very top bar opens "ADD SALE" (wrong).
  // The COLLECTION one sits lower (in the collection header). Pick by Y position
  // (>90px from top) so we never hit Add Sale, then fall back to scanning all.
  console.log('Opening the collection + → Cert CSV…')
  const certCard = page.locator('h5:has-text("Cert CSV"), .cta-card:has-text("Cert CSV")').first()
  const closeModal = async () => {
    await page.locator('button.modal-close, button:has(i.material-icons:text-is("close"))').first()
      .click({ timeout: 2500 }).catch(() => {})
    await sleep(500)
  }
  const addBtns = page.locator('button:has(i.material-icons:has-text("add_circle"))')
  const n = await addBtns.count()
  // Order candidates: collection-header buttons (y>90) first, then the rest.
  const order = []
  for (let i = 0; i < n; i++) {
    const box = await addBtns.nth(i).boundingBox().catch(() => null)
    order.push({ i, y: box?.y ?? 0 })
  }
  order.sort((a, b) => (a.y > 90 ? 0 : 1) - (b.y > 90 ? 0 : 1))
  console.log(`  found ${n} + button(s)`)
  let opened = false
  for (const { i } of order) {
    await addBtns.nth(i).click({ timeout: 5000 }).catch(() => {})
    await sleep(1500)
    if (await certCard.count().catch(() => 0)) { opened = true; break }
    await closeModal()
  }
  await shot(page, 'add-modal')
  if (!opened) throw new Error('Could not find the "Cert CSV" card after trying the + buttons.')

  console.log('Clicking Cert CSV…')
  await certCard.click({ timeout: 6000 })
  await sleep(1000)
  await shot(page, 'cert-csv-modal')

  // ── Set the file input directly (no native picker) ──────────────────────
  console.log('Setting file input…')
  const fileInput = page.locator('input[type="file"][accept=".csv"], input[type="file"]').first()
  await fileInput.setInputFiles(filePath, { timeout: 8000 })
  await sleep(2500)
  await shot(page, 'file-read')

  // Click the "Upload" button (appears after "successfully read N cards").
  console.log('Clicking Upload…')
  await page.locator('button:has-text("Upload"):visible').first().click({ timeout: 8000 })
  console.log('Uploading — waiting for Card Ladder to fetch values (this can take a minute)…')
  await sleep(20000)
  await shot(page, 'after-upload')

  // ── Export the collection (capture the download) ────────────────────────
  console.log('Exporting collection CSV…')
  await page.locator('i.material-icons:has-text("settings")').first().click({ timeout: 8000 }).catch(() => {})
  await sleep(1000)
  await shot(page, 'settings-open')
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('button:has-text("Export CSV"), :text-is("Export CSV")').first().click({ timeout: 6000 }),
  ])
  const out = `./cert-upload/exports/${COLLECTION}-export.csv`
  await download.saveAs(out)
  console.log(`\n✅ Saved export → ${out}`)
  console.log('Now run:  node analyze-exports.mjs')
} catch (e) {
  console.error(`\n❌ Failed at step ${shotN}: ${e.message}`)
  await shot(page, 'error')
  console.error('Share the ./debug/*.png screenshots and I\'ll fix the selector.')
}

console.log('\nLeaving the window open 30s so you can inspect…')
await sleep(30000)
await ctx.close().catch(() => {})
process.exit(0)
