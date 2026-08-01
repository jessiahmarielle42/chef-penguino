#!/usr/bin/env node
// Drives the FULL onboarding tour headlessly against the VITE_REVIEW build
// and screenshots every step. See CLAUDE.md rule 4 / app/review/reviewHarness.js.
//
// Usage: node review/tour.mjs [preset]
//   preset defaults to signed-in-ineligible-many-sessions - the important
//   case: a real, long-tenured chef whose day sheet has many rows and who
//   is NOT eligible for the onboarding coin, but still has onboarding_done
//   false so the tour is reachable via Settings -> Replay Tutorial.
//
// IMPORTANT: steps are advanced by calling `.click()` on the real DOM node
// inside `page.evaluate()`, NOT Playwright's own `.click({ force: true })`.
// Force-clicks bypass the tour's opaque blocker layer entirely and produce
// false "it works" results - this was learned the hard way. Every click in
// this script goes through document.querySelector(sel).click() instead, so
// only truly-reachable targets ever count as advancing the tour.

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, '..')
const shotsDir = path.join(__dirname, 'shots')
mkdirSync(shotsDir, { recursive: true })

const preset = process.argv[2] || 'signed-in-ineligible-many-sessions'
const BASE_PATH = '/chef-penguino/'
const PORT = 4173
const URL = `http://localhost:${PORT}${BASE_PATH}`

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: appDir, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))))
  })
}

function spawnServer(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: appDir, stdio: 'pipe', ...opts })
  return p
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

async function main() {
  console.log(`Building with VITE_REVIEW=1 ...`)
  await run('npx', ['vite', 'build'], { env: { ...process.env, VITE_REVIEW: '1' } })

  console.log(`Starting preview server on :${PORT} ...`)
  const server = spawnServer('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'])
  server.stdout?.on('data', (d) => process.stdout.write(`[preview] ${d}`))
  server.stderr?.on('data', (d) => process.stderr.write(`[preview] ${d}`))

  try {
    await waitForServer(URL)

    const browser = await chromium.launch({
      executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    })
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(String(err)))
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 15000 })

    console.log(`Applying fixture preset: ${preset}`)
    await page.evaluate((p) => window.__reviewSetFixtures({ preset: p }), preset)

    // Mount Settings and click into the real "Replay Tutorial" row to start
    // the tour via its real entry point (renderSettings is a registered
    // renderer; startOnboardingTour() itself is not exposed on window).
    await page.evaluate(() => window.__review('renderSettings'))
    await page.waitForSelector('[data-action="replay-tutorial"]', { timeout: 10000 })
    await shot(page, '00-settings')
    await page.evaluate(() => {
      document.querySelector('[data-action="replay-tutorial"]').click()
    })

    const log = []
    let step = 0
    const maxSteps = 40
    let lastCardText = null
    let stalledCount = 0

    while (step < maxSteps) {
      await page.waitForTimeout(350)
      const info = await page.evaluate(() => {
        const card = document.getElementById('tour-card')
        const ring = document.getElementById('tour-ring')
        const cardVisible = card && !card.hidden
        const cardText = cardVisible ? card.textContent.trim() : null
        let ringRect = null
        if (ring && !ring.hidden) {
          const r = ring.getBoundingClientRect()
          ringRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const blockerCount = document.querySelectorAll('.tour-blocker, [class*="tour-block"]').length
        // Silent steps (guest-coin-prompt, coin-explainer) deliberately show
        // NO tour card or ring - they hand off to a real app overlay and let
        // that do the talking. Treat a visible overlay as the tour still
        // being alive, or every silent step reads as a false strand.
        const overlayVisible = !!document.querySelector('.overlay.show')
        const tourActive = cardVisible || (ring && !ring.hidden) || overlayVisible
        return { cardText, ringRect, blockerCount, tourActive }
      })

      if (!info.tourActive) {
        // The tour legitimately hides itself for a few seconds at times -
        // pause-timer arms for ~2s so its spotlight doesn't fight the
        // "Start Cooking!" splash, and any step whose screen is mid-render
        // is briefly not-ready. Only call it stranded after it stays
        // invisible for a sustained window, and confirm #tour-root is gone
        // before declaring the tour actually ended.
        let reappeared = false
        for (let i = 0; i < 24; i++) {
          await page.waitForTimeout(500)
          const again = await page.evaluate(() => {
            const card = document.getElementById('tour-card')
            const ring = document.getElementById('tour-ring')
            return {
              active: (card && !card.hidden) || (ring && !ring.hidden),
              rootPresent: !!document.getElementById('tour-root'),
            }
          })
          if (again.active) { reappeared = true; break }
          if (!again.rootPresent) {
            log.push({ step, note: 'tour ENDED (#tour-root removed)' })
            console.log(JSON.stringify(log[log.length - 1]))
            break
          }
        }
        if (!reappeared) {
          const ended = await page.evaluate(() => !document.getElementById('tour-root'))
          log.push({ step, note: ended ? 'tour ENDED (#tour-root removed)' : 'tour STRANDED (root alive, nothing visible for 12s)' })
          console.log(JSON.stringify(log[log.length - 1]))
          await shot(page, `${String(step).padStart(2, '0')}-stranded-or-ended`)
          break
        }
        continue
      }

      log.push({ step, cardText: info.cardText, ringRect: info.ringRect, blockerCount: info.blockerCount })
      console.log(JSON.stringify(log[log.length - 1]))
      await shot(page, `${String(step).padStart(2, '0')}-${slug(info.cardText)}`)

      if (info.cardText === lastCardText) {
        stalledCount += 1
      } else {
        stalledCount = 0
      }
      lastCardText = info.cardText

      if (stalledCount >= 6) {
        log.push({ step, note: `STALLED on same card text for ${stalledCount} polls - reporting as stranded` })
        console.log(JSON.stringify(log[log.length - 1]))
        break
      }

      // Swipe steps need a real pointer drag, not a click - the row reveals
      // its Edit/Delete actions via pointerdown/move/up and only advances
      // once it actually lands in the open state.
      if (/swipe/i.test(info.cardText || '') && info.ringRect) {
        const { x, y, w, h } = info.ringRect
        const cy = y + h / 2
        const startX = x + w - 30
        await page.mouse.move(startX, cy)
        await page.mouse.down()
        for (let i = 1; i <= 10; i++) {
          await page.mouse.move(startX - i * 14, cy)
          await page.waitForTimeout(20)
        }
        await page.mouse.up()
        await page.waitForTimeout(600)
        step += 1
        continue
      }

      // Silent step handing off to a real overlay (guest sign-in offer):
      // dismiss it the way a chef would, via its real secondary button.
      const overlayHandled = await page.evaluate(() => {
        const o = document.querySelector('.overlay.show')
        if (!o) return false
        const card = document.getElementById('tour-card')
        if (card && !card.hidden) return false
        const btn = o.querySelector('[data-action="continue-guest"], [data-action="ok"]')
        if (!btn) return false
        btn.click()
        return true
      })
      if (overlayHandled) { step += 1; await page.waitForTimeout(900); continue }

      // Delete step: the revealed action buttons sit BEHIND the row in the
      // stacking order, so elementFromPoint at the ring centre returns the
      // row itself - clicking that closes the swipe instead of deleting.
      // Target the revealed button directly.
      if (/\bDelete\b/.test(info.cardText || '') && !/Yes, delete/i.test(info.cardText || '')) {
        const hitDelete = await page.evaluate(() => {
          const openRow = document.querySelector('.cal-sheet-list .log-row.open')
          if (!openRow) return false
          const btn = openRow.closest('.log-row-wrap')?.querySelector('[data-action="delete-log"]')
          if (!btn) return false
          btn.click()
          return true
        })
        if (hitDelete) { step += 1; await page.waitForTimeout(600); continue }
      }

      // Click the real spotlighted target, exactly the way a chef would tap
      // it - via document.querySelector(...).click() inside page.evaluate,
      // never Playwright's own force-click (see file header comment).
      const clicked = await page.evaluate(() => {
        const ring = document.getElementById('tour-ring')
        if (ring && !ring.hidden) {
          // Action step with a real spotlighted target: walk the ring's
          // position back to the element under its center point and click
          // THAT real element (the actual control, not the tour chrome).
          const r = ring.getBoundingClientRect()
          const cx = r.x + r.width / 2
          const cy = r.y + r.height / 2
          const el = document.elementFromPoint(cx, cy)
          if (!el) return false
          // The tour's own target is authoritative. elementFromPoint can
          // return a sibling stacked above it (e.g. the swipe row sits at
          // z-index 1 over its own action buttons), so prefer an actionable
          // descendant/ancestor at that point when one exists.
          const actionable = el.closest('[data-action], button, [role="button"]')
          if (actionable) { actionable.click(); return true }
          // A text input advances its step on real typing, not on a click -
          // clicking it "succeeds" but never advances, which stalls the run.
          const input = el.matches('input, textarea') ? el : el.querySelector?.('input, textarea')
          if (input) {
            input.focus()
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(input, 'Focus session')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          }
          el.click()
          return true
        }
        // Explain step (no target, centered card, full-viewport dim) -
        // tourExplainClickHandler is bound to document and advances on any
        // tap that reaches it, so clicking the full-screen dim itself
        // reproduces "tap anywhere to continue" via a real click.
        const dim = document.querySelector('.tour-block-t:not([hidden])')
        if (dim) { dim.click(); return true }
        return false
      })

      if (!clicked) {
        // Some steps (task-name typing, timer auto-advance) aren't a simple
        // click - give them a moment and continue polling rather than
        // treating "nothing clickable at ring center" as fatal.
        // Task-name step: type into the visible input via real events.
        await page.evaluate(() => {
          const el = document.querySelector('.task-input')
          if (el) {
            el.focus()
            el.value = 'Focus session'
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
        })
      }

      step += 1
    }

    console.log('\n--- Post-tour state (what happens after delete step) ---')
    const postState = await page.evaluate(() => {
      const card = document.getElementById('tour-card')
      return {
        url: location.href,
        bodyClasses: document.body.className,
        activeScreen: document.querySelector('.app')?.dataset?.screen || null,
        cardHidden: card ? card.hidden : null,
        visibleOverlay: !!document.querySelector('.overlay.show'),
      }
    })
    console.log(JSON.stringify(postState, null, 2))
    await shot(page, 'zz-post-tour')

    if (consoleErrors.length) {
      console.log('\n--- Console/page errors observed ---')
      for (const e of consoleErrors) console.log(e)
    }

    console.log('\n--- Full step log ---')
    console.log(JSON.stringify(log, null, 2))

    await browser.close()
  } finally {
    server.kill()
  }
}

async function shot(page, name) {
  const file = path.join(shotsDir, `${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
}

function slug(text) {
  if (!text) return 'no-card'
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'card'
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
