/**
 * Shared Card Ladder "Enter Graded Card Cert" flow, used by cl-add-cert.mjs
 * (single) and cc-arb-v2's add-pending.mjs (batch, one browser session).
 *
 *   selectCollection(page, "ARBALL")   — once per session
 *   await addOneCert(page, { cert, grader })  → 'added' | 'notfound' | 'error'
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Select the target collection (skips the switcher if it's already active). */
export async function selectCollection(page, collection) {
  const alreadyActive = await page.getByText(collection, { exact: true }).first().isVisible().catch(() => false)
  if (alreadyActive) return
  await page.locator('i.material-icons:has-text("expand_more")').first().click({ timeout: 8000 })
  await sleep(1200)
  await page.locator(`li:has(span:text-is("${collection}")):visible, li:has-text("${collection}"):visible`).first().click({ timeout: 6000 })
  await sleep(3000)
}

/**
 * Add one cert to the currently-selected collection.
 * @returns {Promise<'added'|'notfound'|'error'>}
 * @param {object} [opts] { shot?: (label)=>Promise, grader?: string }
 */
export async function addOneCert(page, { cert, grader = 'PSA' }, opts = {}) {
  const shot = opts.shot ?? (async () => {})
  const G = String(grader).toUpperCase()
  try {
    // Open the collection "+" (header one, y>90; not the global "Add Sale") and
    // find the "Enter Graded Card Cert" option.
    const certOption = page.getByText('Enter Graded Card Cert', { exact: true }).first()
    const closeModal = async () => {
      await page.locator('button.modal-close, button:has(i.material-icons:text-is("close"))').first().click({ timeout: 2000 }).catch(() => {})
      await sleep(400)
    }
    const addBtns = page.locator('button:has(i.material-icons:has-text("add_circle"))')
    const n = await addBtns.count()
    const order = []
    for (let i = 0; i < n; i++) { const b = await addBtns.nth(i).boundingBox().catch(() => null); order.push({ i, y: b?.y ?? 0 }) }
    order.sort((a, b) => (a.y > 90 ? 0 : 1) - (b.y > 90 ? 0 : 1))
    let opened = false
    for (const { i } of order) {
      await addBtns.nth(i).click({ timeout: 5000 }).catch(() => {})
      await sleep(1200)
      if (await certOption.count().catch(() => 0)) { opened = true; break }
      await closeModal()
    }
    if (!opened) return 'error'

    await certOption.click({ timeout: 6000 })
    await sleep(1500)
    await page.locator('input:visible').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})

    // Fill "Cert #" (not the top search box).
    let certInput = page.getByLabel(/cert\s*#?/i).first()
    if (!(await certInput.count().catch(() => 0))) certInput = page.locator('input:visible:not([placeholder*="Search" i])').first()
    await certInput.fill(String(cert), { timeout: 6000 })

    // Grader is a CUSTOM dropdown (div.input → ul.dropdown-menu of <li><span>). CL's
    // UI labels Beckett as "BECKETT" (not "BGS" like the CSV format). Open it and
    // click the matching option — but only if it isn't already the current value.
    const uiGrader = ({ PSA: 'PSA', BGS: 'BECKETT', BECKETT: 'BECKETT', CGC: 'CGC', SGC: 'SGC' })[G] || G
    const graderBox = page.locator('div.input:has(> label)').filter({ hasText: 'Grader' }).first()
    const current = (await graderBox.locator('.value').first().innerText().catch(() => '')).trim().toUpperCase()
    if (current !== uiGrader.toUpperCase()) {
      await graderBox.click({ timeout: 4000 }).catch(() => {})
      await sleep(500)
      await page.locator(`ul.dropdown-menu li span:text-is("${uiGrader}")`).first().click({ timeout: 4000 })
      await sleep(400)
    }
    await sleep(300)
    await page.locator('button:has-text("Submit"):visible').first().click({ timeout: 6000 })

    // Outcome: "No information" toast (notfound) OR the detail form → click "Add".
    const addBtn = page.getByRole('button', { name: 'Add', exact: true })
    const notFound = page.getByText(/No information on this Cert/i)
    let outcome = null
    for (let i = 0; i < 30 && !outcome; i++) {
      if (await notFound.count().catch(() => 0)) outcome = 'notfound'
      else if (await addBtn.isVisible().catch(() => false)) outcome = 'form'
      else await sleep(500)
    }
    await shot('after-submit')
    if (outcome === 'notfound') { await closeModal(); return 'notfound' }
    if (outcome !== 'form') { await closeModal(); return 'error' }

    await addBtn.click({ timeout: 6000 })
    await sleep(3000)
    await shot('added')
    await closeModal() // ensure the modal is closed before the next cert
    return 'added'
  } catch {
    return 'error'
  }
}

import { writeFileSync } from 'node:fs'

/**
 * Export the currently-active collection's CSV (gear → Export CSV) and save it.
 * Accepts the native confirm() dialog handler must be set by the caller
 * (page.on('dialog', d => d.accept())). Returns the saved path.
 */
export async function exportCollection(page, outPath) {
  const exportBtn = page.locator('button:has-text("Export CSV")').first()
  const gearBtn = page.locator('button:has(i.material-icons:has-text("settings"))').first()
  for (let a = 0; a < 4; a++) {
    if (await exportBtn.isVisible().catch(() => false)) break
    await gearBtn.click({ timeout: 8000 }).catch(() => {})
    await sleep(1500)
  }
  await exportBtn.waitFor({ state: 'visible', timeout: 8000 })

  let captured = null
  const onResp = async (resp) => {
    if (captured) return
    try {
      const ct = resp.headers()['content-type'] || ''
      const cd = resp.headers()['content-disposition'] || ''
      if (!/csv|octet-stream/i.test(ct) && !/attachment/i.test(cd) && !/export|\.csv/i.test(resp.url())) return
      const txt = (await resp.body()).toString('utf8')
      if (/Date Purchased|Graded Cert|Current Value/i.test(txt)) captured = txt
    } catch { /* attachment bodies may be unavailable */ }
  }
  page.on('response', onResp)

  const dlPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null)
  await exportBtn.click({ timeout: 6000 })
  const dl = await dlPromise
  if (dl) { await dl.saveAs(outPath) }
  else {
    for (let i = 0; i < 30 && !captured; i++) await sleep(1000)
    if (!captured) throw new Error('Export produced no download or CSV response.')
    writeFileSync(outPath, captured)
  }
  return outPath
}
