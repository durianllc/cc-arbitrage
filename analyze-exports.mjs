#!/usr/bin/env node
/**
 * Analyze Card Ladder collection exports → find arbitrage deals → post to Discord.
 *
 * Flow:
 *   1. node gen-cert-csvs.mjs            → cert-upload/arbN.csv + mapping.json
 *   2. Upload each arbN.csv into a new CL collection (arb1, arb2, …)
 *   3. Export each collection to CSV and drop the files in ./cert-upload/exports/
 *   4. node analyze-exports.mjs          → compares CL value vs CC price, posts BUYs
 *
 *   node analyze-exports.mjs                       # threshold 0.8 (20%+ under)
 *   node analyze-exports.mjs --dir ~/Downloads     # read exports from elsewhere
 *   node analyze-exports.mjs --threshold 0.7
 *
 * Column detection is tolerant (CL's export header isn't documented here). It
 * prints which columns it picked — if they look wrong, paste me the header row.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import './config.mjs'
import { postBuysToDiscord } from './discord.mjs'

const ccUrl = (nft) => `https://collectorcrypt.com/assets/solana/${nft}`
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

// Tracks which deals (cert|grader) we've already posted to Discord, so re-runs
// only send NEW deals instead of re-spamming the same cards every time.
const POSTED_PATH = './posted-deals.json'

let dir = './cert-upload/exports'
let threshold = 0.8
let postAll = false // --all: ignore the posted-deals record, post every qualifying deal
let noPost = false  // --no-post: record current deals as posted but send nothing (seed the record)
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--dir') dir = process.argv[++i]
  else if (process.argv[i] === '--threshold') threshold = Number(process.argv[++i])
  else if (process.argv[i] === '--all') postAll = true
  else if (process.argv[i] === '--no-post') noPost = true
}

// Minimal CSV parser (handles quoted fields, commas, escaped quotes).
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (ch === '\r') { /* skip */ }
    else cell += ch
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function pickCol(header, candidates) {
  const lc = header.map((h) => h.toLowerCase().trim())
  for (const cand of candidates) {
    const idx = lc.findIndex((h) => h === cand)
    if (idx !== -1) return idx
  }
  for (const cand of candidates) {
    const idx = lc.findIndex((h) => h.includes(cand))
    if (idx !== -1) return idx
  }
  return -1
}

const num = (s) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null }

if (!existsSync('./cert-upload/mapping.json')) { console.error('No cert-upload/mapping.json — run gen-cert-csvs.mjs first.'); process.exit(1) }
const mapping = JSON.parse(readFileSync('./cert-upload/mapping.json', 'utf8'))
// Optional: reuse Card Ladder deep-links cached from prior live lookups so the
// Discord embed can show a "Card Ladder" link (the export has no CL URL).
const cache = existsSync('./cache.json') ? JSON.parse(readFileSync('./cache.json', 'utf8')) : {}
const links = existsSync('./cl-links.json') ? JSON.parse(readFileSync('./cl-links.json', 'utf8')) : {}
// cert-only index as a fallback when the export lacks a grader column.
const byCert = {}
for (const [k, v] of Object.entries(mapping)) byCert[k.split('|')[0]] = { ...v, grader: k.split('|')[1] }

if (!existsSync(dir)) { console.error(`Export dir not found: ${dir}`); process.exit(1) }
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'))
if (!files.length) { console.error(`No .csv files in ${dir}`); process.exit(1) }
console.log(`Reading ${files.length} export file(s) from ${dir}`)

const buys = []
const suspects = [] // dropped as likely SOL-mislabeled (see guard below)
let matched = 0, unmatched = 0
for (const f of files) {
  const rows = parseCsv(readFileSync(`${dir}/${f}`, 'utf8')).filter((r) => r.some((c) => c.trim()))
  if (rows.length < 2) continue
  const header = rows[0]
  const certCol = pickCol(header, ['cert #', 'cert', 'certification'])
  const graderCol = pickCol(header, ['grader', 'grading company', 'company'])
  const valCol = pickCol(header, ['cl value', 'card ladder value', 'current value', 'estimated value', 'value'])
  console.log(`  ${f}: cert=col${certCol}"${header[certCol] ?? ''}" grader=col${graderCol}"${header[graderCol] ?? ''}" value=col${valCol}"${header[valCol] ?? ''}"`)
  if (certCol === -1 || valCol === -1) { console.warn(`    ⚠ could not find cert/value columns — paste me this file's header row.`); continue }

  for (const r of rows.slice(1)) {
    const cert = (r[certCol] ?? '').trim()
    const clValue = num(r[valCol])
    if (!cert || clValue == null) continue
    const grader = graderCol !== -1 ? GRADER_MAP[(r[graderCol] ?? '').toUpperCase().trim()] : null
    const m = (grader && mapping[`${cert}|${grader}`]) || byCert[cert]
    if (!m) { unmatched++; continue }
    matched++
    const ratio = m.cc_price / clValue
    if (ratio > threshold) continue
    // SOL-mislabel guard: the CC API sometimes labels a SOL listing as USDC, so a
    // card priced in SOL looks like an impossibly cheap USD deal. If the labeled
    // price is an EXTREME discount (≤25% of CL) but its SOL-interpretation lands at
    // a normal market price (≥50% of CL), it's almost certainly a mislabeled SOL
    // listing — drop it rather than post a bogus deal. (A genuine 42%-off card like
    // a $70 vs $120 listing is NOT extreme, so real deals are unaffected.)
    // A genuine SOL-mislabel lands NEAR market value (a seller pricing roughly at
    // the card's worth). Require the SOL-interpretation to sit in a plausible BAND
    // around CL [0.5×, 4×]: if it's wildly above (e.g. 16× CL), the SOL reading is
    // absurd too, so the cheap USD price is the real one — a genuine steal, keep it.
    const sol = m.sol_interp
    const usdLabeled = (m.currency ?? '').toUpperCase() !== 'SOL'
    if (usdLabeled && sol && ratio <= 0.25 && sol >= 0.5 * clValue && sol <= 4 * clValue) {
      suspects.push({ name: m.name, cc_price: m.cc_price, sol_interp: sol, cl: clValue })
      continue
    }
    buys.push({
      key: `${cert}|${m.grader}`,
      name: m.name, category: m.category, grader: m.grader, grade: m.grade,
      cc_price: m.cc_price, card_ladder_value: clValue, discount_pct: 1 - ratio,
      cc_url: ccUrl(m.nft),
      // Prefer a real cached CL deep-link (from cl-links.json, populated by the
      // monitor's cert lookups, or the old cache.json); else a name search.
      cl_url: links[`${cert}|${m.grader}`] || cache[`${cert}|${m.grader}`]?.clUrl
        || `https://app.cardladder.com/sales-history?direction=desc&sort=date&search=${encodeURIComponent(m.name)}`,
    })
  }
}

buys.sort((a, b) => b.discount_pct - a.discount_pct)
console.log(`\nMatched ${matched} rows to CC listings (${unmatched} unmatched).`)
console.log(`Found ${buys.length} BUY deals (cc <= ${(threshold * 100).toFixed(0)}% of CL).`)
if (suspects.length) {
  console.log(`\n⚠ Dropped ${suspects.length} likely SOL-mislabeled listing(s) (price looks like cheap USD but is plausibly SOL):`)
  for (const s of suspects.sort((a, b) => b.cl - a.cl).slice(0, 20)) {
    console.log(`   $${s.cc_price} (as USD) vs CL $${s.cl} — but ${s.sol_interp} if SOL — ${(s.name || '').slice(0, 50)}`)
  }
}

// Only post deals we haven't posted before (unless --all). The record is keyed
// by cert|grader, so a card is announced once and never re-spammed on re-runs.
const posted = existsSync(POSTED_PATH) ? JSON.parse(readFileSync(POSTED_PATH, 'utf8')) : {}
const toPost = postAll ? buys : buys.filter((b) => !posted[b.key])
const skipped = buys.length - toPost.length
if (postAll) console.log(`--all: posting all ${buys.length} (ignoring posted-deals record).`)
else console.log(`${toPost.length} NEW to post; ${skipped} already posted (skipped).`)

if (noPost) console.log(`--no-post: recording ${toPost.length} as posted WITHOUT sending to Discord (seeding).`)
else await postBuysToDiscord(toPost, (m) => console.log(m))

// Record what we just posted so future runs skip them.
const now = new Date().toISOString()
for (const b of toPost) posted[b.key] = { firstPosted: posted[b.key]?.firstPosted ?? now, cc_price: b.cc_price, cl_value: b.card_ladder_value }
writeFileSync(POSTED_PATH, JSON.stringify(posted, null, 2))
console.log(`Recorded ${toPost.length} posted deal(s) → ${POSTED_PATH} (${Object.keys(posted).length} total tracked).`)
console.log('Done.')
