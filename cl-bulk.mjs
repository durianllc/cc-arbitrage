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
import { resolve } from 'node:path'
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { PROXIES } from './config.mjs'

const args = process.argv.slice(2)
const ci = args.indexOf('--collection')
const COLLECTION = ci !== -1 ? args[ci + 1] : 'ARB'
const file = args.find((a) => a.endsWith('.csv')) ?? 'cert-upload/arb2.csv'
const filePath = resolve(file)

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
  // ── Select or create the target collection ──────────────────────────────
  // Open the collection switcher (the chevron next to the collection title).
  console.log('Opening collection switcher…')
  await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 }).catch(() => {})
  await sleep(1200)
  await shot(page, 'switcher-open')

  const existing = page.locator(`:visible:text-is("${COLLECTION}")`).first()
  if (await existing.count()) {
    console.log(`Selecting existing collection "${COLLECTION}".`)
    await existing.click({ timeout: 5000 }).catch(() => {})
  } else {
    console.log(`Creating collection "${COLLECTION}"…`)
    // Look for a create/new control in the switcher dropdown.
    await page.locator('button:has-text("Create"), button:has-text("New"), :text("Create Collection"), :text("Add Collection")').first().click({ timeout: 5000 }).catch(() => {})
    await sleep(800)
    await shot(page, 'create-dialog')
    const nameInput = page.locator('input[type="text"]:visible').first()
    await nameInput.fill(COLLECTION).catch(() => {})
    await page.locator('button:has-text("Save"), button:has-text("Create")').first().click({ timeout: 5000 }).catch(() => {})
    await sleep(1500)
  }
  await shot(page, 'collection-selected')

  // ── Open Add Card → Cert CSV ────────────────────────────────────────────
  console.log('Opening Add Card → Cert CSV…')
  await page.locator('i.material-icons:has-text("add_circle")').first().click({ timeout: 8000 }).catch(() => {})
  await sleep(1200)
  await shot(page, 'add-modal')
  await page.locator(':text("Cert CSV")').first().click({ timeout: 6000 }).catch(() => {})
  await sleep(1000)
  await shot(page, 'cert-csv-modal')

  // ── Set the file input directly (no native picker) ──────────────────────
  console.log('Setting file input…')
  const fileInput = page.locator('input[type="file"]').first()
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
