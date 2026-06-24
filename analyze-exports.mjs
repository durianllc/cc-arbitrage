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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import './config.mjs'
import { postBuysToDiscord } from './discord.mjs'

const ccUrl = (nft) => `https://collectorcrypt.com/assets/solana/${nft}`
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

let dir = './cert-upload/exports'
let threshold = 0.8
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--dir') dir = process.argv[++i]
  else if (process.argv[i] === '--threshold') threshold = Number(process.argv[++i])
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
// cert-only index as a fallback when the export lacks a grader column.
const byCert = {}
for (const [k, v] of Object.entries(mapping)) byCert[k.split('|')[0]] = { ...v, grader: k.split('|')[1] }

if (!existsSync(dir)) { console.error(`Export dir not found: ${dir}`); process.exit(1) }
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'))
if (!files.length) { console.error(`No .csv files in ${dir}`); process.exit(1) }
console.log(`Reading ${files.length} export file(s) from ${dir}`)

const buys = []
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
    buys.push({
      name: m.name, category: m.category, grader: m.grader, grade: m.grade,
      cc_price: m.cc_price, card_ladder_value: clValue, discount_pct: 1 - ratio,
      cc_url: ccUrl(m.nft), cl_url: '',
    })
  }
}

buys.sort((a, b) => b.discount_pct - a.discount_pct)
console.log(`\nMatched ${matched} rows to CC listings (${unmatched} unmatched).`)
console.log(`Found ${buys.length} BUY deals (cc <= ${(threshold * 100).toFixed(0)}% of CL). Posting to Discord…`)
await postBuysToDiscord(buys, (m) => console.log(m))
console.log('Done.')
