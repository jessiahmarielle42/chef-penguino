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
  // Control element = the timer CAPTION. Not the kitchen video (headless
  // Chromium has no H.264 decoder, so it is near-black either way and cannot
  // show dimming), and no longer the pizza badge either - that is now
  // deliberately spared, so using it as the "still dims" control made this
  // assertion fail for the very reason the feature works.
  const kitchenBright = await shotLuma(page, '.timer-caption')
  await darken(page)
  await page.waitForTimeout(900)   // let the 500ms filter transition settle
  const timerDark = await shotLuma(page, '.timer-value')
  const kitchenDark = await shotLuma(page, '.timer-caption')

  // THE core assertion: timer pixels essentially unchanged.
  const timerDrop = ((timerBright - timerDark) / timerBright) * 100
  const kitchenDrop = ((kitchenBright - kitchenDark) / kitchenBright) * 100
  check(`${name} TIMER pixels not dimmed (<5% drop)`, timerDrop < 5,
    `bright=${timerBright.toFixed(1)} dark=${timerDark.toFixed(1)} drop=${timerDrop.toFixed(1)}%`)
  check(`${name} OTHER UI still dims (>40% drop)`, kitchenDrop > 40,
    `bright=${kitchenBright.toFixed(1)} dark=${kitchenDark.toFixed(1)} drop=${kitchenDrop.toFixed(1)}%`)

  // ---- the session CONTROLS are spared too (featureOn('noDimControls')) ----
  const badgeBright = await shotLuma(page, '.session-pizza-badge')
  const muteBright = await shotLuma(page, '.mute-btn')
  await darken(page)
  await page.waitForTimeout(900)
  const badgeDark = await shotLuma(page, '.session-pizza-badge')
  const muteDark = await shotLuma(page, '.mute-btn')
  const badgeDrop = ((badgeBright - badgeDark) / badgeBright) * 100
  const muteDrop = ((muteBright - muteDark) / muteBright) * 100
  check(`${name} PIZZA COUNT pixels not dimmed (<5% drop)`, badgeDrop < 5,
    `bright=${badgeBright.toFixed(1)} dark=${badgeDark.toFixed(1)} drop=${badgeDrop.toFixed(1)}%`)
  check(`${name} SOUND BUTTON pixels not dimmed (<5% drop)`, muteDrop < 5,
    `bright=${muteBright.toFixed(1)} dark=${muteDark.toFixed(1)} drop=${muteDrop.toFixed(1)}%`)

  // The sound button must remain LIVE while dimmed - holding it is the only
  // way to reach the volume slider, and a tap swallowed by "tap anywhere to
  // brighten" would make sparing it pointless.
  const mb = await page.evaluate(() => { const r = document.querySelector('.mute-btn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  const topAtMute = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el ? (el.className.baseVal ?? el.className ?? el.tagName) : null
  }, mb)
  check(`${name} sound button receives taps while dimmed`, String(topAtMute).includes('mute-btn'),
    `elementFromPoint=${topAtMute}`)

  // Hold it: the slider must open AND be visible above the scrim.
  await page.mouse.move(mb.x, mb.y); await page.mouse.down()
  await page.waitForTimeout(500)
  const sliderState = await page.evaluate(() => {
    const s = document.querySelector('.tvs-slider')
    if (!s) return { present: false }
    const cs = getComputedStyle(s)
    const scrim = getComputedStyle(document.querySelector('.darken-overlay')).zIndex
    return { present: true, hidden: s.hidden, z: cs.zIndex, scrim, filter: cs.filter }
  })
  await page.mouse.up()
  check(`${name} hold while dimmed OPENS the volume slider`,
    sliderState.present && !sliderState.hidden, JSON.stringify(sliderState))
  check(`${name} volume slider sits above the scrim`,
    sliderState.present && Number(sliderState.z) > Number(sliderState.scrim),
    `z=${sliderState.z} scrim=${sliderState.scrim}`)
  check(`${name} volume slider is not brightness-filtered`,
    sliderState.present && sliderState.filter === 'none', String(sliderState.filter))
  await brighten(page)
  await page.waitForTimeout(300)
  await darken(page)
  await page.waitForTimeout(900)

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

  // ---------- RELEASED (FEATURES.timerNoDim === 'all') ----------
  // An ordinary, non-preview account now gets the same treatment. Before the
  // release flip these asserted the OPPOSITE (no gate class, timer dims like
  // everything else) and they failed the moment the flag moved - which is
  // itself the evidence the gate was what gated it. Revert if it ever goes
  // back to 'preview'.
  await setup(page, 'ordinary@example.com')
  check(`${name} released: ordinary account gets the gate class`,
    await page.evaluate(() => document.querySelector('.kitchen').classList.contains('timer-no-dim')))
  const offBright = await shotLuma(page, '.timer-value')
  await darken(page)
  await page.waitForTimeout(900)
  const offDark = await shotLuma(page, '.timer-value')
  const offDrop = ((offBright - offDark) / offBright) * 100
  check(`${name} released: timer stays lit for ordinary accounts too (<5% drop)`, offDrop < 5,
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
