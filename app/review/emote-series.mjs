#!/usr/bin/env node
// Verifies the Emote Series preview feature (FEATURES.emoteSeries) against
// the VITE_REVIEW build + review harness. See CLAUDE.md rule 4/4c.
//
// Usage: node review/emote-series.mjs [chromium|webkit]

import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const shotsDir = path.join(__dirname, 'shots')
mkdirSync(shotsDir, { recursive: true })

const engine = process.argv[2] === 'webkit' ? 'webkit' : 'chromium'
const BASE_PATH = '/chef-penguino/'
const PORT = 4183
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
    try { const res = await fetch(url); if (res.ok || res.status === 404) return } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not come up in time`)
}

let failures = 0
function assert(cond, msg) {
  if (cond) { console.log(`  OK  ${msg}`) }
  else { console.log(`  FAIL ${msg}`); failures++ }
}

async function main() {
  console.log('Building VITE_REVIEW bundle...')
  await run('npx', ['vite', 'build'], { env: { ...process.env, VITE_REVIEW: '1' } })

  console.log('Starting preview server...')
  const server = spawnServer('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'])
  await waitForServer(URL)

  const browserType = engine === 'webkit' ? webkit : chromium
  const launchOpts = engine === 'chromium' ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {}
  const browser = await browserType.launch(launchOpts)
  const context = engine === 'webkit'
    ? await browser.newContext(devices['iPhone 13'])
    : await browser.newContext({ viewport: { width: 414, height: 896 } })
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text()) })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

  await page.goto(URL)
  await page.waitForFunction(() => typeof window.__review === 'function')

  // ---------------------------------------------------------------
  // (a) FLAG OFF: a non-preview signed-in user (owner-many-sessions preset
  // uses keefe@example.com, not a real PREVIEW_EMAILS entry) sees zero
  // series DOM and the plain Equip button.
  // ---------------------------------------------------------------
  console.log('\n[a] flag off (non-preview signed-in user)')
  await page.evaluate(() => window.__reviewSetFixtures({ preset: 'owner-many-sessions' }))
  await page.evaluate(() => window.__review('renderShop'))
  await page.waitForSelector('.anim-card')
  // RELEASED (FEATURES.emoteSeries === 'all'): the series UI now renders for
  // an ordinary account too, so these assert the released shape. Their
  // flipping at release time is the evidence the gate was doing the gating.
  // The equipped badge is now "✓ In series" - matched via data-emote-badge,
  // the mode-agnostic hook, NOT data-equip: keying the onboarding tour off
  // data-equip is exactly what stranded it once this feature shipped.
  let hasTray = await page.$('.series-tray')
  assert(!!hasTray, '.series-tray renders post-release')
  let equipBtn = await page.$('[data-emote-badge="waving"].equipped')
  assert(!!equipBtn, 'equipped badge for waving is findable via data-emote-badge (tour depends on this)')
  await page.screenshot({ path: path.join(shotsDir, `series-${engine}-a-flag-off.png`) })

  // ---------------------------------------------------------------
  // (b) PREVIEW USER: add/remove/reorder-by-readd, MAIN tag, min-1 block,
  // dup block, 5-cap toast.
  // ---------------------------------------------------------------
  console.log('\n[b] preview user (keefefons@gmail.com) - tray flows')
  await page.evaluate(() => {
    window.__reviewSetFixtures({
      preset: 'owner-many-sessions',
      profile: { owned_emotes: ['waving', 'inspection', 'spin-wheel', 'eating', 'lovey-talk', 'show-off'], equipped_emote: 'waving', emote_series: null },
    })
    // owner-many-sessions preset's fixture user email isn't a preview email;
    // override it directly so featureOn() sees a PREVIEW_EMAILS match.
    window.__reviewFixtures.user = { id: 'user-1', email: 'keefefons@gmail.com' }
  })
  // Re-apply user via setUser so currentUser.email actually changes (the
  // fixture object above only updates the harness's own mirror).
  await page.evaluate(() => {
    // installReviewHarness's setUser hook is main.js's own; re-trigger it by
    // re-running __reviewSetFixtures profile write path, which calls
    // installedSetUser(window.__reviewFixtures.user, ...).
    window.__reviewSetFixtures({ profile: { equipped_emote: 'waving' } })
  })
  await page.evaluate(async () => { await window.__review('renderShop') })
  await page.waitForSelector('.series-tray')
  hasTray = await page.$('.series-tray')
  assert(!!hasTray, '.series-tray renders for preview user')

  // Starting state: no series set -> falls back to [equipped] = ['waving'].
  let slot1 = await page.$eval('.series-slot:nth-child(1)', el => el.className)
  assert(slot1.includes('filled'), 'slot 1 filled by fallback (equipped emote) with no series set')
  let mainTag = await page.$('.series-slot:nth-child(1) .series-slot-main')
  assert(!!mainTag, 'slot 1 shows the MAIN tag')
  let slot2Empty = await page.$eval('.series-slot:nth-child(2)', el => el.className.includes('empty'))
  assert(slot2Empty, 'slot 2 starts empty')

  // Add inspection -> goes to slot 2.
  await page.evaluate(() => document.querySelector('[data-series-add="inspection"]').click())
  await page.waitForSelector('.series-slot:nth-child(2).filled')
  let slot2Id = await page.$eval('.series-slot:nth-child(2)', el => el.getAttribute('data-series-remove'))
  assert(slot2Id === 'inspection', 'inspection lands in slot 2 after add')
  let inspectionBadge = await page.$eval('[data-emote="inspection"] .badge', el => el.textContent.trim())
  assert(inspectionBadge === '✓ In series', 'inspection card badge reads "✓ In series" after add')

  // Duplicate add blocked.
  const toastAfterDup = await page.evaluate(async () => {
    document.querySelector('[data-series-add="inspection"]')
    // inspection now shows the disabled "In series" badge, not [data-series-add] -
    // call addToSeries directly isn't exposed, so re-derive via re-render:
    // clicking the disabled badge does nothing (no data-series-add attr left).
    return document.querySelector('[data-emote="inspection"] [data-series-add]') === null
  })
  assert(toastAfterDup, 'dup emote no longer exposes a [data-series-add] control once already in series (hard dup-block)')

  // Fill remaining slots (3,4,5) then hit the 5-cap toast on a 6th.
  await page.evaluate(() => document.querySelector('[data-series-add="spin-wheel"]').click())
  await page.waitForSelector('.series-slot:nth-child(3).filled')
  await page.evaluate(() => document.querySelector('[data-series-add="eating"]').click())
  await page.waitForSelector('.series-slot:nth-child(4).filled')
  await page.evaluate(() => document.querySelector('[data-series-add="lovey-talk"]').click())
  await page.waitForSelector('.series-slot:nth-child(5).filled')
  let allFilled = await page.$$eval('.series-slot.filled', els => els.length)
  assert(allFilled === 5, 'all 5 slots filled')

  await page.evaluate(() => document.querySelector('[data-series-add="show-off"]').click())
  await page.waitForSelector('.toast.show', { timeout: 3000 }).catch(() => {})
  let toastText = await page.$eval('.toast', el => el.textContent.trim()).catch(() => '')
  assert(toastText.includes('Series full'), `5-cap toast shown, got: "${toastText}"`)
  let stillFive = await page.$$eval('.series-slot.filled', els => els.length)
  assert(stillFive === 5, 'still exactly 5 slots after the blocked 6th add')

  await page.screenshot({ path: path.join(shotsDir, `series-${engine}-b-tray-full.png`) })

  // Remove slot 2 (inspection) -> later slots shift up ("reorder by re-add").
  await page.evaluate(() => document.querySelector('[data-series-remove="inspection"]').click())
  await page.waitForTimeout(150)
  let slot2After = await page.$eval('.series-slot:nth-child(2)', el => el.getAttribute('data-series-remove'))
  assert(slot2After === 'spin-wheel', 'removing slot 2 shifts spin-wheel up into slot 2')
  let slot5After = await page.$eval('.series-slot:nth-child(5)', el => el.className.includes('empty'))
  assert(slot5After, 'slot 5 is now empty after the shift-up')

  // Re-add inspection -> goes to the back (slot 5), proving order = add order.
  await page.evaluate(() => document.querySelector('[data-series-add="inspection"]').click())
  await page.waitForTimeout(150)
  let slot5Id = await page.$eval('.series-slot:nth-child(5)', el => el.getAttribute('data-series-remove'))
  assert(slot5Id === 'inspection', 're-added inspection lands at the back (slot 5), not its old spot')

  // Equipped field mirrors series[0] check (see [c] below covers this
  // numerically via the fixture profile).
  let profileNow = await page.evaluate(() => window.__reviewFixtures.profile)
  assert(profileNow.equipped_emote === profileNow.emote_series[0], 'equipped_emote === emote_series[0] after tray mutations')

  // Min-1 block: remove down to 1, then try removing the last one.
  await page.evaluate(() => document.querySelector('[data-series-remove="spin-wheel"]').click())
  await page.waitForTimeout(100)
  await page.evaluate(() => document.querySelector('[data-series-remove="eating"]').click())
  await page.waitForTimeout(100)
  await page.evaluate(() => document.querySelector('[data-series-remove="lovey-talk"]').click())
  await page.waitForTimeout(100)
  await page.evaluate(() => document.querySelector('[data-series-remove="inspection"]').click())
  await page.waitForTimeout(100)
  let downToOne = await page.$$eval('.series-slot.filled', els => els.length)
  assert(downToOne === 1, 'down to exactly 1 slot after removing 4')
  const lastId = await page.$eval('.series-slot:nth-child(1)', el => el.getAttribute('data-series-remove'))
  await page.evaluate((id) => document.querySelector(`[data-series-remove="${id}"]`).click(), lastId)
  await page.waitForSelector('.toast.show', { timeout: 3000 }).catch(() => {})
  let stillOne = await page.$$eval('.series-slot.filled', els => els.length)
  assert(stillOne === 1, 'still 1 slot after attempting to remove the last one (blocked)')
  let minToast = await page.$eval('.toast', el => el.textContent.trim())
  assert(minToast.includes('Keep at least 1'), `min-1 toast shown, got: "${minToast}"`)

  await page.screenshot({ path: path.join(shotsDir, `series-${engine}-b-tray-min1.png`) })

  // ---------------------------------------------------------------
  // (d) HERO TAP-CYCLE: order + loop + reset-on-remount. Headless Chromium
  // in this sandbox has no H.264 decoder (play() rejects with
  // NotSupportedError - see CLAUDE.md rule 4d, video playback is one of
  // the things this harness fundamentally cannot verify), so real clip
  // playback can't be observed. What CAN be measured numerically is the
  // SELECTION logic itself - which id attachEmoteTap() decided to play,
  // exposed via window.__emoteDebug.lastHeroTapId (set right before the
  // playEmoteInto() call, main.js's own always-on debug hook object).
  // ---------------------------------------------------------------
  console.log('\n[d] hero tap-cycle order/loop/reset (selection logic - see comment re: no H.264 in this sandbox)')
  await page.evaluate(() => {
    window.__reviewSetFixtures({
      profile: { owned_emotes: ['waving', 'inspection', 'spin-wheel'], equipped_emote: 'waving', emote_series: ['waving', 'inspection', 'spin-wheel'] },
    })
  })
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('#hero-card')
  // Tapping while a clip is still mid-play is a deliberate no-op (the
  // handler only swaps when the still is currently an <img>, never a live
  // <video> - see attachEmoteTap()). Arrival autoplay plays slot 1 first;
  // since play() always rejects here (no H.264), it reverts back to <img>
  // near-instantly, but wait for it explicitly rather than racing it.
  const waitForStillImg = () => page.waitForFunction(() => {
    const el = document.querySelector('#hero-card .hero-still')
    return !!el && el.tagName === 'IMG'
  }, { timeout: 15000 })
  const tapHero = async () => {
    await waitForStillImg()
    await page.evaluate(() => document.querySelector('#hero-card').click())
    return page.evaluate(() => window.__emoteDebug.lastHeroTapId)
  }
  const playedOrder = []
  playedOrder.push(await tapHero())
  playedOrder.push(await tapHero())
  playedOrder.push(await tapHero()) // should loop back to slot 1
  assert(playedOrder.join(',') === 'inspection,spin-wheel,waving', `tap-cycle order+loop correct, got: ${playedOrder.join(',')}`)

  // Reset-on-remount: leave and come back, next tap must start at slot 1's
  // NEXT (inspection) again, not continue from where it left off.
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('#hero-card')
  const firstAfterRemount = await tapHero()
  assert(firstAfterRemount === 'inspection', `cycle index reset on remount - first tap after remount plays slot 2 again, got: ${firstAfterRemount}`)

  await page.screenshot({ path: path.join(shotsDir, `series-${engine}-d-hero.png`) })

  // ---------------------------------------------------------------
  // (e) VISITOR VIEW cycles the visited profile's series.
  // ---------------------------------------------------------------
  console.log('\n[e] visitor view cycles the visited profile\'s series')
  await page.evaluate(() => window.__review('renderFriendPizzeria'))
  // renderFriendPizzeria's fixture friend (Wolfeschlegel) only has
  // equipped_emote:'waving' and no emote_series, so it must fall back to a
  // 1-item series and just replay waving on every tap - verifies the
  // fallback path on a genuinely foreign profileRow (not currentProfile).
  await page.waitForSelector('#hero-card')
  const visitorTap1 = await tapHero()
  const visitorTap2 = await tapHero()
  assert(visitorTap1 === 'waving' && visitorTap2 === 'waving', `visitor with no series falls back to replaying their equipped emote, got: ${visitorTap1},${visitorTap2}`)
  await page.screenshot({ path: path.join(shotsDir, `series-${engine}-e-visitor.png`) })

  await browser.close()
  server.kill()

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
