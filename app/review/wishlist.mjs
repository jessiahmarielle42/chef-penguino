#!/usr/bin/env node
// Verifies the Shop wishlist preview feature (see CLAUDE.md 8c FEATURES.wishlist)
// against the VITE_REVIEW build, per CLAUDE.md rule 4/4c: measure via real
// assertions + screenshots, not eyeballing. Runs BOTH Chromium and WebKit
// iPhone 13 emulation since the shop layout changed (see CLAUDE.md 4e).
//
// Usage: node review/wishlist.mjs [chromium|webkit|both]

import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const shotsDir = path.join(__dirname, 'shots-wishlist')
mkdirSync(shotsDir, { recursive: true })

const engineArg = process.argv[2] || 'both'
const BASE_PATH = '/chef-penguino/'
const PORT = 4174
const URL = `http://localhost:${PORT}${BASE_PATH}`

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: appDir, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
  })
}
function spawnServer(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: appDir, stdio: 'pipe', ...opts })
}
async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not come up in time`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
  console.log(`  OK: ${msg}`)
}

async function runEngine(engineName) {
  console.log(`\n=== ${engineName} ===`)
  const isWebkit = engineName === 'webkit'
  let browser
  if (isWebkit) {
    browser = await webkit.launch()
  } else {
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  }
  const ctxOpts = isWebkit ? { ...devices['iPhone 13'] } : { viewport: { width: 420, height: 900 } }
  const page = await browser.newPage(ctxOpts)
  const consoleErrors = []
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

  async function shot(name) {
    await page.screenshot({ path: path.join(shotsDir, `${engineName}-${name}.png`) })
    console.log(`  shot: ${engineName}-${name}.png`)
  }

  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 15000 })

  // ---- (a) flag off / non-preview user -> zero wishlist DOM ----
  console.log('(a) non-preview user: released, sees wishlist')
  await page.evaluate(() => window.__reviewSetFixtures({
    preset: 'fresh-signup',
    user: { email: 'not-preview@example.com' },
  }))
  await page.evaluate(() => window.__review('renderShop'))
  await page.waitForSelector('.anim-card', { timeout: 10000 })
  const noWishlistDom = await page.evaluate(() => ({
    stars: document.querySelectorAll('.wishlist-star').length,
    toggle: document.querySelectorAll('.wishlist-toggle').length,
  }))
  // RELEASED (FEATURES.wishlist === 'all'): an ordinary, non-preview account
  // now gets the wishlist too. Before the release flip these asserted the
  // opposite (zero wishlist DOM); rewritten at flip time, and their flipping
  // is itself the evidence the gate was what gated it. Revert if it ever
  // goes back to 'preview'.
  assert(noWishlistDom.stars > 0, `non-preview user sees wishlist stars post-release (found ${noWishlistDom.stars})`)
  assert(noWishlistDom.toggle > 0, `non-preview user sees the wishlist filter post-release (found ${noWishlistDom.toggle})`)
  await shot('a-flag-off')

  // ---- (b)-(e) preview user ----
  console.log('(b) preview user: star toggles + toast')
  await page.evaluate(() => window.__reviewSetFixtures({
    preset: 'fresh-signup',
    user: { email: 'keefefons@gmail.com' },
  }))
  await page.evaluate(() => window.__review('renderShop'))
  await page.waitForSelector('.anim-card', { timeout: 10000 })

  const starsPresent = await page.evaluate(() => document.querySelectorAll('.wishlist-star').length)
  assert(starsPresent > 0, `preview user sees .wishlist-star buttons (found ${starsPresent})`)

  // Pick the first unowned card's star and its emote id.
  const firstStarId = await page.evaluate(() => document.querySelector('.wishlist-star').dataset.wishlist)
  assert(!!firstStarId, `resolved a target emote id for the star (${firstStarId})`)

  const before = await page.evaluate((id) => {
    const el = document.querySelector(`[data-wishlist="${id}"]`)
    return { active: el.classList.contains('active'), glyph: el.textContent.trim(), pressed: el.getAttribute('aria-pressed') }
  }, firstStarId)
  assert(before.active === false && before.glyph === '☆' && before.pressed === 'false', `star starts blank/unfilled (${JSON.stringify(before)})`)

  await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).click(), firstStarId)
  await page.waitForTimeout(150)
  const afterOn = await page.evaluate((id) => {
    const el = document.querySelector(`[data-wishlist="${id}"]`)
    return { active: el.classList.contains('active'), glyph: el.textContent.trim(), pressed: el.getAttribute('aria-pressed') }
  }, firstStarId)
  assert(afterOn.active === true && afterOn.glyph === '★' && afterOn.pressed === 'true', `star fills after first tap (${JSON.stringify(afterOn)})`)
  const toastAdd = await page.evaluate(() => document.querySelector('.toast.show')?.textContent.trim())
  assert(toastAdd === 'Added to wishlist', `toast reads "Added to wishlist" (got "${toastAdd}")`)
  await shot('b-star-on-toast')

  // Persistence check: signed-in write landed on the fixture profile row.
  const profileWishlist = await page.evaluate(() => window.__reviewFixtures.profile.wishlist)
  assert(Array.isArray(profileWishlist) && profileWishlist.includes(firstStarId), `signed-in profile.wishlist persisted the id (${JSON.stringify(profileWishlist)})`)

  await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).click(), firstStarId)
  await page.waitForTimeout(150)
  const afterOff = await page.evaluate((id) => {
    const el = document.querySelector(`[data-wishlist="${id}"]`)
    return { active: el.classList.contains('active'), glyph: el.textContent.trim() }
  }, firstStarId)
  assert(afterOff.active === false && afterOff.glyph === '☆', `star empties after second tap (${JSON.stringify(afterOff)})`)
  const toastRemove = await page.evaluate(() => document.querySelector('.toast.show')?.textContent.trim())
  assert(toastRemove === 'Removed from wishlist', `toast reads "Removed from wishlist" (got "${toastRemove}")`)
  await shot('b-star-off-toast')

  // Re-star two emotes for the filter test.
  console.log('(c) filter shows only starred')
  const twoIds = await page.evaluate(() => Array.from(document.querySelectorAll('.wishlist-star')).slice(0, 2).map(el => el.dataset.wishlist))
  for (const id of twoIds) {
    await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).click(), id)
    await page.waitForTimeout(120)
  }
  const totalCardsBeforeFilter = await page.evaluate(() => document.querySelectorAll('.anim-card').length)
  await page.evaluate(() => document.querySelector('[data-action="wishlist-filter"]').click())
  await page.waitForTimeout(150)
  const filteredCount = await page.evaluate(() => document.querySelectorAll('.anim-card').length)
  const filteredIds = await page.evaluate(() => Array.from(document.querySelectorAll('.anim-top')).map(el => el.dataset.emote))
  assert(filteredCount === twoIds.length, `filtered grid shows exactly ${twoIds.length} card(s) (found ${filteredCount}, total was ${totalCardsBeforeFilter})`)
  assert(twoIds.every(id => filteredIds.includes(id)), `filtered grid contains only the starred ids (${JSON.stringify(filteredIds)} vs ${JSON.stringify(twoIds)})`)
  const toggleActive = await page.evaluate(() => document.querySelector('[data-action="wishlist-filter"]').classList.contains('active'))
  assert(toggleActive, 'wishlist-filter toggle shows active state')
  await shot('c-filtered')

  // ---- (d) empty state ----
  console.log('(d) empty state when filter active and wishlist empty')
  for (const id of twoIds) {
    // Filter is active, so after unstarring the last one the grid will be
    // empty and the star for an already-hidden card can't be clicked - undo
    // by turning the filter off first, unstar both, then reapply.
  }
  await page.evaluate(() => document.querySelector('[data-action="wishlist-filter"]').click()) // off
  await page.waitForTimeout(120)
  for (const id of twoIds) {
    await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).click(), id)
    await page.waitForTimeout(120)
  }
  await page.evaluate(() => document.querySelector('[data-action="wishlist-filter"]').click()) // on, now empty
  await page.waitForTimeout(150)
  const emptyText = await page.evaluate(() => document.querySelector('.shop-empty')?.textContent.trim())
  assert(emptyText === 'No wishlisted emotes yet — tap the ☆ on any emote to save it here.', `empty-state copy matches spec (got "${emptyText}")`)
  await shot('d-empty')

  // ---- (e) buy clears star ----
  console.log('(e) buying a wishlisted emote silently clears the star')
  await page.evaluate(() => document.querySelector('[data-action="wishlist-filter"]').click()) // off, back to full grid
  await page.waitForTimeout(150)
  const buyTargetId = await page.evaluate(() => document.querySelector('[data-buy]')?.dataset.buy)
  assert(!!buyTargetId, `found a buyable card to test (${buyTargetId})`)
  await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).click(), buyTargetId)
  await page.waitForTimeout(120)
  const starredBeforeBuy = await page.evaluate((id) => document.querySelector(`[data-wishlist="${id}"]`).classList.contains('active'), buyTargetId)
  assert(starredBeforeBuy, 'target emote is wishlisted before purchase')
  // Give this profile a coin to spend (mirrors buyEmote's coinBalance()
  // gate - fresh-signup preset has 0 pizzas/0 coins otherwise).
  await page.evaluate(() => window.__reviewSetFixtures({ profile: { coin_adjustment: 5 } }))
  await page.evaluate(() => window.__review('renderShop'))
  await page.waitForTimeout(150)
  await page.evaluate((id) => document.querySelector(`[data-buy="${id}"]`).click(), buyTargetId)
  await page.waitForTimeout(150)
  await page.evaluate(() => document.querySelector('[data-action="yes"]')?.click())
  await page.waitForTimeout(200)
  const wishlistAfterBuy = await page.evaluate(() => window.__reviewFixtures.profile.wishlist)
  assert(!wishlistAfterBuy.includes(buyTargetId), `wishlist no longer contains the purchased id (${JSON.stringify(wishlistAfterBuy)})`)
  // NOTE (pre-existing, unrelated to this feature): confirmBuy() fires
  // toast() right after calling the async, re-mounting renderShop() without
  // awaiting it, so in this harness the "Unlocked!" toast node can land in
  // a screen generation that gets replaced a tick later before it's ever
  // observed. Not asserting its text here since that race predates and is
  // outside this change - only the spec-relevant part: no EXTRA
  // "Removed from wishlist" toast fired for the silent auto-clear.
  const toastAfterBuy = await page.evaluate(() => document.querySelector('.toast.show')?.textContent.trim())
  assert(toastAfterBuy !== 'Removed from wishlist', `no "Removed from wishlist" toast on auto-clear-by-purchase (got "${toastAfterBuy}")`)
  await shot('e-after-buy')

  console.log(`  console errors: ${consoleErrors.length ? JSON.stringify(consoleErrors) : 'none'}`)
  assert(consoleErrors.length === 0, 'no console/page errors during the run')

  await browser.close()
}

async function main() {
  console.log('Building with VITE_REVIEW=1 ...')
  await run('npx', ['vite', 'build'], { env: { ...process.env, VITE_REVIEW: '1' } })

  console.log(`Starting preview server on :${PORT} ...`)
  const server = spawnServer('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'])
  server.stdout?.on('data', () => {})
  server.stderr?.on('data', (d) => process.stderr.write(`[preview] ${d}`))

  try {
    await waitForServer(URL)
    const engines = engineArg === 'both' ? ['chromium', 'webkit'] : [engineArg]
    for (const eng of engines) {
      await runEngine(eng)
    }
    console.log('\nALL ASSERTIONS PASSED')
  } finally {
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
