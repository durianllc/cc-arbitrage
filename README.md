# cc-arbitrage

Scrapes **cards** from the [Collector Crypt](https://collectorcrypt.com/marketplace/cards)
marketplace (Pokemon + One Piece by default), looks up each one's **Card Ladder**
value, and writes a CSV ranked by how far under market it's listed — so you can
spot arbitrage buys.

## How it works

1. **Scrape** — `collectorcrypt.mjs` pages the public `GET /marketplace` API
   ([docs](https://docs.collectorcrypt.com/marketplace/api)) with
   `cardType=Card` + `marketplaceStatus=Buy now`, so merch / sealed / raw /
   comics are excluded. No API key — browsing is open.
2. **Filter** — Card Ladder only grades **PSA / BGS / CGC / SGC**, so cards from
   other graders (or without a cert) are dropped.
3. **Look up Card Ladder** — `cardladder.mjs` drives `app.cardladder.com`'s
   "Search Sales by Cert #" using each card's `gradingID` (cert) + grader, and
   reads the CL Value. This is the same flow used by the BoosterBin POS, minus
   the Supabase plumbing. It needs a real logged-in browser session (Card Ladder
   sits behind Cloudflare and has no public API).
4. **Compare** — `pct_discrepancy = cc_price / card_ladder_value`. A card is
   flagged **BUY** when `cc_price <= threshold × CL value` (default 80%).

## Setup

```bash
cd ~/cc-arbitrage
npm install
npm run install-browsers   # downloads Chromium for Playwright (uses your real Chrome if present)
```

## Log in to Card Ladder (once)

Cloudflare blocks headless login, so you sign in by hand once; the session
cookie persists to `browser-state-context/` and is reused by every run.

```bash
npm run login              # opens a browser → sign in (handle 2FA) → close the window
```

Re-run this whenever a run reports "Not logged in to Card Ladder".

## Run

```bash
npm start                     # full run, headless → results.csv
node run.mjs --limit 25       # smoke-test on the 25 priciest cards
node run.mjs --threshold 0.75 # flag BUY at 25%+ under market
node run.mjs --headed         # watch the browser (debug)
node run.mjs --categories Pokemon
```

Results are **checkpointed to `cache.json`** after every lookup, so you can stop
and resume anytime — re-runs skip cards already priced and only retry failures.

## Output — `results.csv`

| column | meaning |
|--------|---------|
| `name` | Collector Crypt item name |
| `category` | Pokemon / One Piece |
| `grader`, `grade` | e.g. PSA, GEM-MT 10 |
| `cc_price` | Collector Crypt list price (USDC) |
| `card_ladder_value` | Card Ladder value (USD) |
| `pct_discrepancy` | `cc_price ÷ card_ladder_value` |
| `discount_pct` | how far under market (`1 − pct_discrepancy`), best first |
| `buy_flag` | `BUY` when at/under the threshold |
| `nft_address`, `cl_url` | deep links back to each source |

## Notes / caveats

- Card Ladder lookups are browser automation (~5–10s each) and depend on live
  DOM selectors (verified 2026-06). If Card Ladder restyles, update the locators
  in `cardladder.mjs`. `inspect.mjs` from the pokemon-pos worker is the tool for
  re-capturing them.
- The CL "value" is the cert-matched profile value, not a live sale — treat it
  as a market estimate, and sanity-check big discounts (grade mismatches,
  qualifiers, wrong cert) before buying.
