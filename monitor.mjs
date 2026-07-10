#!/usr/bin/env node
/**
 * 15-minute Collector Crypt ↔ Card Ladder monitor (one cycle per run).
 *
 * Each run:
 *   1. Scrape CC now; diff against the saved price snapshot (cc-snapshot.json).
 *   2. NEW certs (never loaded) → add each into ARBALL via the single "Add Cert"
 *      flow, then re-export ARBALL to learn their Card Ladder values.
 *   3. PRICE CHANGES on existing certs → re-check against the known CL value.
 *   4. Any card now ≤ threshold (default 80% of CL) → post to Discord.
 *      Deduped, but re-posts a card if its CC price DROPPED further since last post.
 *   5. Save the new snapshot + CL values.
 *
 * State: cc-snapshot.json (last CC prices), cl-values.json (known CL values),
 * posted-deals.json (shared dedup).
 *
 *   node monitor.mjs                 # one cycle
 *   node monitor.mjs --threshold 0.8 --max-add 40
 *
 * Run every 15 min via monitor-loop.sh (or launchd). First run seeds baselines
 * from the current ARBALL export and posts little/nothing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import './config.mjs'
import { scrapeCards } from './collectorcrypt.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { selectCollection, addOneCert } from './cl-cert-flow.mjs'
import { postBuysToDiscord } from './discord.mjs'

const args = process.argv.slice(2)
const numArg = (f, d) => { const i = args.indexOf(f); return i !== -1 ? Number(args[i + 1]) : d }
const THRESH = numArg('--threshold', 0.8)
const MAX_ADD = numArg('--max-add', 40)      // cap single-adds per cycle (bounds time)
const COLL = 'ARBALL'
const CATS = ['Pokemon', 'One Piece']
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

const SNAP = './cc-snapshot.json'
const CLV = './cl-values.json'
const NOTFOUND = './cl-notfound.json' // certs Card Ladder has no data for — don't retry forever
const POSTED = './posted-deals.json'
const EXPORT = './cert-upload/exports/ARBALL-export.csv'
const ccUrl = (nft) => `https://collectorcrypt.com/assets/solana/${nft}`
const clUrl = (name) => `https://app.cardladder.com/sales-history?direction=desc&sort=date&search=${encodeURIComponent(name)}`
const loadJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getSolUsd() {
  try { const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); if (!r.ok) return null; const v = (await r.json())?.solana?.usd; return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
}

// Minimal CSV parse for the ARBALL export (cert + Current Value columns).
function parseExportToClValues(path) {
  if (!existsSync(path)) return {}
  const t = readFileSync(path, 'utf8')
  const rows = []; let r = [], c = '', q = false
  for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++ } else q = false } else c += ch } else if (ch === '"') q = true; else if (ch === ',') { r.push(c); c = '' } else if (ch === '\n') { r.push(c); rows.push(r); r = []; c = '' } else if (ch === '\r') {} else c += ch }
  if (c.length || r.length) { r.push(c); rows.push(r) }
  if (!rows.length) return {}
  const h = rows[0]
  const ci = h.findIndex((x) => /graded cert/i.test(x))
  const vi = h.findIndex((x) => /current value/i.test(x))
  const out = {}
  for (const row of rows.slice(1)) {
    const cert = (row[ci] || '').trim()
    const v = parseFloat(String(row[vi] || '').replace(/[^0-9.]/g, ''))
    if (cert && Number.isFinite(v) && v > 0) out[cert] = v // keyed by cert only (export has no grader col)
  }
  return out
}

async function main() {
  console.log(`\n=== monitor ${new Date().toISOString()} ===`)

  // 1. Scrape CC now.
  const all = await scrapeCards(CATS, () => {})
  const solUsd = all.some((c) => (c.currency ?? '').toUpperCase() === 'SOL') ? await getSolUsd() : null
  const current = {} // key cert|grader -> { cc_price, cert, grader, name, nft, grade, category, currency }
  for (const c of all) {
    const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
    if (!grader || !c.gradingID) continue
    const isSol = (c.currency ?? '').toUpperCase() === 'SOL'
    const price = isSol ? (solUsd ? Math.round(c.price * solUsd * 100) / 100 : null) : c.price
    if (price == null) continue
    current[`${c.gradingID}|${grader}`] = { cc_price: price, cert: String(c.gradingID), grader, name: c.itemName, nft: c.nftAddress, grade: c.grade, category: c.category }
  }
  console.log(`Scraped ${Object.keys(current).length} eligible CC listings.`)

  const snapshot = loadJson(SNAP)          // key -> last cc_price
  let clValues = existsSync(CLV) ? loadJson(CLV) : parseExportToClValues(EXPORT) // cert -> CL value
  if (!Object.keys(clValues).length) console.warn('No CL values yet — run daily.sh / an export first to seed cl-values.')
  const firstRun = !existsSync(SNAP)

  // 2. Classify.
  const notfound = loadJson(NOTFOUND) // cert -> true (CL has no data; skip)
  const newKeys = []      // certs we have no CL value for (never loaded) and not known-notfound
  const changedKeys = []  // price changed vs snapshot
  for (const [k, cur] of Object.entries(current)) {
    const cert = cur.cert
    if (clValues[cert] == null) { if (!notfound[cert]) newKeys.push(k) }
    else if (snapshot[k] != null && Math.abs(snapshot[k] - cur.cc_price) > 0.01) changedKeys.push(k)
  }
  console.log(`${newKeys.length} new cert(s), ${changedKeys.length} price change(s).`)

  // 3. Add NEW certs to ARBALL (single-add), then re-export to learn values.
  if (newKeys.length && !firstRun) {
    const toAdd = newKeys.slice(0, MAX_ADD)
    if (newKeys.length > MAX_ADD) console.log(`Adding first ${MAX_ADD} of ${newKeys.length} new (rest next cycle).`)
    try {
      const ctx = await launchContext('./browser-state-context', { headless: true })
      const page = ctx.pages()[0] ?? await ctx.newPage()
      page.on('dialog', (d) => d.accept().catch(() => {}))
      await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
      await sleep(4000)
      if (/\/login(\?|$)/i.test(page.url())) throw new Error('not logged in — run `node login.mjs`')
      await selectCollection(page, COLL)
      let added = 0
      for (const k of toAdd) {
        const cur = current[k]
        const r = await addOneCert(page, { cert: cur.cert, grader: cur.grader }).catch(() => 'error')
        if (r === 'added') added++
        else if (r === 'notfound') { notfound[cur.cert] = true } // never retry
        console.log(`  add ${cur.grader} ${cur.cert}: ${r}`)
      }
      await ctx.close().catch(() => {})
      writeFileSync(NOTFOUND, JSON.stringify(notfound, null, 2))
      console.log(`Added ${added}/${toAdd.length}. Re-exporting ARBALL…`)
      execSync('pkill -9 -f browser-state-context; sleep 2; NO_WAIT=1 node cl-bulk.mjs --export-only --collection ARBALL; pkill -9 -f browser-state-context; sleep 1', { stdio: 'ignore', shell: '/bin/bash' })
      clValues = parseExportToClValues(EXPORT)
      writeFileSync(CLV, JSON.stringify(clValues, null, 2))
    } catch (e) {
      console.warn(`Add/export step failed (${e.message}). Price-change checks still run.`)
    }
  }

  // 4. Build deals from new + changed certs that now have a CL value.
  const posted = loadJson(POSTED)
  const candidateKeys = [...new Set([...newKeys, ...changedKeys])]
  const deals = []
  for (const k of candidateKeys) {
    const cur = current[k]
    const cl = clValues[cur.cert]
    if (cl == null) continue
    const ratio = cur.cc_price / cl
    if (ratio > THRESH) continue
    // Post if never posted, or price dropped ≥2% below the last posted price.
    const prev = posted[k]
    if (prev && cur.cc_price >= prev.cc_price * 0.98) continue
    deals.push({ key: k, name: cur.name, category: cur.category, grader: cur.grader, grade: cur.grade, cc_price: cur.cc_price, card_ladder_value: cl, discount_pct: 1 - ratio, cc_url: ccUrl(cur.nft), cl_url: clUrl(cur.name) })
  }
  deals.sort((a, b) => b.discount_pct - a.discount_pct)
  console.log(`${deals.length} deal(s) to post${firstRun ? ' (suppressed on first run)' : ''}.`)

  // 5. Post (skip on first run — just establish baselines).
  if (!firstRun && deals.length) {
    await postBuysToDiscord(deals, (m) => console.log(m))
    const now = new Date().toISOString()
    for (const d of deals) posted[d.key] = { firstPosted: posted[d.key]?.firstPosted ?? now, lastPosted: now, cc_price: d.cc_price, cl_value: d.card_ladder_value }
    writeFileSync(POSTED, JSON.stringify(posted, null, 2))
  }

  // 6. Save snapshot (all current prices) + cl-values.
  const snapOut = {}
  for (const [k, v] of Object.entries(current)) snapOut[k] = v.cc_price
  writeFileSync(SNAP, JSON.stringify(snapOut, null, 2))
  writeFileSync(CLV, JSON.stringify(clValues, null, 2))
  console.log('=== cycle done ===')
}

main().catch((e) => { console.error('monitor error:', e.message); process.exit(1) })
