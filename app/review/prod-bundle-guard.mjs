// Guards the PRODUCTION bundle against review-only scaffolding leaking into
// shipped code paths. Exists because of a real regression (Aug 2026): the
// hero-card tap handler wrote to `window.__emoteDebug.lastHeroTapId`
// unconditionally, but that object is created only inside the VITE_REVIEW
// branch - so in production the write threw a TypeError and killed the tap
// before any clip played. Every review suite passed, because the review build
// is the one place the object exists.
//
// Rule of thumb this encodes: a VITE_REVIEW-only global may be WRITTEN TO or
// READ only behind a truthiness guard, so the shipped build no-ops instead of
// throwing. Run against a plain `npx vite build` (no VITE_REVIEW).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const distAssets = path.resolve(process.cwd(), 'dist/assets')
const bundle = readdirSync(distAssets).find((f) => /^index-.*\.js$/.test(f))
if (!bundle) { console.error('FAIL: no production bundle found — run `npx vite build` first'); process.exit(1) }
const src = readFileSync(path.join(distAssets, bundle), 'utf8')

const failures = []

// The review-only globals. Their DEFINITIONS must be tree-shaken out of prod...
for (const g of ['__emoteDebug', '__reviewFixtures', '__reviewSetFixtures']) {
  if (new RegExp(`${g}\\s*=\\s*\\{`).test(src)) failures.push(`${g} is DEFINED in the production bundle (VITE_REVIEW branch not eliminated)`)
  // ...and any surviving reference must be guarded, i.e. every occurrence of
  // `X.prop` is immediately preceded by a `X&&` / `X?.` style check.
  for (const m of src.matchAll(new RegExp(`.{0,30}window\\.${g}\\.`, 'g'))) {
    const ctx = m[0]
    const guarded = new RegExp(`window\\.${g}(&&|\\?\\.|\\?)`).test(ctx) || /if\s*\(\s*window\.$/.test(ctx)
    if (!guarded) failures.push(`unguarded ${g} member access in prod bundle: ...${ctx}`)
  }
}

if (failures.length) {
  console.error('PROD BUNDLE GUARD FAILED:')
  failures.forEach((f) => console.error('  - ' + f))
  process.exit(1)
}
console.log(`PROD BUNDLE GUARD PASSED (${bundle}): no review-only globals defined, all references guarded`)
