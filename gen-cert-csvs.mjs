#!/usr/bin/env node
/**
 * Generate Card Ladder bulk cert-upload CSVs from Collector Crypt listings.
 *
 * Avoids the per-cert rate limit: instead of looking each card up one by one,
 * we scrape all CC cards, write them into Card Ladder's "Cert CSV" upload
 * format (≤500 rows per file), and you bulk-upload each into a NEW Card Ladder
 * collection (arb1, arb2, …). Card Ladder fetches every value at once.
 *
 *   node gen-cert-csvs.mjs                      # Pokemon + One Piece
 *   node gen-cert-csvs.mjs --categories Pokemon
 *
 * Output → ./cert-upload/arb1.csv, arb2.csv, …  plus mapping.json (cert→CC data,
 * used later to join Card Ladder values back to CC prices).
 *
 * CL upload columns: Date Purchased,Cert #,Grader,Investment,Estimated Value,Notes,Date Sold,Sold Price
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import './config.mjs'
import { scrapeCards } from './collectorcrypt.mjs'

const OUT_DIR = './cert-upload'
const ROWS_PER_FILE = 500
// CC gradingCompany → the grader string Card Ladder's CSV expects (BGS, not BECKETT).
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

console.log(`Scraping Collector Crypt (${categories.join(', ')})…`)
const all = await scrapeCards(categories, (m) => console.log(m))

const solUsd = all.some((c) => (c.currency ?? '').toUpperCase() === 'SOL') ? await getSolUsd() : null
if (solUsd) console.log(`SOL/USD rate: $${solUsd}`)

// Build the eligible list (PSA/BGS/CGC/SGC + cert + a USD price) and the mapping.
const rows = []
const mapping = {}
let skipped = 0
for (const c of all) {
  const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
  if (!grader || !c.gradingID) { skipped++; continue }
  const priceUsd = (c.currency ?? '').toUpperCase() === 'SOL'
    ? (solUsd ? Math.round(c.price * solUsd * 100) / 100 : null)
    : c.price
  if (priceUsd == null) { skipped++; continue }
  rows.push({ cert: String(c.gradingID), grader, priceUsd, name: c.itemName, nft: c.nftAddress })
  // Key by cert|grader to match Card Ladder rows back later.
  mapping[`${c.gradingID}|${grader}`] = {
    cc_price: priceUsd, name: c.itemName, nft: c.nftAddress, category: c.category, grade: c.grade,
  }
}
console.log(`${rows.length} eligible cards; skipped ${skipped}.`)

// De-dupe certs (a cert can appear once); keep first.
const seen = new Set()
const unique = rows.filter((r) => {
  const k = `${r.cert}|${r.grader}`
  if (seen.has(k)) return false
  seen.add(k); return true
})

mkdirSync(OUT_DIR, { recursive: true })
const header = 'Date Purchased,Cert #,Grader,Investment,Estimated Value,Notes,Date Sold,Sold Price'
let fileNo = 0
for (let i = 0; i < unique.length; i += ROWS_PER_FILE) {
  fileNo++
  const batch = unique.slice(i, i + ROWS_PER_FILE)
  const lines = [header]
  for (const r of batch) {
    // Cert # + Grader are what CL needs; we stash the CC price in Investment and
    // the nft address in Notes so the collection is self-describing.
    lines.push([
      '', csvCell(r.cert), csvCell(r.grader), csvCell(r.priceUsd), '', csvCell(r.nft), '', '',
    ].join(','))
  }
  writeFileSync(`${OUT_DIR}/arb${fileNo}.csv`, lines.join('\n'))
  console.log(`  wrote ${OUT_DIR}/arb${fileNo}.csv (${batch.length} rows)`)
}
writeFileSync(`${OUT_DIR}/mapping.json`, JSON.stringify(mapping, null, 2))
console.log(`\nDone. ${fileNo} file(s) → upload each into a NEW Card Ladder collection named arb1, arb2, …`)
console.log(`mapping.json saved (used to join CL values back to CC prices).`)
