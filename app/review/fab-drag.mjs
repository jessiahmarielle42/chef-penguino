// Draggable snap-to-corner bug FAB (featureOn('draggableFab')).
// Drives REAL pointer events (mouse.move/down/up), not synthetic .click(),
// because the whole feature lives in pointerdown/move/up and a synthetic
// click would bypass the drag machinery entirely and pass vacuously.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4183
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const wait = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(URL)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) } throw new Error('server never came up') }

const results = []
const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`)

async function boot(page, email) {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 20000 })
  await page.evaluate((e) => window.__reviewSetFixtures({ preset: 'owner-many-sessions', user: { email: e } }), email)
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('#bug-fab')
}

const box = (page) => page.evaluate(() => {
  const el = document.getElementById('bug-fab')
  const r = el.getBoundingClientRect()
  return { l: Math.round(r.left), t: Math.round(r.top), cx: r.left + r.width / 2, cy: r.top + r.height / 2, cls: el.className, vw: innerWidth, vh: innerHeight }
})

// A real press-move-release. steps>1 so pointermove actually fires.
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(450)   // let the 250ms snap finish
}

async function run(browserType, name) {
  const browser = await browserType.launch(name === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {})
  const ctx = await browser.newContext(name === 'webkit'
    ? { ...devices['iPhone 13'] } : { viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()

  // ---- flag OFF: nothing changes at all ----
  await boot(page, 'ordinary-user@example.com')
  const off = await box(page)
  check(`${name} flag off: no corner classes`, !/fab-(bl|br|tl|tr)/.test(off.cls), off.cls || '(none)')
  check(`${name} flag off: still bottom-RIGHT`, off.cx > off.vw / 2, `cx=${Math.round(off.cx)} of ${off.vw}`)

  // ---- flag ON ----
  await boot(page, 'keefefons@gmail.com')
  const start = await box(page)
  const tabbarTop = await page.evaluate(() => document.querySelector('.tabbar').getBoundingClientRect().top)
  check(`${name} default corner is bottom-LEFT`, start.cls.includes('fab-bl') && start.cx < start.vw / 2, `cx=${Math.round(start.cx)}`)
  check(`${name} default sits ABOVE the tab bar`, start.t + 41 <= Math.round(tabbarTop) + 1, `fabBottom≈${start.t + 41} tabbarTop=${Math.round(tabbarTop)}`)

  // ---- a DRAG moves + snaps, and must NOT open the bug report ----
  await drag(page, { x: start.cx, y: start.cy }, { x: start.vw - 40, y: 120 })
  const afterDrag = await box(page)
  const opened = await page.evaluate(() => !!document.querySelector('.bug-report-overlay'))
  check(`${name} drag snaps to nearest corner (top-right)`, afterDrag.cls.includes('fab-tr'), afterDrag.cls)
  check(`${name} drag did NOT open the bug report`, !opened)
  check(`${name} snapped flush to that corner`, afterDrag.cx > afterDrag.vw / 2 && afterDrag.cy < afterDrag.vh / 2,
    `c=(${Math.round(afterDrag.cx)},${Math.round(afterDrag.cy)})`)
  check(`${name} no leftover inline transform after snap`,
    await page.evaluate(() => !document.getElementById('bug-fab').style.transform))

  // ---- a TAP (under the 8px threshold) still performs the action ----
  const now = await box(page)
  await page.mouse.move(now.cx, now.cy)
  await page.mouse.down()
  await page.mouse.move(now.cx + 3, now.cy + 2, { steps: 2 })   // 3.6px < 8px
  await page.mouse.up()
  await page.waitForTimeout(600)
  check(`${name} plain tap still opens the bug report`,
    await page.evaluate(() => !!document.querySelector('.bug-report-overlay')))

  // ---- no persistence: navigating resets to the default corner ----
  await page.evaluate(() => document.querySelector('.bug-report-overlay .popup-close, .bug-report-overlay [data-action="close"]')?.click())
  await page.evaluate(() => window.__review('renderShop'))
  await page.waitForTimeout(200)
  const afterNav = await box(page)
  check(`${name} resets to bottom-left on navigation`, afterNav.cls.includes('fab-bl'), afterNav.cls)

  await page.screenshot({ path: `/tmp/claude-0/-home-user-chef-penguino/cb91145d-799f-5264-8422-ab1f01853fb6/scratchpad/fab-${name}.png` })
  await browser.close()
}

try {
  await wait()
  await run(chromium, 'chromium')
  await run(webkit, 'webkit')
} finally { server.kill() }
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
