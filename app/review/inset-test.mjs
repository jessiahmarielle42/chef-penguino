// Verifies the iOS inset-standalone handling in BOTH engines. The dead strip
// under the tab bar comes from an install whose webview iOS runs INSET (short
// of the physical screen); index.html hides the manifest from iOS so new
// Add-to-Home-Screen installs take the full-screen meta-tag path instead.
// Cases per engine:
//  1. inset standalone (navigator.standalone=true, screen.height = innerHeight+47)
//     -> ios-inset-standalone class set, manifest removed, tab bar bottom flush
//        with innerHeight (no gap INSIDE the webview)
//  2. healthy full-screen standalone (strip=0) -> no inset class
//  3. plain browser tab (no navigator.standalone) -> manifest link PRESENT
//     so Android's install path still works
import { chromium, webkit, devices } from 'playwright'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '/home/user/chef-penguino/app')
const PORT = 4174
const URL = `http://localhost:${PORT}/chef-penguino/`

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: appDir, stdio: 'pipe' })
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URL); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server not up')
}

const results = []
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`)
}

async function runCase(browserType, engineName, mode) {
  const launch = engineName === 'chromium'
    ? { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }
    : {}
  const browser = await browserType.launch(launch)
  const ctxOpts = engineName === 'webkit'
    ? { ...devices['iPhone 13'] }
    : { viewport: { width: 428, height: 879 } }
  const ctx = await browser.newContext(ctxOpts)
  const page = await ctx.newPage()
  // Mark onboarding done so the fresh-guest tour doesn't auto-start and
  // cover the tab bar the geometry assertions measure.
  await page.addInitScript(() => {
    localStorage.setItem('chef-penguino-save', JSON.stringify({ onboardingDone: true }))
  })
  if (mode !== 'tab') {
    const strip = mode === 'inset' ? 47 : 0
    await page.addInitScript((strip) => {
      Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true })
      const realH = () => window.innerHeight + strip
      try { Object.defineProperty(window.screen, 'height', { get: realH, configurable: true }) } catch (e) {}
    }, strip)
  }
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabbar', { timeout: 15000 })
  await page.waitForTimeout(1200) // let renderHome's prompt checks run

  const data = await page.evaluate(() => ({
    insetClass: document.documentElement.classList.contains('ios-inset-standalone'),
    popupText: document.querySelector('.overlay .popup h3')?.textContent || null,
    manifestPresent: !!document.querySelector('link[rel="manifest"]'),
    tabbarBottom: Math.round(document.querySelector('.tabbar').getBoundingClientRect().bottom),
    innerH: window.innerHeight,
    tabbarH: getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h').trim(),
    screenH: window.screen.height,
  }))
  const tag = `${engineName}/${mode}`
  if (mode === 'inset') {
    check(`${tag} ios-inset-standalone class set`, data.insetClass)
    check(`${tag} manifest link removed`, !data.manifestPresent)
    check(`${tag} tabbar bottom == innerHeight (no gap)`, data.tabbarBottom === data.innerH, `bottom=${data.tabbarBottom} vh=${data.innerH} tbh=${data.tabbarH}`)
    await page.screenshot({ path: `/tmp/claude-0/-home-user-chef-penguino/cb91145d-799f-5264-8422-ab1f01853fb6/scratchpad/${engineName}-inset.png` })
  } else if (mode === 'healthy') {
    check(`${tag} no inset class`, !data.insetClass)
  } else {
    // navigator.standalone natively exists in WebKit's iOS emulation, so the
    // manifest is (correctly) removed there; only Chromium models a non-iOS tab.
    if (engineName === 'chromium') check(`${tag} manifest link kept in non-iOS tab`, data.manifestPresent)
  }
  await browser.close()
}

try {
  await waitForServer()
  for (const [bt, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
    for (const mode of ['inset', 'healthy', 'tab']) {
      await runCase(bt, name, mode)
    }
  }
} finally {
  server.kill()
}
console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
