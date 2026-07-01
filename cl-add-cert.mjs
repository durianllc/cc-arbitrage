#!/usr/bin/env node
/**
 * Add a SINGLE graded cert to a Card Ladder collection via the "Enter Graded Card
 * Cert" UI flow. Thin wrapper over cl-cert-flow.mjs.
 *
 *   node cl-add-cert.mjs --cert 76033720 --grader PSA
 *   node cl-add-cert.mjs --cert 76033720 --grader PSA --collection ARBALL --headless
 *
 * Exit codes: 0 added, 2 not found (CL has no data), 1 error.
 */
import { mkdirSync } from 'node:fs'
import './config.mjs'
import { launchContext, CARD_LADDER_BASE } from './browser.mjs'
import { selectCollection, addOneCert } from './cl-cert-flow.mjs'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : d }
const CERT = opt('--cert', null)
const GRADER = (opt('--grader', 'PSA')).toUpperCase()
const COLLECTION = opt('--collection', 'ARBALL')
const headless = args.includes('--headless')
if (!CERT) { console.error('Need --cert <number> (and optional --grader PSA).'); process.exit(1) }

mkdirSync('./debug', { recursive: true })
let shotN = 0
const shot = async (label) => { shotN++; await page.screenshot({ path: `./debug/add-${String(shotN).padStart(2, '0')}-${label}.png` }).catch(() => {}) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ctx = await launchContext('./browser-state-context', { headless })
const page = ctx.pages()[0] ?? await ctx.newPage()
page.on('dialog', (d) => d.accept().catch(() => {}))

console.log(`Adding cert ${CERT} (${GRADER}) → "${COLLECTION}"`)
await page.goto(`${CARD_LADDER_BASE}/collection`, { waitUntil: 'domcontentloaded' })
await sleep(4000)
if (/\/login(\?|$)/i.test(page.url())) { console.error('Not logged in — run `node login.mjs`.'); await ctx.close(); process.exit(1) }

await selectCollection(page, COLLECTION)
const outcome = await addOneCert(page, { cert: CERT, grader: GRADER }, { shot })

if (!process.env.NO_WAIT) await sleep(15000)
await ctx.close().catch(() => {})

if (outcome === 'added') { console.log(`✅ Added ${CERT} (${GRADER}) to ${COLLECTION}.`); process.exit(0) }
if (outcome === 'notfound') { console.log(`⚠ NOT FOUND — Card Ladder has no data for cert ${CERT} (${GRADER}).`); process.exit(2) }
console.log(`❌ Error adding ${CERT} (${GRADER}) — check ./debug/add-*.png`); process.exit(1)
