// Measures the EMPTY space below the tab bar's label glyphs - the "extra bar
// under the nav bar" a full-screen iOS install shows.
//
// env(safe-area-inset-bottom) resolves to 0 in headless browsers and cannot
// be faked, so the iOS case is simulated by overriding ONLY .tabbar's
// padding-bottom with the literal each formula produces at a real 34px home
// indicator. That verifies the arithmetic and the resulting geometry; it does
// NOT verify iOS's own inset reporting (device-only, see CLAUDE.md 4d).
//
// Assertions per engine:
//   34px indicator, OLD formula `env(...)`                -> ~42px dead space (the bug)
//   34px indicator, NEW formula `max(.5rem, env - .5rem)` -> 34px, exactly the
//                                                            indicator reserve
//   no indicator (browser tab / Android / desktop)        -> unchanged, ~16px
// Glyph-box rounding differs ~1-2px between Chromium and WebKit, so the
// non-padding-driven numbers are asserted as ranges, not engine-exact values.
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = 4175
const URL = `http://localhost:${PORT}/chef-penguino/`
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URL); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('preview server never came up')
}

const results = []
const check = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)

// Empty px between the bottom of the lowest label GLYPH and the bar's bottom
// edge. Uses a Range over the text node, so it measures what the eye sees
// rather than .tab's padded border box.
function measureScript() {
  const bar = document.querySelector('.tabbar')
  const barBottom = bar.getBoundingClientRect().bottom
  let lowest = -Infinity
  for (const el of bar.querySelectorAll('.tab, .tab-fab-label')) {
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue
      const r = document.createRange()
      r.selectNodeContents(node)
      lowest = Math.max(lowest, r.getBoundingClientRect().bottom)
    }
  }
  return { gap: Math.round(barBottom - lowest), barH: Math.round(bar.getBoundingClientRect().height) }
}

async function run(browserType, name) {
  const browser = await browserType.launch(
    name === 'chromium' ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' } : {}
  )
  const ctx = await browser.newContext(
    name === 'webkit' ? { ...devices['iPhone 13'] } : { viewport: { width: 428, height: 926 } }
  )
  const page = await ctx.newPage()
  await page.addInitScript(() =>
    localStorage.setItem('chef-penguino-save', JSON.stringify({ onboardingDone: true })))
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabbar')

  const shipped = await page.evaluate(measureScript)
  check(`${name} no-indicator (tab/Android/desktop) unchanged`, shipped.gap >= 15 && shipped.gap <= 19, `gap=${shipped.gap}px barH=${shipped.barH}`)

  const withPad = async (css) => {
    await page.evaluate((c) => {
      document.getElementById('sim')?.remove()
      const s = document.createElement('style')
      s.id = 'sim'
      s.textContent = `.tabbar{padding-bottom:${c} !important}`
      document.head.appendChild(s)
    }, css)
    return page.evaluate(measureScript)
  }

  const before = await withPad('34px')
  check(`${name} OLD formula reproduces the dead band`, before.gap >= 41 && before.gap <= 44, `gap=${before.gap}px barH=${before.barH}`)

  const after = await withPad('max(0.5rem, calc(34px - 0.5rem))')
  check(`${name} NEW formula = indicator reserve only`, after.gap === 34, `gap=${after.gap}px barH=${after.barH}`)
  check(`${name} NEW reclaims the double-counted 0.5rem`, before.gap - after.gap >= 8 && before.gap - after.gap <= 9, `${before.gap} -> ${after.gap}`)

  await page.evaluate(() => document.getElementById('sim')?.remove())
  await browser.close()
}

try {
  await waitForServer()
  await run(chromium, 'chromium')
  await run(webkit, 'webkit')
} finally {
  server.kill()
}
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
