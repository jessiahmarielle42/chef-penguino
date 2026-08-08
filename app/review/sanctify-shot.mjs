// Focused review: Background Music picker with the Sanctify connector.
// Verifies (a) non-admin sees the UNCHANGED picker (no Sanctify UI, presets
// intact) and (b) admin sees the "Connect Sanctify" card above the presets,
// with no console/page errors on render. See CLAUDE.md rule 4.
import { spawn } from 'node:child_process'
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'
const { chromium, webkit, devices } = pkg
const ENGINE = process.env.ENGINE === 'webkit' ? 'webkit' : 'chromium'
const PORT = 4319
const URL = `http://localhost:${PORT}/`
const OUT = '/tmp/claude-0/-home-user-chef-penguino/16991182-6d40-59ae-905c-41876314cf2d/scratchpad'

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts })
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`))))
  })
}
function spawnServer(cmd, args) { return spawn(cmd, args, { stdio: 'ignore' }) }
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('server never came up')
}

async function main() {
  await run('npx', ['vite', 'build'], { env: { ...process.env, VITE_REVIEW: '1' } })
  const server = spawnServer('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'])
  try {
    await waitForServer(URL)
    const browser = ENGINE === 'webkit'
      ? await webkit.launch()
      : await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
    const page = ENGINE === 'webkit'
      ? await browser.newPage({ ...devices['iPhone 13'] })
      : await browser.newPage({ viewport: { width: 420, height: 900 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.__review === 'function', { timeout: 15000 })

    // (A) NON-ADMIN
    await page.evaluate(() => window.__reviewSetFixtures({ preset: 'fresh-signup' }))
    await page.evaluate(() => window.__review('soundtrack'))
    await page.waitForSelector('.st-list .st-row', { timeout: 8000 })
    const nonAdmin = await page.evaluate(() => ({
      hasSanctify: !!document.querySelector('#sanctify-sec, .sanc-card'),
      presetRows: document.querySelectorAll('.st-list .st-row').length,
      saveBtn: !!document.querySelector('#st-save'),
    }))
    await page.screenshot({ path: `${OUT}/sanc-nonadmin.png`, fullPage: true })

    // (B) ADMIN, not connected — force admin email then re-render
    await page.evaluate(() => { window.__reviewFixtures.user.email = 'keefefons@gmail.com' })
    await page.evaluate(() => window.__reviewSetFixtures({ profile: { soundtrack: null } }))
    await page.evaluate(() => window.__review('soundtrack'))
    await page.waitForSelector('.st-list .st-row', { timeout: 8000 })
    await page.waitForTimeout(500) // async mountSanctifySection()
    const admin = await page.evaluate(() => ({
      hasCard: !!document.querySelector('.sanc-card'),
      hasConnectBtn: !!document.querySelector('#sanc-connect'),
      presetRows: document.querySelectorAll('.st-list .st-row').length,
      presetsDivider: !!document.querySelector('.st-divider'),
    }))
    await page.screenshot({ path: `${OUT}/sanc-admin-${ENGINE}.png`, fullPage: true })

    console.log(JSON.stringify({ engine: ENGINE, nonAdmin, admin, errors }, null, 2))
    await browser.close()
  } finally {
    server.kill()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
