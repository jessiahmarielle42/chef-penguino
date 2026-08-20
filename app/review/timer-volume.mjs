// Press-and-hold volume slider on the timer screen's mute button
// (featureOn('timerVolumeSlider')). Drives REAL pointer events
// (mouse.move/down/up, steps>1) - a synthetic .click() bypasses the whole
// hold/drag gesture and would pass vacuously. See CLAUDE.md rule 4/4c/4e.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4184
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const wait = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(URL)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) } throw new Error('server never came up') }

const results = []
const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`)

async function boot(page, email) {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 20000 })
  await page.evaluate((e) => window.__reviewSetFixtures({ preset: 'owner-many-sessions', user: { email: e } }), email)
  // Turn off auto-darken BEFORE the timer screen arms its 5s timer, so a
  // slow multi-step gesture sequence doesn't race it and have the overlay
  // steal taps mid-test - (g) below re-enables darkened state explicitly
  // and directly instead, independent of this flag.
  await page.evaluate(() => window.__reviewSetState?.({ autoDarken: false }))
  await page.evaluate(() => window.__review('startTypedTimer'))
  await page.waitForSelector('.mute-btn')
  // Let the "Start Cooking!" splash finish (removed at 1800ms) before any
  // gesture targets the mute button underneath it.
  await page.waitForTimeout(2000)
}

const muteBox = (page) => page.evaluate(() => {
  const el = document.querySelector('.mute-btn')
  const r = el.getBoundingClientRect()
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, top: r.top, bottom: r.bottom }
})

const sliderVisible = (page) => page.evaluate(() => {
  const el = document.querySelector('.tvs-slider')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { present: true, hidden: el.hidden, w: r.width, h: r.height }
})

const getVolume = (page) => page.evaluate(() => window.__reviewGetState ? window.__reviewGetState().volume : null)
const getMuted = (page) => page.evaluate(() => window.__reviewGetState ? window.__reviewGetState().muted : null)

async function run(browserType, name) {
  const browser = await browserType.launch(name === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {})
  const ctx = await browser.newContext(name === 'webkit'
    ? { ...devices['iPhone 13'] } : { viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  // ---- (a) flag OFF (non-preview email): no slider DOM at all, and a
  // plain tap still performs the ordinary mute toggle ----
  await boot(page, 'ordinary-user@example.com')
  const svOff = await sliderVisible(page)
  check(`${name} (a) flag off: no slider DOM at all`, svOff === null, JSON.stringify(svOff))
  const bOff = await muteBox(page)
  const mutedBeforeOff = await getMuted(page)
  await page.mouse.click(bOff.cx, bOff.cy)
  await page.waitForTimeout(150)
  const mutedAfterOff = await getMuted(page)
  check(`${name} (a) flag off: tap still toggles mute`, mutedAfterOff !== mutedBeforeOff, `before=${mutedBeforeOff} after=${mutedAfterOff}`)
  // A hold gesture, if it somehow fired without the DOM, must still be a
  // harmless no-op - confirm no slider element exists to open.
  await page.mouse.move(bOff.cx, bOff.cy)
  await page.mouse.down()
  await page.waitForTimeout(400)
  await page.mouse.up()
  check(`${name} (a) flag off: hold gesture has nothing to open`, (await sliderVisible(page)) === null)

  // ---- remaining assertions use the preview account (flag ON) ----
  await boot(page, 'keefefons@gmail.com')
  const b = await muteBox(page)
  const mutedBefore = await getMuted(page)
  await page.mouse.click(b.cx, b.cy)
  await page.waitForTimeout(150)
  const mutedAfterTap = await getMuted(page)
  check(`${name} plain click toggles mute (flag on)`, mutedAfterTap !== mutedBefore, `before=${mutedBefore} after=${mutedAfterTap}`)
  // toggle back
  await page.mouse.click(b.cx, b.cy)
  await page.waitForTimeout(150)

  // ---- (b) quick tap (<250ms, no movement) toggles mute, no slider ----
  const beforeMuted2 = await getMuted(page)
  await page.mouse.move(b.cx, b.cy)
  await page.mouse.down()
  await page.waitForTimeout(80)
  await page.mouse.up()
  await page.waitForTimeout(100)
  const afterMuted2 = await getMuted(page)
  const sv1 = await sliderVisible(page)
  check(`${name} (b) quick tap toggles mute`, afterMuted2 !== beforeMuted2, `before=${beforeMuted2} after=${afterMuted2}`)
  check(`${name} (b) quick tap does NOT open slider`, !sv1 || sv1.hidden, JSON.stringify(sv1))
  await page.mouse.click(b.cx, b.cy) // reset mute state
  await page.waitForTimeout(120)

  // ---- (c) hold ~400ms opens the slider ----
  await page.mouse.move(b.cx, b.cy)
  await page.mouse.down()
  await page.waitForTimeout(400)
  const sv2 = await sliderVisible(page)
  check(`${name} (c) hold opens slider`, !!sv2 && sv2.present && !sv2.hidden, JSON.stringify(sv2))

  // ---- (d) dragging during the SAME hold changes state.volume. Opening
  // the slider already sets an initial volume from the button's own y, so
  // establish a known mid-range baseline first, then verify each direction
  // moves the NUMBER the expected way from that baseline. ----
  // Aim at the track's own MIDPOINT rather than a fixed pixel offset from the
  // button: the capsule's padding changes where a given offset lands, and a
  // baseline that happens to sit at the 0 or 1 ceiling makes "drag further
  // that way" untestable (it silently passed/failed for the wrong reason).
  const trackMid = await page.evaluate(() => {
    const t = document.querySelector('.tvs-track').getBoundingClientRect()
    return { x: t.left + t.width / 2, y: t.top + t.height / 2 }
  })
  await page.mouse.move(trackMid.x, trackMid.y, { steps: 4 })
  await page.waitForTimeout(80)
  const volBaseline = await getVolume(page)
  await page.mouse.move(b.cx, b.top - 60, { steps: 8 }) // drag well above the button = louder
  await page.waitForTimeout(80)
  const volAfterUp = await getVolume(page)
  check(`${name} (d) drag UP raises volume`, volAfterUp > volBaseline, `baseline=${volBaseline} after=${volAfterUp}`)
  await page.mouse.move(b.cx, b.bottom + 200, { steps: 8 }) // drag far below = quieter/0
  await page.waitForTimeout(80)
  const volAfterDown = await getVolume(page)
  check(`${name} (d) drag DOWN lowers volume`, volAfterDown < volAfterUp, `after=${volAfterDown}`)
  await page.mouse.up()
  await page.waitForTimeout(100)

  // ---- (h) no leftover inline transform after the gesture ----
  const inlineAfter = await page.evaluate(() => ({
    btn: document.querySelector('.mute-btn').style.transform,
    slider: document.querySelector('.tvs-slider').style.transform,
  }))
  check(`${name} (h) no stale inline transform on mute-btn`, inlineAfter.btn === '', `"${inlineAfter.btn}"`)

  // screenshot the open slider mid-gesture on a fresh hold+drag
  await page.mouse.move(b.cx, b.cy)
  await page.mouse.down()
  await page.waitForTimeout(400)
  await page.mouse.move(b.cx, b.top - 40, { steps: 8 })
  await page.waitForTimeout(80)
  const shotPath = `/tmp/claude-0/-home-user-chef-penguino/cb91145d-799f-5264-8422-ab1f01853fb6/scratchpad/timer-volume-${name}.png`
  await page.screenshot({ path: shotPath })
  await page.mouse.up()
  await page.waitForTimeout(50)

  // ---- (e) release-without-moving leaves it open, auto-hides ~2.5s ----
  await page.mouse.move(b.cx, b.cy)
  await page.mouse.down()
  await page.waitForTimeout(500) // hold opens it
  await page.mouse.up()
  await page.waitForTimeout(300)
  const svStay = await sliderVisible(page)
  check(`${name} (e) release-without-move leaves slider open`, !!svStay && !svStay.hidden, JSON.stringify(svStay))
  await page.waitForTimeout(2600)
  const svHidden = await sliderVisible(page)
  check(`${name} (e) auto-hides after ~2.5s`, !!svHidden && svHidden.hidden, JSON.stringify(svHidden))

  // ---- (f) volume set via slider matches Settings slider's reading ----
  await page.mouse.move(b.cx, b.cy)
  await page.mouse.down()
  await page.waitForTimeout(400)
  await page.mouse.move(b.cx, b.top - 55, { steps: 6 })
  await page.waitForTimeout(80)
  const volSetBySlider = await getVolume(page)
  await page.mouse.up()
  await page.waitForTimeout(100)
  await page.evaluate(() => window.__review('renderSettings'))
  await page.waitForSelector('#volume-slider')
  const settingsReading = await page.evaluate(() => Number(document.querySelector('#volume-slider').value) / 100)
  check(`${name} (f) Settings slider matches value set on timer screen`,
    Math.abs(settingsReading - volSetBySlider) < 0.02, `slider=${volSetBySlider} settings=${settingsReading}`)

  // ---- (g) hold while darkened does NOT open the slider ----
  await boot(page, 'keefefons@gmail.com')
  await page.evaluate(() => { document.querySelector('.kitchen').classList.add('darkened') })
  const b2 = await muteBox(page)
  await page.mouse.move(b2.cx, b2.cy)
  await page.mouse.down()
  await page.waitForTimeout(450)
  const svDarkened = await sliderVisible(page)
  check(`${name} (g) hold while darkened does NOT open slider`, !svDarkened || svDarkened.hidden, JSON.stringify(svDarkened))
  await page.mouse.up()
  await page.waitForTimeout(100)

  await browser.close()
  return shotPath
}

let shots = {}
try {
  await wait()
  shots.chromium = await run(chromium, 'chromium')
  shots.webkit = await run(webkit, 'webkit')
} finally { server.kill() }
console.log(results.join('\n'))
console.log('Screenshots:', JSON.stringify(shots))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
