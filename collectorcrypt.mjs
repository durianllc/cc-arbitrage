/**
 * Collector Crypt marketplace scraper.
 *
 * Pages the public GET /marketplace endpoint (no API key — only on-chain
 * actions need a wallet signature; browsing is open) and returns every
 * currently-listed *card* in the requested categories.
 *
 * We filter to `cardType=Card` so merch / sealed / raw / comics are excluded
 * server-side. `marketplaceStatus=Buy now` keeps only actively-listed cards.
 *
 * API docs: https://docs.collectorcrypt.com/marketplace/api
 */

const BASE = process.env.CC_API_BASE ?? 'https://api.collectorcrypt.com'

// Max page size the API accepts.
const STEP = 100

/**
 * Scrape all listed cards in the given categories.
 * @param {string[]} categories e.g. ['Pokemon', 'One Piece']
 * @param {(msg: string) => void} [log]
 * @returns {Promise<Array<{
 *   nftAddress: string, itemName: string, price: number, currency: string,
 *   gradingID: string|null, gradingCompany: string|null, grade: string|null,
 *   gradeNum: number|null, category: string, year: number|null
 * }>>}
 */
export async function scrapeCards(categories, log = () => {}) {
  const params = new URLSearchParams({
    categories: categories.join(','),
    cardType: 'Card',
    marketplaceStatus: 'Buy now',
    orderBy: 'priceDesc',
    step: String(STEP),
  })

  const out = []
  let page = 1
  let totalPages = 1

  do {
    params.set('page', String(page))
    const url = `${BASE}/marketplace?${params}`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new Error(`Collector Crypt API ${res.status} ${res.statusText} on page ${page}: ${await res.text().catch(() => '')}`)
    }
    const body = await res.json()

    // findTotal = rows matching the filter; totalPages is for the filtered set.
    totalPages = body.totalPages ?? 1
    const rows = body.filterNFtCard ?? []
    for (const c of rows) {
      // A card is only buyable if it has a listing with a price.
      const price = c.listing?.price
      if (price == null) continue
      out.push({
        nftAddress: c.nftAddress,
        itemName: c.itemName,
        price: Number(price),
        currency: c.listing?.currency ?? 'USDC',
        marketplace: c.listing?.marketplace ?? null, // 'CC' (native USD) or 'ME' (Magic Eden)
        gradingID: c.gradingID ?? null,
        gradingCompany: c.gradingCompany ?? null,
        grade: c.grade ?? null,
        gradeNum: c.gradeNum ?? null,
        category: c.category,
        year: c.year ?? null,
      })
    }
    log(`  page ${page}/${totalPages} — ${rows.length} rows (running total ${out.length})`)
    page++
  } while (page <= totalPages)

  return out
}
