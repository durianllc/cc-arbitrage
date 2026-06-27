#!/usr/bin/env node
/**
 * Scrape Collector Crypt and report only NEW certs vs. the existing baseline.
 *
 * Baseline = the cert|grader keys already in cert-upload/mapping.json (the last
 * full scrape). We re-scrape CC, build the same eligible-cert set, and diff:
 * any cert|grader not in the baseline is "new" (a freshly-listed graded card).
 *
 *   node scrape-new.mjs                 # Pokemon + One Piece
 *   node scrape-new.mjs --categories Pokemon
 *
 * Output → cert-upload/new-certs.csv (CL upload format, ≤500/file if >500)
 *          cert-upload/new-mapping.json (cert→CC data for just the new ones)
 * Does NOT modify the existing mapping.json / arb*.csv baseline.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import './config.mjs'
import { scrapeCards } from './collectorcrypt.mjs'

const OUT_DIR = './cert-upload'
const ROWS_PER_FILE = 500
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

async function getSolUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')
    if (!r.ok) return null
    const v = (await r.json())?.solana?.usd
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

let categories = ['Pokemon', 'One Piece']
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--categories') categories = process.argv[++i].split(',').map(s => s.trim())
}

// Persistent cumulative baseline of every cert|grader we've ever seen. This is
// SEPARATE from mapping.json (which the daily gen-cert-csvs run overwrites with
// the current full scrape — using that as the baseline makes "new" meaningless).
// known-certs.json is only ever appended to, so "new since last run" stays exact.
const knownPath = `${OUT_DIR}/known-certs.json`
let knownKeys
if (existsSync(knownPath)) {
  knownKeys = new Set(JSON.parse(readFileSync(knownPath, 'utf8')))
  console.log(`Baseline: ${knownKeys.size} known certs (from ${knownPath}).`)
} else {
  // First run: seed from the current mapping.json (the latest full scrape) so we
  // don't flag the entire marketplace as "new" on day one.
  const seed = existsSync(`${OUT_DIR}/mapping.json`) ? JSON.parse(readFileSync(`${OUT_DIR}/mapping.json`, 'utf8')) : {}
  knownKeys = new Set(Object.keys(seed))
  console.log(`Baseline: seeding ${knownPath} from mapping.json (${knownKeys.size} certs) — first run.`)
}

console.log(`Scraping Collector Crypt (${categories.join(', ')})…`)
const all = await scrapeCards(categories, (m) => console.log(m))

const solUsd = all.some((c) => (c.currency ?? '').toUpperCase() === 'SOL') ? await getSolUsd() : null
if (solUsd) console.log(`SOL/USD rate: $${solUsd}`)

// Build the current eligible set, keyed by cert|grader.
const current = {}
let skipped = 0
for (const c of all) {
  const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
  if (!grader || !c.gradingID) { skipped++; continue }
  const priceUsd = (c.currency ?? '').toUpperCase() === 'SOL'
    ? (solUsd ? Math.round(c.price * solUsd * 100) / 100 : null)
    : c.price
  if (priceUsd == null) { skipped++; continue }
  const key = `${c.gradingID}|${grader}`
  if (current[key]) continue // de-dupe, keep first
  current[key] = {
    cert: String(c.gradingID), grader, priceUsd,
    cc_price: priceUsd, name: c.itemName, nft: c.nftAddress, category: c.category, grade: c.grade,
  }
}
const currentKeys = Object.keys(current)
console.log(`Current scrape: ${currentKeys.length} eligible certs; skipped ${skipped}.`)

// Diff: new = in current, not in baseline.
const newKeys = currentKeys.filter((k) => !knownKeys.has(k))
console.log(`\n=> ${newKeys.length} NEW certs (not in baseline).`)

// Persist the cumulative baseline = everything ever seen ∪ this scrape, so the
// next run's "new" is exact even after the daily run rewrites mapping.json.
for (const k of currentKeys) knownKeys.add(k)
writeFileSync(knownPath, JSON.stringify([...knownKeys]))
console.log(`Updated ${knownPath} → ${knownKeys.size} known certs.`)

if (newKeys.length === 0) {
  console.log('Nothing new. No CSV written.')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
const header = 'Date Purchased,Cert #,Grader,Investment,Estimated Value,Notes,Date Sold,Sold Price'
const newMapping = {}
const rows = newKeys.map((k) => current[k])
// Dated stem so each day's new batch is preserved (e.g. 2026-06-27.csv), like
// the manual rename we did before. Multi-file days get -1/-2 suffixes.
const today = new Date().toISOString().slice(0, 10)
const csvLine = (r) => ['', csvCell(r.cert), csvCell(r.grader), csvCell(r.priceUsd), '', csvCell(r.nft), '', ''].join(',')

if (rows.length <= ROWS_PER_FILE) {
  const lines = [header, ...rows.map(csvLine)]
  for (const r of rows) newMapping[`${r.cert}|${r.grader}`] = { cc_price: r.cc_price, name: r.name, nft: r.nft, category: r.category, grade: r.grade }
  writeFileSync(`${OUT_DIR}/${today}.csv`, lines.join('\n'))
  console.log(`  wrote ${OUT_DIR}/${today}.csv (${rows.length} rows)`)
} else {
  let fileNo = 0
  for (let i = 0; i < rows.length; i += ROWS_PER_FILE) {
    fileNo++
    const batch = rows.slice(i, i + ROWS_PER_FILE)
    const lines = [header, ...batch.map(csvLine)]
    for (const r of batch) newMapping[`${r.cert}|${r.grader}`] = { cc_price: r.cc_price, name: r.name, nft: r.nft, category: r.category, grade: r.grade }
    writeFileSync(`${OUT_DIR}/${today}-${fileNo}.csv`, lines.join('\n'))
    console.log(`  wrote ${OUT_DIR}/${today}-${fileNo}.csv (${batch.length} rows)`)
  }
}
writeFileSync(`${OUT_DIR}/new-mapping.json`, JSON.stringify(newMapping, null, 2))
console.log(`  wrote ${OUT_DIR}/new-mapping.json (${Object.keys(newMapping).length} entries)`)

// Show a sample.
console.log('\nSample of new certs:')
for (const r of rows.slice(0, 15)) {
  console.log(`  ${r.cert} ${r.grader}  $${r.priceUsd}  ${(r.name ?? '').slice(0, 60)}`)
}
