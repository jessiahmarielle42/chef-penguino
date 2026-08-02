// Chef Penguino headless review harness.
// See CLAUDE.md rule 4 - this is the gitignored-no-more harness that lets
// Opus/Playwright screenshot auth-gated screens without real OAuth or a
// live Supabase session. Only ever imported behind `import.meta.env.VITE_REVIEW`
// in main.js, so it (and this sentinel) never ship in a normal build:
// REVIEW_HARNESS_SENTINEL_9f2c71a4
//
// It monkeypatches the real supabase client's .from()/.rpc()/.channel()
// with an in-memory fixture layer so no network calls happen, sets the
// app's module-level currentUser/currentProfile via the setUser() hook
// main.js passes in, and exposes window.__review(screenName) +
// window.__reviewSetFixtures(partial) for a Playwright script to drive.

// ---------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------

function todayAt(hh, mm) {
  const d = new Date()
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

// Mirrors main.js's SGT day-boundary math (fixed UTC+8, no DST) rather than
// importing it, since this harness runs standalone under Node/Playwright,
// outside the Vite app bundle. SGT midnight (UTC instant) for the SGT
// calendar day containing `now`.
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000
function sgtStartOfDayUTC(now = new Date()) {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS)
  const flooredShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(flooredShifted - SGT_OFFSET_MS)
}
// `h` hours before "now", clamped to never cross back of today's SGT
// midnight boundary. Used for fixture sessions that must be OLDER than the
// practice session the tour creates during the run (which is always the
// most recent, real-world-realistic) while still landing on TODAY's
// calendar cell (the one the tour's open-day step targets).
function hoursAgo(h) {
  const target = Date.now() - h * 60 * 60 * 1000
  const floor = sgtStartOfDayUTC().getTime()
  return new Date(Math.max(target, floor)).toISOString()
}

function makeSessionRow(id, task, minutes, pizzas, hh, mm, extra = {}) {
  return {
    id,
    user_id: 'user-1',
    completed_at: todayAt(hh, mm),
    minutes,
    pizzas,
    task,
    icon: '🍕',
    type: 'deep',
    ...extra,
  }
}

// Same shape as makeSessionRow, but timestamped relative to "now"
// (hoursAgo) instead of a fixed clock time - for fixtures that must stay
// realistically OLDER than a session the run itself creates live.
function makeSessionRowAgo(id, task, minutes, pizzas, hoursAgoVal, extra = {}) {
  return {
    id,
    user_id: 'user-1',
    completed_at: hoursAgo(hoursAgoVal),
    minutes,
    pizzas,
    task,
    icon: '🍕',
    type: 'deep',
    ...extra,
  }
}

const PRESET_AVATARS = [
  { id: 'pa-1', path: 'p1.png', url: 'https://placehold.co/96x96?text=1', unlock_level: 1, created_at: todayAt(1, 0) },
  { id: 'pa-9', path: 'p9.png', url: 'https://placehold.co/96x96?text=9', unlock_level: 9, created_at: todayAt(1, 0) },
  { id: 'pa-15', path: 'p15.png', url: 'https://placehold.co/96x96?text=15', unlock_level: 15, created_at: todayAt(1, 0) },
]

const GUEST_PROFILE = null

// waving_free defaults to false for a genuinely new signup (see
// supabase/migration_onboarding.sql: `default false`, only backfilled to
// true for pre-migration grandfathered accounts) - true here would make
// isOwned('waving') report the emote as already "owned" via the free-grant
// path and permanently fail isEligibleForOnboardingCoin()'s `if
// (isOwned('waving')) return false` check, so this preset would silently
// never actually be eligible despite its name.
const ELIGIBLE_PROFILE = {
  id: 'user-1',
  display_name: 'Keefe',
  friend_code: 'KEEFE01',
  pizzas: 0,
  avatar_url: null,
  owned_emotes: [],
  equipped_emote: null,
  coin_adjustment: 0,
  task_type_labels: null,
  level_seen: 1,
  waving_free: false,
  onboarding_done: false,
  onboarding_coin_claimed: false,
}

// The important preset: reproduces a real, long-tenured signed-in chef's
// account - Lv ~10-ish (29 lifetime pizzas), already holds a coin (so
// isEligibleForOnboardingCoin() genuinely returns false - see main.js
// ~line 8210: coinsEarned() = floor(29/12) = 2 >= 1 already disqualifies
// it, and owned_emotes containing 'waving' + waving_free:false double-
// disqualifies via isOwned('waving') too, belt-and-braces), but with
// onboarding_done:false so the tour still auto-starts on Home. Seven
// same-day sessions with varied times/tasks reproduces the busy day-sheet
// that was breaking the calendar/tour.
const INELIGIBLE_PROFILE = {
  id: 'user-1',
  display_name: 'Keefe',
  friend_code: 'KEEFE01',
  pizzas: 29,
  avatar_url: null,
  owned_emotes: ['waving'],
  equipped_emote: 'waving',
  coin_adjustment: 1,
  task_type_labels: null,
  level_seen: 10,
  waving_free: false,
  onboarding_done: false,
  onboarding_coin_claimed: true,
}

// Relative to "now" (hoursAgo), not fixed clock times - a fixed 1:30pm etc.
// could sort NEWER than the practice session the tour run creates live,
// which is unrealistic (in reality the practice session is always the
// most recent) and was exactly what made tourLogId's old "guess the
// newest entry" resolution unreliable. All within a few hours of "now" so
// they stay on today's SGT calendar cell (see hoursAgo's clamp).
const INELIGIBLE_SESSIONS = [
  makeSessionRowAgo('s-1', 'replying tutors n stu', 38, 1, 1),
  makeSessionRowAgo('s-2', 'test', 0, 0, 2),
  makeSessionRowAgo('s-3', 'test', 0, 0, 3),
  makeSessionRowAgo('s-4', 'test', 0, 0, 4),
  makeSessionRowAgo('s-5', 'test', 0, 0, 5),
  makeSessionRowAgo('s-6', 'lesson prep', 25, 1, 6),
  makeSessionRowAgo('s-7', 'grading', 45, 1, 7),
]

// S2: a guest who already earned a coin locally (coinsEarned() = floor(14/12)
// = 1 >= 1), so guestWouldQualify() is false and the tour must NOT promise a
// coin it can't grant after sign-in. A few same-day sessions so the day
// sheet/delete-flow steps have real rows to work with, same as the other
// non-empty presets. Does not own waving (guest waving is always "free"
// visually, but ownedEmotes doesn't include it, matching a real guest who
// hasn't purchased it).
const GUEST_EARNED_SESSIONS = [
  makeSessionRowAgo('gs-1', 'reading', 40, 1, 1),
  makeSessionRowAgo('gs-2', 'writing', 25, 1, 2),
  makeSessionRowAgo('gs-3', 'test', 0, 0, 3),
]

const PRESETS = {
  guest: {
    user: null,
    profile: GUEST_PROFILE,
    sessions: [],
  },
  'guest-earned-coin': {
    user: null,
    profile: GUEST_PROFILE,
    sessions: GUEST_EARNED_SESSIONS,
    // Guest state (pizzas/ownedEmotes) lives in main.js's localStorage-backed
    // `state`, not in the fixture profile/sessions tables - applyPreset's
    // guestState passthrough (below) seeds it directly.
    guestState: { pizzas: 14, ownedEmotes: [] },
  },
  'signed-in-eligible': {
    user: { id: 'user-1', email: 'keefe@example.com' },
    profile: ELIGIBLE_PROFILE,
    sessions: [],
  },
  'signed-in-ineligible-many-sessions': {
    user: { id: 'user-1', email: 'keefe@example.com' },
    profile: INELIGIBLE_PROFILE,
    sessions: INELIGIBLE_SESSIONS,
  },
}

// ---------------------------------------------------------------
// In-memory "tables" the .from() shim reads/writes.
// ---------------------------------------------------------------

const tables = {
  profiles: [],
  sessions: [],
  preset_avatars: PRESET_AVATARS.slice(),
  emote_tags: [],
  emote_meta: [],
  warnings: [],
  system_notifications: [],
  noots: [],
  friends: [],
  group_icons: [],
  reports: [],
  admin_meta: [],
  blocked_users: [],
  bug_reports: [],
}

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)) }

function rowMatches(row, filters) {
  for (const f of filters) {
    const v = row[f.col]
    if (f.op === 'eq' && v !== f.val) return false
    if (f.op === 'neq' && v === f.val) return false
    if (f.op === 'in' && !(Array.isArray(f.val) && f.val.includes(v))) return false
    if (f.op === 'gte' && !(v >= f.val)) return false
    if (f.op === 'lte' && !(v <= f.val)) return false
    if (f.op === 'gt' && !(v > f.val)) return false
    if (f.op === 'lt' && !(v < f.val)) return false
    if (f.op === 'is' && v !== f.val) return false
  }
  return true
}

// Chainable thenable mimicking the real supabase-js query builder closely
// enough for every shape used in main.js (select/eq/neq/in/gte/lte/order/
// limit/single/maybeSingle/insert/update/delete).
function makeQuery(table) {
  const filters = []
  let mode = 'select'
  let selectCols = '*'
  let selectOpts = null
  let insertRows = null
  let updateVals = null
  let orderCol = null
  let orderAsc = true
  let limitN = null
  let wantSingle = false
  let wantMaybeSingle = false

  const api = {
    select(cols, opts) { selectCols = cols; selectOpts = opts || null; return api },
    eq(col, val) { filters.push({ col, op: 'eq', val }); return api },
    neq(col, val) { filters.push({ col, op: 'neq', val }); return api },
    in(col, val) { filters.push({ col, op: 'in', val }); return api },
    gte(col, val) { filters.push({ col, op: 'gte', val }); return api },
    lte(col, val) { filters.push({ col, op: 'lte', val }); return api },
    gt(col, val) { filters.push({ col, op: 'gt', val }); return api },
    lt(col, val) { filters.push({ col, op: 'lt', val }); return api },
    is(col, val) { filters.push({ col, op: 'is', val }); return api },
    order(col, opts) { orderCol = col; orderAsc = opts ? opts.ascending !== false : true; return api },
    limit(n) { limitN = n; return api },
    single() { wantSingle = true; return api },
    maybeSingle() { wantMaybeSingle = true; return api },
    insert(rows) { mode = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return api },
    update(vals) { mode = 'update'; updateVals = vals; return api },
    delete() { mode = 'delete'; return api },
    then(resolve, reject) {
      try {
        resolve(run())
      } catch (e) {
        if (reject) reject(e); else throw e
      }
    },
  }

  function run() {
    const store = tables[table] || (tables[table] = [])

    if (mode === 'insert') {
      const inserted = insertRows.map(r => ({ id: r.id || `${table}-${Math.random().toString(36).slice(2, 9)}`, ...r }))
      store.push(...inserted)
      return { data: clone(inserted), error: null }
    }

    if (mode === 'update') {
      const matched = store.filter(r => rowMatches(r, filters))
      matched.forEach(r => Object.assign(r, updateVals))
      return { data: clone(matched), error: null, count: matched.length }
    }

    if (mode === 'delete') {
      const keep = []
      const removed = []
      for (const r of store) {
        if (rowMatches(r, filters)) removed.push(r); else keep.push(r)
      }
      tables[table] = keep
      return { data: clone(removed), error: null }
    }

    // select
    let rows = store.filter(r => rowMatches(r, filters))
    if (orderCol) {
      rows = rows.slice().sort((a, b) => {
        const av = a[orderCol]; const bv = b[orderCol]
        if (av === bv) return 0
        return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1)
      })
    }
    if (limitN != null) rows = rows.slice(0, limitN)

    if (selectOpts && selectOpts.head && selectOpts.count === 'exact') {
      return { data: null, error: null, count: rows.length }
    }

    if (wantSingle) {
      if (rows.length === 0) return { data: null, error: { message: 'no rows', code: 'PGRST116' } }
      return { data: clone(rows[0]), error: null }
    }
    if (wantMaybeSingle) {
      return { data: rows.length ? clone(rows[0]) : null, error: null }
    }
    return { data: clone(rows), error: null }
  }

  return api
}

function fakeFrom(table) {
  return makeQuery(table)
}

function fakeRpc(name, args) {
  // claim_onboarding_coin needs REAL behaviour, not a benign no-op: the
  // onboarding tour's buy-waving step reads coinBalance() (derived from the
  // profile's coin_adjustment) to decide whether the forced purchase is
  // affordable. Mirrors supabase/migration_onboarding.sql's function
  // exactly - same refusal conditions, same +1 coin_adjustment grant on
  // success - so the fixture layer models the coin actually landing.
  if (name === 'claim_onboarding_coin') {
    const me = tables.profiles[0]
    if (!me) return Promise.resolve({ data: false, error: { message: 'No profile' } })
    const alreadyDisqualified = me.onboarding_coin_claimed
      || Math.floor(Math.floor(me.pizzas || 0) / 12) >= 1
      || (me.coin_adjustment || 0) !== 0
      || (me.owned_emotes || []).includes('waving')
      || me.waving_free
    if (alreadyDisqualified) {
      me.onboarding_coin_claimed = true
      return Promise.resolve({ data: false, error: null })
    }
    me.coin_adjustment = (me.coin_adjustment || 0) + 1
    me.onboarding_coin_claimed = true
    return Promise.resolve({ data: true, error: null })
  }
  // No other RPC behaviour is required by the current renderers list;
  // resolve benignly so any incidental call doesn't throw and stall a
  // screen.
  return Promise.resolve({ data: null, error: null })
}

function fakeChannel() {
  const chan = {
    on() { return chan },
    subscribe(cb) { if (cb) cb('SUBSCRIBED'); return chan },
    unsubscribe() { return Promise.resolve('ok') },
  }
  return chan
}

// ---------------------------------------------------------------
// Install
// ---------------------------------------------------------------

let installedSupabase = null
let installedSetUser = null
let installedRenderers = null
let installedState = null

function applyPreset(name) {
  const preset = PRESETS[name]
  if (!preset) throw new Error(`Unknown review fixture preset: ${name}`)
  tables.profiles = preset.profile ? [clone(preset.profile)] : []
  tables.sessions = preset.sessions.map(clone)
  installedSetUser(preset.user ? clone(preset.user) : null, preset.profile ? clone(preset.profile) : null)
  window.__reviewFixtures.preset = name
  window.__reviewFixtures.user = preset.user ? clone(preset.user) : null
  window.__reviewFixtures.profile = preset.profile ? clone(preset.profile) : null
  window.__reviewFixtures.sessions = tables.sessions.slice()
  // Guest-only local state (pizzas/ownedEmotes/log) lives in main.js's
  // module-level `state` object, not in the fixture profile/sessions
  // tables - those only model what a SIGNED-IN chef's data looks like.
  // Presets that need to seed a guest's coinsEarned()/ownedEmotes() (e.g.
  // guest-earned-coin) mutate it directly here.
  if (installedState) {
    installedState.pizzas = preset.guestState?.pizzas ?? 0
    installedState.ownedEmotes = preset.guestState?.ownedEmotes ? preset.guestState.ownedEmotes.slice() : []
    installedState.log = preset.sessions.map(s => ({
      id: s.id, task: s.task, minutes: s.minutes, pizzas: s.pizzas,
      icon: s.icon, type: s.type, completed_at: s.completed_at,
    }))
  }
}

export function installReviewHarness({ supabase, setUser, renderers, state }) {
  installedSupabase = supabase
  installedSetUser = setUser
  installedRenderers = renderers
  installedState = state || null

  supabase.from = fakeFrom
  supabase.rpc = fakeRpc
  supabase.channel = fakeChannel

  window.__reviewFixtures = {
    preset: null,
    user: null,
    profile: null,
    sessions: [],
    presetAvatars: PRESET_AVATARS,
  }

  applyPreset('signed-in-eligible')

  window.__review = async function (screenName) {
    const renderer = renderers[screenName]
    if (!renderer) {
      throw new Error(`No renderer registered for screen "${screenName}". Known: ${Object.keys(renderers).join(', ')}`)
    }
    return renderer()
  }

  window.__reviewSetFixtures = function (partial) {
    if (!partial) return
    if (partial.preset) {
      applyPreset(partial.preset)
    }
    if (partial.profile) {
      Object.assign(tables.profiles[0] || (tables.profiles[0] = {}), partial.profile)
      window.__reviewFixtures.profile = clone(tables.profiles[0])
      if (installedSetUser) installedSetUser(window.__reviewFixtures.user, window.__reviewFixtures.profile)
    }
    if (partial.sessions) {
      tables.sessions = partial.sessions.map(clone)
      window.__reviewFixtures.sessions = tables.sessions.slice()
    }
  }

  return { tables }
}
