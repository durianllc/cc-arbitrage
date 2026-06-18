/**
 * Post arbitrage BUY hits to a Discord channel via webhook.
 *
 * Set DISCORD_WEBHOOK_URL in .env (Discord → Server Settings → Integrations →
 * Webhooks → New Webhook → Copy URL). If it's unset, posting is skipped.
 *
 * Each card becomes a rich embed: item name links to the Collector Crypt buy
 * page, with grader/grade/prices as fields and a Card Ladder link in the body.
 */

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL

// Discord allows up to 10 embeds per message.
const PER_MSG = 10

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

async function postBatch(embeds) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds }),
  })
  if (res.status === 429) {
    // Rate limited — wait the suggested time and retry once.
    const retry = Number(res.headers.get('retry-after') ?? 1) * 1000
    await new Promise((r) => setTimeout(r, retry + 250))
    return postBatch(embeds)
  }
  if (!res.ok) {
    throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => '')}`)
  }
}

/** Send a plain text message to the webhook (used for status pings). */
export async function postMessageToDiscord(content, log = () => {}) {
  if (!WEBHOOK) {
    log('DISCORD_WEBHOOK_URL not set — skipping Discord message.')
    return false
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    log(`Discord webhook error ${res.status}: ${await res.text().catch(() => '')}`)
    return false
  }
  return true
}

/**
 * @param {Array} buys rows with { name, cc_url, cl_url, grader, grade, category, cc_price, card_ladder_value, discount_pct }
 * @param {(msg: string) => void} [log]
 */
export async function postBuysToDiscord(buys, log = () => {}) {
  if (!WEBHOOK) {
    log('DISCORD_WEBHOOK_URL not set — skipping Discord post.')
    return
  }
  if (!buys.length) {
    log('No BUY hits to post to Discord.')
    return
  }
  for (let i = 0; i < buys.length; i += PER_MSG) {
    const batch = buys.slice(i, i + PER_MSG)
    await postBatch(batch.map(embedFor))
    await new Promise((r) => setTimeout(r, 600)) // gentle pacing between messages
  }
  log(`Posted ${buys.length} BUY hit${buys.length === 1 ? '' : 's'} to Discord.`)
}
