#!/usr/bin/env node
/**
 * Parallel Card Ladder bulk upload + export. Runs N tabs concurrently over a
 * shared queue of arb CSVs — each tab creates its own collection, uploads,
 * waits for values, and exports. Reuses the exact flow proven in cl-bulk.mjs.
 *
 *   node cl-bulk-parallel.mjs                 # all cert-upload/arb*.csv, 3 tabs
 *   node cl-bulk-parallel.mjs --tabs 4
 *   node cl-bulk-parallel.mjs --from 3 --to 16 --tabs 3
 *   node cl-bulk-parallel.mjs --analyze       # also run analyze-exports at the end
 *
 * NOTE: whether this is faster than sequential depends on Card Ladder throttling
 * PSA lookups per-account (then it won't help) vs per-job (then it scales). Test
 * with --tabs 3 on a few files and compare wall-clock before scaling up.
 *
 * Each tab logs with a [tN] prefix and screenshots to ./debug/tN-step.png.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'

const args = process.argv.slice(2)
const numArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? Number(args[i + 1]) : def }
const TABS = Math.max(1, numArg('--tabs', 3))
const FROM = numArg('--from', 3)
const TO = numArg('--to', 16)
const doAnalyze = args.includes('--analyze')

// Build the work queue (files that exist).
const files = []
for (let n = FROM; n <= TO; n++) {
  const f = `cert-upload/arb${n}.csv`
  if (existsSync(f)) files.push(f)
}
if (!files.length) { console.error('No arb CSVs found in range.'); process.exit(1) }

mkdirSync('./debug', { recursive: true })
mkdirSync('./cert-upload/exports', { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = await launchContext('./browser-state-context', { headless: false })
// Accept Card Ladder's Export confirm() dialogs on every page (Playwright would
// otherwise auto-dismiss them and silently abort the export).
ctx.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})))

console.log(`${files.length} file(s) × ${TABS} tab(s). Files: ${files.map((f) => basename(f, '.csv')).join(', ')}`)

// Shared queue index — single-threaded event loop makes next++ race-free.
let next = 0
const results = []

async function processFile(page, tag, file) {
  const COLLECTION = basename(file, '.csv')
  const filePath = resolve(file)
  let step = 0
  const shot = async (label) => { step++; await page.screenshot({ path: `./debug/${tag}-${String(step).padStart(2, '0')}-${label}.png` }).catch(() => {}) }
  const log = (m) => console.log(`[${tag}] ${COLLECTION}: ${m}`)

  try {
    await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
    await sleep(4000)
    if (/\/login(\?|$)/i.test(page.url())) throw new Error('not logged in')

    // Create the collection.
    log('creating collection…')
    await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 })
    await sleep(1200)
    await page.locator(':text("Create New Collection")').first().click({ timeout: 6000 })
    await sleep(1000)
    const dialog = page.locator('[role="dialog"]:visible, .modal:visible').filter({ hasText: 'Create New Collection' }).first()
    await dialog.locator('input:visible').first().fill(COLLECTION)
    await dialog.locator('button:has-text("Create")').first().click({ timeout: 5000 })
    await sleep(2500)
    if (!/\/collection/i.test(page.url())) { await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' }); await sleep(3000) }
    await shot('created')

    // Open the collection's "+" (by Y position, skipping the global top-bar +) → Cert CSV.
    log('opening Cert CSV upload…')
    const certCard = page.locator('h5:has-text("Cert CSV"), .cta-card:has-text("Cert CSV")').first()
    const closeModal = async () => { await page.locator('button.modal-close, button:has(i.material-icons:text-is("close"))').first().click({ timeout: 2500 }).catch(() => {}); await sleep(500) }
    const addBtns = page.locator('button:has(i.material-icons:has-text("add_circle"))')
    const n = await addBtns.count()
    const order = []
    for (let i = 0; i < n; i++) { const b = await addBtns.nth(i).boundingBox().catch(() => null); order.push({ i, y: b?.y ?? 0 }) }
    order.sort((a, b) => (a.y > 90 ? 0 : 1) - (b.y > 90 ? 0 : 1))
    let opened = false
    for (const { i } of order) {
      await addBtns.nth(i).click({ timeout: 5000 }).catch(() => {})
      await sleep(1500)
      if (await certCard.count().catch(() => 0)) { opened = true; break }
      await closeModal()
    }
    if (!opened) throw new Error('could not open Cert CSV card')
    await certCard.click({ timeout: 6000 })
    await sleep(1000)

    // Set the file + Upload.
    log('uploading file…')
    await page.locator('input[type="file"][accept=".csv"], input[type="file"]').first().setInputFiles(filePath, { timeout: 8000 })
    await sleep(2500)
    await page.locator('button:has-text("Upload"):visible').first().click({ timeout: 8000 })

    // Wait for the import to TRULY complete. Don't trust the modal closing —
    // poll the modal's "N of M" counter AND the collection's "N results" count,
    // and only finish when it actually reaches the expected number of cards.
    const expected = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length - 1
    log(`waiting for import to complete (target ${expected} cards)…`)
    const t0 = Date.now()
    let lastLog = ''
    let done = false
    let stalls = 0
    let prevUp = -1
    while (Date.now() - t0 < 25 * 60 * 1000) {
      await sleep(8000)
      const info = await page.evaluate(() => {
        const t = document.body?.innerText || ''
        const up = t.match(/Finished uploading\s+(\d+)\s+of\s+(\d+)/i)
        const res = t.match(/([\d,]+)\s+results/i)
        return { modal: /UPLOAD CERTS/i.test(t), upN: up ? +up[1] : null, upM: up ? +up[2] : null, saving: /\bSaving\b/i.test(t), results: res ? +res[1].replace(/,/g, '') : null }
      }).catch(() => ({}))
      const line = `up=${info.upN ?? '?'}/${info.upM ?? '?'}${info.saving ? ' saving' : ''} results=${info.results ?? '?'}`
      if (line !== lastLog) { lastLog = line; log(`import ${line}`) }
      // Truly done: modal reports all cards uploaded.
      if (info.upN != null && info.upM != null && info.upN === info.upM) { done = true; break }
      // Modal gone AND the collection already shows the full count.
      if (!info.modal && info.results != null && info.results >= expected) { done = true; break }
      // Detect a stall (counter not advancing) so we don't wait the full 25 min for nothing.
      if (info.upN != null) { if (info.upN === prevUp) stalls++; else { stalls = 0; prevUp = info.upN } }
      if (stalls >= 12) { log(`⚠ import stalled at ${info.upN}/${info.upM} — Card Ladder likely throttled this upload.`); break }
    }
    if (!done) log(`⚠ import did NOT reach ${expected} — export may be incomplete.`)
    await closeModal()
    await sleep(1500)

    // Export.
    log('exporting…')
    const exportBtn = page.locator('button:has-text("Export CSV")').first()
    const gearBtn = page.locator('button:has(i.material-icons:has-text("settings"))').first()
    for (let a = 0; a < 4; a++) { if (await exportBtn.isVisible().catch(() => false)) break; await gearBtn.click({ timeout: 8000 }).catch(() => {}); await sleep(1500) }
    await exportBtn.waitFor({ state: 'visible', timeout: 8000 })
    const out = `./cert-upload/exports/${COLLECTION}-export.csv`
    let captured = null
    const onResp = async (resp) => { if (captured) return; try { const ct = resp.headers()['content-type'] || ''; const cd = resp.headers()['content-disposition'] || ''; if (!/csv|octet-stream/i.test(ct) && !/attachment/i.test(cd) && !/export|\.csv/i.test(resp.url())) return; const t = (await resp.body()).toString('utf8'); if (/Date Purchased|Graded Cert|Current Value/i.test(t)) captured = t } catch {} }
    page.on('response', onResp)
    const dlPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null)
    await exportBtn.click({ timeout: 6000 })
    const dl = await dlPromise
    if (dl) await dl.saveAs(out)
    else { for (let i = 0; i < 30 && !captured; i++) await sleep(1000); if (!captured) throw new Error('no export download/response'); writeFileSync(out, captured) }
    log(`✅ exported → ${out}`)
    results.push({ file, ok: true })
  } catch (e) {
    log(`❌ ${e.message}`)
    await shot('error')
    results.push({ file, ok: false, error: e.message })
  }
}

async function worker(tag) {
  const page = await ctx.newPage()
  if (tag !== 't0') await sleep(Number(tag.slice(1)) * 4000) // stagger tab starts
  while (true) {
    const i = next++
    if (i >= files.length) break
    await processFile(page, tag, files[i])
  }
  await page.close().catch(() => {})
}

await Promise.all(Array.from({ length: Math.min(TABS, files.length) }, (_, t) => worker(`t${t}`)))
await ctx.close().catch(() => {})

console.log('\n=== Summary ===')
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${basename(r.file)}${r.error ? ' — ' + r.error : ''}`)

if (doAnalyze) {
  console.log('\nAnalyzing + posting deals…')
  const { execSync } = await import('node:child_process')
  execSync('node analyze-exports.mjs', { stdio: 'inherit' })
}
process.exit(0)
