/**
 * Loads config from plain-text files so it's easy to edit on a server, then
 * exposes everything via process.env (so the rest of the code stays unchanged).
 *
 * Precedence (later does NOT override earlier — first one wins):
 *   1. real environment variables already set
 *   2. .env            (optional, dotenv format)
 *   3. settings.txt    (KEY=VALUE lines — e.g. DISCORD_WEBHOOK_URL=...)
 *   4. proxy.txt       (one proxy line, see formats below)
 *
 * proxy.txt accepts any of these on a single line:
 *   http://host:port
 *   socks5://host:port
 *   http://user:pass@host:port
 *   host:port
 *   host:port:user:pass            (common proxy-provider export format)
 *   user:pass@host:port
 */

import { existsSync, readFileSync } from 'node:fs'

function setIfUnset(key, value) {
  if (value != null && value !== '' && (process.env[key] == null || process.env[key] === '')) {
    process.env[key] = value
  }
}

// 2. .env (optional) — load via dotenv if the package + file exist.
try {
  if (existsSync('.env')) (await import('dotenv')).config()
} catch { /* dotenv not installed — fine */ }

// 3. settings.txt — KEY=VALUE lines, '#' comments allowed.
if (existsSync('settings.txt')) {
  for (const raw of readFileSync('settings.txt', 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    setIfUnset(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
}

// 4. proxy.txt — one proxy line → PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD.
if (existsSync('proxy.txt')) {
  const line = readFileSync('proxy.txt', 'utf8').split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('#'))
  if (line) {
    const parsed = parseProxy(line)
    if (parsed) {
      setIfUnset('PROXY_SERVER', parsed.server)
      setIfUnset('PROXY_USERNAME', parsed.username)
      setIfUnset('PROXY_PASSWORD', parsed.password)
    } else {
      console.warn(`[config] could not parse proxy.txt line: "${line}"`)
    }
  }
}

/**
 * The proxy fleet, parsed from proxies.txt (one proxy per line). Each profile
 * in a multi-proxy run gets its own entry + its own logged-in browser profile.
 * Falls back to a single PROXY_SERVER (from proxy.txt / env) if proxies.txt is
 * absent, or an empty list for a direct connection.
 */
export const PROXIES = (() => {
  if (existsSync('proxies.txt')) {
    return readFileSync('proxies.txt', 'utf8')
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
      .map(parseProxy).filter(Boolean)
  }
  if (process.env.PROXY_SERVER) {
    return [{
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined,
    }]
  }
  return []
})()

function parseProxy(line) {
  let scheme = 'http'
  let rest = line
  const schemeMatch = line.match(/^(\w+):\/\/(.*)$/)
  if (schemeMatch) { scheme = schemeMatch[1]; rest = schemeMatch[2] }

  let username, password, hostport

  if (rest.includes('@')) {
    // user:pass@host:port
    const [creds, hp] = rest.split('@')
    const ci = creds.indexOf(':')
    if (ci !== -1) { username = creds.slice(0, ci); password = creds.slice(ci + 1) }
    hostport = hp
  } else {
    const parts = rest.split(':')
    if (parts.length === 4) {
      // host:port:user:pass
      hostport = `${parts[0]}:${parts[1]}`
      username = parts[2]; password = parts[3]
    } else if (parts.length === 2) {
      // host:port
      hostport = rest
    } else {
      return null
    }
  }
  if (!hostport || !hostport.includes(':')) return null
  return { server: `${scheme}://${hostport}`, username, password }
}
