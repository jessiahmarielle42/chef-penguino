// Hero-card tap-cycle behaviour (device-reported, Aug 2026): taps landing
// DURING a clip used to advance heroCycleIndex while playback was skipped,
// so two taps during clip 2 made the next real play jump to clip 5.
//
// Headless browsers here cannot decode H.264, so this drives playEmoteInto's
// state machine directly through the VITE_REVIEW __emoteDebug hook and
// asserts which emote id each tap SELECTS - the selection logic is the thing
// that was wrong. Real rendering still needs a device (CLAUDE.md 4d).
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4181
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const wait = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(URL)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) } throw new Error('server never came up') }

const results = []
const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`)

async function run(browserType, name) {
  const browser = await browserType.launch(name === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {})
  const ctx = await browser.newContext(name === 'webkit'
    ? { ...devices['iPhone 13'] } : { viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 20000 })
  await page.evaluate(() => window.__reviewSetFixtures({
    preset: 'owner-many-sessions',
    user: { email: 'keefefons@gmail.com' },
    profile: { emote_series: ['waving', 'eating', 'fireworks'], equipped_emote: 'waving' },
  }))
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('#hero-card')

  const tap = () => page.evaluate(() => { document.querySelector('#hero-card').click(); return window.__emoteDebug.lastHeroTapId })

  // Baseline: nothing playing -> taps walk the series in order and loop.
  await page.evaluate(() => window.__emoteDebug.forceIdle())
  const seq = []
  for (let i = 0; i < 4; i++) { seq.push(await tap()); await page.evaluate(() => window.__emoteDebug.forceIdle()) }
  check(`${name} taps cycle in order and loop`, seq.join(',') === 'eating,fireworks,waving,eating', seq.join(','))

  // THE BUG: taps during a clip that has been playing a while should
  // interrupt and advance by exactly ONE, never silently burn slots.
  await page.evaluate(() => window.__emoteDebug.forceIdle())
  const before = await tap()                                  // starts a clip
  await page.evaluate(() => window.__emoteDebug.simulatePlaying(1200))
  const after = await tap()                                   // interrupt -> next
  const order = ['waving', 'eating', 'fireworks']
  const stepped = order[(order.indexOf(before) + 1) % 3] === after
  check(`${name} tap during a settled clip advances exactly one`, stepped, `${before} -> ${after}`)

  // FAILSAFE: a tap while the clip has only just appeared is ignored.
  await page.evaluate(() => window.__emoteDebug.simulatePlaying(100))
  const early = await tap()
  check(`${name} tap within the 500ms grace is ignored (no skip)`, early === after, `stayed on ${early}`)

  // ...and a tap while the clip is still BUFFERING (never fired 'playing').
  await page.evaluate(() => window.__emoteDebug.simulatePlaying(null))
  const buffering = await tap()
  check(`${name} tap while still buffering is ignored`, buffering === after, `stayed on ${buffering}`)

  // After the grace passes, the very next tap advances exactly one again.
  await page.evaluate(() => window.__emoteDebug.simulatePlaying(900))
  const resumed = await tap()
  check(`${name} advances again once grace has passed`,
    order[(order.indexOf(after) + 1) % 3] === resumed, `${after} -> ${resumed}`)

  await browser.close()
}

try {
  await wait()
  await run(chromium, 'chromium')
  await run(webkit, 'webkit')
} finally { server.kill() }
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
