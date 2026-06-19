#!/usr/bin/env node
/**
 * One-time: post every cached BUY deal to Discord.
 *
 * Re-scrapes current Collector Crypt listings, joins them against the Card
 * Ladder values already in cache.json, and posts everything at/under the
 * threshold to the Discord webhook. Use this to catch up on BUY hits that were
 * found before live Discord posting existed.
 *
 *   node post-cached.mjs                 # threshold 0.8 (20%+ under market)
 *   node post-cached.mjs --threshold 0.7 # only 30%+ under market
 *   node post-cached.mjs --categories Pokemon,One Piece
 */
import { readFileSync, existsSync } from 'node:fs'
import './config.mjs'
import { scrapeCards } from './collectorcrypt.mjs'
import { postBuysToDiscord } from './discord.mjs'

const ccUrl = (nftAddress) => `https://collectorcrypt.com/assets/solana/${nftAddress}`
const GRADER_MAP = { PSA: 'PSA', BGS: 'BGS', BECKETT: 'BGS', 'BECKETT (BGS)': 'BGS', CGC: 'CGC', SGC: 'SGC' }

async function getSolUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')
    if (!r.ok) return null
    const v = (await r.json())?.solana?.usd
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null }
}

// args
let threshold = 0.8
let categories = ['Pokemon', 'One Piece']
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--threshold') threshold = Number(process.argv[++i])
  else if (process.argv[i] === '--categories') categories = process.argv[++i].split(',').map(s => s.trim())
}

if (!existsSync('./cache.json')) { console.error('No cache.json found — nothing to post.'); process.exit(1) }
const cache = JSON.parse(readFileSync('./cache.json', 'utf8'))

console.log(`Scraping Collector Crypt (${categories.join(', ')}) to match against cached CL values…`)
const all = await scrapeCards(categories, (m) => console.log(m))

// Convert SOL-priced (Magic Eden) listings to USD at the live rate.
const solUsd = all.some((c) => (c.currency ?? '').toUpperCase() === 'SOL') ? await getSolUsd() : null
if (solUsd) console.log(`SOL/USD rate: $${solUsd}`)

const buys = []
for (const c of all) {
  const grader = GRADER_MAP[(c.gradingCompany ?? '').toUpperCase()]
  if (!grader || !c.gradingID) continue
  const priceUsd = (c.currency ?? '').toUpperCase() === 'SOL' ? (solUsd ? c.price * solUsd : null) : c.price
  if (priceUsd == null) continue // SOL price we couldn't convert — skip, don't post bad data
  const hit = cache[`${c.gradingID}|${grader}`]
  const clValue = hit?.clValue
  if (clValue == null) continue
  const ratio = priceUsd / clValue
  if (ratio > threshold) continue
  buys.push({
    name: c.itemName, category: c.category, grader, grade: c.grade,
    cc_price: Math.round(priceUsd * 100) / 100, card_ladder_value: clValue, discount_pct: 1 - ratio,
    cc_url: ccUrl(c.nftAddress), cl_url: hit.clUrl ?? '',
    _ratio: ratio,
  })
}

buys.sort((a, b) => b.discount_pct - a.discount_pct) // best deals first
console.log(`Found ${buys.length} cached BUY deals (cc <= ${(threshold * 100).toFixed(0)}% of CL). Posting to Discord…`)
await postBuysToDiscord(buys, (m) => console.log(m))
console.log('Done.')
