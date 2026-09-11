// Auto-darken must leave the TIMER readable (featureOn('timerNoDim')).
//
// Property checks alone are too weak here: the timer was dimmed by TWO
// mechanisms (a brightness() filter AND the .darken-overlay scrim painted on
// top), so asserting "filter is none" would pass while the scrim still tinted
// it. This samples REAL RENDERED PIXELS from screenshots and compares the
// timer's mean brightness darkened vs bright - the only measurement that
// actually answers "is it dimmed".
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import { PNG } from 'pngjs'

const PORT = 4191
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const wait = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(URL)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) } throw new Error('server never came up') }

const results = []
const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`)

// Mean luminance of a screenshot buffer.
function meanLuma(buf) {
  const png = PNG.sync.read(buf)
  let sum = 0, n = 0
  for (let i = 0; i < png.data.length; i += 4) {
    sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]
    n++
  }
  return sum / n
}

async function shotLuma(page, sel) {
  const el = await page.$(sel)
  return meanLuma(await el.screenshot())
}

async function setup(page, email) {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 20000 })
  await page.evaluate((e) => window.__reviewSetFixtures({ preset: 'owner-many-sessions', user: { email: e } }), email)
  // autoDarken off so WE control when darkening happens - the real 5s timer
  // would race every measurement below.
  await page.evaluate(() => window.__reviewSetState && window.__reviewSetState({ autoDarken: false, darkenLevel: 1 }))
  await page.evaluate(() => window.__review('startTypedTimer'))
  await page.waitForSelector('.timer-value', { timeout: 15000 })
  // The "Start Cooking!" splash covers the screen for its first ~1.8s and
  // tinted the BRIGHT baseline, which made the timer look 66% brighter when
  // darkened - a nonsense number that still slipped past a "<5% drop" check.
  // Wait for it to remove itself so both samples measure the same scene.
  await page.waitForFunction(() => !document.querySelector('.start-cooking'), { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(400)
}

// Darken exactly the way the app does (class + overlay), no fake styling.
const darken = (page) => page.evaluate(() => {
  document.querySelector('.kitchen').classList.add('darkened')
  document.querySelector('.darken-overlay').hidden = false
})
const brighten = (page) => page.evaluate(() => {
  document.querySelector('.kitchen').classList.remove('darkened')
  document.querySelector('.darken-overlay').hidden = true
})

async function run(browserType, name) {
  const browser = await browserType.launch(name === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {})
  const ctx = await browser.newContext(name === 'webkit'
    ? { ...devices['iPhone 13'] } : { viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()

  // ---------- FLAG ON (preview account) ----------
  await setup(page, 'keefefons@gmail.com')
  check(`${name} gate class present for preview account`,
    await page.evaluate(() => document.querySelector('.kitchen').classList.contains('timer-no-dim')))

  const timerBright = await shotLuma(page, '.timer-value')
  // Control element = the pizza badge, NOT the kitchen video: headless
  // Chromium has no H.264 decoder, so the video renders near-black in both
  // states and can't show dimming at all. The badge is a real UI element in
  // the same dim list and renders identically in both engines.
  const kitchenBright = await shotLuma(page, '.session-pizza-badge')
  await darken(page)
  await page.waitForTimeout(900)   // let the 500ms filter transition settle
  const timerDark = await shotLuma(page, '.timer-value')
  const kitchenDark = await shotLuma(page, '.session-pizza-badge')

  // THE core assertion: timer pixels essentially unchanged.
  const timerDrop = ((timerBright - timerDark) / timerBright) * 100
  const kitchenDrop = ((kitchenBright - kitchenDark) / kitchenBright) * 100
  check(`${name} TIMER pixels not dimmed (<5% drop)`, timerDrop < 5,
    `bright=${timerBright.toFixed(1)} dark=${timerDark.toFixed(1)} drop=${timerDrop.toFixed(1)}%`)
  check(`${name} OTHER UI still dims (>40% drop)`, kitchenDrop > 40,
    `bright=${kitchenBright.toFixed(1)} dark=${kitchenDark.toFixed(1)} drop=${kitchenDrop.toFixed(1)}%`)

  // The decorative caption must still dim.
  const capDark = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.timer-caption')).filter)
  check(`${name} caption still dims`, capDark !== 'none', capDark)

  // Stacking: the HUD must clear the scrim.
  const z = await page.evaluate(() => ({
    hud: getComputedStyle(document.querySelector('.timer-hud')).zIndex,
    scrim: getComputedStyle(document.querySelector('.darken-overlay')).zIndex,
  }))
  check(`${name} timer HUD above the scrim`, Number(z.hud) > Number(z.scrim), `hud=${z.hud} scrim=${z.scrim}`)

  // Tapping the visible timer must BRIGHTEN, never pause.
  const pausedBefore = await page.evaluate(() => !!document.querySelector('.kitchen').classList.contains('paused'))
  const tb = await page.evaluate(() => { const r = document.querySelector('.timer-value').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await page.mouse.click(tb.x, tb.y)
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({
    darkened: document.querySelector('.kitchen').classList.contains('darkened'),
    paused: document.querySelector('.kitchen').classList.contains('paused'),
  }))
  check(`${name} tap on timer brightens`, !after.darkened, `darkened=${after.darkened}`)
  check(`${name} tap on timer does NOT pause`, after.paused === pausedBefore, `paused=${after.paused}`)

  await darken(page)
  await page.waitForTimeout(700)
  await page.screenshot({ path: `/tmp/claude-0/-home-user-chef-penguino/cb91145d-799f-5264-8422-ab1f01853fb6/scratchpad/nodim-${name}.png` })

  // ---------- FLAG OFF (ordinary account) -> old behaviour intact ----------
  await setup(page, 'ordinary@example.com')
  check(`${name} flag off: no gate class`,
    await page.evaluate(() => !document.querySelector('.kitchen').classList.contains('timer-no-dim')))
  const offBright = await shotLuma(page, '.timer-value')
  await darken(page)
  await page.waitForTimeout(900)
  const offDark = await shotLuma(page, '.timer-value')
  const offDrop = ((offBright - offDark) / offBright) * 100
  check(`${name} flag off: timer STILL dims (>40% drop)`, offDrop > 40,
    `bright=${offBright.toFixed(1)} dark=${offDark.toFixed(1)} drop=${offDrop.toFixed(1)}%`)

  await browser.close()
}

try {
  await wait()
  await run(chromium, 'chromium')
  await run(webkit, 'webkit')
} finally { server.kill() }
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
