/**
 * Post arbitrage BUY hits to a Discord channel via webhook.
 *
 * Set DISCORD_WEBHOOK_URL in .env (Discord → Server Settings → Integrations →
 * Webhooks → New Webhook → Copy URL). If it's unset, posting is skipped.
 *
 * Each card becomes a rich embed: item name links to the Collector Crypt buy
 * page, with grader/grade/prices as fields and a Card Ladder link in the body.
 */

// Read env at CALL time (config.mjs uses top-level await, so reading at module
// load can race ahead of the env being set).
// Deals route by CC price: < PRICE_SPLIT → LOW webhook, >= → HIGH webhook.
// DISCORD_WEBHOOK_URL is the fallback if a LOW/HIGH one is missing.
const PRICE_SPLIT = 200
const webhookFor = (ccPrice) => {
  const low = process.env.DISCORD_WEBHOOK_LOW
  const high = process.env.DISCORD_WEBHOOK_HIGH
  const fb = process.env.DISCORD_WEBHOOK_URL
  return (Number(ccPrice) < PRICE_SPLIT ? low : high) || fb
}
const anyWebhook = () => process.env.DISCORD_WEBHOOK_HIGH || process.env.DISCORD_WEBHOOK_LOW || process.env.DISCORD_WEBHOOK_URL

function embedFor(r) {
  return {
    title: r.name.slice(0, 256),
    url: r.cc_url, // makes the title a clickable buy link
    color: 0x2ecc71, // green = good deal
    description:
      `**${(r.discount_pct * 100).toFixed(0)}% under market** — ` +
      `CC **$${r.cc_price.toLocaleString()}** vs Card Ladder **$${r.card_ladder_value.toLocaleString()}**\n` +
      `🛒 [Buy on Collector Crypt](${r.cc_url})` +
      (r.cl_url ? ` • 📈 [Card Ladder](${r.cl_url})` : ''),
    fields: [
      { name: 'Grader', value: r.grader || '—', inline: true },
      { name: 'Grade', value: r.grade || '—', inline: true },
      { name: 'Category', value: r.category || '—', inline: true },
    ],
  }
}

async function postOne(url, embed) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  })
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 1) * 1000
    await new Promise((r) => setTimeout(r, retry + 250))
    return postOne(url, embed)
  }
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => '')}`)
}

/**
 * Post each deal as its own message, routed by CC price to the LOW/HIGH webhook.
 * @param {Array} buys rows with { name, cc_url, cl_url, grader, grade, category, cc_price, card_ladder_value, discount_pct }
 * @param {(msg: string) => void} [log]
 */
export async function postBuysToDiscord(buys, log = () => {}) {
  if (!anyWebhook()) { log('No Discord webhook set (LOW/HIGH/URL) — skipping.'); return }
  if (!buys.length) { log('No BUY hits to post to Discord.'); return }
  let low = 0, high = 0, skipped = 0
  for (const b of buys) {
    const url = webhookFor(b.cc_price)
    if (!url) { skipped++; continue }
    await postOne(url, embedFor(b))
    if (Number(b.cc_price) < PRICE_SPLIT) low++; else high++
    await new Promise((r) => setTimeout(r, 600)) // gentle pacing
  }
  log(`Posted ${low + high} deal(s) → LOW(<$${PRICE_SPLIT}): ${low}, HIGH(≥$${PRICE_SPLIT}): ${high}${skipped ? `, skipped ${skipped} (no webhook)` : ''}.`)
}
