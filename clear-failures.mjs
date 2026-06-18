/**
 * Removes failed (clValue: null) entries from cache.json so the next run
 * retries them. Successful lookups are untouched.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CACHE_FILE = './cache.json'
if (!existsSync(CACHE_FILE)) { console.log('No cache.json found.'); process.exit(0) }

const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
let removed = 0
for (const [key, val] of Object.entries(cache)) {
  if (val.clValue == null) { delete cache[key]; removed++ }
}
writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
console.log(`Cleared ${removed} failures. ${Object.keys(cache).length} successful lookups kept.`)
