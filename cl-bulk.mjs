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
import { mkdirSync, writeFileSync } from 'node:fs'
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
// --export-only: skip create+upload; just select the existing collection by
// name and export it (use when the upload already happened).
const exportOnly = args.includes('--export-only')

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

// NO proxy here on purpose: the Card Ladder login's Cloudflare clearance was
// earned on your real IP, and bulk upload is a single session (no per-cert rate
// limit to dodge). Routing through a proxy = different IP = Cloudflare friction
// for zero benefit. Pass --proxy N to force proxy N if you really want one.
const pIdx = args.indexOf('--proxy')
const proxy = pIdx !== -1 ? PROXIES[Number(args[pIdx + 1])] : undefined
const ctx = await launchContext('./browser-state-context', { headless: false, proxy })
const page = ctx.pages()[0] ?? await ctx.newPage()

// Card Ladder's "Export CSV" pops a native confirm() ("Are you sure…"). Playwright
// auto-DISMISSES JS dialogs by default (= clicks Cancel), which silently aborts
// the export. Accept them so the export actually runs.
page.on('dialog', (d) => d.accept().catch(() => {}))

console.log(`Target collection: "${COLLECTION}" | file: ${filePath}`)
await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
await sleep(4000)
if (/\/login(\?|$)/i.test(page.url())) { console.error('Not logged in — run `node login.mjs`.'); await ctx.close(); process.exit(1) }
await shot(page, 'collection-loaded')

try {
  if (exportOnly) {
    // Select the existing collection by name, then jump straight to export.
    console.log(`Selecting existing collection "${COLLECTION}" (export-only)…`)
    await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 })
    await sleep(1200)
    await shot(page, 'switcher-open')
    // Click a VISIBLE switcher entry (hidden recent-search spans also match the text).
    await page.locator(`:text-is("${COLLECTION}"):visible`).first().click({ timeout: 6000 })
    await sleep(3000)
    await shot(page, 'collection-selected')
  } else {
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

  // Card Ladder fetches every cert from the grading company — this takes
  // ~5-10 min for 500 cards. POLL until it finishes instead of a fixed wait.
  // The modal shows "Finished uploading N of M cards" then "Saving"; we're done
  // when the count reaches M and "Saving" is gone (or the modal closes).
  console.log('Uploading — polling until Card Ladder finishes (up to ~15 min)…')
  const MAX_MS = 15 * 60 * 1000
  const t0 = Date.now()
  let lastLog = ''
  while (Date.now() - t0 < MAX_MS) {
    await sleep(8000)
    const txt = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    const modalOpen = /UPLOAD CERTS/i.test(txt)
    const m = txt.match(/Finished uploading\s+(\d+)\s+of\s+(\d+)\s+cards/i)
    const saving = /\bSaving\b/i.test(txt)
    if (m && `${m[1]}/${m[2]}` !== lastLog) { lastLog = `${m[1]}/${m[2]}`; console.log(`  progress: ${lastLog} cards${saving ? ' (saving…)' : ''}`) }
    // Done: modal gone, or all cards uploaded and no longer "saving".
    if (!modalOpen) { console.log('  upload modal closed — done.'); break }
    if (m && m[1] === m[2] && !saving) { console.log('  all cards uploaded.'); break }
  }
  await shot(page, 'after-upload')

  // Close the upload modal if it's still open, so the collection view (with the
  // gear/Export) is interactable.
  await page.locator('button.modal-close, button:has(i.material-icons:text-is("close"))').first()
    .click({ timeout: 3000 }).catch(() => {})
  await sleep(1500)
  } // end of !exportOnly (create + upload)

  // ── Export the collection (capture the download) ────────────────────────
  // Must press the gear (settings) first to reveal the Settings modal, which
  // contains the "Export CSV" button.
  console.log('Opening Settings (gear)…')
  const exportBtn = page.locator('button:has-text("Export CSV")').first()
  const gearBtn = page.locator('button:has(i.material-icons:has-text("settings"))').first()
  // Click the gear until the Export CSV button is actually VISIBLE (it's present
  // in the DOM even when the Settings modal is closed, so check visibility).
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await exportBtn.isVisible().catch(() => false)) break
    await gearBtn.click({ timeout: 8000 }).catch(() => {})
    await sleep(1500)
  }
  await shot(page, 'settings-open')
  await exportBtn.waitFor({ state: 'visible', timeout: 8000 })

  const out = `./cert-upload/exports/${COLLECTION}-export.csv`
  // Capture the CSV two ways: (a) a real browser download event, and (b) the
  // network response body in case CL returns the CSV inline. A 499-card export
  // can take a while to generate, so give it up to 2 minutes.
  let captured = null
  const onResp = async (resp) => {
    if (captured) return
    try {
      const ct = resp.headers()['content-type'] || ''
      const cd = resp.headers()['content-disposition'] || ''
      if (!/csv|octet-stream/i.test(ct) && !/attachment/i.test(cd) && !/export|\.csv/i.test(resp.url())) return
      const txt = (await resp.body()).toString('utf8')
      if (/Date Purchased|Graded Cert|Current Value/i.test(txt)) captured = txt
    } catch { /* attachment bodies may be unavailable — download event handles it */ }
  }
  page.on('response', onResp)

  console.log('Clicking Export CSV (waiting up to 2 min for the file)…')
  const dlPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null)
  await exportBtn.click({ timeout: 6000 })
  const download = await dlPromise

  if (download) {
    await download.saveAs(out)
    console.log(`\n✅ Saved export (download) → ${out}`)
  } else {
    // No download event — wait a moment for the response capture to land.
    for (let i = 0; i < 30 && !captured; i++) await sleep(1000)
    if (!captured) { await shot(page, 'export-noresult'); throw new Error('Export produced no download or CSV response within timeout.') }
    writeFileSync(out, captured)
    console.log(`\n✅ Saved export (response) → ${out}`)
  }
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
