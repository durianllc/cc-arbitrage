#!/usr/bin/env node
/**
 * Collector Crypt ↔ Card Ladder monitor (one cycle per run). Cross-platform
 * (pure Node — no shell/pkill), so it runs on Windows/Linux/macOS servers.
 *
 * Each run:
 *   1. Scrape CC now; diff NATIVE prices against cc-snapshot.json (native, so
 *      SOL/USD rate wobble doesn't create phantom "price changes").
 *   2. NEW certs (never loaded, not known-notfound) → single-add into ARBALL.
 *   3. If anything was added OR the CL export is >20h old → re-export ARBALL to
 *      refresh Card Ladder values (CL re-values daily on its own).
 *   4. NEW + PRICE-CHANGED certs now ≤ threshold (default 80% of CL) → post to
 *      Discord. Deduped, but re-posts if the CC price DROPPED further.
 *   5. Save snapshot + CL values.
 *
 *   node monitor.mjs                 # one cycle
 *   node monitor.mjs --threshold 0.8 --max-add 40
 *
 * Loop it with:  node monitor-loop.mjs   (every 15 min, cross-platform)
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import './config.mjs'
import { scrapeCards } from './collectorcrypt.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { selectCollection, addOneCert, exportCollection } from './cl-cert-flow.mjs'
import { postBuysToDiscord } from './discord.mjs'

const args = process.argv.slice(2)
const numArg = (f, d) => { const i = args.indexOf(f); return i !== -1 ? Number(args[i + 1]) : d }
const THRESH = numArg('--threshold', 0.8)
const MAX_ADD = numArg('--max-add', 40)
// Re-post an already-posted deal only if its discount % moved by at least this
// much (default 0.01 = 1 percentage point, e.g. 20% → 21%). Prevents re-posting
// the same unchanged deal every cycle.
const MIN_PCT_CHANGE = numArg('--min-change', 0.01)
const REFRESH_HOURS = numArg('--refresh-hours', 20) // re-export CL values at least this often
const COLL = 'ARBALL'
const CATS = ['Pokemon', 'One Piece']
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

const SNAP = './cc-snapshot.json'
const CLV = './cl-values.json'
const NOTFOUND = './cl-notfound.json'
const POSTED = './posted-deals.json'
const EXPORT = './cert-upload/exports/ARBALL-export.csv'
const ccUrl = (nft) => `https://collectorcrypt.com/assets/solana/${nft}`
const clUrl = (name) => `https://app.cardladder.com/sales-history?direction=desc&sort=date&search=${encodeURIComponent(name)}`
const loadJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getSolUsd() {
  try { const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); if (!r.ok) return null; const v = (await r.json())?.solana?.usd; return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
}

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
    if (cert && Number.isFinite(v) && v > 0) out[cert] = v
  }
  return out
}

async function main() {
  console.log(`\n=== monitor ${new Date().toISOString()} ===`)

  // 1. Scrape CC.
  const all = await scrapeCards(CATS, () => {})
  const solUsd = all.some((c) => (c.currency ?? '').toUpperCase() === 'SOL') ? await getSolUsd() : null
  const current = {} // key -> { cc_price(USD), raw(native), cert, grader, name, nft, grade, category }
  for (const c of all) {
    const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
    if (!grader || !c.gradingID) continue
    const isSol = (c.currency ?? '').toUpperCase() === 'SOL'
    const usd = isSol ? (solUsd ? Math.round(c.price * solUsd * 100) / 100 : null) : c.price
    if (usd == null) continue
    current[`${c.gradingID}|${grader}`] = { cc_price: usd, raw: c.price, cert: String(c.gradingID), grader, name: c.itemName, nft: c.nftAddress, grade: c.grade, category: c.category }
  }
  console.log(`Scraped ${Object.keys(current).length} eligible CC listings.`)

  const snapshot = loadJson(SNAP)   // key -> last NATIVE price
  let clValues = existsSync(CLV) ? loadJson(CLV) : parseExportToClValues(EXPORT)
  const notfound = loadJson(NOTFOUND)
  const firstRun = !existsSync(SNAP)

  // 2. Classify (compare NATIVE prices → no SOL-rate phantom changes).
  const newKeys = [], changedKeys = []
  for (const [k, cur] of Object.entries(current)) {
    if (clValues[cur.cert] == null) { if (!notfound[cur.cert]) newKeys.push(k) }
    else if (snapshot[k] != null && Math.abs(snapshot[k] - cur.raw) > Math.max(0.01, snapshot[k] * 0.001)) changedKeys.push(k)
  }
  console.log(`${newKeys.length} new cert(s), ${changedKeys.length} price change(s).`)

  // 3. Add new certs + refresh CL values (one browser session, in-process).
  const exportAgeH = existsSync(EXPORT) ? (Date.now() - statSync(EXPORT).mtimeMs) / 3.6e6 : Infinity
  const needRefresh = exportAgeH > REFRESH_HOURS
  const toAdd = firstRun ? [] : newKeys.slice(0, MAX_ADD)
  if (toAdd.length || (needRefresh && !firstRun)) {
    if (newKeys.length > MAX_ADD) console.log(`Adding first ${MAX_ADD} of ${newKeys.length} new (rest next cycle).`)
    let ctx
    try {
      ctx = await launchContext('./browser-state-context', { headless: true })
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
        else if (r === 'notfound') notfound[cur.cert] = true
        console.log(`  add ${cur.grader} ${cur.cert}: ${r}`)
      }
      writeFileSync(NOTFOUND, JSON.stringify(notfound, null, 2))
      if (added > 0 || needRefresh) {
        console.log(`Re-exporting ARBALL (added ${added}${needRefresh ? ', daily refresh' : ''})…`)
        await exportCollection(page, EXPORT)
        clValues = parseExportToClValues(EXPORT)
        writeFileSync(CLV, JSON.stringify(clValues, null, 2))
      }
    } catch (e) {
      console.warn(`Add/export step failed (${e.message}). Price-change checks still run on cached values.`)
    } finally {
      if (ctx) await ctx.close().catch(() => {})
    }
  }

  // 4. Evaluate EVERY current listing against its CL value; the %-change dedup
  //    below decides what to post — so a discount that shifts because the CC
  //    price OR the CL value moved both get caught, and unchanged ones are skipped.
  const posted = loadJson(POSTED)
  const deals = []
  for (const [k, cur] of Object.entries(current)) {
    const cl = clValues[cur.cert]
    if (cl == null) continue
    const ratio = cur.cc_price / cl
    if (ratio > THRESH) continue
    const pct = 1 - ratio // current discount fraction
    // Skip if we already posted this card at essentially the same discount %.
    // Re-post when the % changed by ≥ MIN_PCT_CHANGE (either CC price or CL value moved).
    const prev = posted[k]
    if (prev && prev.cl_value > 0) {
      const prevPct = 1 - prev.cc_price / prev.cl_value
      if (Math.abs(pct - prevPct) < MIN_PCT_CHANGE) continue
    }
    deals.push({ key: k, name: cur.name, category: cur.category, grader: cur.grader, grade: cur.grade, cc_price: cur.cc_price, card_ladder_value: cl, discount_pct: pct, cc_url: ccUrl(cur.nft), cl_url: clUrl(cur.name) })
  }
  deals.sort((a, b) => b.discount_pct - a.discount_pct)
  console.log(`${deals.length} deal(s) to post${firstRun ? ' (suppressed on first run)' : ''}.`)

  // 5. Post (skip on first run).
  if (!firstRun && deals.length) {
    await postBuysToDiscord(deals, (m) => console.log(m))
    const now = new Date().toISOString()
    for (const d of deals) posted[d.key] = { firstPosted: posted[d.key]?.firstPosted ?? now, lastPosted: now, cc_price: d.cc_price, cl_value: d.card_ladder_value }
    writeFileSync(POSTED, JSON.stringify(posted, null, 2))
  }

  // 6. Save snapshot (NATIVE prices) + CL values.
  const snapOut = {}
  for (const [k, v] of Object.entries(current)) snapOut[k] = v.raw
  writeFileSync(SNAP, JSON.stringify(snapOut, null, 2))
  writeFileSync(CLV, JSON.stringify(clValues, null, 2))
  console.log('=== cycle done ===')
}

main().catch((e) => { console.error('monitor error:', e.message); process.exit(1) })
