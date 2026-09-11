// "Skip intro video" (Settings > Focus session, featureOn('skipIntro')).
// Checks BOTH halves: the row is geometrically consistent with its
// neighbours, and the setting actually skips the opening clip on the real
// cook-button path (not a synthetic call to renderIntro).
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4192
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const wait = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(URL)).ok) return } catch {} await new Promise(r => setTimeout(r, 300)) } throw new Error('server never came up') }

const results = []
const check = (n, c, x = '') => results.push(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  [' + x + ']' : ''}`)

async function boot(page, email) {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 20000 })
  await page.evaluate((e) => window.__reviewSetFixtures({ preset: 'owner-many-sessions', user: { email: e } }), email)
}

// Geometry of the "Focus session" group's rows, by their visible titles.
const groupRows = (page) => page.evaluate(() => {
  const lab = [...document.querySelectorAll('.glab')].find(p => /focus session/i.test(p.textContent))
  const list = lab.nextElementSibling
  return [...list.querySelectorAll('.grow')].map(r => {
    const b = r.getBoundingClientRect()
    const sw = r.querySelector('.switch') || r.querySelector('.chevron')
    const sb = sw ? sw.getBoundingClientRect() : null
    return {
      title: r.querySelector('.gt').textContent.trim(),
      h: Math.round(b.height), top: Math.round(b.top), left: Math.round(b.left), right: Math.round(b.right),
      // Signed distance between the control's centre and the row's centre.
      // Rows land on fractional y offsets (675.5, 743.5, ...), so the browser
      // rounds flex centring differently per row - the SHIPPED "Task types"
      // row already sits at 0.5. Comparing two rows' raw offsets therefore
      // fails on rounding alone; what actually matters is that each control
      // is centred in its own row.
      centreOff: sb ? +((sb.top + sb.height / 2) - (b.top + b.height / 2)).toFixed(2) : null,
      ctrlRight: sb ? Math.round(b.right - sb.right) : null,
    }
  })
})

async function run(browserType, name) {
  const browser = await browserType.launch(name === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {})
  const ctx = await browser.newContext(name === 'webkit'
    ? { ...devices['iPhone 13'] } : { viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  // Whether the browser ever FETCHES the clip. This is the real proof that
  // it's bypassed and it needs no video decoder: if the intro is skipped the
  // <video> is never created, so intro.mp4 is never requested. Headless
  // Chromium/WebKit can't decode H.264, so watching frames was never an
  // option - watching the network is.
  let introRequests = []
  page.on('request', (r) => { if (/intro\.mp4/.test(r.url())) introRequests.push(r.url()) })

  // ---- flag OFF: nothing changes ----
  await boot(page, 'ordinary@example.com')
  await page.evaluate(() => window.__review('renderSettings'))
  await page.waitForSelector('.glab')
  const off = await groupRows(page)
  check(`${name} flag off: no Skip intro row`, !off.some(r => /skip intro/i.test(r.title)),
    off.map(r => r.title).join(' | '))

  // ---- flag ON: row present and geometrically consistent ----
  await boot(page, 'keefefons@gmail.com')
  await page.evaluate(() => window.__review('renderSettings'))
  await page.waitForSelector('.glab')
  const rows = await groupRows(page)
  const skip = rows.find(r => /skip intro/i.test(r.title))
  const darken = rows.find(r => /auto-darken/i.test(r.title))
  const types = rows.find(r => /task types/i.test(r.title))
  check(`${name} row exists in Focus session group`, !!skip, rows.map(r => r.title).join(' | '))
  if (!skip) { await browser.close(); return }

  // Every row here carries a subtitle, so heights must match exactly.
  const heights = rows.map(r => r.h)
  check(`${name} all Focus-session rows identical height`, new Set(heights).size === 1,
    rows.map(r => `${r.title}=${r.h}`).join(' '))
  check(`${name} same left edge as neighbours`, skip.left === darken.left && skip.left === types.left,
    `skip=${skip.left} darken=${darken.left} types=${types.left}`)
  check(`${name} switch inset matches the other toggle`, skip.ctrlRight === darken.ctrlRight,
    `skip=${skip.ctrlRight} darken=${darken.ctrlRight}`)
  check(`${name} switch vertically centred in its row`, Math.abs(skip.centreOff) <= 0.5,
    `off=${skip.centreOff}`)
  check(`${name} centring no worse than the shipped rows`,
    Math.abs(skip.centreOff) <= Math.max(Math.abs(darken.centreOff), Math.abs(types.centreOff)),
    `skip=${skip.centreOff} darken=${darken.centreOff} types=${types.centreOff}`)
  check(`${name} sits between Auto-darken and Task types`,
    darken.top < skip.top && skip.top < types.top, `${darken.top} < ${skip.top} < ${types.top}`)

  await page.locator('.glab:text-matches("Focus session","i") + .glist').screenshot({
    path: `/tmp/claude-0/-home-user-chef-penguino/cb91145d-799f-5264-8422-ab1f01853fb6/scratchpad/skipintro-${name}.png`,
  }).catch(() => {})

  // ---- the toggle actually flips + persists ----
  const before = await page.evaluate(() => window.__reviewGetState().skipIntro)
  await page.evaluate(() => document.querySelector('[data-action="toggle-skip-intro"]').click())
  const after = await page.evaluate(() => window.__reviewGetState().skipIntro)
  check(`${name} toggle flips the setting`, before === false && after === true, `${before} -> ${after}`)
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('chef-penguino-save') || '{}').skipIntro)
  check(`${name} setting persists to storage`, persisted === true, String(persisted))

  // ---- BEHAVIOUR on the real cook path: setting ON -> no intro video ----
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('.cta[data-action="cook"]')
  introRequests = []
  const onSkip = await page.evaluate(() => {
    document.querySelector('.cta[data-action="cook"]').click()
    return {
      intro: !!document.querySelector('.intro-video'),
      duration: !!document.querySelector('.dur-btn, [data-dur], .duration-picker, .picker'),
    }
  })
  check(`${name} setting ON: intro clip skipped`, !onSkip.intro, JSON.stringify(onSkip))
  check(`${name} setting ON: lands on duration picker`, onSkip.duration, JSON.stringify(onSkip))
  await page.waitForTimeout(500)   // give any stray fetch time to appear
  check(`${name} setting ON: intro.mp4 never even requested`, introRequests.length === 0,
    `requests=${introRequests.length}`)

  // ---- ...and OFF still plays it (the old path must survive) ----
  await page.evaluate(() => window.__reviewSetState({ skipIntro: false }))
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('.cta[data-action="cook"]')
  // Read the DOM in the SAME evaluate as the click: renderIntro() writes its
  // markup synchronously, but headless Chromium has no H.264 decoder so
  // video.play() rejects almost immediately and the .catch() navigates
  // straight on to the duration picker. Waiting even 600ms therefore found an
  // empty screen and reported "the intro never played" on Chromium only.
  const onPlay = await page.evaluate(() => {
    document.querySelector('.cta[data-action="cook"]').click()
    return !!document.querySelector('.intro-video')
  })
  check(`${name} setting OFF: intro clip still plays`, onPlay, `introVideo=${onPlay}`)
  await page.waitForTimeout(800)
  check(`${name} setting OFF: intro.mp4 IS requested`, introRequests.length > 0,
    `requests=${introRequests.length}`)

  // ---- the setting survives a re-render of Settings (not reset to off) ----
  await page.evaluate(() => window.__reviewSetState({ skipIntro: true }))
  await page.evaluate(() => window.__review('renderSettings'))
  await page.waitForSelector('[data-action="toggle-skip-intro"]')
  const switchOn = await page.evaluate(() =>
    !document.querySelector('[data-action="toggle-skip-intro"]').classList.contains('off'))
  check(`${name} switch reflects saved state on re-render`, switchOn, `on=${switchOn}`)

  // ---- round trip: turning it back OFF restores the intro ----
  await page.evaluate(() => document.querySelector('[data-action="toggle-skip-intro"]').click())
  const roundTrip = await page.evaluate(() => window.__reviewGetState().skipIntro)
  check(`${name} toggling back off restores the setting`, roundTrip === false, `skipIntro=${roundTrip}`)

  // ---- GUEST path (Not signed in -> "continue anyway") still shows the intro.
  // Guests have no email so the flag is off for them: the clip must be
  // untouched, and this is also the second renderIntro() call site, proving
  // the gate did not break it.
  await page.evaluate(() => window.__reviewSetFixtures({ preset: 'guest' }))
  await page.evaluate(() => window.__review('renderHome'))
  await page.waitForSelector('.cta[data-action="cook"]')
  await page.evaluate(() => document.querySelector('.cta[data-action="cook"]').click())
  await page.waitForTimeout(300)
  const warned = await page.evaluate(() => !!document.querySelector('[data-action="risk"]'))
  check(`${name} guest sees the not-signed-in warning`, warned, `warning=${warned}`)
  if (warned) {
    const guestIntro = await page.evaluate(() => {
      document.querySelector('[data-action="risk"]').click()
      return !!document.querySelector('.intro-video')
    })
    check(`${name} guest path still reaches the intro`, guestIntro, `introVideo=${guestIntro}`)
  }

  await browser.close()
}

try {
  await wait()
  await run(chromium, 'chromium')
  await run(webkit, 'webkit')
} finally { server.kill() }
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
