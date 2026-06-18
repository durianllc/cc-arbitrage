#!/usr/bin/env node
/**
 * cc-arbitrage orchestrator.
 *
 *   1. Scrape all listed cards from Collector Crypt (Pokemon + One Piece).
 *   2. Keep only cards graded by a company Card Ladder supports (PSA/BGS/CGC/SGC).
 *   3. Look up each card's Card Ladder value by cert number (gradingID),
 *      reusing the logged-in browser session created by `npm run login`.
 *   4. Compute the price discrepancy and write results.csv, best deal first.
 *
 * Lookups are slow browser automation, so every result is checkpointed to
 * cache.json keyed by `gradingID|grader`. Re-running resumes where it left off
 * and only retries cards that previously failed.
 *
 * Usage:
 *   node run.mjs                         # full run, headless
 *   node run.mjs --limit 25              # only the first 25 (priciest) cards
 *   node run.mjs --threshold 0.8         # buy_flag when cc_price <= 80% of CL
 *   node run.mjs --headed                # show the browser (debug selectors)
 *   node run.mjs --categories Pokemon    # override default category list
 */

import { PROXIES } from './config.mjs'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { launchContext } from './browser.mjs'
import { lookupCardLadder, checkSession } from './cardladder.mjs'
import { scrapeCards } from './collectorcrypt.mjs'
import { postBuysToDiscord, postMessageToDiscord } from './discord.mjs'

// Public Collector Crypt buy page for a listing (verified pattern, 2026-06).
const ccUrl = (nftAddress) => `https://collectorcrypt.com/assets/solana/${nftAddress}`

const CONTEXT_DIR = process.env.BROWSER_CONTEXT_DIR ?? './browser-state-context'
const CACHE_FILE = './cache.json'
const CSV_FILE = './results.csv'

// Card Ladder only grades these. CC's gradingCompany strings → CL grader code.
const GRADER_MAP = {
  PSA: 'PSA',
  BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS',
  CGC: 'CGC',
  SGC: 'SGC',
}

function parseArgs(argv) {
  const a = { limit: Infinity, threshold: 0.8, headed: false, concurrency: 2, delay: 800, profiles: 5, retries: 2, categories: ['Pokemon', 'One Piece'] }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--limit') a.limit = Number(argv[++i])
    else if (k === '--threshold') a.threshold = Number(argv[++i])
    else if (k === '--headed') a.headed = true
    else if (k === '--concurrency') a.concurrency = Math.max(1, Number(argv[++i]))
    else if (k === '--delay') a.delay = Math.max(0, Number(argv[++i]))
    else if (k === '--profiles') a.profiles = Math.max(1, Number(argv[++i]))
    else if (k === '--retries') a.retries = Math.max(0, Number(argv[++i]))
    else if (k === '--categories') a.categories = argv[++i].split(',').map(s => s.trim())
  }
  return a
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {}
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) } catch { return {} }
}
function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const args = parseArgs(process.argv)
  console.log(`Categories: ${args.categories.join(', ')} | buy threshold: cc <= ${(args.threshold * 100).toFixed(0)}% of CL`)

  // ── 1. Scrape Collector Crypt ────────────────────────────────────────────
  console.log('Scraping Collector Crypt marketplace…')
  const all = await scrapeCards(args.categories, (m) => console.log(m))
  console.log(`Found ${all.length} listed cards.`)

  // ── 2. Filter to Card-Ladder-gradeable cards ─────────────────────────────
  const eligible = []
  let skipped = 0
  for (const c of all) {
    const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
    if (!grader || !c.gradingID) { skipped++; continue }
    eligible.push({ ...c, grader })
  }
  console.log(`${eligible.length} cards are PSA/BGS/CGC/SGC with a cert; skipped ${skipped} (ungradeable on Card Ladder or no cert).`)

  const targets = eligible.slice(0, args.limit)
  if (targets.length < eligible.length) console.log(`Limiting to first ${targets.length} (priciest).`)

  // Startup ping so you can confirm the webhook is wired up correctly.
  const ok = await postMessageToDiscord(
    `🚀 **Starting arbitrage run** — scanning ${targets.length} cards (${args.categories.join(', ')}). BUY alerts at ≤${(args.threshold * 100).toFixed(0)}% of CL value will post here.`,
    (m) => console.log(m),
  )
  if (ok) console.log('Sent "starting" ping to Discord.')

  // ── 3. Card Ladder lookups (proxy fleet × tab pool, checkpointed) ────────
  const cache = loadCache()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // One "profile" = one logged-in browser. With ≥2 proxies we run a fleet, each
  // proxy getting its own profile dir (browser-state-context-N) logged in via
  // `node login.mjs --profile N`. With 0–1 proxies we use the single default
  // profile (./browser-state-context) so existing logins keep working.
  const multi = PROXIES.length >= 2
  const proxiesSlice = PROXIES.slice(0, args.profiles)
  const profiles = multi
    ? proxiesSlice.map((proxy, i) => ({ contextDir: `${CONTEXT_DIR}-${i}`, proxy, id: `p${i}` }))
    : [{ contextDir: CONTEXT_DIR, proxy: PROXIES[0], id: 'p0' }]
  console.log(multi
    ? `Proxy fleet: ${profiles.length} profiles × ${args.concurrency} tabs = ${profiles.length * args.concurrency} workers.`
    : `Single profile × ${args.concurrency} tabs.`)

  // Launch each profile's browser and validate its session. A profile that
  // isn't logged in is skipped (warned), not fatal — the others still run.
  const live = []
  for (const p of profiles) {
    let ctx
    try {
      ctx = await launchContext(p.contextDir, { headless: !args.headed, proxy: p.proxy })
    } catch (e) {
      console.warn(`${p.id}: could not launch (${e.message.slice(0, 80)}) — skipping.`)
      continue
    }
    const probe = ctx.pages()[0] ?? await ctx.newPage()
    if (!(await checkSession(probe))) {
      await ctx.close().catch(() => {})
      console.warn(`${p.id}: not logged in — run \`node login.mjs${multi ? ` --profile ${p.id.slice(1)}` : ''}\` and re-run. Skipping.`)
      continue
    }
    live.push({ ...p, ctx, probe })
  }
  if (!live.length) {
    console.error('\nNo logged-in profiles available. Log in (see warnings above) and re-run.')
    process.exit(1)
  }

  // Only look up cards without a value yet (re-runs retry failures).
  const todo = targets.filter((c) => cache[`${c.gradingID}|${c.grader}`]?.clValue == null)
  console.log(`${targets.length - todo.length} already cached; looking up ${todo.length} across ${live.length} profile(s).`)

  // One shared queue across the whole fleet. Single-threaded event loop means
  // `next++` and cache writes never truly race.
  let next = 0
  let done = 0
  let aborted = false

  async function worker(profile, tabIdx) {
    if (tabIdx > 0) await sleep(tabIdx * 1500) // stagger tabs within a profile
    const page = tabIdx === 0 ? profile.probe : await profile.ctx.newPage()
    const wid = `${profile.id}t${tabIdx}`
    while (!aborted) {
      const i = next++
      if (i >= todo.length) break
      const c = todo[i]
      const key = `${c.gradingID}|${c.grader}`
      // Retry transient misses (a throttled account often returns nothing within
      // the wait window even though the card exists). AUTH/Cloudflare are handled
      // separately. Each retry backs off a bit longer to let the throttle ease.
      let lastErr
      let resolved = false
      for (let attempt = 0; attempt <= args.retries; attempt++) {
        if (attempt > 0) await sleep(attempt * 4000)
        try {
          const { value, cardName, url } = await lookupCardLadder(page, { certNumber: c.gradingID, grader: c.grader })
          cache[key] = { clValue: value, clName: cardName, clUrl: url }
          const tag = attempt > 0 ? ` (retry ${attempt})` : ''
          const disc = ((1 - c.price / value) * 100).toFixed(0)
          const deal = c.price <= args.threshold * value ? ' 🔥BUY' : ''
          console.log(`[${++done}/${todo.length}] ${wid} ${c.grader} ${c.gradingID} — CC $${c.price} vs CL $${value} (${disc}% off)${deal}${tag} — ${c.itemName.slice(0, 40)}`)
          resolved = true
          break
        } catch (e) {
          lastErr = e
          if (e.code === 'AUTH_REQUIRED') {
            console.warn(`${wid}: session expired — stopping this profile.`)
            profile.dead = true
            resolved = true // not a value, but don't fall through to cache-as-failure
            break
          }
          if (e.code === 'CLOUDFLARE_BLOCK') {
            console.log(`[${done}/${todo.length}] ${wid} ${c.grader} ${c.gradingID} — CLOUDFLARE BLOCK, backing off 30s`)
            await sleep(30_000)
            attempt-- // a block doesn't burn a retry; try this card again
            continue
          }
          // "no value" — fall through to retry loop
        }
      }
      if (lastErr?.code === 'AUTH_REQUIRED') break
      if (!resolved) {
        cache[key] = { clValue: null, error: lastErr?.message }
        console.log(`[${++done}/${todo.length}] ${wid} ${c.grader} ${c.gradingID} — no value after ${args.retries + 1} tries (${(lastErr?.message ?? '').slice(0, 35)})`)
      }
      saveCache(cache) // checkpoint after every lookup so a crash loses nothing
      if (args.delay) await sleep(args.delay) // pace requests per tab
    }
  }

  const tabs = Math.min(args.concurrency, Math.max(1, todo.length))
  await Promise.all(live.flatMap((p) => Array.from({ length: tabs }, (_, t) => worker(p, t))))
  await Promise.all(live.map((p) => p.ctx.close().catch(() => {})))

  // ── 4. Compute discrepancy + write CSV ───────────────────────────────────
  const rows = []
  for (const c of targets) {
    const hit = cache[`${c.gradingID}|${c.grader}`]
    const clValue = hit?.clValue
    if (clValue == null) continue
    const ratio = c.price / clValue            // cc / cardladder, as requested
    rows.push({
      name: c.itemName,
      category: c.category,
      grader: c.grader,
      grade: c.grade,
      cc_price: c.price,
      card_ladder_value: clValue,
      pct_of_cl: ratio,                        // cc ÷ cl
      discount_pct: 1 - ratio,                 // how far under market (for sorting)
      buy_flag: ratio <= args.threshold ? 'BUY' : '',
      nft_address: c.nftAddress,
      cc_url: ccUrl(c.nftAddress),
      cl_url: hit.clUrl ?? '',
    })
  }
  rows.sort((a, b) => b.discount_pct - a.discount_pct) // best deals first

  const header = ['name', 'category', 'grader', 'grade', 'cc_price', 'card_ladder_value', 'pct_discrepancy', 'discount_pct', 'buy_flag', 'cc_url', 'cl_url', 'nft_address']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      r.name, r.category, r.grader, r.grade, r.cc_price, r.card_ladder_value,
      r.pct_of_cl.toFixed(4), (r.discount_pct * 100).toFixed(1) + '%', r.buy_flag, r.cc_url, r.cl_url, r.nft_address,
    ].map(csvCell).join(','))
  }
  writeFileSync(CSV_FILE, lines.join('\n'))

  const buys = rows.filter(r => r.buy_flag)
  console.log(`\nWrote ${rows.length} priced cards to ${CSV_FILE} — ${buys.length} flagged BUY (cc <= ${(args.threshold * 100).toFixed(0)}% of CL).`)

  // ── 5. Push BUY hits to Discord ──────────────────────────────────────────
  await postBuysToDiscord(buys, (m) => console.log(m))
}

main().catch((e) => { console.error(e); process.exit(1) })
