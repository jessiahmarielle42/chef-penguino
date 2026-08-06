import './style.css'
import { supabase } from './supabaseClient.js'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL
// Standard blank profile picture shown when a user hasn't chosen an avatar
// (or an admin removes theirs) - a neutral silhouette, like other apps.
const DEFAULT_AVATAR = `${BASE}assets/default-avatar.svg`
const APP_VERSION = 'v2.5.2.1'

const STORAGE_KEY = 'chef-penguino-save'

// Native "Add to Home Screen" install support - capability detection, NOT
// browser sniffing. Chromium-family browsers (desktop/Android Chrome, Edge,
// Brave, Samsung Internet...) fire `beforeinstallprompt` when the page meets
// install criteria (manifest + service-worker-less PWA still qualifies with
// just a manifest in modern Chrome); we stash that event and can replay it
// on demand via .prompt(). Anything that never fires it - iOS Safari,
// Firefox, or a Chromium instance that already installed the app - simply
// leaves deferredInstallPrompt null, and callers fall back to the manual
// tutorial. Checking navigator.userAgent instead would be wrong: it can't
// tell us whether the browser will actually honor a prompt() call, only
// what it claims to be, and UA strings drift/lie across versions and
// embedded webviews. Presence of the real event is the only thing that
// reliably answers "can I install this right now?".
let deferredInstallPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
})
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null
})

// Single source of truth for which destructive confirms play the
// barrel-explosion clip (see playDeleteClip()). Action-based, not
// person-based, and deliberately excludes account deletion, admin-only
// confirms, and step 1 of the two-step group deletion.
const DELETE_CLIP_ACTIONS = ['remove-friend', 'leave-group', 'delete-group', 'delete-account']

// Client-side hiding of the Admin Dashboard entry point only - real
// enforcement lives in Supabase RLS (see migration_admin.sql), which checks
// auth.email() server-side and can't be spoofed from here.
const ADMIN_EMAIL = 'keefefons@gmail.com'
function isAdmin() { return currentUser?.email === ADMIN_EMAIL }

let currentUser = null
let currentProfile = null

// Best-known count of unread items (warnings + system_notifications) for the
// signed-in user, driving both the bottom tab-bar dot and the Settings row
// badge. Refreshed via refreshNotifBadges() - see the "System Notifications"
// section below.
let notifUnread = 0

// Whichever of renderHome() / renderHistory() is currently on screen, so a
// session edit or delete (fired from either screen's swipe actions or the
// History day-sheet) refreshes the right one instead of always bouncing back
// to Home.
let afterLogChange = renderHome

// ---------- auth / profile / supabase plumbing (unchanged mechanics) ----------
async function signInWithGoogle() {
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + BASE,
      // Always show Google's account chooser. Without this Google silently
      // reuses whichever account is already signed in, which is confusing for
      // anyone with more than one - and actively misleading right after an
      // account deletion, where being dropped instantly into a fresh account
      // bearing the same name and picture looks like the deletion failed.
      queryParams: { prompt: 'select_account' },
    },
  })
}

async function signInWithApple() {
  // Apple provider isn't enabled yet - show an "under construction" notice
  // instead of triggering an OAuth flow that would error. Swap this back to
  // supabase.auth.signInWithOAuth({ provider: 'apple', ... }) once it's set up.
  toast('Sign in with Apple is coming soon! 🚧')
}

// Wire both OAuth buttons on a given root (element or app).
function wireSignInButtons(root) {
  if (!root) return
  root.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
  root.querySelector('[data-action="apple"]')?.addEventListener('click', signInWithApple)
}

async function signOut() {
  unsubscribeFromSocial()
  await supabase.auth.signOut()
  currentUser = null
  currentProfile = null
  applySavedSoundtrack() // no profile anymore - revert to the default track
  clearNotifBadges()
  renderHome()
}

async function refreshProfile() {
  if (!currentUser) { currentProfile = null; return }
  // Falls back to the pre-migration column set if `task_type_labels` doesn't
  // exist yet (migration_task_types.sql hasn't been run), so the profile still
  // loads and the app doesn't break for signed-in users before the migration.
  // Same reasoning covers `soundtrack` (migration_soundtrack.sql) - it's
  // simply absent from the fallback select, so a pre-migration profile loads
  // fine and soundtrackById(undefined) treats it as the default track.
  let { data } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code, pizzas, avatar_url, owned_emotes, equipped_emote, coin_adjustment, task_type_labels, level_seen, waving_free, onboarding_done, onboarding_coin_claimed, soundtrack')
    .eq('id', currentUser.id)
    .single()
  if (!data) {
    ({ data } = await supabase
      .from('profiles')
      .select('id, display_name, friend_code, pizzas, avatar_url, owned_emotes, equipped_emote, coin_adjustment, level_seen')
      .eq('id', currentUser.id)
      .single())
  }
  currentProfile = data || null
  if (currentProfile && !Array.isArray(currentProfile.owned_emotes)) currentProfile.owned_emotes = []
  applySavedSoundtrack()
}

async function migrateLocalDataIfNeeded() {
  if (state.cloudSynced) return
  if (state.log.length > 0) {
    const rows = state.log.map(e => ({
      user_id: currentUser.id,
      completed_at: new Date(e.completedAt).toISOString(),
      minutes: e.minutes,
      pizzas: e.pizzas,
      task: e.task || '',
    }))
    await supabase.from('sessions').insert(rows)
  }
  // Carry a grandfathered guest's free waving into the new profile.
  // profiles.waving_free defaults to false server-side (new economy: fresh
  // signups buy waving with the tour coin), which is exactly right for a
  // guest whose captureGuestWavingFreeIfNeeded() flag came back false - no
  // write needed, they simply arrive not owning it, same as any new signup.
  // Only a LEGACY guest (flag true - had activity before this flag existed)
  // needs an explicit write here, once, on this first-ever migration, or
  // they'd silently lose the free waving they already had.
  if (state.guestWavingFree) {
    await supabase.from('profiles').update({ waving_free: true }).eq('id', currentUser.id)
  }
  // Carry a guest's completed onboarding-tour purchase (completeOnboardingPurchase())
  // into the new profile - a guest who bought waving with the tour's free
  // coin locally must arrive server-side owning it at the SAME net-zero
  // (owned_emotes + a matching coin_adjustment), not lose it on sign-in.
  // Guarded by state.onboardingCoinClaimed exactly like
  // completeOnboardingPurchase() itself is, so this can't double-grant even
  // if migrateLocalDataIfNeeded() somehow ran twice. Assumes a genuinely
  // fresh profile row here (owned_emotes/coin_adjustment both start at
  // their column defaults - empty/0 - for a brand-new signup), so a direct
  // set is safe rather than an array_append/increment.
  if (state.onboardingCoinClaimed && state.ownedEmotes?.includes('waving') && (state.coinAdjustment || 0) > 0) {
    await supabase.from('profiles').update({
      owned_emotes: ['waving'],
      coin_adjustment: state.coinAdjustment,
      equipped_emote: 'waving',
      onboarding_coin_claimed: true,
    }).eq('id', currentUser.id)
  }
  state.cloudSynced = true
  save()
}

async function handleSignedIn(user) {
  currentUser = user
  await migrateLocalDataIfNeeded()
  await flushPendingSessions()
  await refreshProfile()
  await ensureStarterAvatar()
  await ensureAvatarWithinLevel()
  subscribeToSocial()
}

// A chef with no picture yet gets the first rung of the ladder - the level 1
// preset - rather than the grey silhouette. That picture is the starting look,
// not a placeholder, so it's written to the profile like any other choice.
// Level 1 is always unlocked (level_for_pizzas never returns less than 1), so
// the avatar-unlock trigger accepts it.
async function ensureStarterAvatar() {
  if (!currentUser || !currentProfile || currentProfile.avatar_url) return
  const { data } = await supabase
    .from('preset_avatars')
    .select('url, unlock_level')
    .order('unlock_level', { ascending: true })
    .limit(1)
  const starter = data && data[0]
  if (!starter || (starter.unlock_level || 1) > 1) return
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: starter.url })
    .eq('id', currentUser.id)
  if (!error) currentProfile.avatar_url = starter.url
}

// Moves a chef out of a picture that's above their level and into the best one
// they've actually earned. Reachable whenever a picture's unlock_level is
// raised after someone equipped it - the DB trigger only validates avatar_url
// on change, so an already-equipped picture is never revoked server-side.
// Without this the picker showed one more unlocked picture than was earned.
async function ensureAvatarWithinLevel() {
  if (!currentUser || !currentProfile || !currentProfile.avatar_url) return
  const level = myLevel()
  if (level == null) return
  const { data } = await supabase.from('preset_avatars').select('url, unlock_level')
  if (!data || !data.length) return
  const mine = data.find(p => p.url === currentProfile.avatar_url)
  // Not a preset (custom upload / legacy value), or already within level.
  if (!mine || (mine.unlock_level || 1) <= level) return
  const best = data
    .filter(p => (p.unlock_level || 1) <= level)
    .sort((a, b) => (b.unlock_level || 1) - (a.unlock_level || 1))[0]
  if (!best) return
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: best.url })
    .eq('id', currentUser.id)
  if (!error) currentProfile.avatar_url = best.url
}

// Live push (Supabase Realtime) for incoming Noots and coin gifts, so they
// appear near-instantly instead of only on app reload. On (re)subscribe we
// also run a catch-up check, which covers anything inserted while the socket
// was down (backgrounded, network blip). Requires the noots + coin_gifts
// tables to be in the supabase_realtime publication (see migration_realtime.sql).
let socialChannel = null
function subscribeToSocial() {
  if (!currentUser) return
  unsubscribeFromSocial()
  const uid = currentUser.id
  socialChannel = supabase
    .channel(`social-${uid}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'noots', filter: `recipient_id=eq.${uid}` }, () => checkPendingNoots())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'coin_gifts', filter: `recipient_id=eq.${uid}` }, () => checkPendingCoinGifts())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'warnings', filter: `user_id=eq.${uid}` }, () => { checkPendingWarnings(); refreshNotifBadges() })
    // system_notifications are announcements, not interruptions - unlike a
    // warning, a new one never pops a popup. Just keep the unread badges
    // (tab bar + Settings row) fresh; see migration_system_notifications.sql.
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'system_notifications', filter: `user_id=eq.${uid}` }, () => refreshNotifBadges())
    // Admin "unsend" (see migration_unsend_messages.sql) hard-deletes rows.
    // DELETE payloads may not carry the old row (needs REPLICA IDENTITY
    // FULL), so treat this purely as a "something changed, refetch" signal:
    // refresh the badge count always, and if the user is currently looking
    // at their System Notifications page, reload it so the unsent item
    // vanishes live instead of only on next visit.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'system_notifications' }, () => {
      refreshNotifBadges()
      if (systemNotificationsPageOpen && app.querySelector('#notif-sys-list')) loadSystemNotificationsPage()
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'warnings' }, () => {
      refreshNotifBadges()
      if (systemNotificationsPageOpen && app.querySelector('#notif-sys-list')) loadSystemNotificationsPage()
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') { checkPendingNoots(); checkPendingCoinGifts(); checkPendingWarnings(); refreshNotifBadges() }
    })
}
function unsubscribeFromSocial() {
  if (socialChannel) { supabase.removeChannel(socialChannel); socialChannel = null }
}

// Sessions that failed to reach Supabase (offline, dropped connection, etc.)
// are queued here so nothing gets silently lost, and retried on next sign-in.
async function flushPendingSessions() {
  if (!currentUser || !state.pendingSessions?.length) return
  const remaining = []
  for (const row of state.pendingSessions) {
    const { error } = await supabase.from('sessions').insert({ ...row, user_id: currentUser.id })
    if (error) remaining.push(row)
  }
  state.pendingSessions = remaining
  save()
}

function displayPizzas() {
  return currentProfile ? currentProfile.pizzas : state.pizzas
}

// ---------------------------------------------------------------
// Singapore-time day/week boundaries.
//
// Chef Penguino's users are all in Singapore, so "today" and "this week"
// must roll over at midnight Asia/Singapore, not at midnight in whatever
// timezone the viewer's (or admin's) device happens to be set to. Singapore
// is a FIXED UTC+8 offset with no daylight saving, ever - so a plain +8h
// shift is correct and much simpler/safer than Intl timezone lookups.
//
// Technique: shift the UTC instant by +8h so its *UTC* getters read as SGT
// wall-clock time, do the flooring/date maths against those UTC getters
// (which never touch the device's local timezone), then shift back by -8h
// to recover the real UTC instant. Every helper below returns a genuine
// Date (a UTC instant), safe to compare/store via .toISOString() against
// sessions.completed_at (timestamptz, stored in UTC).
//
// Worked example: 2026-07-29T15:30:00Z -> +8h -> 2026-07-29T23:30 "SGT
// wall-clock" (still the 29th), so sgtStartOfDay(...) floors to
// 2026-07-29T00:00 SGT -> -8h -> 2026-07-28T16:00:00Z. (23:30 SGT on the
// 29th really is still the 29th in Singapore, so its start-of-day is
// midnight SGT on the 29th, i.e. 16:00 UTC the day before.)
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000

// UTC instant of 00:00 Singapore time on the SGT calendar day containing
// the instant `d`.
function sgtStartOfDay(d = new Date()) {
  const shifted = new Date(d.getTime() + SGT_OFFSET_MS)
  const flooredUTC = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(flooredUTC - SGT_OFFSET_MS)
}

// UTC instant of 00:00 Singapore time on the Monday of the SGT week
// containing the instant `d`.
function sgtStartOfWeek(d = new Date()) {
  const dayStart = sgtStartOfDay(d)
  const shifted = new Date(dayStart.getTime() + SGT_OFFSET_MS) // back to SGT wall-clock to read the weekday
  const dow = shifted.getUTCDay() // 0=Sun..6=Sat
  const mondayOffset = (dow + 6) % 7 // 0=Mon..6=Sun
  return new Date(dayStart.getTime() - mondayOffset * 86400000)
}

// { y, mo, day } of the SGT calendar date that the instant `d` falls on -
// the building block for admin-calendar day keys / anchoring "today" in
// Singapore time instead of the device's local date.
function sgtDateParts(d = new Date()) {
  const shifted = new Date(d.getTime() + SGT_OFFSET_MS)
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), day: shifted.getUTCDate() }
}

// UTC instant of 00:00 Singapore time for an explicit SGT calendar date (y,
// 0-based mo, d) - used to build query-range boundaries (e.g. "1st of this
// month, SGT" .. "1st of next month, SGT") directly from calendar numbers,
// without ever routing through a device-local Date first.
function sgtDateFromYMD(y, mo, d) {
  return new Date(Date.UTC(y, mo, d) - SGT_OFFSET_MS)
}

// Start of the current SGT week (Monday 00:00 Singapore time). The weekly
// leaderboards/scoreboards sum only sessions completed since this instant,
// so they naturally "reset" every Monday (Singapore time) without any
// stored state or cron - the window just moves forward and last week's
// pizzas fall off.
function startOfThisWeek() {
  return sgtStartOfWeek()
}

// Date of the upcoming Monday (when the weekly leaderboard resets, in
// Singapore time), e.g. "27 Jul". If today is Monday (SGT), the current
// week resets next Monday (7 days out) - adding 7 days to *this* SGT week's
// Monday always lands on the correct upcoming reset Monday either way.
function nextMondayLabel() {
  const next = new Date(sgtStartOfWeek().getTime() + 7 * 86400000)
  const { mo, day } = sgtDateParts(next)
  return `${day} ${CAL_MONTHS_SHORT[mo]}`
}

const DURATIONS = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
]

// ---------- Task types ----------
// Five fixed-emoji task categories (priority order). The emoji<->key mapping is
// permanent and never user-editable; only the title + description labels can be
// overridden per-user (profiles.task_type_labels JSONB for signed-in users,
// state.taskTypeLabels for guests). See migration_task_types.sql.
const TASK_TYPES = [
  { key: 'deep',     emoji: '🍅', title: 'Deep Work',        desc: 'Impt projects, studying, etc.' },
  { key: 'shallow',  emoji: '🥦', title: 'Admin',             desc: 'Emails, errands, etc.' },
  { key: 'chores',   emoji: '🍄‍🟫', title: 'Chores',           desc: '' },
  { key: 'exercise', emoji: '🧀', title: 'Exercise',         desc: '' },
  { key: 'planning', emoji: '🥖', title: 'Other',            desc: '', fixed: true },
]
const TASK_TYPE_EMOJI = Object.fromEntries(TASK_TYPES.map(t => [t.key, t.emoji]))
const TASK_TITLE_MAX = 10
const TASK_DESC_MAX = 45

// Where per-user label overrides live: currentProfile.task_type_labels when
// signed in, else the guest's local state. Shape: { deep: {title, desc}, ... }.
function taskLabelOverrides() {
  const src = currentProfile ? currentProfile.task_type_labels : state.taskTypeLabels
  return (src && typeof src === 'object') ? src : {}
}

// Default labels overlaid with any per-user override. An override title only
// wins if non-empty (so clearing a title falls back to the default, never
// blank); description may be intentionally empty. Both are length-clamped.
function resolvedTaskTypes() {
  const ov = taskLabelOverrides()
  return TASK_TYPES.map(t => {
    const o = ov[t.key] || {}
    const title = t.fixed
      ? t.title
      : ((typeof o.title === 'string' && o.title.trim()) ? o.title.trim().slice(0, TASK_TITLE_MAX) : t.title)
    const desc = (typeof o.desc === 'string')
      ? o.desc.slice(0, TASK_DESC_MAX) : t.desc
    return { key: t.key, emoji: t.emoji, title, desc, fixed: !!t.fixed }
  })
}

function taskTypeLabel(key) {
  return resolvedTaskTypes().find(t => t.key === key) || null
}

// Persist label overrides (profile column for signed-in, localStorage for guest).
async function saveTaskTypeLabels(overrides) {
  if (currentProfile) {
    currentProfile.task_type_labels = overrides
    const { error } = await supabase.from('profiles').update({ task_type_labels: overrides }).eq('id', currentUser.id)
    if (error) throw error
  } else {
    state.taskTypeLabels = overrides
    save()
  }
}

const state = load()

// Grandfathers waving-emote ownership for GUESTS the same way
// maybeAutoStartOnboardingTour() grandfathers onboardingDone: captured ONCE,
// at boot, before any tour/purchase activity this session can touch it, so
// it can never be flipped true later by tour steps or test runs. A guest
// with prior activity (pizzas baked or a session logged) already had free
// waving under the old blanket-grandfather rule and keeps it; a genuinely
// fresh install gets false and must buy waving with the tour coin like any
// new signed-in signup. Runs unconditionally at load (not gated on guest
// status) - it's about this device's local save, not the current session's
// auth state, and a later sign-in reads it via the guest branch below.
function captureGuestWavingFreeIfNeeded() {
  if (state.guestWavingFree !== undefined) return
  state.guestWavingFree = displayPizzas() > 0 || (state.log && state.log.length > 0)
  save()
}
captureGuestWavingFreeIfNeeded()

function load() {
  const defaults = {
    pizzas: 0, muted: false, volume: 0.5, lastVolume: 0.5, darkenLevel: 1, autoDarken: true,
    timer: null, log: [], cloudSynced: false, lastSeenPizzaCount: null,
    pendingSessions: [], ownedEmotes: [], equippedEmote: 'waving', lastSeenCoins: null,
    lightMode: false, taskTypeLabels: {}, deleteAnimations: true, onboardingDone: false,
    lastHomescreenPromptAt: null, homescreenPromptDismissedForever: false,
    // Undefined until captureGuestWavingFreeCaptured() runs once at boot -
    // NOT defaulted true/false here so that helper can tell "never captured
    // yet" apart from an already-decided false.
    guestWavingFree: undefined,
    // Guest-side mirror of profiles.coin_adjustment (see coinAdjustment())
    // and profiles.onboarding_coin_claimed (see completeOnboardingPurchase())
    // - lets a guest's tour purchase stay net-zero on the local derived
    // balance and idempotent across a re-run, exactly like the signed-in RPC.
    coinAdjustment: 0,
    onboardingCoinClaimed: false,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const merged = { ...defaults, ...JSON.parse(raw) }
      if (merged.muted) merged.volume = 0
      return merged
    }
  } catch {}
  return defaults
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

// The status bar area behind an installed web app is painted with theme-color,
// so it has to track the theme or the notch strip ends up a different colour
// from the app under it - it was pinned to the brand gold, which iOS rendered
// as a pale strip above a dark app.
// Deliberately NOT apple-mobile-web-app-status-bar-style=black-translucent, the
// usual answer: that forces the status bar TEXT to always be light, which is
// unreadable against the light theme. index.html now ships `default`
// instead, which lets iOS pick legible text for whichever background we
// hand it via theme-color.
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.lightMode ? 'light' : 'dark')
  syncThemeColorMeta()
}

// Vanilla-JS equivalent of a "ThemeColorSync" component: keeps
// <meta name="theme-color"> in step with the ACTUAL resolved page
// background, read straight off the --page-bg custom property, rather than
// duplicating its hex values in JS (the old approach here, which could
// silently drift out of sync with style.css). Deliberately NOT
// getComputedStyle(document.body).backgroundColor - html/body's background
// is set via the `background: linear-gradient(...)` SHORTHAND (see
// style.css), which only sets background-image; backgroundColor stays
// 'rgba(0, 0, 0, 0)' regardless of theme, so reading it would silently do
// nothing.
// True only for the one configuration that shows a dead strip under the tab
// bar: an iOS Home-Screen (standalone) install whose webview iOS runs INSET -
// shorter than the physical screen - so ~a status bar's worth of screen at
// the bottom sits OUTSIDE the webview where no CSS can paint. Which installs
// get the inset webview depends on the iOS version the app was added under
// (Apple moved standalone rendering to the manifest around iOS 16.4 and
// changed status-bar handling with it), so two iPhones on the same code can
// disagree. Detected from geometry, not UA sniffing:
//   - navigator.standalone === true  -> iOS standalone ONLY (property doesn't
//     exist on Android/desktop, false in Safari tabs) - Android and every
//     browser tab are excluded by construction and stay untouched
//   - portrait                       -> screen.height on iOS is orientation-
//     fixed; comparing it to innerHeight in landscape would false-positive
//   - strip > 20px                   -> full-screen installs measure 0 and
//     stay untouched (the healthy case keeps its exact current behaviour)
function iosInsetStandaloneStrip() {
  if (typeof navigator.standalone === 'undefined' || navigator.standalone !== true) return 0
  if (innerWidth > innerHeight) return 0
  const strip = (screen.height || 0) - innerHeight
  return strip > 20 ? strip : 0
}

// The strip can't be painted, but iOS colours it with the page's theme-color
// (device-verified: the strip sampled exactly #120c09 in dark mode - the
// theme-color value - on the affected iPhone 13 Pro Max). So when the strip
// exists, publish the TAB BAR's colour as theme-color instead of the page
// background: the strip then reads as the tab bar extending to the physical
// bottom edge and the seam disappears. The tab bar's CSS colour is
// translucent (backdrop blur), so composite it over the page bg first to get
// the solid colour iOS needs.
function resolvedTabbarColor(pageBg) {
  const tb = app.querySelector('.tabbar')
  if (!tb) return null
  const raw = getComputedStyle(tb).backgroundColor
  const m = raw.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/)
  if (!m) return null
  const a = m[4] === undefined ? 1 : parseFloat(m[4])
  const pm = pageBg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  const base = pm ? [parseInt(pm[1], 16), parseInt(pm[2], 16), parseInt(pm[3], 16)] : [0, 0, 0]
  const ch = (i) => Math.round(parseFloat(m[1 + i]) * a + base[i] * (1 - a))
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`
}

function syncThemeColorMeta() {
  let bg = getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim()
  if (!bg) return
  if (iosInsetStandaloneStrip()) {
    const tbColor = resolvedTabbarColor(bg)
    if (tbColor) bg = tbColor
  }
  // index.html ships a light/dark `prefers-color-scheme`-scoped theme-color
  // pair so the very first paint is right before this script runs. Those
  // MUST be removed the moment we take over: the browser uses the FIRST
  // theme-color meta whose media matches, not the last. With the OS in dark
  // mode, the media="(prefers-color-scheme: dark)" tag matched and won
  // outright, so an in-app switch to light mode never reached the status
  // bar - it tracked the OS setting forever. Dropping them leaves exactly
  // one unconditional meta as the single source of truth, which is what the
  // in-app toggle needs to drive.
  document.querySelectorAll('meta[name="theme-color"][media]').forEach(m => m.remove())
  let meta = document.querySelector('meta[name="theme-color"]:not([media])')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.appendChild(meta)
  }
  meta.setAttribute('content', bg)
}
applyTheme()
// Belt and braces: re-syncs on ANY attribute change to <html> that could
// affect --page-bg, not just the ones applyTheme() itself makes - this
// app's toggle only ever sets data-theme (confirmed at the setAttribute
// call above), so `class` never actually changes, but it's included
// defensively in case a future code path flips theme some other way.
new MutationObserver(syncThemeColorMeta).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class', 'data-theme'],
})

// ---------- App-wide background music (persists across screens) ----------
// Volume is driven through a Web Audio gain node rather than
// HTMLMediaElement.volume, because iOS Safari silently ignores .volume on
// <audio>/<video> elements (it only respects the hardware volume buttons).
// A GainNode's gain still works there since it's just math on the samples.
const bgMusic = new Audio(`${BASE}assets/bg-music.mp3`)
bgMusic.loop = true

const AudioContextClass = window.AudioContext || window.webkitAudioContext
const audioCtx = AudioContextClass ? new AudioContextClass() : null
let musicGain = null
if (audioCtx) {
  const source = audioCtx.createMediaElementSource(bgMusic)
  musicGain = audioCtx.createGain()
  source.connect(musicGain).connect(audioCtx.destination)
}

// True while something else legitimately owns audio focus (a lore video
// playing with its own sound) - syncMusic() must not resume bgMusic while
// this is set, see the comment on the global click listener below.
let musicSuspendedByOther = false

// True only while the Background Music picker has a preview actively
// playing. Lets a muted chef still hear the track they're auditioning
// (at a low, non-persisted volume) without ever touching state.muted or
// state.volume - their real saved prefs come straight back the moment the
// preview ends (see teardownSoundtrackPreview()).
let soundtrackPreviewBoost = false

// True while the chef has deliberately paused a picker preview. Needed for
// the same reason as musicSuspendedByOther: the global document-click
// listener below re-runs syncMusic() on the very tap that paused the
// preview, and without this flag it would call bgMusic.play() again and
// undo the pause before the finger even lifts.
let soundtrackPreviewPaused = false

function syncMusic() {
  const previewVol = soundtrackPreviewBoost && state.muted ? 0.4 : state.volume
  if (musicGain) musicGain.gain.value = previewVol
  else bgMusic.volume = previewVol
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  if ((state.muted && !soundtrackPreviewBoost) || musicSuspendedByOther || soundtrackPreviewPaused) bgMusic.pause()
  else bgMusic.play().catch(() => {})
}

// Re-sync on every tap rather than once - any interruption (an intro video
// with its own sound taking over the audio focus, backgrounding the tab,
// etc.) would otherwise leave the music paused with nothing to resume it.
// This ALSO fires on the very tap that opens a lore video (the click bubbles
// from the card up to document) and on every tap inside the lore player
// itself - which is exactly why playLoreVideo() sets musicSuspendedByOther
// rather than relying on bgMusic.pause() alone: without that flag this
// listener would immediately call bgMusic.play() again on that same click
// and undo the pause before the video even finished opening.
document.addEventListener('click', () => syncMusic())

// Backgrounding the tab (switching apps, locking the phone) auto-pauses
// <audio> and suspends the AudioContext - that part is the browser's own
// background-audio policy and isn't something a website can override, so
// music stopping WHILE backgrounded is expected. What was missing is the
// return trip: the only resume path was the next document click, which can
// be seconds away or may never land (e.g. coming straight back into an
// already-running focus session with nothing to tap). Catch every signal a
// browser uses for "foregrounded again" so the very first frame back syncs
// it, instead of waiting on an incidental tap.
;['visibilitychange', 'pageshow', 'focus'].forEach((evt) => {
  window.addEventListener(evt, () => { if (!document.hidden) syncMusic() })
})

// Also wires the OS-level lock-screen/notification-shade media controls
// (and CarPlay/Bluetooth "play" buttons) to the same resume path, and gives
// the browser a clearer signal this tab has an active "now playing" session
// - which on some platforms (mainly Android Chrome) makes it less eager to
// fully tear down playback in the background in the first place.
if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Chef Penguino',
    artist: 'Kitchen ambience',
  })
  navigator.mediaSession.setActionHandler('play', () => syncMusic())
  navigator.mediaSession.setActionHandler('pause', () => { state.muted = true; save(); syncMusic() })
}

// ---------- Background Music picker (settings -> soundtrack) ----------
// `id: null` is the shipped default track - it deliberately reuses the exact
// src bgMusic was constructed with above, so applySavedSoundtrack() below is
// a no-op for every chef who never opens the picker.
const SOUNDTRACKS = [
  { id: null, title: 'Chef Penguino Theme', isDefault: true, src: `${BASE}assets/bg-music.mp3`, art: `${BASE}assets/icon-512.png` },
  { id: 'handpan', title: 'Handpan', src: `${BASE}assets/soundtracks/handpan.mp3`, art: `${BASE}assets/soundtracks/handpan.jpg` },
  { id: 'lofi-girl', title: 'Lofi Girl', src: `${BASE}assets/soundtracks/lofi-girl.mp3`, art: `${BASE}assets/soundtracks/lofi-girl.jpg` },
  { id: 'plants-vs-zombies', title: 'Plants vs Zombies', src: `${BASE}assets/soundtracks/plants-vs-zombies.mp3`, art: `${BASE}assets/soundtracks/plants-vs-zombies.jpg` },
  { id: 'sad-mouse', title: 'Sad Mouse', src: `${BASE}assets/soundtracks/sad-mouse.mp3`, art: `${BASE}assets/soundtracks/sad-mouse.jpg` },
]
function soundtrackById(id) { return SOUNDTRACKS.find(t => (t.id || null) === (id || null)) || SOUNDTRACKS[0] }

// The src bgMusic is *supposed* to be playing right now, per the signed-in
// chef's saved profile (or the default, for guests/no-selection). Tracked
// separately from bgMusic.src itself because the picker temporarily points
// bgMusic.src at whatever track is being previewed - this is what
// teardownSoundtrackPreview() restores on the way out.
// Always stored as an ABSOLUTE url (what bgMusic.src reflects back), never
// the relative `${BASE}…` form in SOUNDTRACKS - comparing the two forms
// directly would always mismatch and needlessly restart playback from 0:00.
const soundtrackAbsUrl = (src) => new URL(src, document.baseURI).href
let currentTrackSrc = bgMusic.src

function updateMediaSessionTrack(title) {
  if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Chef Penguino' })
  }
}

// Swaps bgMusic to the chef's saved soundtrack, if it isn't already playing
// it - never constructs a new Audio(), just repoints .src (see the module
// comment above bgMusic's own declaration for why that matters on iOS).
// Skipped entirely when nothing actually changed, so a routine profile
// refresh (e.g. the realtime resync in subscribeToSocial()) doesn't restart
// playback from 0:00 on every poll.
function applySavedSoundtrack() {
  const saved = soundtrackById(currentProfile?.soundtrack)
  const abs = soundtrackAbsUrl(saved.src)
  if (abs === currentTrackSrc) return
  currentTrackSrc = abs
  bgMusic.src = abs
  bgMusic.loop = true
  updateMediaSessionTrack(saved.title)
  syncMusic()
}

// Tactile tap feedback (see the matching CSS rule in style.css): iOS Safari
// can take ~300ms to apply :active on non-form elements while it waits to
// see if the touch turns into a scroll, which reads as laggy. Toggling a
// .pressed class straight off pointerdown/pointerup is instant instead.
function pressTarget(e) { return e.target.closest('button:not(:disabled), [role="button"]') }
document.addEventListener('pointerdown', (e) => { pressTarget(e)?.classList.add('pressed') }, { passive: true })
;['pointerup', 'pointercancel'].forEach(type => {
  document.addEventListener(type, () => {
    document.querySelectorAll('.pressed').forEach(el => el.classList.remove('pressed'))
  }, { passive: true })
})

function round2(n) { return parseFloat(n.toFixed(2)) }
function round1(n) { return parseFloat(n.toFixed(1)) }
function formatScore(n) { return String(round2(n)) }
function signedScore(n) { return (n > 0 ? '+' : '') + formatScore(n) }
function formatScore1(n) { return String(round1(n)) }
function formatScoreFixed2(n) { return round2(n).toFixed(2) }

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function formatDuration(minutes) {
  // Admin pizza deductions produce negative durations; format the magnitude
  // with a leading minus so the row reads e.g. "-1h".
  const sign = minutes < 0 ? '-' : ''
  const m = Math.round(Math.abs(minutes))
  if (m < 60) return `${sign}${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return sign + (rem ? `${h}h ${rem}m` : `${h}h`)
}

function formatWorkedDuration(minutes) {
  const m = Math.round(minutes)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h${rem}min` : `${h}h`
}

// Kept at full precision (not rounded) so that several short sessions in a
// row still accumulate toward the next 0.01 instead of each one's tiny
// fraction being rounded away to 0 and lost. Rounding only happens at
// display time, via formatScore()/formatScoreFixed2().
function addSessionPizzas(minutes) {
  state.pizzas = state.pizzas + minutes / 60
  save()
}

// Tracks the id of whichever session entry was most recently logged, so
// callers that need to reference "the session that was JUST created" (the
// onboarding tour's swipe-row/tap-delete/confirm-delete steps) can read it
// directly instead of guessing which log entry is newest after the fact -
// a guess that's wrong whenever some other real entry happens to sort
// newer, or an async re-fetch resolves before the new session has landed.
// Set on BOTH write paths: here (guest/local), and in finalizeSession()'s
// signed-in branch, where it's overwritten with the ACTUAL persisted
// Supabase row id (which is server-generated, not the client's
// crypto.randomUUID() - the two are never the same id for a signed-in
// chef, since the local entry() below is written unconditionally by
// finalizeSession() too, purely for symmetry/backward-compat, but isn't
// what fetchLog() actually returns for a signed-in chef).
let lastLoggedSessionId = null

function logSession({ completedAt, minutes, pizzas, task, icon, type }) {
  const entry = { id: crypto.randomUUID(), completedAt, minutes, pizzas, task }
  if (icon) entry.icon = icon
  if (type) entry.type = type
  state.log.unshift(entry)
  lastLoggedSessionId = entry.id
  save()
}

// Records a "Coin earned!" marker in the session log so the pizza -> coin
// conversion is visible to the user. Stored like the admin coin rows (0 min,
// 0 pizzas, amount carried in the task label) so no schema change is needed;
// rendered non-editable (see isCoinEntry). Timestamped just after the session
// that earned it so it sorts directly above it in the log.
async function logCoinConversion(count, completedAt) {
  if (count < 1) return
  const label = `Coin earned! (+${count} coin${count === 1 ? '' : 's'})`
  const ts = completedAt + 1000
  if (currentUser) {
    await insertSessionRow({ user_id: currentUser.id, completed_at: new Date(ts).toISOString(), minutes: 0, pizzas: 0, task: label, icon: '🪙' })
  } else {
    logSession({ completedAt: ts, minutes: 0, pizzas: 0, task: label, icon: '🪙' })
  }
}

async function finalizeSession(playAlarm) {
  const t = state.timer
  const minutes = t.elapsedMs / 60000
  const pizzasEarned = minutes / 60 // full precision - see addSessionPizzas
  const completedAt = Date.now()
  // Base total BEFORE this session (DB value for signed-in, local for guest),
  // used to detect whether this session pushes the user across a 12-pizza coin
  // threshold.
  const oldTotal = Number(displayPizzas()) || 0
  const coinsBefore = Math.floor(Math.floor(oldTotal) / 12)
  addSessionPizzas(minutes)
  logSession({ completedAt, minutes, pizzas: pizzasEarned, task: t.task, type: t.type })
  state.timer = null
  save()
  setBakingNow(false)

  if (currentUser) {
    const row = {
      completed_at: new Date(completedAt).toISOString(),
      minutes,
      pizzas: pizzasEarned,
      task: t.task || '',
    }
    if (t.type) row.type = t.type
    // Retry without `type` if the column doesn't exist yet (migration_task_types
    // .sql not run) so a session is never lost to a schema mismatch.
    // .select('id').single() so lastLoggedSessionId can be overwritten with
    // the ACTUAL persisted row id (server-generated, not the client-side
    // crypto.randomUUID() the local logSession() call above assigned) - the
    // two are never the same id for a signed-in chef, and it's the server
    // id that fetchLog()/the day sheet actually renders.
    let { data, error } = await supabase.from('sessions').insert({ ...row, user_id: currentUser.id }).select('id').single()
    if (error && t.type) {
      const { type, ...rowNoType } = row
      ;({ data, error } = await supabase.from('sessions').insert({ ...rowNoType, user_id: currentUser.id }).select('id').single())
      if (error) { state.pendingSessions.push(rowNoType); save() }
    } else if (error) {
      state.pendingSessions.push(row)
      save()
    }
    // Neither the local guest-log id (meaningless here - fetchLog() never
    // reads state.log for a signed-in chef) nor a stale id from some
    // earlier session should survive an insert failure - null falls back
    // to the onboarding tour's unqualified selectors rather than pointing
    // at a session that was never actually written.
    lastLoggedSessionId = !error && data?.id ? data.id : null
    // Optimistically reflect the new total so the coin chip updates right away,
    // even if the profile refresh below lags or fails; refreshProfile() then
    // reconciles against the authoritative DB value.
    if (currentProfile) currentProfile.pizzas = oldTotal + pizzasEarned
    await refreshProfile()
  }

  const coinsAfter = Math.floor(Math.floor(oldTotal + pizzasEarned) / 12)
  if (coinsAfter > coinsBefore) await logCoinConversion(coinsAfter - coinsBefore, completedAt)

  // checkLevelUp() runs only after the results screen has been dismissed (or
  // immediately for a silent/background finalize with no results screen) so
  // a level-up popup never fights the tap-to-continue/results screen for it.
  if (playAlarm) renderTapToContinue(() => { renderHome(); checkLevelUp() }, true, { minutes, pizzas: pizzasEarned })
  else { renderHome(); checkLevelUp() }
}

// ---------- boot ----------
async function boot() {
  const { data } = await supabase.auth.getSession()
  if (data.session?.user) {
    await handleSignedIn(data.session.user)
    checkLevelUp()
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      handleSignedIn(session.user).then(() => {
        if (!state.timer) renderHome()
        checkLevelUp()
        checkPendingNoots()
        checkPendingCoinGifts()
        checkPendingWarnings()
        ensureBugFab()
      })
    } else if (event === 'SIGNED_OUT') {
      unsubscribeFromSocial()
      currentUser = null
      currentProfile = null
      clearNotifBadges()
      ensureBugFab()
    }
  })

  if (state.timer) {
    const t = state.timer
    if (t.segmentStartedAt != null) {
      const remaining = t.segmentPlannedMs - (Date.now() - t.segmentStartedAt)
      if (remaining > 0) {
        renderTimerLoop(false)
      } else {
        t.elapsedMs += t.segmentPlannedMs
        finalizeSession(true)
      }
    } else {
      renderTimerLoop(false)
    }
  } else {
    renderHome()
    // Auto-start the tour only on a fresh Home landing (never mid-session) -
    // see maybeAutoStartOnboardingTour(). The welcome step needs no DOM, and
    // later steps pick up the Home markup via the tour's own MutationObserver
    // once renderHome()'s async fetch finishes mounting it.
    maybeAutoStartOnboardingTour()
  }
  ensureBugFab()
  checkPendingNoots()
  checkPendingCoinGifts()
  checkPendingWarnings()
  installUiDebug()
}

// ---------------------------------------------------------------
// Review harness hook - headless screenshot review only, see app/review/.
// import.meta.env.VITE_REVIEW is only ever set by `VITE_REVIEW=1 npx vite
// build` (app/review/shots.mjs); it's statically undefined in every normal
// build, so this whole branch - including the dynamic import - is dead-code
// eliminated from production bundles (verified by grepping dist/ for the
// harness's fixture sentinel string as part of the build check).
// ---------------------------------------------------------------
if (import.meta.env.VITE_REVIEW) {
  import('../review/reviewHarness.js').then((mod) => mod.installReviewHarness({
    supabase,
    state,
    setUser: (user, profile) => { currentUser = user; currentProfile = profile },
    // Numeric test hooks for tour.mjs's onboarding-economics assertions
    // (displayed balance +1 after coin-popup, back to base after purchase,
    // owned state unchanged if the run is killed before purchase) - reading
    // coinBalance()/isOwned() straight off the module rather than scraping
    // rendered DOM text, since not every value that needs asserting (e.g.
    // ownership) has an on-screen number to scrape.
    getCoinBalance: coinBalance,
    getIsOwned: isOwned,
    renderers: {
      renderAdminDashboard, renderModerationCenter, renderSystemNotifications,
      renderComposeNotification, renderSettings, renderFriends,
      renderTaskTypesEditor, renderBugReports, renderHistory, renderHome, renderShop,
      renderAdminPizzasCal, renderAdminChefs, renderAdminUsers,
      renderAdminPresets, renderAdminEmotes, renderAdminGroupIcons,
      soundtrack: renderSoundtrackPicker,
      renderTypePicker: () => renderTypePicker(30, 'Essay writing'),
      openBugReport: () => { renderSettings(); return openBugReport() },
      startTypedTimer: () => startSession(30, 'Essay writing', 'deep'),
      openEditRecord: () => { renderHome(); logEntriesById.set('demo', { entry: { id: 'demo', task: 'Admin Edit (+1)', minutes: 60, pizzas: 1 }, icon: '🛠️' }); openEditLogPopup('demo') },
      openBugManage: () => { renderBugReports(); openBugManageMenu({ id: 'demo', status: 'open', sent_to_claude_at: null, reporter: { display_name: 'Jordan' }, description: 'test' }) },
      bugDismissedTab: () => { bugTab = 'dismissed'; renderBugReports() },
      ensureBugFab,
      // Chefs redesign: renderFriends() above only ever shows the default
      // Friends tab, so these give the review harness a way to reach the
      // other tabs/screens for screenshotting.
      renderChefsGroups: () => { chefsTab = 'groups'; renderChefsScreen() },
      renderChefsRequests: () => { chefsTab = 'requests'; renderChefsScreen() },
      renderChefsGroupDetail: () => { chefsTab = 'groups'; openChefsGroup('g1') },
      renderChefsGroupSettings: () => { chefsTab = 'groups'; openChefsGroupSettings('g1') },
      // Long name on purpose: exercises the banner's truncation + chevron.
      renderFriendPizzeria: () => renderFriendHome({ id:'u-2', display_name:'Wolfeschlegel', pizzas:412, avatar_url:null, equipped_emote:'waving' }),
      renderEmoteEdit: () => { renderAdminEmotes(); return openEmoteEditPopup(EMOTE_BY_ID['waving']) },
      renderChefsCreateGroup: async () => { chefsTab = 'groups'; renderChefsScreen(); await openCreateGroupPopup() },
      // g1's fixture members are Keefe/Waddles/Pip, and the friend fixtures are
      // Waddles/Skua/Nix - so this also exercises "already a member" filtering
      // (Waddles should not be offered).
      renderChefsGroupInvite: async () => {
        chefsTab = 'groups'; await openChefsGroup('g1')
        await openGroupInvitePopup('g1', 'Late Night Bakers', ['admin-1', 'u-2', 'u-3'])
      },
      // Level system (review-only entry points; see app/review/shots.mjs).
      // renderHome() is async (it awaits the session log fetch before
      // mounting) and mountScreen() replaces app.innerHTML wholesale - if the
      // popup's overlay gets appended before that mount finishes, the mount
      // wipes it straight back out. Await renderHome() to completion first so
      // the popup overlay is always the last thing appended to the DOM.
      levelPopup: async () => { await renderHome(); return openProfilePopup() },
      levelUpPopup: async () => { await renderHome(); return openLevelUpPopup(9, [window.__reviewFixtures.presetAvatars.find(p => p.unlock_level === 9)]) },
      levelUpPopupNoArt: async () => { await renderHome(); return openLevelUpPopup(9, []) },
      editPicture: () => { renderSettings(); return openEditPicturePopup() },
      lockedPreview: () => {
        renderSettings()
        const locked = window.__reviewFixtures.presetAvatars.find(p => p.unlock_level === 15)
        return openLockedPresetPreview(locked.url, locked.unlock_level)
      },
      // renderPresetGrid's remove (X) buttons are edit-mode only, gated
      // behind clicking "Edit Pictures" - drive that same real toggle here
      // (after waiting for the async preset fetch to populate the grid)
      // rather than reaching into presetEditMode directly, so this exercises
      // the actual click path.
      adminPresetsEdit: async () => {
        renderAdminPresets()
        for (let i = 0; i < 50 && !document.querySelector('#preset-grid .adm-preset-item'); i++) {
          await new Promise(r => setTimeout(r, 20))
        }
        document.querySelector('[data-action="toggle-preset-edit"]')?.click()
      },
      // Same real toggle path as adminPresetsEdit but for the new drag-to-
      // reorder "Arrange" mode, so this exercises the actual click handler.
      adminPresetsArrange: async () => {
        renderAdminPresets()
        for (let i = 0; i < 50 && !document.querySelector('#preset-grid .adm-preset-item'); i++) {
          await new Promise(r => setTimeout(r, 20))
        }
        document.querySelector('[data-action="toggle-preset-arrange"]')?.click()
      },
      // Not a screen to screenshot - a read-only escape hatch so Playwright
      // can assert the arrange-mode drag actually persisted new
      // unlock_levels, without fighting the fixture layer's .order() chain
      // (each chained .order() call re-sorts from scratch instead of
      // combining sort keys, so a second .order('created_at') call wipes out
      // an earlier .order('unlock_level') - a fixture quirk, not a real
      // Postgrest behavior, and irrelevant to what's actually persisted).
      getPresetLevels: () => presetAvatarsCache.map(p => ({ id: p.id, level: p.unlock_level })),
    },
  }))
} else {
  boot()
}

// =================================================================
//  Coin + emote economy (all derived from lifetime pizzas)
// =================================================================
const EMOTES = [
  { id: 'waving', name: 'Waving', desc: 'Your chef waves hello', clip: 'waving.mp4', free: true },
  { id: 'inspection', name: 'Inspection', desc: 'Checks pizza for quality', clip: 'inspection.mp4' },
  { id: 'spin-wheel', name: 'Spin Wheel', desc: 'Spins a pizza like a wheel', clip: 'spin-wheel.mp4' },
  { id: 'eating', name: 'Sneaky Bite', desc: 'Steals a slice for himself', clip: 'eating.mp4' },
  { id: 'lovey-talk', name: 'Lovey talk', desc: 'Whispers words of love to pizza', clip: 'lovey-talk.mp4' },
  { id: 'show-off', name: 'Show Off', desc: 'Juggles 2 pizzas for entertainment', clip: 'show-off.mp4' },
  { id: 'phase-through', name: "Physics? What's that?", desc: 'Phase through the shelf, coz you can.', clip: 'phase-through.mp4' },
  { id: 'happy-feet', name: 'Happy Feet', desc: 'Chef dances in excitement', clip: 'happy-feet.mp4' },
  { id: 'fireworks', name: 'Fireworks!', desc: 'Toss a firework in the air. Totally safe.', clip: 'fireworks.mp4' },
  { id: 'happy-birthday', name: 'Happy Birthday!', desc: 'Perfect for a celebratory occasion.', clip: 'happy-birthday.mp4' },
  { id: 'bang-bang', name: 'Bang Bang!', desc: 'Chef fends off Pizza snatchers.', clip: 'bang-bang.mp4' },
  { id: 'spilt-wine', name: 'Crying over spilt wine', desc: 'Chef pours a bottle of wine... on the ground?', clip: 'spilt-wine.mp4' },
  { id: 'say-grace', name: "Let's Say Grace", desc: 'Chef prays over his meal', clip: 'say-grace.mp4' },
  { id: 'whack-a-meelo', name: 'Whack-a-Meelo', desc: 'An excellent stress-reliever', clip: 'whack-a-meelo.mp4' },
  { id: 'my-favourite', name: 'My Favourite!', desc: 'Chef hugs Meelo the monkey plush toy', clip: 'my-favourite.mp4' },
  { id: 'lightsaber-battle', name: 'Lightsaber battle!', desc: 'Chef vs Meelo. who will win?', clip: 'lightsaber-battle.mp4' },
  { id: 'meelo-omelette', name: 'Meelo Omelette', desc: "Let's cook Meelo. Delicious!", clip: 'meelo-omelette.mp4' },
  { id: 'meelo-milo', name: 'Meelo Milo', desc: "one of Chef's favourite drinks", clip: 'meelo-milo.mp4' },
  { id: 'meelo-pizza', name: 'Meelo Pizza', desc: 'Pepperoni pizza, but Meelo. Tastes great!', clip: 'meelo-pizza.mp4' },
  { id: 'chef-mouse', name: 'Chef Mouse', desc: 'Chef Penguino and Sad Mouse make pizza!', clip: 'chef-mouse.mp4' },
  { id: 'chef-mouse-hamster', name: 'Chef Mouse', desc: 'Chef Mouse helps Chef Penguino make pizza!', clip: 'chef-mouse-hamster.mp4' },
  { id: 'rat-in-the-kitchen', name: 'Rat in the Kitchen!', desc: 'Unsanitary cooking environment.', clip: 'rat-in-the-kitchen.mp4' },
  { id: 'ratatouille', name: 'Ratatouille!', desc: 'Chef Penguino reveals the secret to his cooking skill', clip: 'ratatouille.mp4' },
]
const EMOTE_BY_ID = Object.fromEntries(EMOTES.map(e => [e.id, e]))

// Admin-managed emote metadata: a single Type tag plus optional Title/
// Description overrides per emote, loaded from Supabase (see
// migration_emote_tags.sql). Empty until loadEmoteData() runs; the accessors
// below always fall back to the hardcoded EMOTES defaults, so the app works
// unchanged before the migration is run or if the fetch fails.
let emoteTags = []      // [{ id, name }] - the master list of Type tags
let emoteMeta = {}      // emote_id -> { tag_id, title, description }
let emoteDataLoaded = false

async function loadEmoteData(force = false) {
  if (emoteDataLoaded && !force) return
  const [tagsRes, metaRes] = await Promise.all([
    supabase.from('emote_tags').select('id, name').order('created_at', { ascending: true }),
    supabase.from('emote_meta').select('emote_id, tag_id, title, description'),
  ])
  if (!tagsRes.error) emoteTags = tagsRes.data || []
  if (!metaRes.error) emoteMeta = Object.fromEntries((metaRes.data || []).map(m => [m.emote_id, m]))
  emoteDataLoaded = true
}

function emoteName(e) { return (emoteMeta[e.id]?.title) || e.name }
function emoteDesc(e) { return (emoteMeta[e.id]?.description) || e.desc }
function emoteTagId(e) { return emoteMeta[e.id]?.tag_id || null }
function tagNameById(id) { return emoteTags.find(t => t.id === id)?.name || null }

const LORE_VIDEOS = [
  { title: 'Who Is Chef Penguino', clip: 'lore/who-is-chef-penguino.mp4', thumb: 'lore/who-is-chef-penguino.jpg' },
  { title: 'Ghost Orders Pizza', clip: 'lore/ghost-orders-pizza.mp4', thumb: 'lore/ghost-orders-pizza.jpg' },
  { title: 'Pizza Poisoning', clip: 'lore/pizza-poisoning.mp4', thumb: 'lore/pizza-poisoning.jpg' },
  { title: 'Chef Penguino Goes Crazy', clip: 'lore/chef-penguino-goes-crazy.mp4', thumb: 'lore/chef-penguino-goes-crazy.jpg' },
]

function ownedEmotes() {
  return (currentProfile ? currentProfile.owned_emotes : state.ownedEmotes) || []
}
// Waving is free (without ever being added to owned_emotes - see coinBalance
// comment above) for: guests grandfathered via state.guestWavingFree (see
// captureGuestWavingFreeIfNeeded() - false for a genuinely fresh guest, so
// they must buy it like any new signup), and signed-in users grandfathered
// via profiles.waving_free. Guard the column read with `?.` and treat
// undefined as free: pre-migration the column doesn't exist yet, and the
// safe default is "everyone keeps waving free" until the migration lands,
// so nothing breaks in the interim.
function wavingFreeForCurrentUser() {
  if (!isSignedIn()) return !!state.guestWavingFree
  return currentProfile?.waving_free !== false
}
function isOwned(id) {
  if (id === 'waving') return wavingFreeForCurrentUser() || ownedEmotes().includes(id)
  return ownedEmotes().includes(id)
}
function coinsEarned() { return Math.floor(Math.floor(displayPizzas()) / 12) }
// coin_adjustment is the net of coins gifted away (-) and received (+), PLUS
// the +1 the onboarding tour's free coin credits when it grants waving (see
// completeOnboardingPurchase()) - guests can't gift, so state.coinAdjustment
// only ever moves via that one write, kept as the local mirror of the same
// profiles.coin_adjustment column a signed-in chef has.
function coinAdjustment() { return currentProfile ? (currentProfile.coin_adjustment || 0) : (state.coinAdjustment || 0) }
// While the tour is active and has shown the coin-popup but not yet
// completed the purchase, the DISPLAYED balance reads +1 for EVERYONE
// (owners included - see coin-popup's enter()) - a render-time illusion
// only, never written anywhere. Disappears the instant the real purchase
// lands (tour.wavingPurchased): for someone who didn't already own waving,
// the real balance by then already reflects the net-zero write and needs
// no illusion; for an existing owner, the real balance never actually
// changed (completeOnboardingPurchase()'s no-coin/no-array-change branch),
// so the +1 was purely a teaching moment, not a promise.
function coinBalance() {
  const base = Math.max(0, coinsEarned() - ownedEmotes().length + coinAdjustment())
  if (tour && tour.coinBonusShown && !tour.wavingPurchased) return base + 1
  return base
}
function stashCount() { return Math.floor(displayPizzas()) % 12 }

// =================================================================
//  Levels (derived from lifetime pizzas, same pattern as coins - never
//  stored). Curve: level N -> N+1 costs min(12, ceil(N/2)) pizzas, so early
//  levels are cheap and it caps at 12 pizzas/level from level 24 onward.
//  Cumulative pizzas to REACH level L is floor(L*L/4) while L <= 24 (that's
//  where the per-level cost first hits the 12 cap), then grows linearly by
//  12/level after that: 144 + 12*(L-24).
//
//  Hand-verified inverse (levelForPizzas):
//    p=0     -> 1   (floor(sqrt(1))=1)
//    p=1     -> 2   (floor(sqrt(5))=2)
//    p=2     -> 3   (floor(sqrt(9))=3)
//    p=4     -> 4   (floor(sqrt(17))=4)
//    p=6     -> 5   (floor(sqrt(25))=5)
//    p=100   -> 20  (floor(sqrt(401))=20)
//    p=143.9 -> 23  (p floored to 143 first: floor(sqrt(573))=23)
//    p=144   -> 24  (>=144 branch: 24 + floor(0/12) = 24)
//    p=156   -> 25  (>=144 branch: 24 + floor(12/12) = 25)
function levelForPizzas(p) {
  if (p >= 144) return 24 + Math.floor((p - 144) / 12)
  // p is floored here (all cumulative thresholds are whole numbers, so
  // fractional progress can never cross one) - this must match the SQL
  // function public.level_for_pizzas() exactly, since a server-side trigger
  // uses it to reject locked pictures.
  return Math.max(1, Math.floor(Math.sqrt(4 * Math.floor(Math.max(p, 0)) + 1)))
}
// Total lifetime pizzas needed to REACH level L (inverse of levelForPizzas).
function pizzasForLevel(L) {
  if (L <= 24) return Math.floor((L * L) / 4)
  return 144 + 12 * (L - 24)
}
function myLevel() { return isSignedIn() ? levelForPizzas(displayPizzas()) : null }
// { level, next, into, need, pct } describing progress toward the current
// user's next level. into = pizzas earned into the current level, need =
// pizzas the current level costs, pct = 0-100 clamped.
function levelProgress() {
  const level = myLevel() || 1
  const next = level + 1
  const cur = pizzasForLevel(level)
  const nxt = pizzasForLevel(next)
  const into = Math.max(0, displayPizzas() - cur)
  const need = Math.max(1, nxt - cur)
  const pct = Math.min(100, Math.max(0, (into / need) * 100))
  return { level, next, into, need, pct }
}

// Same ownership rules as equippedEmote()/isOwned()/wavingFreeForCurrentUser(),
// but generalized to any profile row (e.g. a friend's, from a friends-list
// select) instead of always reading currentProfile/state. Returns the
// equipped emote id if owned, else 'waving' if waving is free to that
// profile, else null (owns nothing - e.g. a new signup who hasn't bought
// an emote yet).
function effectiveEmoteFor(profileRow) {
  const owned = profileRow?.owned_emotes || []
  const wavingFree = profileRow?.waving_free !== false
  const e = profileRow?.equipped_emote || 'waving'
  const isOwnedByRow = (id) => (id === 'waving' ? (wavingFree || owned.includes(id)) : owned.includes(id))
  if (isOwnedByRow(e)) return e
  return wavingFree ? 'waving' : null
}

// Returns the equipped emote id if owned, else 'waving' if waving is free to
// this user, else null (user owns nothing - e.g. a new signup who hasn't
// bought an emote yet).
function equippedEmote() {
  const e = (currentProfile ? currentProfile.equipped_emote : state.equippedEmote) || 'waving'
  if (isOwned(e)) return e
  return wavingFreeForCurrentUser() ? 'waving' : null
}

async function buyEmote(id) {
  if (coinBalance() < 1 || isOwned(id)) return
  const next = [...ownedEmotes(), id]
  if (currentUser && currentProfile) {
    const { error } = await supabase.from('profiles').update({ owned_emotes: next }).eq('id', currentUser.id)
    if (error) { toast(error.message); return }
    currentProfile.owned_emotes = next
  } else {
    state.ownedEmotes = next
    save()
  }
}

async function equipEmote(id) {
  if (!isOwned(id)) return
  if (currentUser && currentProfile) {
    const { error } = await supabase.from('profiles').update({ equipped_emote: id }).eq('id', currentUser.id)
    if (error) { toast(error.message); return }
    currentProfile.equipped_emote = id
  } else {
    state.equippedEmote = id
    save()
  }
}

// Preloaded emote clips so tapping starts playback instantly.
const preloadedEmotes = {}
for (const e of EMOTES) {
  const v = document.createElement('video')
  v.src = `${BASE}assets/${e.clip}`
  v.preload = 'auto'; v.muted = true; v.playsInline = true
  parkVideo(v)
  preloadedEmotes[e.id] = v
}
// Test-only hook for driving these module-scope functions directly from
// Playwright (they aren't on `window`) - lets a review script reproduce
// "navigate away mid-emote-play" deterministically instead of depending on
// real video playback, which headless Chromium here can't decode anyway.
// Dead-code-eliminated along with the rest of the VITE_REVIEW branch.
// (playEmoteInto/forceParkLiveEmotes are function declarations, so they're
// hoisted and safe to reference here even though they're defined below -
// preloadedEmotes above is a const and needs to be resolved AFTER its own
// declaration, which is why this isn't up at the top of the review block.)
if (import.meta.env.VITE_REVIEW) {
  window.__emoteDebug = { playEmoteInto, forceParkLiveEmotes, preloadedEmotes }
}
function parkVideo(v) {
  v.pause()
  try { v.currentTime = 0 } catch {}
  v.id = ''; v.className = ''
  v.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px'
  document.body.appendChild(v)
}

// Parked, preloaded barrel-explosion clip used by playDeleteClip() below -
// same "hidden parked <video>, nudge with .load() once" trick as the emotes.
const deleteClipVideo = document.createElement('video')
deleteClipVideo.src = `${BASE}assets/delete-barrel.mp4`
deleteClipVideo.poster = `${BASE}assets/delete-barrel-poster.jpg`
deleteClipVideo.preload = 'auto'; deleteClipVideo.playsInline = true
parkVideo(deleteClipVideo)
let deleteClipWarmed = false
function warmDeleteClip() {
  if (deleteClipWarmed) return
  deleteClipWarmed = true
  deleteClipVideo.load()
}

// iOS in particular often defers the actual network fetch for a
// preload="auto" video until something nudges it, even though the element
// is already in the DOM - so the very first tap-to-emote can stall waiting
// on that fetch. warmEmote() gives it that nudge (once per id) by calling
// .load() on the parked hidden <video>. No play()/pause(), no visible
// change - it's a no-op if the id has no preloaded clip.
const warmedEmoteIds = new Set()
function warmEmote(id) {
  if (!id || warmedEmoteIds.has(id)) return
  warmedEmoteIds.add(id)
  preloadedEmotes[id]?.load()
}

// Waits until a clip can play through, THEN plays it once - used when a
// screen first appears, so the emote never starts mid-buffer or judders.
// Falls back to a short timeout so a clip that never reports canplaythrough
// (or is already cached and fires nothing) still gets its one play.
function autoplayEmoteWhenReady(imgEl, emoteId, revertSrc) {
  const v = preloadedEmotes[emoteId]
  if (!v || !imgEl) return
  warmEmote(emoteId)
  let started = false
  // `let timer` must be declared BEFORE start(), not after: when the clip is
  // already buffered we call start() synchronously below, and a `const timer`
  // declared further down is still in its temporal dead zone at that point -
  // so clearTimeout(timer) threw ReferenceError on every visit after the
  // first (first visit isn't buffered yet, so it took the async path and
  // worked). The throw escaped this function into the caller's mountScreen
  // callback and killed every line after the call - which on a friend's
  // Pizzeria is what left the back button with no click listener at all.
  // clearTimeout(null) is a harmless no-op, so the sync path is fine.
  let timer = null
  const start = () => {
    if (started) return
    started = true
    clearTimeout(timer)
    v.removeEventListener('canplaythrough', start)
    // The element may have been re-rendered away while we were buffering.
    if (!imgEl.isConnected) return
    playEmoteInto(imgEl, emoteId, revertSrc)
  }
  // HAVE_ENOUGH_DATA already - no need to wait on an event that won't fire.
  if (v.readyState >= 4) { start(); return }
  v.addEventListener('canplaythrough', start)
  timer = setTimeout(start, 2500)
}

// Swap an <img> for the equipped/given emote clip, play it, then revert.
function playEmoteInto(imgEl, emoteId, revertSrc, onRevert) {
  const v = preloadedEmotes[emoteId]
  if (!v) return
  // Each emote id has exactly ONE shared <video> node reused everywhere it
  // plays (see preloadedEmotes above). If a previous play was interrupted by
  // navigating away before 'ended' fired - e.g. tapping Back on a friend's
  // Pizzeria mid-clip - that old play's "revert to <img>" closure is still
  // attached. Left in place, it fires later against stale/detached elements
  // (the wrong revertSrc, an id from a screen that no longer exists), which
  // is what corrupted the shared node into not autoplaying and, once, into
  // sitting on top of the back button eating clicks. One node, one listener.
  if (v._pendingRevert) v.removeEventListener('ended', v._pendingRevert)
  v.className = imgEl.className
  v.id = imgEl.id
  v.style.cssText = ''
  try { v.currentTime = 0 } catch {}
  const objectPosition = imgEl.style.objectPosition
  if (objectPosition) v.style.objectPosition = objectPosition
  imgEl.replaceWith(v)

  let done = false
  const back = () => {
    if (done) return
    done = true
    v._pendingRevert = null
    const img = document.createElement('img')
    img.className = v.className
    img.id = v.id
    img.alt = ''
    img.src = revertSrc
    if (objectPosition) img.style.objectPosition = objectPosition
    // The video may already have been force-parked by mountScreen (see
    // forceParkLiveEmotes) if this fired after the screen moved on - only
    // touch the DOM if v is still actually where we put it.
    if (v.isConnected) v.replaceWith(img)
    parkVideo(v)
    if (onRevert) onRevert(img)
  }
  v._pendingRevert = back
  v.addEventListener('ended', back, { once: true })
  v.play().catch(back)
}

// Called right before mountScreen wipes #app's DOM. Any preloaded emote
// <video> currently swapped into the outgoing screen (mid-play, 'ended' not
// yet fired) is about to be destroyed along with it - park it immediately
// instead of leaving it detached-but-still-"live" with a stale revert
// closure attached, which is what let a shared emote node break for every
// future play. innerHTML wiping a node doesn't fire 'ended', so this is the
// only place that can catch this.
function forceParkLiveEmotes() {
  for (const id in preloadedEmotes) {
    const v = preloadedEmotes[id]
    if (v.isConnected && v.parentElement !== document.body) {
      if (v._pendingRevert) v.removeEventListener('ended', v._pendingRevert)
      v._pendingRevert = null
      v.pause()
      parkVideo(v)
    }
  }
}

// =================================================================
//  Shared UI helpers (status bar, tab bar, overlays, toast)
// =================================================================
function isSignedIn() { return !!currentUser }

// Everyone is displayed as "Chef <name>". The raw [name] (max 15 chars) is
// what's stored in profiles.display_name and what the user edits; the "Chef"
// prefix is added at display time and isn't editable. stripChef() guards
// against double-prefixing if an older stored name already begins with "Chef".
function stripChef(name) {
  return String(name || '').replace(/^chef\s+/i, '').trim()
}
function chefName(name) {
  const raw = stripChef(name)
  return raw ? `Chef ${raw}` : 'Chef'
}
function myRawName() {
  if (!currentUser) return ''
  return stripChef(currentProfile?.display_name || currentUser.email?.split('@')[0] || '')
}
function myName() {
  if (!currentUser) return 'Guest'
  return chefName(myRawName())
}
function myAvatar() {
  return currentProfile?.avatar_url || DEFAULT_AVATAR
}

function coinImg(extra = '') {
  return `<img class="coin ${extra}" src="${BASE}assets/coin.png" alt="coin" />`
}

const GOOGLE_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`

const APPLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M16.36 12.78c.02 2.5 2.19 3.33 2.22 3.35-.02.06-.35 1.19-1.15 2.36-.69 1.01-1.41 2.02-2.54 2.04-1.11.02-1.47-.66-2.74-.66s-1.66.64-2.72.68c-1.09.04-1.92-1.09-2.62-2.1-1.43-2.06-2.52-5.83-1.05-8.38.73-1.26 2.03-2.06 3.44-2.08 1.07-.02 2.09.72 2.74.72.66 0 1.89-.89 3.19-.76.54.02 2.07.22 3.05 1.65-.08.05-1.82 1.06-1.8 3.16zM14.28 5.4c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.54.62-1.01 1.61-.88 2.56.93.07 1.88-.47 2.46-1.16z"/></svg>`

function googleBtn() {
  return `
    <button class="gbtn" type="button" data-action="google">${GOOGLE_SVG}<span>Sign in with Google</span></button>
  `
  // Sign in with Apple is fully wired (signInWithApple() above, the
  // data-action="apple" handler, .abtn CSS) but hidden until Supabase Auth
  // has a real Apple provider configured - see signInWithApple()'s comment.
  // Uncomment the button below to bring it back:
  // <button class="abtn" type="button" data-action="apple">${APPLE_SVG}<span>Sign in with Apple</span></button>
}

const CAL_BACK_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`

const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 7.5 16.5 10.5"/></svg>`
const CAMERA_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.2"/></svg>`
const COPY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/><path d="M10 11v6M14 11v6"/></svg>`

function statusBarHtml() {
  return `
    <div class="statusbar">
      <div class="who" role="button" tabindex="0" data-action="profile">
        <img class="who-avatar" src="${myAvatar()}" alt="" />
        <div>
          ${isSignedIn() ? '' : '<div class="greet">Hello,</div>'}
          <div class="nm">${escapeHtml(myName())}</div>
          ${isSignedIn() ? (() => {
            const { level, pct } = levelProgress()
            return `<div class="lv-line"><button class="lv-pill" type="button" data-action="level-info">Lv. ${level}</button><span class="lv-bar"><span class="lv-bar-fill" style="width:${pct}%"></span></span></div>`
          })() : `<div class="lv-guest">Sign in to level up</div>`}
        </div>
      </div>
      <div class="stats">
        <button class="chip" type="button" data-action="pizza-info"><span class="ic">🍕</span><span>${formatScore(displayPizzas())}</span></button>
        <button class="chip coin-chip" type="button" data-action="coin-info">${coinImg()}<span>${coinBalance()}</span></button>
      </div>
    </div>
  `
}

const TABS = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'shop', label: 'Shop', icon: '🛍️' },
  // id stays 'friends' (wireTabBar/mountScreen/etc. all key off it) - only the
  // label/icon changed for the Friends/Groups/Requests "Chefs" redesign.
  { id: 'friends', label: 'Chefs', icon: '🧑‍🍳' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
]

function tabBarHtml(active) {
  const [home, shop, friends, settings] = TABS
  const tab = (t) => {
    // Only the Settings tab can carry the unread-notifications badge. The
    // badge span is always in the markup (so later updates can just toggle
    // it) but starts hidden unless we already know there's something unread.
    const icon = t.id === 'settings'
      ? `<span class="tab-ic-wrap"><span class="ti">${t.icon}</span><span class="tab-notif-badge" ${notifUnread > 0 ? '' : 'hidden'}>${notifBadgeText(notifUnread)}</span></span>`
      : `<span class="ti">${t.icon}</span>`
    return `<button class="tab ${active === t.id ? 'active' : ''}" type="button" data-tab="${t.id}">${icon}${t.label}</button>`
  }
  return `
    <div class="tabbar">
      ${tab(home)}
      ${tab(shop)}
      <div class="tab-fab-wrap">
        <button class="tab-fab" type="button" aria-label="Start cooking" data-action="cook">🔥</button>
        <span class="tab-fab-label">Cook</span>
      </div>
      ${tab(friends)}
      ${tab(settings)}
    </div>
  `
}

let mountedScreenKey = null
// Where the user was on each screen, keyed by screen. Re-rendering the same
// screen kept its position already; remembering it per-screen means going
// *back* to a list (Bug Reports -> a report -> back) also lands where you
// left off instead of snapping to the top.
const scrollMemory = new Map()

// One-shot cleanup a screen can register for itself before mountScreen tears
// its DOM down (see renderSoundtrackPicker's teardownSoundtrackPreview) -
// mountScreen replaces #app's innerHTML wholesale on every navigation, so
// this is the one choke point guaranteed to run before any other screen
// mounts, no matter how the chef left (back button, tab bar, a realtime kick
// re-rendering the same screen, etc).
let screenTeardown = null

// The single source of truth for how tall the tab bar actually is right now,
// published to CSS as --tabbar-h. Everything that must sit directly above the
// tab bar - the .scroll bottom padding, the bug FAB, the soundtrack mini-
// player - anchors to this measured value instead of a hardcoded
// "7.1rem + env(safe-area-inset-bottom)" guess. That guess was the root of a
// whole family of device-only bugs: env() reads 0 in the headless harness so
// nothing could verify it, and on a real iPhone the home-indicator inset made
// the tab bar taller AND pushed those fixed guesses higher, leaving the FAB
// and player floating well above the bar with a gap the track rows showed
// through (which read as "transparent"). offsetHeight is measured on the real
// device, inset included, so anchoring to it is correct everywhere.
// Re-run on viewport resize too: iOS Safari's dynamic bottom toolbar and
// rotation both change the tab bar's rendered height without any screen
// re-mount, which would otherwise leave --tabbar-h stale.
function syncTabbarHeight() {
  // On an inset iOS standalone install the home indicator sits in the dead
  // strip BELOW the webview, yet iOS still reports a ~34px bottom safe-area
  // inset inside it - so the tab bar was padding itself for an indicator
  // that isn't over it, stacking ~34px of in-app dead space on top of the
  // ~47px strip. Flag the state on <html>; the CSS drops the bogus padding.
  // Must happen BEFORE measuring offsetHeight so --tabbar-h reflects it,
  // and everything derived from --tabbar-h (FAB, mini-player, scroll
  // padding) follows automatically.
  document.documentElement.classList.toggle('ios-inset-standalone', !!iosInsetStandaloneStrip())
  const tb = app.querySelector('.tabbar')
  if (tb && tb.offsetHeight) document.documentElement.style.setProperty('--tabbar-h', tb.offsetHeight + 'px')
  // Re-derive theme-color too: on an inset iOS standalone install it's the
  // tab bar's colour (see syncThemeColorMeta), which can only be resolved
  // once the tab bar exists - the boot-time call runs before first mount.
  syncThemeColorMeta()
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncTabbarHeight)
} else {
  window.addEventListener('resize', syncTabbarHeight)
}
window.addEventListener('orientationchange', () => setTimeout(syncTabbarHeight, 100))

function mountScreen(active, contentHtml, after, opts = {}) {
  if (screenTeardown) { const t = screenTeardown; screenTeardown = null; t() }
  const key = opts.key || active
  const prevScroll = app.querySelector('.scroll')
  if (prevScroll && mountedScreenKey) scrollMemory.set(mountedScreenKey, prevScroll.scrollTop)
  const carryTop = scrollMemory.get(key) || 0
  forceParkLiveEmotes()
  app.innerHTML = `
    <div class="app">
      ${opts.hideStatusBar ? '' : statusBarHtml()}
      <div class="scroll view active${opts.hideStatusBar ? ' scroll-no-header' : ''}">${contentHtml}</div>
      ${tabBarHtml(active)}
    </div>
  `
  syncTabbarHeight()
  mountedScreenKey = key
  const newScroll = app.querySelector('.scroll')
  if (newScroll && carryTop) {
    newScroll.scrollTop = carryTop
    // Many screens inject their real content asynchronously (Home's session
    // log, History, Bug Reports…). At this point the scroll area is still a
    // short "Loading…" placeholder, so the line above clamps to ~0. Re-apply
    // the saved position as the content grows in, until it sticks, the user
    // scrolls, or a short window elapses — so an action/popup never bounces
    // the user back to the top.
    restoreScrollWhenReady(newScroll, carryTop)
  }
  if (!opts.hideStatusBar) wireStatusBar()
  wireTabBar()
  if (after) after()
  // Keep the unread-notifications badges fresh on every screen render - see
  // refreshNotifBadges() below. No-ops instantly for guests.
  if (isSignedIn()) refreshNotifBadges()
  // The persistent bug-report FAB lives on <body>; ensure it exists and its
  // visibility matches the current auth/modal state on every render.
  ensureBugFab()
}

// Re-applies a target scrollTop to `el` as its (async-loaded) content grows,
// so a re-render never strands the user at the top. Stops once the target is
// reached, the user takes over scrolling, or ~2.5s passes.
function restoreScrollWhenReady(el, target) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    obs.disconnect()
    clearTimeout(timer)
    el.removeEventListener('wheel', onUser)
    el.removeEventListener('touchstart', onUser)
  }
  const onUser = () => finish() // user started scrolling — don't fight them
  const apply = () => {
    if (done) return
    el.scrollTop = target // browser clamps to max while content is still short
    if (Math.abs(el.scrollTop - target) <= 1) finish()
  }
  const obs = new MutationObserver(apply)
  obs.observe(el, { childList: true, subtree: true })
  el.addEventListener('wheel', onUser, { passive: true })
  el.addEventListener('touchstart', onUser, { passive: true })
  const timer = setTimeout(finish, 2500)
}

// =================================================================
//  System Notifications: unread badge (tab bar + Settings row)
// =================================================================
// Two independent timestamps drive different things (see
// migration_system_notifications.sql): a warning's acknowledged_at fires the
// instant the user dismisses the live popup, so it can't drive an unread
// count (it'd read ~0 almost always). read_at is set only when that specific
// message scrolls into view on the System Notifications page - see
// wireNotifReadObserver() - and is what these badges count.
function notifBadgeText(n) { return n > 9 ? '9+' : String(n) }

async function computeUnreadNotifCount() {
  if (!currentUser) return 0
  const [{ count: wc }, { count: nc }] = await Promise.all([
    supabase.from('warnings').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id).is('read_at', null),
    supabase.from('system_notifications').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id).is('read_at', null),
  ])
  return (wc || 0) + (nc || 0)
}

async function refreshNotifBadges() {
  notifUnread = await computeUnreadNotifCount()
  updateNotifBadgeDom()
}

// Called when the session ends (sign out / delete account). Without this the
// tab-bar dot keeps showing the previous user's unread count, since
// refreshNotifBadges() only runs for signed-in users.
function clearNotifBadges() {
  notifUnread = 0
  updateNotifBadgeDom()
}

function updateNotifBadgeDom() {
  const n = notifUnread
  const text = notifBadgeText(n)
  app.querySelectorAll('.tab-notif-badge').forEach(el => {
    el.textContent = text
    el.hidden = n <= 0
  })
  const rowBadge = app.querySelector('#settings-notif-badge')
  if (rowBadge) {
    rowBadge.textContent = text
    rowBadge.hidden = n <= 0
  }
}

// One place that decides how a count badge renders, so "0 shows no badge"
// holds everywhere rather than each tab bar re-implementing it (the
// Moderation tabs used to just write textContent and so sat on a literal
// "0"). Pass the id of a .seg-badge span.
function setSegBadge(id, n) {
  const el = app.querySelector('#' + id)
  if (!el) return
  const count = Number(n) || 0
  el.textContent = String(count)
  el.hidden = count <= 0
}

function wireStatusBar() {
  app.querySelector('[data-action="profile"]')?.addEventListener('click', openProfilePopup)
  app.querySelector('[data-action="coin-info"]')?.addEventListener('click', openCoinInfo)
  app.querySelector('[data-action="pizza-info"]')?.addEventListener('click', openPizzaInfo)
  app.querySelector('[data-action="level-info"]')?.addEventListener('click', openProfilePopup)
}

function wireTabBar() {
  app.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab
      if (id === 'home') renderHome()
      else if (id === 'shop') renderShop()
      else if (id === 'friends') renderFriends()
      else if (id === 'settings') renderSettings()
    })
  })
  app.querySelector('.tab-fab[data-action="cook"]')?.addEventListener('click', startCookingFlow)
}

function startCookingFlow() {
  if (currentUser) {
    // Skip the intro video during the tour - on iOS it can't autoplay, so
    // the chef lands on renderTapToContinue()'s "Tap to Continue" screen,
    // an unguided dead screen the tutorial never explains. Normal (non-tour)
    // cooking sessions are unaffected.
    if (tour) renderDurationPicker()
    else renderIntro(renderDurationPicker, false)
  }
  else showNotSignedInWarning()
}

function shellEl() { return app.querySelector('.app') }

function overlay(innerHtml, { popupClass = '', dismissable = true } = {}) {
  const o = document.createElement('div')
  o.className = 'overlay show'
  o.innerHTML = `<div class="popup ${popupClass}">${innerHtml}</div>`
  ;(shellEl() || app).appendChild(o)
  if (dismissable) o.addEventListener('click', e => { if (e.target === o) o.remove() })
  return o
}

let toastTimer
function toast(msg) {
  let el = app.querySelector('.toast')
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    ;(shellEl() || app).appendChild(el)
  }
  el.innerHTML = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900)
}

// =================================================================
//  Home dashboard
// =================================================================
async function renderHome() {
  afterLogChange = renderHome
  const lifetime = displayPizzas()
  const stash = stashCount()
  const toNext = 12 - stash
  const pct = Math.round((stash / 12) * 100)
  const heroSrc = pizzaImagePath(stash)

  // Fetch + build the session log BEFORE mounting, so the screen renders with
  // its real content already in place. Mounting a "Loading…" placeholder first
  // and injecting rows async is what made a re-render (e.g. after editing a
  // session) briefly flash to the top before the saved scroll position could
  // be restored. Building it up front lets mountScreen restore scroll in one shot.
  const log = await fetchLog(currentUser?.id)
  const recent = log.slice(0, 6)
  const groups = groupLogByDate(recent)
  logEntriesById.clear()
  const logHtml = groups.length
    ? groups.map(g => renderDateGroup(g, true)).join('')
    : '<p class="log-empty">No sessions yet. Start cooking!</p>'

  // Owns nothing (new signup who hasn't bought waving yet) - button still
  // reads "Tap to emote", but tapping just toasts a nudge to the Shop
  // instead of navigating (no clip to play).
  const myEmote = equippedEmote()
  const heroTapHtml = `<button class="hero-tap" type="button" data-action="emote">💃 Tap to emote</button>`

  const content = `
    <div class="hero-card" id="hero-card" role="button" tabindex="0">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      <button class="hero-info" type="button" data-action="emote-info" aria-label="About emotes">i</button>
      ${heroTapHtml}
    </div>

    <div class="tiles">
      <div class="tile" role="button" tabindex="0" data-action="tile-pizza-info">
        <span class="info-badge tile-info" aria-hidden="true">i</span>
        <div class="lab">🍕 Lifetime pizzas</div>
        <div class="big">${formatScore(lifetime)}</div>
        <div class="sub">All-time made</div>
      </div>
      <div class="tile coin-tile" role="button" tabindex="0" data-action="stash-info">
        <span class="info-badge tile-info" aria-hidden="true">i</span>
        <div class="lab">Pizzas in stash</div>
        <div class="big">${stash}<span style="font-size:16px;color:var(--muted)">/12</span></div>
        <div class="sub">${toNext} more → 1 coin</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
    </div>

    <button class="cta" type="button" data-action="cook">🔥 Start Cooking</button>

    <div class="section-h" style="margin-top:2.75rem"><h2 class="section-h-lg">Recent sessions</h2></div>
    <p class="swipe-line" style="margin:0.25rem 0 1rem">Swipe left on a session to edit</p>
    <div class="log-list" id="home-log">${logHtml}</div>
    <button class="cal-seeall-btn" type="button" data-action="see-all-sessions">📅&nbsp; See All Sessions</button>
  `

  mountScreen('home', content, () => {
    app.querySelector('[data-action="see-all-sessions"]').addEventListener('click', renderHistory)
    app.querySelector('.cta[data-action="cook"]').addEventListener('click', startCookingFlow)
    app.querySelector('[data-action="tile-pizza-info"]')?.addEventListener('click', openPizzaInfo)
    app.querySelector('[data-action="stash-info"]')?.addEventListener('click', openStashInfo)
    app.querySelector('[data-action="emote-info"]')?.addEventListener('click', (e) => { e.stopPropagation(); openEmoteInfo() })

    // Tap the shopfront to play the equipped emote, then revert to the still.
    // If the chef owns no emote yet, tapping just nudges toward the Shop via
    // toast - no navigation, no clip to play.
    const attachEmoteTap = (btnHost) => {
      btnHost.addEventListener('click', () => {
        if (!myEmote) { toast('Equip emotes in shop'); return }
        const img = app.querySelector('#hero-card .hero-still')
        if (img && img.tagName === 'IMG') {
          playEmoteInto(img, myEmote, heroSrc)
        }
      })
    }
    attachEmoteTap(app.querySelector('#hero-card'))
    // Greet the chef with their equipped emote on arrival - buffered first so
    // it plays smoothly rather than stuttering into life. No clip to preload
    // when the chef owns nothing yet.
    if (myEmote) autoplayEmoteWhenReady(app.querySelector('#hero-card .hero-still'), myEmote, heroSrc)

    // Log content is already in the DOM (built above) — just wire the swipes.
    wireLogSwipe(app.querySelector('#home-log'))
    maybeShowCoinMilestone()
    maybeShowAddToHomescreenPrompt()
  })
}

async function loadHomeLog(userId) {
  const editable = userId === undefined
  const log = await fetchLog(userId ?? currentUser?.id)
  const listEl = app.querySelector('#home-log')
  if (!listEl) return
  const recent = log.slice(0, 6)
  const groups = groupLogByDate(recent)
  logEntriesById.clear()
  listEl.innerHTML = groups.length
    ? groups.map(g => renderDateGroup(g, editable)).join('')
    : '<p class="log-empty">No sessions yet. Start cooking!</p>'
  if (editable) wireLogSwipe(listEl)
}

function maybeShowCoinMilestone() {
  const earned = coinsEarned()
  if (state.lastSeenCoins === null) {
    state.lastSeenCoins = earned
    save()
    return
  }
  if (earned > state.lastSeenCoins) {
    const gained = earned - state.lastSeenCoins
    const o = overlay(`
      ${coinImg('lg spin')}
      <h3>Cha-ching!</h3>
      <p>You sold 12 pizzas for a gold coin! Spend it in the Emotes Shop.</p>
      <button type="button" data-action="collect">Collect coin</button>
    `, { dismissable: false })
    o.querySelector('[data-action="collect"]').addEventListener('click', () => {
      state.lastSeenCoins = earned
      save()
      o.remove()
      // refresh the coin chip
      const chip = app.querySelector('.coin-chip span:last-child')
      if (chip) chip.textContent = coinBalance()
      toast(`${coinImg('toast-coin')} +${gained} coin${gained > 1 ? 's' : ''}!`)
    })
  }
}

// Recurring "Add this lil' app to Homescreen?" nudge - fires at most once
// every 6 hours, for guests and signed-in users alike (localStorage only,
// no DB column). Skipped entirely in standalone/installed mode, during an
// active cooking session, while the onboarding tour is running, or if
// another popup/overlay is already up. Checked once per app load from
// renderHome (see maybeShowCoinMilestone's call site) - homescreenPromptShownThisSession
// keeps it from firing again if Home re-renders later in the same visit.
const HOMESCREEN_PROMPT_INTERVAL_MS = 6 * 60 * 60 * 1000
let homescreenPromptShownThisSession = false
function isStandaloneApp() {
  return (window.matchMedia?.('(display-mode: standalone)').matches) || window.navigator.standalone === true
}

// Shared entry point for both "add to homescreen" surfaces (the recurring
// popup's button and Settings > Tutorials > Add to Homescreen row). If the
// browser handed us a real beforeinstallprompt event, replay it - that's a
// native install, no tutorial needed. Otherwise fall back to the manual
// step-by-step guide subpage, exactly as before.
function triggerAddToHomescreen() {
  if (deferredInstallPrompt) {
    const evt = deferredInstallPrompt
    deferredInstallPrompt = null
    evt.prompt()
    return
  }
  renderAddToHomescreenGuide()
}
function maybeShowAddToHomescreenPrompt() {
  if (homescreenPromptShownThisSession) return
  if (isStandaloneApp()) return
  if (state.homescreenPromptDismissedForever) return
  if (state.timer) return
  if (tour) return
  if (document.querySelector('.overlay.show')) return
  const last = state.lastHomescreenPromptAt
  if (last && Date.now() - last < HOMESCREEN_PROMPT_INTERVAL_MS) return

  homescreenPromptShownThisSession = true
  state.lastHomescreenPromptAt = Date.now()
  save()

  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Add this lil' app to Homescreen?</h3>
    <img class="add-homescreen-img" src="${BASE}assets/add-homescreen.jpg" alt="" />
    <p>Makes cooking pizzas super convenient for you.</p>
    <div class="home-btn-col">
      <button type="button" data-action="add">Add to homescreen</button>
      <button type="button" class="btn-secondary" data-action="never">Don't show again</button>
    </div>
  `, { popupClass: 'popup-wide' })

  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="add"]').addEventListener('click', () => {
    o.remove()
    if (deferredInstallPrompt) { triggerAddToHomescreen(); return }
    renderSettings(false, true)
  })
  o.querySelector('[data-action="never"]').addEventListener('click', () => {
    o.remove()
    state.homescreenPromptDismissedForever = true
    save()
    playDeleteClip()
  })
}

// =================================================================
//  History / Calendar screen (Month / Week / Day)
// =================================================================
let calView = 'month'        // 'month' | 'week' | 'day'
let calY = null              // displayed month year (month view + nav anchor)
let calMo = null             // displayed month index 0-11
let calSelKey = null         // selected day key 'YYYY-MM-DD' (week/day nav + month highlight)
let calSheetDate = null      // day key currently open in the bottom sheet, or null if closed
let calSheetFocusId = null   // entry id to scroll-to + flash inside the sheet, once
let calSheetFreshOpen = false // true right before a user-initiated (animated) sheet open
let calTypeFilter = null     // null = "All"; else a Set of task-type keys. Persists across month/week/day.

const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const CAL_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CAL_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const CAL_DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const CAL_HPX_REM = 2.875 // week-view hour row height (46px at the app's 390px design width)

function calPad2(n) { return String(n).padStart(2, '0') }
function calKey(y, mo, d) { return `${y}-${calPad2(mo + 1)}-${calPad2(d)}` }
function calKeyFromDate(dt) { return calKey(dt.getFullYear(), dt.getMonth(), dt.getDate()) }
// Bucket by the SGT calendar day the session fell on, not the device's local
// day, so a chef's own history agrees with the admin totals (which already
// bucket the same way - see admCalFetchDayTotals). calKey/calDateFromKey/
// calWeekDays themselves stay device-timezone-agnostic pure calendar-number
// arithmetic (like the admin calendar's identical helpers) - only the
// timestamp -> calendar-day resolution needs the SGT conversion.
function calKeyFromTs(ts) { const { y, mo, day } = sgtDateParts(new Date(ts)); return calKey(y, mo, day) }
function calDateFromKey(key) { const [y, mo, d] = key.split('-').map(Number); return new Date(y, mo - 1, d) }
function calOrdinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }
// Pinned to Singapore time for the same reason the day buckets are: a session
// listed under an SGT day should show the SGT clock time it happened at.
function calFmtTime(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' }) }
function calFmtDur(mn) { return formatDuration(mn) }
// Root font-size in px, so the week view's ~6am auto-scroll lands correctly
// under the app's viewport-scaled rem sizing (html{font-size:calc(...)}).
function calRootPx() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 }

function calGroupByDay(log) {
  const map = new Map()
  for (const e of log) {
    const k = calKeyFromTs(e.completedAt)
    let arr = map.get(k)
    if (!arr) { arr = []; map.set(k, arr) }
    arr.push(e)
  }
  for (const arr of map.values()) arr.sort((a, b) => a.completedAt - b.completedAt)
  return map
}

function calDayTotals(map, key) {
  const arr = map.get(key) || []
  let pz = 0, mn = 0
  arr.forEach(e => { pz += e.pizzas; mn += e.minutes })
  // Newest first for display - copy the array rather than sorting arr in
  // place, since arr is the map's own stored bucket and other code (the
  // pz/mn totals above, calMonthTotals) doesn't care about order but
  // there's no reason to risk mutating shared state for a rendering
  // concern. Entries use `completedAt` (see renderLogRow), not `ts`.
  const entries = [...arr].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
  return { pz, mn, n: arr.length, entries }
}

function calMonthTotals(map, y, mo) {
  const prefix = `${y}-${calPad2(mo + 1)}-`
  let pz = 0, mn = 0
  for (const [key, arr] of map) {
    if (!key.startsWith(prefix)) continue
    arr.forEach(e => { pz += e.pizzas; mn += e.minutes })
  }
  return { pz, mn }
}

// ---------- task-type filter (calendar) ----------
// The bucket key an entry counts toward: its task-type, or 'planning' (Other)
// for legacy/typeless sessions and admin/coin audit rows.
const EMOJI_TO_TYPE = Object.fromEntries(Object.entries(TASK_TYPE_EMOJI).map(([k, v]) => [v, k]))
function calBucketOf(e) {
  if (e.type && TASK_TYPE_EMOJI[e.type]) return e.type
  if (isAdminEditEntry(e)) return 'planning'
  return EMOJI_TO_TYPE[stableIconFor(e)] || 'planning'
}

// Every entry within the currently-displayed scope (month / week / day).
function calScopeEntries(map) {
  const out = []
  if (calView === 'month') {
    const prefix = `${calY}-${calPad2(calMo + 1)}-`
    for (const [key, arr] of map) { if (key.startsWith(prefix)) out.push(...arr) }
  } else if (calView === 'week') {
    for (const d of calWeekDays(calSelKey)) { const a = map.get(calKeyFromDate(d)); if (a) out.push(...a) }
  } else {
    const a = map.get(calSelKey); if (a) out.push(...a)
  }
  return out
}

// Every selectable filter key (the 5 task types). The filter is "all
// selected" by default; users deselect pills to narrow the summary cards.
const ALL_FILTER_KEYS = [...Object.keys(TASK_TYPE_EMOJI)]
function ensureCalFilterInit() {
  if (calTypeFilter === null) calTypeFilter = new Set(ALL_FILTER_KEYS)
}

function calToggleTypeFilter(key) {
  ensureCalFilterInit()
  if (calTypeFilter.has(key)) calTypeFilter.delete(key); else calTypeFilter.add(key)
}

// Pizzas + focus-minutes summed over ONLY the selected categories — this drives
// the two summary cards, so deselecting a pill removes its contribution.
function calSelectedTotals(map) {
  ensureCalFilterInit()
  let pz = 0, mn = 0
  for (const e of calScopeEntries(map)) {
    if (calTypeFilter.has(calBucketOf(e))) { pz += e.pizzas; mn += e.minutes }
  }
  return { pz, mn }
}

function calTypeChipLabel(key) {
  const t = taskTypeLabel(key)
  return `${TASK_TYPE_EMOJI[key]} ${escapeHtml(t ? t.title : key)}`
}

// Just the category pill row — no "All" pill, no per-type breakdown panel. All
// pills start selected; the summary cards above reflect the selected set.
function calFilterBarHtml(map) {
  if (calScopeEntries(map).length === 0) return '' // nothing to filter on an empty scope
  ensureCalFilterInit()
  const keys = Object.keys(TASK_TYPE_EMOJI)
  const chips = keys.map(k =>
    `<button type="button" class="tt-chip${calTypeFilter.has(k) ? ' active' : ''}" data-tk="${k}">${calTypeChipLabel(k)}</button>`
  ).join('')
  return `<div class="tt-cal-filter"><div class="tt-chip-row">${chips}</div></div>`
}

// The Monday-start week containing `key`.
function calWeekDays(key) {
  const dt = calDateFromKey(key)
  const off = (dt.getDay() + 6) % 7
  const monday = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - off)
  const days = []
  for (let i = 0; i < 7; i++) { const d = new Date(monday); d.setDate(monday.getDate() + i); days.push(d) }
  return days
}

// Intensity by whole-pizza buckets: 0 = none, 1, 2, 3, and 4+ = most intense.
function calIntensity(pz) {
  const n = Math.round(pz)
  if (n <= 0) return 0
  if (n >= 4) return 4
  return n
}

async function renderHistory() {
  afterLogChange = renderHistory
  // "Today" anchors on the SGT calendar date, not the device's local date -
  // see the sgt* helpers near nextMondayLabel() - so a chef's own history
  // agrees with the admin dashboard's totals regardless of the chef's device
  // timezone.
  const { y: todayY, mo: todayMo, day: todayDay } = sgtDateParts(new Date())
  const todayKey = calKey(todayY, todayMo, todayDay)
  if (calY === null) { calY = todayY; calMo = todayMo }
  if (calSelKey === null) calSelKey = todayKey

  const log = await fetchLog(currentUser?.id)
  const dayMap = calGroupByDay(log)
  // Initialise the "all pills selected" filter before the day body renders,
  // since its per-row dimming reads the selected set.
  ensureCalFilterInit()

  let navHtml = ''
  if (calView === 'month') {
    navHtml = `
      <div class="cal-navbar">
        <button class="cal-chev" type="button" data-action="cal-prev">‹</button>
        <div class="cal-navlabel">${CAL_MONTHS[calMo]} ${calY}</div>
        <button class="cal-chev" type="button" data-action="cal-next">›</button>
      </div>`
  } else if (calView === 'week') {
    const days = calWeekDays(calSelKey)
    const first = days[0], last = days[6]
    const label = (first.getMonth() === last.getMonth())
      ? `${first.getDate()}–${last.getDate()} ${CAL_MONTHS_SHORT[first.getMonth()]}`
      : `${first.getDate()} ${CAL_MONTHS_SHORT[first.getMonth()]} – ${last.getDate()} ${CAL_MONTHS_SHORT[last.getMonth()]}`
    navHtml = `
      <div class="cal-navbar">
        <button class="cal-chev" type="button" data-action="cal-prev">‹</button>
        <div class="cal-navlabel">${label}</div>
        <button class="cal-chev" type="button" data-action="cal-next">›</button>
      </div>`
  } else {
    const dt = calDateFromKey(calSelKey)
    navHtml = `
      <div class="cal-navbar">
        <button class="cal-chev" type="button" data-action="cal-prev">‹</button>
        <div class="cal-navlabel">${CAL_DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${CAL_MONTHS[dt.getMonth()]}</div>
        <button class="cal-chev" type="button" data-action="cal-next">›</button>
      </div>`
  }

  // Summary cards reflect only the selected category pills (all by default).
  const { pz: sumPz, mn: sumMn } = calSelectedTotals(dayMap)

  const subtitle = calView === 'month' ? 'Your cooking calendar'
    : calView === 'week' ? `Week of the ${calOrdinal(calDateFromKey(calSelKey).getDate())}`
    : 'Single day view'

  const bodyHtml = calView === 'month' ? calRenderMonthBody(dayMap, todayKey)
    : calView === 'week' ? calRenderWeekBody(dayMap, todayKey)
    : calRenderDayBody(dayMap)

  const content = `
    <div class="cal-hdr">
      <button class="cal-back" type="button" data-action="cal-back" aria-label="Back">${CAL_BACK_SVG}</button>
      <div class="cal-hdr-titles"><h1>History</h1><span>${subtitle}</span></div>
      <button class="cal-today-btn" type="button" data-action="cal-today">Today</button>
    </div>
    <div class="cal-seg">
      <button type="button" class="${calView === 'month' ? 'on' : ''}" data-v="month">Month</button>
      <button type="button" class="${calView === 'week' ? 'on' : ''}" data-v="week">Week</button>
      <button type="button" class="${calView === 'day' ? 'on' : ''}" data-v="day">Day</button>
    </div>
    ${navHtml}
    <div class="cal-summary">
      <div class="cal-stat"><div class="v">${formatScore(sumPz)} 🍕</div><div class="k">Pizzas</div></div>
      <div class="cal-stat"><div class="v">${calFmtDur(sumMn)}</div><div class="k">Total focus time</div></div>
    </div>
    ${calFilterBarHtml(dayMap)}
    <div class="cal-viewbody">${bodyHtml}</div>
  `

  mountScreen('home', content, () => calWireHistory(dayMap, todayKey), { key: 'history' })
}

// The scrim + sheet are appended directly onto the `.app` shell (like
// overlay()) rather than living inside the scrollable content string -
// `.scroll` clips absolutely-positioned descendants via its overflow-y:auto,
// which would otherwise cut the sheet off instead of letting it cover the
// full screen (including the tab bar) the way a bottom sheet should.
function calWireHistory(dayMap, todayKey) {
  shellEl()?.insertAdjacentHTML('beforeend', `
    <div class="cal-scrim" id="cal-scrim"></div>
    <div class="cal-sheet" id="cal-sheet">
      <div class="cal-grab" id="cal-grab"></div>
      <div class="cal-sheet-hd"><h3 id="cal-sheet-title">—</h3><span class="cal-sheet-sub" id="cal-sheet-sub"></span></div>
      <p class="swipe-line" style="margin:-0.25rem 1.25rem 0.75rem">Swipe a session left to edit or delete</p>
      <div class="cal-sheet-list" id="cal-sheet-list"></div>
    </div>
  `)

  app.querySelector('[data-action="cal-back"]').addEventListener('click', renderHome)
  app.querySelector('[data-action="cal-today"]').addEventListener('click', () => {
    const { y, mo, day } = sgtDateParts(new Date())
    calY = y; calMo = mo; calSelKey = calKey(y, mo, day)
    renderHistory()
  })
  app.querySelectorAll('.cal-seg button').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.v === calView) return
      calView = b.dataset.v
      calCloseSheet()
      renderHistory()
    })
  })
  app.querySelectorAll('.tt-cal-filter .tt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      calToggleTypeFilter(chip.dataset.tk)
      renderHistory()
    })
  })

  const stepMonth = (delta) => {
    calMo += delta
    if (calMo < 0) { calMo = 11; calY-- } else if (calMo > 11) { calMo = 0; calY++ }
  }
  const stepDays = (delta) => {
    const dt = calDateFromKey(calSelKey)
    dt.setDate(dt.getDate() + delta)
    calSelKey = calKeyFromDate(dt)
  }
  app.querySelector('[data-action="cal-prev"]')?.addEventListener('click', () => {
    if (calView === 'month') stepMonth(-1); else if (calView === 'week') stepDays(-7); else stepDays(-1)
    renderHistory()
  })
  app.querySelector('[data-action="cal-next"]')?.addEventListener('click', () => {
    if (calView === 'month') stepMonth(1); else if (calView === 'week') stepDays(7); else stepDays(1)
    renderHistory()
  })

  const openDay = (key, focusId) => {
    calSelKey = key; calSheetDate = key; calSheetFocusId = focusId ?? null; calSheetFreshOpen = true
    renderHistory()
  }

  if (calView === 'month') {
    app.querySelectorAll('.cal-cell.cal-has[data-day]').forEach(c => {
      c.addEventListener('click', () => openDay(c.dataset.day))
    })
  } else if (calView === 'week') {
    app.querySelectorAll('.cal-wblock[data-day]').forEach(b => {
      b.addEventListener('click', () => openDay(b.dataset.day))
    })
    const scrollEl = app.querySelector('#cal-week-scroll')
    if (scrollEl) scrollEl.scrollTop = Math.max(0, (6 * CAL_HPX_REM - 0.5) * calRootPx())
  } else if (calView === 'day') {
    app.querySelectorAll('.cal-tl-item[data-id]').forEach(it => {
      it.addEventListener('click', () => openDay(calSelKey, it.dataset.id))
    })
  }

  app.querySelector('#cal-scrim')?.addEventListener('click', calCloseSheet)
  app.querySelector('#cal-grab')?.addEventListener('click', () => closeOpenSwipe())
  app.querySelector('.cal-sheet-hd')?.addEventListener('click', () => closeOpenSwipe())
  calWireSheetDrag()

  if (calSheetDate) calPopulateSheet(dayMap, calSheetDate)
}

// Drag the grab handle (or header) down to dismiss the bottom sheet.
function calWireSheetDrag() {
  const sheet = app.querySelector('#cal-sheet')
  if (!sheet) return
  const wire = (handle) => {
    if (!handle) return
    handle.style.touchAction = 'none'
    let startY = 0, dy = 0, dragging = false
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; dy = 0
      sheet.style.transition = 'none'
      try { handle.setPointerCapture(e.pointerId) } catch {}
    })
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return
      dy = Math.max(0, e.clientY - startY)   // downward only
      sheet.style.transform = `translateY(${dy}px)`
    })
    const end = () => {
      if (!dragging) return
      dragging = false
      sheet.style.transition = ''
      sheet.style.transform = ''             // hand back to the CSS .show class
      if (dy > Math.min(120, (sheet.offsetHeight || 400) * 0.25)) calCloseSheet()
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  wire(app.querySelector('#cal-grab'))
  wire(app.querySelector('.cal-sheet-hd'))
}

function calPopulateSheet(dayMap, key) {
  const t = calDayTotals(dayMap, key)
  if (!t.n) { calSheetDate = null; return }
  const dt = calDateFromKey(key)
  const titleEl = app.querySelector('#cal-sheet-title')
  const subEl = app.querySelector('#cal-sheet-sub')
  const listEl = app.querySelector('#cal-sheet-list')
  if (!titleEl || !subEl || !listEl) return
  titleEl.textContent = `${CAL_DOW_FULL[dt.getDay()]} ${dt.getDate()} ${CAL_MONTHS[dt.getMonth()]}`
  subEl.textContent = `${formatScore(t.pz)} 🍕 · ${calFmtDur(t.mn)}`
  logEntriesById.clear()
  listEl.innerHTML = t.entries.map(e => renderLogRow(e, true)).join('')
  wireLogSwipe(listEl)

  const scrim = app.querySelector('#cal-scrim')
  const sheet = app.querySelector('#cal-sheet')
  const show = () => { scrim.classList.add('show'); sheet.classList.add('show') }
  if (calSheetFreshOpen) { calSheetFreshOpen = false; requestAnimationFrame(show) } else show()

  if (calSheetFocusId != null) {
    const id = calSheetFocusId
    calSheetFocusId = null
    const target = listEl.querySelector(`.log-row-wrap[data-log-id="${id}"]`)
    if (target) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.add('cal-flash')
        setTimeout(() => target.classList.remove('cal-flash'), 2400)
      }, 340)
    }
  }
}

function calCloseSheet() {
  calSheetDate = null
  app.querySelector('#cal-scrim')?.classList.remove('show')
  app.querySelector('#cal-sheet')?.classList.remove('show')
  closeOpenSwipe()
}

function calRenderMonthBody(dayMap, todayKey) {
  const y = calY, mo = calMo
  const dim = new Date(y, mo + 1, 0).getDate()
  const off = (new Date(y, mo, 1).getDay() + 6) % 7
  let h = '<div class="cal-monthpanel"><div class="cal-dow">' + CAL_DOW.map(d => `<span>${d}</span>`).join('') + '</div><div class="cal-grid">'
  for (let i = 0; i < off; i++) h += '<div class="cal-cell cal-empty-month"></div>'
  for (let d = 1; d <= dim; d++) {
    const key = calKey(y, mo, d)
    const t = calDayTotals(dayMap, key)
    const has = t.n > 0
    const inten = calIntensity(t.pz)
    const isTdy = key === todayKey
    const sel = key === calSelKey
    const cls = 'cal-cell' + (has ? ' cal-has cal-i' + inten : '') + (isTdy ? ' cal-today' : '') + (sel ? ' cal-sel' : '')
    const total = Math.min(Math.round(t.pz), 10)
    let dotsHtml = ''
    if (total > 0) {
      const mkRow = n => `<div class="cal-dotrow">${Array.from({ length: n }).map(() => '<i></i>').join('')}</div>`
      if (total <= 5) dotsHtml = mkRow(total)
      else { const top = Math.floor(total / 2), bottom = Math.ceil(total / 2); dotsHtml = mkRow(top) + mkRow(bottom) }
    }
    const dots = has ? `<div class="cal-dots">${dotsHtml}</div>` : ''
    h += `<div class="${cls}" data-day="${key}"><div class="cal-dnum">${d}</div>${dots}</div>`
  }
  h += '</div></div>'
  h += `<div class="cal-legend"><span>Less 🍕</span>
    <span class="cal-legend-sw"></span>
    <span class="cal-legend-sw cal-i1"></span>
    <span class="cal-legend-sw cal-i2"></span>
    <span class="cal-legend-sw cal-i3"></span>
    <span class="cal-legend-sw cal-i4"></span>
    <span>More 🍕</span></div>`
  h += `<div class="cal-hint"><span class="info-badge" aria-hidden="true">i</span><p>Tap a day to see more details.</p></div>`
  return h
}

function calRenderWeekBody(dayMap, todayKey) {
  const days = calWeekDays(calSelKey)
  let g = `<div class="cal-weekgrid" id="cal-week-scroll"><div class="cal-wk-table" style="--cal-hpx:${CAL_HPX_REM}rem">`
  g += '<div class="cal-wk-corner"></div>'
  days.forEach(dt => {
    const key = calKeyFromDate(dt)
    const tdy = key === todayKey
    const t = calDayTotals(dayMap, key)
    const tot = t.mn > 0 ? `<span class="cal-wk-tot">${calFmtDur(t.mn)}</span>` : ''
    g += `<div class="cal-wk-head${tdy ? ' cal-tdy' : ''}"><span class="cal-wk-d0">${CAL_DOW[(dt.getDay() + 6) % 7][0]}</span><b>${dt.getDate()}</b>${tot}</div>`
  })
  let gutter = ''
  for (let hh = 0; hh <= 24; hh++) {
    const hd = hh % 24
    const lab = hd === 0 ? '12a' : (hd < 12 ? hd + 'a' : (hd === 12 ? '12p' : (hd - 12) + 'p'))
    gutter += `<div class="cal-hrlabel" style="top:${hh * CAL_HPX_REM}rem">${lab}</div>`
  }
  g += `<div class="cal-wk-gutter">${gutter}</div>`
  days.forEach(dt => {
    const key = calKeyFromDate(dt)
    const arr = dayMap.get(key) || []
    let blocks = ''
    arr.forEach(e => {
      // SGT hours, not the device's: the day columns bucket by SGT, so reading
      // the clock locally would place a session in the right column at the
      // wrong height for anyone whose phone isn't on Singapore time.
      const d = new Date(new Date(e.completedAt).getTime() + SGT_OFFSET_MS)
      const start = d.getUTCHours() + d.getUTCMinutes() / 60
      const top = start * CAL_HPX_REM
      const ht = Math.max((e.minutes / 60) * CAL_HPX_REM, 1.375)
      const low = e.pizzas < 3 ? ' cal-low' : ''
      blocks += `<div class="cal-wblock${low}" style="top:${top}rem; height:${ht}rem" data-day="${key}">🍕 ${formatScore1(e.pizzas)}</div>`
    })
    g += `<div class="cal-wk-col" data-day="${key}">${blocks}</div>`
  })
  g += '</div></div>'
  return g
}

function calRenderDayBody(dayMap) {
  const arr = dayMap.get(calSelKey) || []
  if (!arr.length) {
    return '<div class="cal-empty-note">No sessions this day.<br>Tap 🔥 Start Cooking to add one.</div>'
  }
  let h = `<div class="friend-swipe-hint" style="margin:0.75rem 0 0.875rem"><span class="info-badge" aria-hidden="true">i</span><p>Tap a session to edit it</p></div>`
  h += '<div class="cal-timeline">'
  arr.forEach(e => {
    const isCoin = isCoinEntry(e)
    // Coin conversions get the gold coin glyph; admin edits keep their stored
    // tools icon; everything else uses its stable food icon.
    const adminNoType = isAdminEditEntry(e) && !(e.type && TASK_TYPE_EMOJI[e.type])
    const icon = adminNoType ? '🛠️' : ((isCoin && !isAdminEditEntry(e)) ? coinImg('log-coin') : stableIconFor(e))
    const coinAmt = (COIN_TASK_RE.exec(e.task || '') || [])[1] || ''
    const metric = isCoin ? `${coinImg('log-coin')} ${coinAmt}`.trim() : `🍕 ${formatScore(e.pizzas)}`
    const task = escapeHtml((e.task || '').replace(COIN_TASK_RE, '')) || 'Focus session'
    const dim = calTypeFilter && !calTypeFilter.has(calBucketOf(e)) ? ' tt-dim' : ''
    h += `<div class="cal-tl-item${dim}" data-id="${e.id}" role="button" tabindex="0">
      <div class="cal-tl-time">${calFmtTime(e.completedAt)}</div>
      <div class="cal-tl-rail"><div class="cal-tl-dot"></div><div class="cal-tl-line"></div></div>
      <div class="cal-tl-card">
        <div class="cal-tl-cardbody">
          <div class="cal-tl-top"><span class="cal-tl-ico">${icon}</span><span class="cal-tl-name">${task}</span></div>
          <div class="cal-tl-meta"><span>${calFmtDur(e.minutes)}</span></div>
        </div>
        <span class="cal-tl-pz">${metric}</span>
      </div>
    </div>`
  })
  h += '</div>'
  return h
}

function pizzaImagePath(count) {
  const clamped = Math.max(0, Math.min(12, count))
  return `${BASE}assets/display-case/${clamped}.jpg`
}

// =================================================================
//  Emotes Shop
// =================================================================
// Persists across tab switches within a session. 'newest' shows the most
// recently-added emotes first (a natural default for a shop).
let shopSort = 'newest'
let shopType = 'all'   // 'all' or an emote_tags id
const SORT_LABELS = { owned: 'Owned', az: 'A-Z', newest: 'Newest' }

function sortedShopEmotes() {
  let list
  if (shopSort === 'az') {
    // Sort by the effective (possibly admin-overridden) name.
    list = [...EMOTES].sort((a, b) => emoteName(a).localeCompare(emoteName(b)))
  } else if (shopSort === 'owned') {
    // Only owned emotes, latest bought -> oldest. owned_emotes is stored in
    // purchase order (appended on buy), so reversing gives newest-first. The
    // free 'waving' isn't in that array but is always owned, so it goes last
    // as the oldest-owned default.
    list = [...ownedEmotes()].reverse().map(id => EMOTE_BY_ID[id]).filter(Boolean)
    if (isOwned('waving')) list.push(EMOTE_BY_ID['waving'])
  } else {
    // 'newest': EMOTES is ordered oldest-added -> newest, so reverse it.
    list = [...EMOTES].reverse()
  }
  if (shopType !== 'all') list = list.filter(e => emoteTagId(e) === shopType)
  return list
}

function typeLabel() { return shopType === 'all' ? 'All' : (tagNameById(shopType) || 'All') }

function openSortMenu() {
  const opts = [
    { id: 'owned', label: 'Owned' },
    { id: 'az', label: 'A-Z' },
    { id: 'newest', label: 'Newest' },
  ]
  const o = overlay(`
    <h3>Sort by</h3>
    <div class="sort-options">
      ${opts.map(op => `<button type="button" class="sort-option ${shopSort === op.id ? 'active' : ''}" data-sort="${op.id}">${op.label}</button>`).join('')}
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
    shopSort = b.dataset.sort
    o.remove()
    renderShop()
  }))
}

function openTypeMenu() {
  const opts = [{ id: 'all', label: 'All' }, ...emoteTags.map(t => ({ id: t.id, label: t.name }))]
  const o = overlay(`
    <h3>Filter by type</h3>
    <div class="sort-options">
      ${opts.map(op => `<button type="button" class="sort-option ${shopType === op.id ? 'active' : ''}" data-type="${op.id}">${escapeHtml(op.label)}</button>`).join('')}
      ${emoteTags.length ? '' : '<p class="editpic-empty">No types yet.</p>'}
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    shopType = b.dataset.type
    o.remove()
    renderShop()
  }))
}

async function renderShop(scrollTop) {
  // The onboarding tour's buy-waving step walks a GUEST through the shop too
  // (unified flow - see buildOnboardingSteps()) using buyEmote()/
  // equipEmote()'s existing guest-local branches; only the sign-in gate
  // below needs to step aside for that, never permanently.
  if (!isSignedIn() && !tour) {
    const content = `
      <div class="friends-gate" style="display:block">
        <img src="${myAvatar()}" alt="" />
        <h2>Unlock emotes</h2>
        <p>Sign in with Google to earn Penguino Coins and unlock new emotes for your chef.</p>
        ${googleBtn()}
      </div>
    `
    mountScreen('shop', content, () => {
      wireSignInButtons(app)
    })
    return
  }

  // Pull the admin-managed Type tags + title/description overrides so cards,
  // the Type filter, and the A-Z sort all reflect them. Falls back silently.
  await loadEmoteData()

  const thumb = `${BASE}assets/display-case/shop-preview.jpg`
  const shopList = sortedShopEmotes()
  // Render-time override, never persisted: while the tour is active and
  // hasn't completed the waving purchase yet, Waving renders Locked/buyable
  // for EVERYONE, existing owners included - the tour always walks the same
  // real shop tap regardless of what's actually owned underneath. The
  // instant tour.wavingPurchased flips true, this stops overriding and the
  // card reflects real ownership again (which, for an owner, was never
  // touched - see completeOnboardingPurchase()).
  const cards = shopList.length ? shopList.map(e => {
    const tourLocked = !!(tour && e.id === 'waving' && !tour.wavingPurchased)
    const owned = tourLocked ? false : isOwned(e.id)
    const equipped = tourLocked ? false : equippedEmote() === e.id

    let badge
    if (equipped) badge = `<button class="badge badge-equip equipped" type="button" data-equip="${e.id}">✓ Equipped</button>`
    else if (owned) badge = `<button class="badge badge-equip" type="button" data-equip="${e.id}">Equip</button>`
    else badge = '<span class="badge">Locked</span>'
    const lock = (!owned) ? '<div class="lock">🔒</div>' : ''

    const action = owned ? '' : `<button class="btn btn-buy" type="button" data-buy="${e.id}">${coinImg()}1</button>`

    return `
      <div class="anim-card">
        <div class="anim-top" data-emote="${e.id}">
          <img class="anim-still" src="${thumb}" alt="${escapeHtml(emoteName(e))}" />
          ${badge}${lock}
        </div>
        <div class="anim-body">
          <div class="anim-info"><div class="nm">${escapeHtml(emoteName(e))}</div><div class="ds">${escapeHtml(emoteDesc(e))}</div></div>
          <div class="act">
            ${action}
            <button class="btn btn-preview" type="button" data-preview="${e.id}">▶ Preview</button>
          </div>
        </div>
      </div>
    `
  }).join('') : '<p class="shop-empty">No emotes to show here yet.</p>'

  const content = `
    <div class="shop-banner" role="button" tabindex="0" data-action="shop-coin-info">
      <span class="info-badge shop-banner-info" aria-hidden="true">i</span>
      ${coinImg('lg')}
      <div class="txt">
        <div class="t">Emotes Shop</div>
        <div class="s">Unlock new moves for your chef.</div>
      </div>
    </div>
    <div class="shop-sort-row">
      <button class="sort-btn" type="button" data-action="sort">Sort by: <b>${SORT_LABELS[shopSort]}</b> <span class="chev">▼</span></button>
      <button class="sort-btn" type="button" data-action="type">Type: <b>${escapeHtml(typeLabel())}</b> <span class="chev">▼</span></button>
    </div>
    ${cards}
    <p class="code-note" style="text-align:center">More emotes coming — earn a coin every 12 pizzas.</p>
  `

  mountScreen('shop', content, () => {
    if (scrollTop) app.querySelector('.scroll').scrollTop = scrollTop

    app.querySelector('[data-action="shop-coin-info"]')?.addEventListener('click', openCoinInfo)
    app.querySelector('[data-action="sort"]')?.addEventListener('click', openSortMenu)
    app.querySelector('[data-action="type"]')?.addEventListener('click', openTypeMenu)

    app.querySelectorAll('[data-preview]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.preview
        const top = btn.closest('.anim-card').querySelector('.anim-top')
        const img = top.querySelector('.anim-still')
        if (img && img.tagName === 'IMG') {
          top.classList.remove('previewing'); void top.offsetWidth; top.classList.add('previewing')
          playEmoteInto(img, id, thumb)
          toast(`▶ Previewing ${emoteName(EMOTE_BY_ID[id])}…`)
        }
      })
    })

    app.querySelectorAll('[data-buy]').forEach(btn => {
      // Tour spotlights only [data-buy="waving"] (blockers make every other
      // buy button unreachable while it's active), but gating on `tour`
      // alone rather than the id keeps this correct even if that changes.
      btn.addEventListener('click', () => (tour ? confirmBuyTour : confirmBuy)(btn.dataset.buy))
    })
    app.querySelectorAll('[data-equip]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const y = app.querySelector('.scroll')?.scrollTop
        await equipEmote(btn.dataset.equip)
        renderShop(y)
      })
    })
  })
}

function confirmBuy(id) {
  const e = EMOTE_BY_ID[id]
  if (coinBalance() < 1) { toast('Not enough coins — go focus! 🍅'); return }
  const o = overlay(`
    <h3>Unlock ${escapeHtml(emoteName(e))}?</h3>
    <p>This will spend 1 Penguino Coin.</p>
    <div class="home-btn-col">
      <button type="button" data-action="yes">Yes, unlock it</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    await buyEmote(id)
    equipEmote(id)
    shopSort = 'owned'
    renderShop()
    toast(`Unlocked! ${coinImg('toast-coin')} −1`)
  })
}

// Tour-mode variant of confirmBuy(), used ONLY while the onboarding tour is
// active (see renderShop's [data-buy] wiring) - never changes normal shop
// behaviour. Differences from confirmBuy(): no Cancel button (the tour has
// no back-out path except Skip Tutorial - see the buy-waving step), no
// affordability gate (the tour's own display-only +1 already covers it, and
// an existing owner needs no coin at all - see completeOnboardingPurchase()),
// and the write goes through completeOnboardingPurchase() instead of
// buyEmote()/equipEmote() directly, so it's a single atomic, idempotent
// operation server-side rather than two separate client writes.
function confirmBuyTour(id) {
  const e = EMOTE_BY_ID[id]
  const o = overlay(`
    <h3>Unlock ${escapeHtml(emoteName(e))}?</h3>
    <p>This will spend 1 Penguino Coin.</p>
    <div class="home-btn-col">
      <button type="button" data-action="yes">Yes, unlock it</button>
    </div>
  `)
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    await completeOnboardingPurchase()
    shopSort = 'owned'
    renderShop()
    toast(`Unlocked! ${coinImg('toast-coin')} −1`)
  })
  return o
}

// Write-once-atomically purchase for the onboarding tour's free coin (see
// buildOnboardingSteps()'s coin-popup/buy-waving steps). NOTHING is written
// anywhere before this runs - the tour's "+1" balance and the shop's
// "Locked" card for Waving are both pure render-time illusions until this
// actually fires, on the real "Yes, unlock it" tap.
//
// SIGNED-IN: a single SECURITY DEFINER RPC (complete_onboarding_purchase(),
// see supabase/migration_onboarding_v2.sql - NOT run by Claude, paste it
// into the SQL editor yourself) does the whole thing in one transaction,
// guarded by profiles.onboarding_coin_claimed so a retry/re-run can never
// double-grant. Pre-migration (RPC missing) or any other RPC failure: skip
// the write entirely and let the tour continue anyway - no toast, no
// fallback to the old claim+client mechanics, per the brief. The chef keeps
// touring; a real grant just doesn't happen until the migration is live.
//
// GUEST: purely local, same net-zero shape (owned_emotes + a matching
// coin_adjustment) and the same claimed-flag idempotency guard
// (state.onboardingCoinClaimed), so a guest who completes the tour arrives
// server-side owning waving at net-zero once migrateLocalDataIfNeeded()
// carries it over on their first sign-in (see that function).
async function completeOnboardingPurchase() {
  if (isSignedIn() && currentUser) {
    try {
      const { error } = await supabase.rpc('complete_onboarding_purchase')
      if (!error) await refreshProfile()
    } catch {}
  } else if (!state.onboardingCoinClaimed) {
    if (!isOwned('waving')) {
      state.ownedEmotes = [...ownedEmotes(), 'waving']
      state.coinAdjustment = (state.coinAdjustment || 0) + 1
    }
    state.equippedEmote = 'waving'
    state.onboardingCoinClaimed = true
    save()
  }
  if (tour) tour.wavingPurchased = true
}

// =================================================================
//  Coin info popup (the (i) education popup)
// =================================================================
function openCoinInfo() {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    ${coinImg('xl')}
    <h3>Penguino Coins</h3>
    <div class="popup-facts">
      <div class="fact"><span class="fact-k">Earn</span><span class="fact-v">Every 12 pizzas you bake, Chef Penguino sells them for a Penguino Coin. Your lifetime total pizza count will not be affected.</span></div>
      <div class="fact"><span class="fact-k">Spend</span><span class="fact-v">Use coins to unlock awesome new emotes in the Emotes Shop!</span></div>
    </div>
    <button type="button" data-action="ok">Got it</button>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

// =================================================================
//  Lifetime pizzas info popup (the (i) education popup, top-left chip)
// =================================================================
function openPizzaInfo() {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    <div class="popup-emoji-xl">🍕</div>
    <h3>Lifetime Pizzas</h3>
    <p>All the Pizzas you've ever baked.<br>1 Pizza = 1 hour you worked on a task!</p>
    <button type="button" data-action="ok">Got it</button>
  `)
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

// =================================================================
//  Level-up celebration popup + detection
// =================================================================
function openLevelUpPopup(newLevel, unlockedPresets) {
  const art = unlockedPresets && unlockedPresets[0]
  const artHtml = art
    ? `<img class="lvup-art" src="${art.url}" alt="" /><div class="lvup-sub">New profile picture unlocked</div>`
    : ''
  const o = overlay(`
    <div class="lvup-kicker">Level Up</div>
    <div class="lvup-num">${newLevel}</div>
    ${artHtml}
    <div class="home-btn-col">
      ${art ? `<button type="button" data-action="equip">Equip now</button>` : ''}
      <button type="button" class="btn-secondary" data-action="later">${art ? 'Later' : 'Nice!'}</button>
    </div>
  `, { popupClass: 'popup-levelup' })
  o.querySelector('[data-action="later"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="equip"]')?.addEventListener('click', () => {
    o.remove()
    openEditPicturePopup()
  })
}

// Compares the current derived level against currentProfile.level_seen and,
// if it's advanced, shows ONE consolidated celebration popup for the highest
// level reached (never a stack), then persists level_seen so it doesn't fire
// again. Guests never level up, so this is a no-op unless signed in.
async function checkLevelUp() {
  if (!currentUser || !currentProfile) return
  const level = myLevel()
  if (level == null) return
  const seen = currentProfile.level_seen ?? 1
  if (level <= seen) return
  let unlocked = []
  const { data } = await supabase
    .from('preset_avatars')
    .select('id, url, unlock_level')
    .gt('unlock_level', seen)
    .lte('unlock_level', level)
    .order('unlock_level', { ascending: false })
  if (data && data.length) unlocked = data
  openLevelUpPopup(level, unlocked)
  currentProfile.level_seen = level
  await supabase.from('profiles').update({ level_seen: level }).eq('id', currentUser.id)
}

// =================================================================
//  Emotes info popup (the (i) education popup, home hero card)
// =================================================================
function openEmoteInfo() {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    <div class="popup-emoji-xl">💃</div>
    <h3>About Emotes</h3>
    <p>Emotes are cool animations that lets your Chef Penguino express himself.<br>Get more from the shop!</p>
    <button type="button" data-action="ok">Got it</button>
  `)
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

// =================================================================
//  Pizzas in stash info popup (the (i) education popup, home tile)
// =================================================================
function openStashInfo() {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    <div class="popup-emoji-xl">👨‍🍳</div>
    <h3>Pizzas In Stash</h3>
    <p>Current pizzas Chef Penguino has yet to sell.<br>The number you have corresponds to how many you see in Chef Penguino's display shelving.</p>
    <button type="button" data-action="ok">Got it</button>
  `)
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

// =================================================================
//  Profile popup (tap the status-bar avatar)
// =================================================================
async function openProfilePopup() {
  const signed = isSignedIn()
  // Level lives here rather than in its own popup: tapping the header avatar
  // or the Lv. pill both land on this one screen, so there's a single place
  // that answers "how am I doing".
  let levelBlock = ''
  if (signed) {
    const { level, next, into, need } = levelProgress()
    const { data } = await supabase
      .from('preset_avatars')
      .select('id, url, unlock_level')
      .gt('unlock_level', level)
      .order('unlock_level', { ascending: true })
      .limit(1)
    const up = (data && data[0]) || null
    const teaser = up
      ? `<div class="lvup-next"><img class="lvup-next-art" src="${up.url}" alt="" /><span>New picture at <b>Level ${up.unlock_level}</b></span></div>`
      : `<div class="lvup-next"><span>You've unlocked every picture</span></div>`
    levelBlock = `
      <div class="profile-lv">
        <div class="lvup-kicker">Level</div>
        <div class="lvup-num compact">${level}</div>
        <div class="lv-bar wide"><span class="lv-bar-fill" style="width:${need ? Math.min(100, Math.max(0, (into / need) * 100)) : 0}%"></span></div>
        <p class="lvup-sub">${formatScore(into)} / ${need} pizzas to Level ${next}</p>
        ${teaser}
      </div>
    `
  }
  const editOrGuest = signed
    ? `<button class="btn-edit-profile" type="button" data-action="edit-profile">${PENCIL_SVG}<span style="margin-left:8px">Edit Profile</span></button>
       <button class="btn-danger" type="button" data-action="sign-out" style="margin-top:0.625rem">Sign Out</button>`
    // No "Sign in to level up" line here - the paragraph above already makes
    // the case for signing in, and the header carries that exact wording under
    // a guest's name, so repeating it in the same popup was redundant.
    : `<p style="color:var(--muted);font-size:13px;line-height:1.5;margin:0 0 16px">Sign in to save your progress and customise your profile.</p>${googleBtn()}`

  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <div class="popup-profile-name">${escapeHtml(myName())}</div>
    <img class="popup-profile-avatar" src="${myAvatar()}" alt="" />
    ${levelBlock}
    ${editOrGuest}
  `, { popupClass: 'popup-profile' })

  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  wireSignInButtons(o)
  o.querySelector('[data-action="edit-profile"]')?.addEventListener('click', () => {
    o.remove()
    renderSettings(true)
  })
  o.querySelector('[data-action="sign-out"]')?.addEventListener('click', () => {
    o.remove()
    signOut()
  })
}

// =================================================================
//  Friends
// =================================================================
async function renderFriends() {
  if (!isSignedIn()) {
    const content = `
      <div class="friends-gate" style="display:block">
        <img src="${myAvatar()}" alt="" />
        <h2>Play with friends</h2>
        <p>Sign in with Google to add friends, compare your pizzas, and climb the leaderboard.</p>
        ${googleBtn()}
      </div>
    `
    mountScreen('friends', content, () => {
      wireSignInButtons(app)
    })
    return
  }
  renderChefsScreen()
}

// =================================================================
//  Chefs: Friends / Groups / Requests (renderFriends() above is the entry
//  point from the bottom tab bar and the sign-in gate; everything below
//  builds the three-tab screen it hands off to once signed in). Ported from
//  the approved mockup at app/review/chefs-page-mockup.html, retokenised
//  onto this app's own --card/--fire/--gold/etc. variables and rem units.
//
//  chefsTab is module state rather than screen-local so re-entering the
//  Chefs tab (e.g. after backing out of a friend's Pizzeria) lands back on
//  whichever of Friends/Groups/Requests the chef was last looking at.
// =================================================================
let chefsTab = 'friends' // 'friends' | 'groups' | 'requests'

function renderChefsScreen() {
  const content = `
    ${chefsSegHtml(chefsTab)}
    <div class="chefs-pill-bar" id="chefs-pill-bar" hidden></div>
    <div id="chefs-body"><p class="log-empty">Loading&hellip;</p></div>
  `
  mountScreen('friends', content, () => {
    wireChefsSeg()
    refreshChefsPendingBadge()
    loadChefsTabBody()
  }, { key: 'chefs-' + chefsTab })
}

function chefsSegHtml(tab) {
  const seg = (id, label) => `<button type="button" class="${tab === id ? 'on' : ''}" data-chefs-tab="${id}">${label}${id === 'requests' ? '<span class="seg-badge" id="chefs-req-badge" hidden>0</span>' : ''}</button>`
  return `<div class="cal-seg" id="chefs-seg">${seg('friends', 'Friends')}${seg('groups', 'Groups')}${seg('requests', 'Requests')}</div>`
}

function wireChefsSeg() {
  app.querySelectorAll('#chefs-seg [data-chefs-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.chefsTab
      if (tab === chefsTab) return
      chefsTab = tab
      renderChefsScreen()
    })
  })
}

function loadChefsTabBody() {
  if (chefsTab === 'friends') return loadChefsFriendsTab()
  if (chefsTab === 'groups') return loadChefsGroupsTab()
  return loadChefsRequestsTab()
}

// Friend requests + group invites fetched together so the Requests badge and
// the Requests tab body never issue two separate round-trips for the same
// numbers. Both RPCs only exist once migration_friend_requests.sql /
// migration_groups.sql have been run in Supabase - until then they 404 and
// that's treated as "nothing pending" rather than surfacing a raw Postgres
// error anywhere in the UI.
async function fetchChefsPending() {
  const [freq, ginv] = await Promise.all([
    supabase.rpc('incoming_friend_requests'),
    supabase.rpc('my_group_invites'),
  ])
  return {
    friendRequests: freq.error ? [] : (freq.data || []),
    groupInvites: ginv.error ? [] : (ginv.data || []),
  }
}

async function refreshChefsPendingBadge() {
  const { friendRequests, groupInvites } = await fetchChefsPending()
  const n = friendRequests.length + groupInvites.length
  const badge = app.querySelector('#chefs-req-badge')
  if (badge) { badge.textContent = String(n); badge.hidden = n === 0 }
}

// Compact relative-time label for request rows ("2h ago", "3d ago").
function chefsTimeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// The one "N baking" indicator used everywhere in the app - Friends, the
// Groups list, a group's detail screen - so they all read as the same live
// signal. It matches the admin dashboard's pill, which is where this design
// started: green, with a pulsing dot.
// A count of 0 keeps that exact styling rather than dropping to a muted
// variant. This isn't a badge (badges hide at 0, see setSegBadge) - it's a
// live-status readout, and "0 baking" is a real, useful answer.
function chefsPillHtml(count) {
  return `<div class="adm-live-dot chefs-pill"><i></i><span>${count} baking</span></div>`
}
function showChefsPill(count) {
  const bar = app.querySelector('#chefs-pill-bar')
  if (!bar) return
  bar.hidden = false
  bar.innerHTML = chefsPillHtml(count)
}
// Groups LIST hides the pill entirely (ambiguous across several groups -
// which one would it even count?); Requests has no baking scope either.
function hideChefsPill() {
  const bar = app.querySelector('#chefs-pill-bar')
  if (!bar) return
  bar.hidden = true
  bar.innerHTML = ''
}

// startOfThisWeek() (Monday 00:00 Singapore time) is defined earlier, near
// nextMondayLabel() / the other sgt* helpers, so both live together.

// ---------------- Friends tab ----------------
async function loadChefsFriendsTab() {
  const body = app.querySelector('#chefs-body')
  if (!body) return
  body.innerHTML = `
    <input class="chefs-search" id="chefs-search" placeholder="Search chefs to add" autocomplete="off">
    <div class="section-h" id="chefs-board-head"><h2>Weekly Scoreboard</h2><span class="meta">Resets&nbsp;${nextMondayLabel()}</span></div>
    <div id="chefs-friends-list"><p class="log-empty">Loading&hellip;</p></div>
    <div class="section-h" style="margin-top:2.75rem"><h2>Add by code</h2></div>
    <div class="addfriend"><input id="friend-code-input" placeholder="Friend's code" maxlength="6" /><button type="button" data-action="add">Add</button></div>
    <p class="friends-error" id="friends-error" hidden></p>
    <p class="code-note">They'll get a request to approve — it shows up in their <b>Requests</b> tab.</p>
    <p class="code-note">Your code: <b id="friend-code-val">${escapeHtml(currentProfile?.friend_code || '…')}</b> <button class="copy-btn" type="button" data-action="copy" aria-label="Copy friend code">${COPY_SVG}</button></p>
  `
  const errorEl = body.querySelector('#friends-error')
  body.querySelector('[data-action="add"]').addEventListener('click', async () => {
    const input = body.querySelector('#friend-code-input')
    const code = input.value.trim()
    if (!code) return
    errorEl.hidden = true
    const { error } = await supabase.rpc('add_friend_by_code', { code })
    if (error) { errorEl.textContent = error.message; errorEl.hidden = false; return }
    input.value = ''
    toast('Request sent — they approve it from their Requests tab.')
    loadFriendsList()
    refreshChefsPendingBadge()
  })
  body.querySelector('[data-action="copy"]').addEventListener('click', () => {
    const code = body.querySelector('#friend-code-val').textContent.trim()
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('Code copied!')).catch(() => toast('Code copied!'))
    else toast('Code copied!')
  })
  let searchTimer
  body.querySelector('#chefs-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    const q = e.target.value.trim()
    searchTimer = setTimeout(() => (q ? runChefsSearch(q) : loadFriendsList()), 250)
  })
  loadFriendsList()
}

// Empty-search state: the weekly scoreboard. Function name kept from before
// the Chefs redesign since block/remove/add-by-code below all refresh it by
// calling it directly.
async function loadFriendsList() {
  const listEl = app.querySelector('#chefs-friends-list')
  if (!listEl) return

  const weekStartISO = startOfThisWeek().toISOString()
  const [friendRows, { data: pendingRows }, { data: weekSessions }] = await Promise.all([
    fetchAcceptedFriends(),
    supabase.from('noots').select('recipient_id').eq('sender_id', currentUser.id).is('acknowledged_at', null),
    // RLS ("sessions are visible to self and friends") scopes this to me + my
    // friends automatically, so one query gives every board member's week.
    supabase.from('sessions').select('user_id, pizzas').gte('completed_at', weekStartISO),
  ])

  const friends = friendRows.map(r => r.profiles).filter(Boolean)
  const pendingNootTargets = new Set((pendingRows || []).map(r => r.recipient_id))

  // profiles.baking_since is set while a timer runs (see setBakingNow), and
  // anything older than the staleness cutoff is treated as abandoned rather
  // than still baking. Friends' profiles are readable under existing RLS, so
  // no extra query is needed - the flag rides along on the friend rows.
  const cutoff = bakingCutoffISO()
  friends.forEach(f => { f.baking = !!f.baking_since && f.baking_since > cutoff })
  showChefsPill(friends.filter(f => f.baking).length)
  const boardHead = app.querySelector('#chefs-board-head')
  if (boardHead) boardHead.hidden = false

  if (!friends.length) {
    listEl.innerHTML = `<div class="frow lonely-card">It's lonely here. Add friends to start climbing the ladder!</div>`
    return
  }

  // Sum this week's pizzas per user. Anyone with no sessions this week isn't in
  // the result and correctly falls back to 0. profiles.pizzas (lifetime) stays
  // untouched on each object, so tapping a friend still shows their all-time
  // total on their Pizzeria page.
  const weeklyById = {}
  ;(weekSessions || []).forEach(s => { weeklyById[s.user_id] = (weeklyById[s.user_id] || 0) + (Number(s.pizzas) || 0) })

  // Your own row never shows the dot - you know you're baking, and the pill
  // above counts friends. Friends keep the flag computed from baking_since.
  const me = { id: currentUser.id, display_name: myName(), pizzas: displayPizzas(), avatar_url: myAvatar(), isMe: true, baking: false }
  const board = [...friends.map(f => ({ ...f })), me]
  board.forEach(f => { f.weekly = weeklyById[f.id] || 0 })
  board.sort((a, b) => b.weekly - a.weekly)

  listEl.innerHTML = board.map((f, i) => chefsFriendRowHtml(f, i)).join('')

  const friendsById = Object.fromEntries(friends.map(f => [f.id, f]))
  // Tap the row = visit Pizzeria; tap the 3 dots = the full action menu.
  listEl.querySelectorAll('.frow[data-friend]').forEach(row => {
    const friend = friendsById[row.dataset.friend]
    wireFriendRow(row, friend, pendingNootTargets)
  })
  // Your own row opens your profile popup instead (same as tapping your avatar/name up top).
  const meRow = listEl.querySelector('.frow.me')
  meRow?.addEventListener('click', openProfilePopup)
}

// Tries the post-migration_friend_requests.sql shape first (only accepted
// friendships belong on the scoreboard, not pending ones); falls back to the
// unfiltered pre-migration query - which only ever contained accepted rows
// anyway - so the board still loads if that migration hasn't been run yet.
async function fetchAcceptedFriends() {
  const sel = 'friend_id, profiles:friend_id(id, display_name, pizzas, avatar_url, friend_code, equipped_emote, owned_emotes, waving_free, baking_since)'
  let { data, error } = await supabase.from('friends').select(sel).eq('status', 'accepted')
  // Fall back twice: once without the status filter (pre-friend-requests DB),
  // then without baking_since (pre-migration_baking_now DB), so the board
  // still loads on an older schema instead of coming back empty.
  if (error) ({ data, error } = await supabase.from('friends').select(sel))
  if (error) {
    const legacy = 'friend_id, profiles:friend_id(id, display_name, pizzas, avatar_url, friend_code, equipped_emote, owned_emotes)'
    ;({ data } = await supabase.from('friends').select(legacy))
  }
  return data || []
}

function chefsFriendRowHtml(f, i) {
  const rank = i < 3 ? `<div class="medal">${['🥇', '🥈', '🥉'][i]}</div>` : `<div class="rank">${i + 1}</div>`
  const name = escapeHtml(chefName(f.display_name))
  // A dot, not a chip, next to the name - a chip would change row height for
  // every row whenever one friend happens to be baking.
  const liveDot = f.baking ? '<span class="chefs-live-dot" title="Baking now"></span>' : ''
  // Two lines instead of one: the name owns the full row width on line 1, and
  // the score (plus the "you" marker) drops to a quieter line beneath it.
  // Previously the name competed horizontally with a right-aligned score AND
  // an inline "(you)", which is what forced such a short name limit. Rank,
  // avatar and ⋮ stay put, and two text lines are still shorter than the
  // avatar, so row height is unchanged.
  const meta = [
    `<span class="chefs-score">🍕 ${formatScore(Number(f.weekly) || 0)}</span>`,
    f.isMe ? '<span class="you-tag">you</span>' : '',
  ].filter(Boolean).join('')
  return `
    <div class="frow ${f.isMe ? 'me' : ''}" ${f.isMe ? 'role="button" tabindex="0"' : `data-friend="${f.id}" role="button" tabindex="0"`}>
      ${rank}
      <img src="${f.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="finfo">
        <div class="chefs-fn-row">${liveDot}<span class="fn">${name}</span></div>
        <div class="chefs-meta-row">${meta}</div>
      </div>
      ${f.isMe ? '<span class="chefs-more-spacer" aria-hidden="true"></span>' : `<button type="button" class="frow-more" data-more="${f.id}" aria-label="More actions">⋮</button>`}
    </div>`
}

// Guards against an in-flight search response landing after a newer
// keystroke's - without this, typing quickly can flash a stale result set.
let chefsSearchAbort = 0
async function runChefsSearch(q) {
  const listEl = app.querySelector('#chefs-friends-list')
  if (!listEl) return
  hideChefsPill() // search results aren't a baking-count scope
  // Search results are not the weekly board, so its heading goes with it.
  const head = app.querySelector('#chefs-board-head')
  if (head) head.hidden = true
  const myCall = ++chefsSearchAbort
  listEl.innerHTML = `<p class="log-empty">Searching&hellip;</p>`
  const { data, error } = await supabase.rpc('search_chefs', { q, lim: 30 })
  if (myCall !== chefsSearchAbort) return
  if (error) { listEl.innerHTML = `<p class="chefs-empty-hint">Chef search isn't available yet.</p>`; return }
  const hits = (data || []).filter(c => c.relationship !== 'self')
  if (!hits.length) { listEl.innerHTML = `<p class="chefs-empty-hint">No chefs match "${escapeHtml(q)}"</p>`; return }
  listEl.innerHTML = `<div class="chefs-label">Chefs matching "${escapeHtml(q)}"</div>` + hits.map(chefsSearchRowHtml).join('')
  listEl.querySelectorAll('[data-send]').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    btn.disabled = true
    const { error: sendErr } = await supabase.rpc('send_friend_request', { target_id: btn.dataset.send })
    if (sendErr) { btn.disabled = false; toast("Friend requests aren't available yet.") ; return }
    toast('Friend request sent!')
    refreshChefsPendingBadge()
    runChefsSearch(q)
  }))
}

// Search results deliberately show no friend code (search_chefs() doesn't
// return one either) - a stranger shouldn't be able to harvest codes.
function chefsSearchRowHtml(c) {
  const action = c.relationship === 'friend' ? '<span class="chefs-rel-tag friend">✓ Friend</span>'
    : c.relationship === 'outgoing' ? '<span class="chefs-rel-tag pending">Pending</span>'
    : c.relationship === 'incoming' ? '<span class="chefs-rel-tag pending">Wants to add you</span>'
    : `<button type="button" class="chefs-add-btn" data-send="${c.id}" aria-label="Add ${escapeHtml(chefName(c.display_name))}">＋</button>`
  return `
    <div class="frow" style="cursor:default">
      <img src="${c.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="finfo"><span class="fn">${escapeHtml(chefName(c.display_name))}</span></div>
      <div class="score">🍕 ${formatScore(Number(c.weekly_pizzas) || 0)}</div>
      ${action}
    </div>`
}

// ---------------- Groups tab ----------------
async function loadChefsGroupsTab() {
  const body = app.querySelector('#chefs-body')
  if (!body) return
  hideChefsPill() // ambiguous across several groups - only shown once inside one
  body.innerHTML = `
    <input class="chefs-search" id="chefs-group-search" placeholder="Search or discover groups" autocomplete="off">
    <div id="chefs-groups-list"><p class="log-empty">Loading&hellip;</p></div>
  `
  let searchTimer
  body.querySelector('#chefs-group-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    const q = e.target.value.trim()
    searchTimer = setTimeout(() => runChefsGroupSearch(q), 250)
  })
  runChefsGroupSearch('')
}

async function runChefsGroupSearch(q) {
  const listEl = app.querySelector('#chefs-groups-list')
  if (!listEl) return
  const { data: mineData, error: mineErr } = await supabase.rpc('my_groups', { week_start: startOfThisWeek().toISOString() })
  if (mineErr) {
    listEl.innerHTML = `<p class="chefs-empty-hint">Groups aren't available yet.</p>` + chefsGroupActionsHtml(!q)
    wireChefsGroupActions(listEl)
    return
  }
  const mine = (mineData || []).filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase()))
  let found = []
  if (q) {
    const { data: discData } = await supabase.rpc('discover_groups', { q, week_start: startOfThisWeek().toISOString() })
    found = discData || []
  }
  let html = ''
  if (mine.length) html += (q ? `<div class="chefs-label">Your groups</div>` : '') + mine.map(g => chefsGroupCardHtml(g, false)).join('')
  else if (q) html += `<p class="chefs-empty-hint">None of your groups match "${escapeHtml(q)}"</p>`
  if (q && found.length) html += `<div class="chefs-label">Discover</div>` + found.map(g => chefsGroupCardHtml(g, true)).join('')
  if (!mine.length && !q) html += `<p class="chefs-empty-hint">You're not in any groups yet.</p>`
  html += chefsGroupActionsHtml(!q)
  listEl.innerHTML = html
  listEl.querySelectorAll('.chefs-gcard[data-group]:not([data-joinable])').forEach(card => {
    card.addEventListener('click', () => openChefsGroup(card.dataset.group))
  })
  listEl.querySelectorAll('[data-join]').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    btn.disabled = true
    const { error } = await supabase.rpc('join_group', { group_id: btn.dataset.join })
    if (error) { btn.disabled = false; toast(error.message || 'Could not join that group.'); return }
    toast('Joined!')
    openChefsGroup(btn.dataset.join)
  }))
  wireChefsGroupActions(listEl)
}

function wireChefsGroupActions(listEl) {
  listEl.querySelector('[data-action="create-group"]')?.addEventListener('click', openCreateGroupPopup)
  listEl.querySelector('[data-action="join-with-code"]')?.addEventListener('click', openJoinGroupByCodePopup)
}

function chefsGroupActionsHtml(show) {
  if (!show) return ''
  return `
    <div class="chefs-group-actions">
      <button type="button" class="chefs-grp-btn primary" data-action="create-group">＋ Create group</button>
      <button type="button" class="chefs-grp-btn secondary" data-action="join-with-code">Join with code</button>
    </div>`
}

function chefsGroupCardHtml(g, joinable) {
  const id = g.group_id || g.id
  const members = Number(g.member_count) || 0
  return `
    <div class="chefs-gcard" data-group="${id}" ${joinable ? 'data-joinable="1"' : ''}>
      <div class="chefs-gcard-top">
        <div class="chefs-gavatar">${escapeHtml(g.emoji || '🍕')}</div>
        <div class="chefs-gcard-info">
          <div class="chefs-gname">${escapeHtml(g.name)}</div>
          <div class="chefs-gmeta">${chefsPrivacyChip(g.privacy)} · ${members} member${members === 1 ? '' : 's'}</div>
        </div>
      </div>
      <div class="chefs-gbottom">
        <div class="chefs-gscore"><span class="ic">🍕</span><span class="num">${formatScore(Number(g.weekly_pizzas) || 0)}</span><span class="unit">pizzas</span></div>
        ${joinable
          ? `<button type="button" class="chefs-join-btn" data-join="${id}">Join</button>`
          // baking_count comes from my_groups(); it's absent on an older
          // schema, in which case the line is simply omitted rather than
          // asserting "0 baking" as if it were measured.
          : (g.baking_count === undefined || g.baking_count === null
              ? ''
              : chefsPillHtml(Number(g.baking_count)))}
      </div>
    </div>`
}

const CHEFS_ICON_GLOBE = `<svg class="chefs-pic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 5.8 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.8-3.8-9S9.5 5.7 12 3z"/></svg>`
const CHEFS_ICON_LOCK = `<svg class="chefs-pic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8.2 10V7.2a3.8 3.8 0 0 1 7.6 0V10"/></svg>`
// White outline icon + label, never emoji - a privacy emoji reads as
// unreadable/muddy on some platforms' dark chip backgrounds.
function chefsPrivacyChip(privacy) {
  const pub = privacy === 'public'
  return `<span class="chefs-priv-chip">${pub ? CHEFS_ICON_GLOBE : CHEFS_ICON_LOCK}${pub ? 'Public' : 'Private'}</span>`
}

// ---------------- Create group / Join by code popups ----------------
let chefsCreateEmoji = null
async function openCreateGroupPopup() {
  await loadGroupIcons() // same curated set (+ fallback) as the admin picker
  chefsCreateEmoji = groupIconChoices()[0]?.emoji || '🍕'
  let privacy = 'public'
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Create a group</h3>
    <label class="chefs-flabel">Group icon</label>
    <div class="chefs-emoji-picker" id="cg-emoji-picker">${chefsEmojiPickerHtml(chefsCreateEmoji)}</div>
    <label class="chefs-flabel">Name</label>
    <input class="rename-input" id="cg-name" maxlength="30" placeholder="e.g. Late Night Bakers">
    <label class="chefs-flabel">Who can join</label>
    <div class="chefs-setcard" id="cg-privacy">
      ${chefsPrivacyOptHtml('public', true)}
      ${chefsPrivacyOptHtml('private', false)}
    </div>
    <div class="home-btn-col" style="margin-top:1rem">
      <button type="button" data-action="create">Create group</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelectorAll('#cg-emoji-picker [data-emoji]').forEach(btn => btn.addEventListener('click', () => {
    chefsCreateEmoji = btn.dataset.emoji
    o.querySelectorAll('#cg-emoji-picker [data-emoji]').forEach(b => b.classList.toggle('on', b === btn))
  }))
  o.querySelectorAll('#cg-privacy [data-privacy-opt]').forEach(row => row.addEventListener('click', () => {
    privacy = row.dataset.privacyOpt
    o.querySelectorAll('#cg-privacy [data-privacy-opt]').forEach(r => {
      const on = r.dataset.privacyOpt === privacy
      r.classList.toggle('on', on)
      r.querySelector('.chefs-radio').classList.toggle('on', on)
    })
  }))
  o.querySelector('[data-action="create"]').addEventListener('click', async () => {
    const name = o.querySelector('#cg-name').value.trim()
    if (!name) { toast('Give your group a name first'); return }
    // Same blocklist as chef display names - a group name is just as public.
    if (!isNameAllowed(name)) { toast("That name isn't allowed — please choose another."); return }
    const btn = o.querySelector('[data-action="create"]')
    btn.disabled = true
    const { data, error } = await supabase.rpc('create_group', { name, emoji: chefsCreateEmoji, privacy })
    if (error) { btn.disabled = false; toast(error.message || 'Could not create group.'); return }
    o.remove()
    toast(`${name} created!`)
    chefsTab = 'groups'
    openChefsGroup(data)
  })
}

// Scoped as `.chefs-emoji-picker .chefs-epick` in CSS (not just `.chefs-epick`)
// so it outranks the generic `.popup button` gold-fill rule these buttons sit
// inside here - same trick already used for `.popup .gbtn`/`.popup .abtn`.
// The picker must never come up empty. groupIconsCache is the real DB state
// (the admin Group Icons manager needs that truth, including "none yet"), but
// a chef creating a group still has to have something to pick - an empty
// "Group icon" section just reads as broken. So the picker, and only the
// picker, falls back to the default set.
function groupIconChoices() {
  return groupIconsCache.length ? groupIconsCache : GROUP_ICONS_FALLBACK.map(e => ({ id: null, emoji: e }))
}

function chefsEmojiPickerHtml(selected) {
  return groupIconChoices().map(g => `<button type="button" class="chefs-epick ${g.emoji === selected ? 'on' : ''}" data-emoji="${escapeHtml(g.emoji)}">${escapeHtml(g.emoji)}</button>`).join('')
}

function chefsPrivacyOptHtml(val, isOn) {
  const icon = val === 'public' ? CHEFS_ICON_GLOBE : CHEFS_ICON_LOCK
  const label = val === 'public' ? 'Public' : 'Private'
  const sub = val === 'public' ? 'Anyone can find and join instantly' : 'Hidden from search — join by code or invite'
  return `
    <div class="chefs-opt ${isOn ? 'on' : ''}" data-privacy-opt="${val}">
      <div class="chefs-opt-ic">${icon}</div>
      <div class="chefs-opt-info"><div class="chefs-opt-t">${label}</div><div class="chefs-opt-s">${sub}</div></div>
      <div class="chefs-radio ${isOn ? 'on' : ''}"></div>
    </div>`
}

function openJoinGroupByCodePopup() {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Join a group</h3>
    <p>Enter the 6-character code a chef shared with you.</p>
    <input class="rename-input" id="jg-code" maxlength="6" placeholder="Group code" style="text-transform:uppercase;letter-spacing:0.12em">
    <div class="home-btn-col" style="margin-top:0.5rem">
      <button type="button" data-action="join">Join group</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="join"]').addEventListener('click', async () => {
    const code = o.querySelector('#jg-code').value.trim()
    if (!code) { toast('Enter a code first'); return }
    const btn = o.querySelector('[data-action="join"]')
    btn.disabled = true
    const { data, error } = await supabase.rpc('join_group_by_code', { code })
    if (error) { btn.disabled = false; toast(error.message || 'No group found with that code.'); return }
    o.remove()
    toast('Joined!')
    chefsTab = 'groups'
    openChefsGroup(data)
  })
}

// ---------------- Group detail ----------------
function openChefsGroup(groupId) {
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-groups">‹ Groups</div>
    <div class="chefs-pill-bar" id="chefs-pill-bar" hidden></div>
    <div id="chefs-group-body"><p class="log-empty">Loading&hellip;</p></div>
  `
  mountScreen('friends', content, () => {
    app.querySelector('[data-action="back-to-groups"]').addEventListener('click', () => { chefsTab = 'groups'; renderChefsScreen() })
    loadChefsGroupDetail(groupId)
  }, { key: 'chefs-group-' + groupId })
}

async function loadChefsGroupDetail(groupId) {
  const bodyEl = app.querySelector('#chefs-group-body')
  if (!bodyEl) return
  const [{ data: mineData }, { data: memberData, error: memErr }] = await Promise.all([
    supabase.rpc('my_groups', { week_start: startOfThisWeek().toISOString() }),
    supabase.rpc('group_members_list', { group_id: groupId, week_start: startOfThisWeek().toISOString() }),
  ])
  const g = (mineData || []).find(x => x.group_id === groupId)
  if (!g) { bodyEl.innerHTML = `<p class="chefs-empty-hint">This group is no longer available.</p>`; return }
  if (memErr) { bodyEl.innerHTML = `<p class="chefs-empty-hint">${escapeHtml(memErr.message || "Couldn't load members.")}</p>`; return }
  const members = memberData || []
  const ranked = [...members].sort((a, b) => Number(b.weekly_pizzas) - Number(a.weekly_pizzas))

  // group_members_list() returns each member's baking_since (see
  // migration_baking_now.sql), so this group's live count is just a filter.
  const bakingCutoff = bakingCutoffISO()
  showChefsPill(members.filter(m => m.baking_since && m.baking_since > bakingCutoff).length)

  bodyEl.innerHTML = `
    <div class="chefs-ghead">
      <div class="chefs-gavatar lg">${escapeHtml(g.emoji || '🍕')}</div>
      <div class="chefs-gcard-info">
        <div class="chefs-gname lg">${escapeHtml(g.name)}</div>
        <div class="chefs-gmeta">${chefsPrivacyChip(g.privacy)} · ${members.length} member${members.length === 1 ? '' : 's'}</div>
      </div>
      ${g.role === 'owner' ? `<button type="button" class="chefs-gear-btn" data-action="group-settings" aria-label="Group settings">⚙️</button>` : ''}
    </div>
    <div class="section-h" style="margin-top:1.25rem"><h2>Weekly Leaderboard</h2><span class="meta">Resets&nbsp;${nextMondayLabel()}</span></div>
    ${ranked.map((m, i) => chefsMemberRowHtml(m, i)).join('')}
    <div class="chefs-group-actions">
      ${g.role === 'owner'
        // Owner only: both ways of getting new people in belong to whoever
        // owns the group. A member has neither - they just have the way out.
        // No "Leave" here for the owner: leave_group() rejects the owner by
        // design, so that button could only ever toast its own refusal. The
        // owner's real exit is Delete group, in the gear settings.
        ? `<button type="button" class="chefs-grp-btn primary" data-action="invite-friends">Invite friends</button>
           <button type="button" class="chefs-grp-btn secondary" data-action="share-code">Share join code</button>`
        : `<button type="button" class="chefs-grp-btn danger" data-action="leave">Leave group</button>`}
    </div>
  `
  bodyEl.querySelector('[data-action="group-settings"]')?.addEventListener('click', () => openChefsGroupSettings(groupId))
  bodyEl.querySelector('[data-action="share-code"]')?.addEventListener('click', () => {
    const code = g.join_code || ''
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast(`Code copied: ${code}`)).catch(() => toast(`Group code: ${code}`))
    else toast(`Group code: ${code}`)
  })
  bodyEl.querySelector('[data-action="invite-friends"]')?.addEventListener('click', () =>
    openGroupInvitePopup(groupId, g.name, members.map(m => m.user_id)))
  bodyEl.querySelector('[data-action="leave"]')?.addEventListener('click', () => confirmLeaveGroup(groupId, g.name))
}

function chefsMemberRowHtml(m, i) {
  const rank = i < 3 ? `<div class="medal">${['🥇', '🥈', '🥉'][i]}</div>` : `<div class="rank">${i + 1}</div>`
  const isMe = m.user_id === currentUser.id
  // Same two-line layout as the Friends leaderboard rows: the name gets the
  // full row on line 1, and the score + you/owner tags drop to a quieter
  // line 2. This row used to cram name + "(you)" + "Owner" onto one line
  // competing with a right-aligned score - which the shared .fn ellipsis
  // rule (added for long names) would then truncate mid-word.
  const meta = [
    `<span class="chefs-score">🍕 ${formatScore(Number(m.weekly_pizzas) || 0)}</span>`,
    isMe ? '<span class="you-tag">you</span>' : '',
    m.role === 'owner' ? '<span class="chefs-role-tag">Owner</span>' : '',
  ].filter(Boolean).join('')
  return `
    <div class="frow ${isMe ? 'me' : ''}" style="cursor:default">
      ${rank}
      <img src="${m.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="finfo">
        <div class="chefs-fn-row"><span class="fn">${escapeHtml(chefName(m.display_name))}</span></div>
        <div class="chefs-meta-row">${meta}</div>
      </div>
    </div>`
}

// Owner-only: invite existing friends straight into a group instead of
// making them find the join code. Multi-select, because inviting four
// people shouldn't mean opening this four times.
// `memberIds` are the chefs already in the group - they're filtered out
// rather than shown-but-disabled, since a list of people you can't pick is
// just noise on a phone-sized popup.
async function openGroupInvitePopup(groupId, groupName, memberIds) {
  const already = new Set(memberIds || [])
  const o = overlay(`
    <h3>Invite friends</h3>
    <p class="chefs-invite-sub">to ${escapeHtml(groupName)}</p>
    <div class="chefs-invite-list" id="gi-list"><p class="log-empty" style="margin:0.75rem 0">Loading&hellip;</p></div>
    <div class="home-btn-col">
      <button type="button" data-action="send" disabled>Send invites</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  const listEl = o.querySelector('#gi-list')
  const sendBtn = o.querySelector('[data-action="send"]')
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())

  const rows = await fetchAcceptedFriends()
  const friends = rows.map(r => r.profiles).filter(Boolean).filter(f => !already.has(f.id))
  if (!friends.length) {
    listEl.innerHTML = `<p class="chefs-empty-hint" style="margin:0.75rem 0">${
      rows.length ? 'All your friends are already in this group.' : 'Add some friends first, then you can invite them here.'
    }</p>`
    sendBtn.remove()
    return
  }

  const picked = new Set()
  listEl.innerHTML = friends.map(f => `
    <button type="button" class="chefs-invite-row" data-id="${escapeHtml(f.id)}">
      <img class="chefs-invite-av" src="${f.avatar_url || DEFAULT_AVATAR}" alt="" />
      <span class="chefs-invite-name">${escapeHtml(chefName(f.display_name))}</span>
      <span class="chefs-check" aria-hidden="true"></span>
    </button>`).join('')

  const syncSend = () => {
    sendBtn.disabled = picked.size === 0
    sendBtn.textContent = picked.size ? `Send ${picked.size} invite${picked.size === 1 ? '' : 's'}` : 'Send invites'
  }
  listEl.querySelectorAll('.chefs-invite-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id
      if (picked.has(id)) { picked.delete(id); row.classList.remove('on'); row.setAttribute('aria-pressed', 'false') }
      else { picked.add(id); row.classList.add('on'); row.setAttribute('aria-pressed', 'true') }
      syncSend()
    })
  })

  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true
    sendBtn.textContent = 'Sending…'
    const ids = [...picked]
    const results = await Promise.all(ids.map(id =>
      supabase.rpc('invite_to_group', { group_id: groupId, target_id: id })))
    o.remove()
    const failed = results.filter(r => r.error)
    if (!failed.length) {
      toast(`Invited ${ids.length} chef${ids.length === 1 ? '' : 's'} 🐧`)
    } else if (failed.length === ids.length) {
      toast(failed[0].error.message || "Couldn't send those invites.")
    } else {
      // Partial success is worth stating plainly - silently reporting
      // success would leave the owner thinking everyone got one.
      toast(`Invited ${ids.length - failed.length} of ${ids.length} — ${failed[0].error.message || 'some failed'}`)
    }
  })
}

function confirmLeaveGroup(groupId, name) {
  const o = overlay(`
    <h3>Leave ${escapeHtml(name)}?</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>You'll lose access to this group's leaderboard. You can rejoin anytime with an invite or the join code.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, leave</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  warmDeleteClip()
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', () => {
    o.remove()
    const clipPromise = playDeleteClipFor('leave-group')
    const rpcPromise = supabase.rpc('leave_group', { group_id: groupId })
    Promise.allSettled([rpcPromise, clipPromise]).then(([rpcResult]) => {
      const { error } = rpcResult.value || {}
      if (error) { toast(error.message || 'Could not leave group.'); return }
      toast(`Left ${name}`)
      chefsTab = 'groups'
      renderChefsScreen()
    })
  })
}

// ---------------- Group settings (owner only) ----------------
function openChefsGroupSettings(groupId) {
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-group">‹ Group settings</div>
    <div id="chefs-settings-body"><p class="log-empty">Loading&hellip;</p></div>
  `
  mountScreen('friends', content, () => {
    app.querySelector('[data-action="back-to-group"]').addEventListener('click', () => openChefsGroup(groupId))
    loadChefsGroupSettings(groupId)
  }, { key: 'chefs-group-settings-' + groupId })
}

async function loadChefsGroupSettings(groupId) {
  const bodyEl = app.querySelector('#chefs-settings-body')
  if (!bodyEl) return
  const [{ data: mineData }, { data: memberData, error: memErr }] = await Promise.all([
    supabase.rpc('my_groups', { week_start: startOfThisWeek().toISOString() }),
    supabase.rpc('group_members_list', { group_id: groupId, week_start: startOfThisWeek().toISOString() }),
  ])
  const g = (mineData || []).find(x => x.group_id === groupId)
  // Not the owner (or the group's gone) - this screen isn't theirs to see.
  if (!g || g.role !== 'owner') { openChefsGroup(groupId); return }
  await loadGroupIcons()

  bodyEl.innerHTML = `
    <div class="section-h" style="margin-top:2px"><h2>${escapeHtml(g.name)}</h2></div>
    <div class="chefs-setcard" style="margin-bottom:1.5rem">
      <label class="chefs-flabel">Group icon</label>
      <div class="chefs-emoji-picker" id="gs-emoji-picker">${chefsEmojiPickerHtml(g.emoji)}</div>
      <label class="chefs-flabel">Name</label>
      <input class="rename-input" id="gs-name" maxlength="30" value="${escapeHtml(g.name)}">
      <button type="button" class="chefs-wide-btn" data-action="save-details">Save details</button>
    </div>

    <div class="section-h" style="margin-top:0"><h2>Who can join</h2></div>
    <div class="chefs-setcard" id="gs-privacy" style="margin-bottom:1.5rem">
      ${chefsPrivacyOptHtml('public', g.privacy === 'public')}
      ${chefsPrivacyOptHtml('private', g.privacy !== 'public')}
    </div>

    <div class="section-h" style="margin-top:0"><h2>Join code</h2></div>
    <div class="chefs-setcard" style="margin-bottom:1.5rem">
      <p class="code-note" style="margin-top:0">Code: <b>${escapeHtml(g.join_code || '')}</b> <button class="copy-btn" type="button" data-action="copy-code" aria-label="Copy group code">${COPY_SVG}</button></p>
      <p class="chefs-empty-hint" style="margin:0.5rem 0 0;text-align:left">Anyone with this code joins instantly, even in a private group.</p>
    </div>

    <div class="section-h" style="margin-top:0"><h2>Members</h2></div>
    <div class="chefs-setcard" style="margin-bottom:1.5rem">
      ${memErr ? `<p class="chefs-empty-hint">${escapeHtml(memErr.message || "Couldn't load members.")}</p>` : (memberData || []).map(chefsSettingsMemberRowHtml).join('')}
    </div>

    <div class="section-h" style="margin-top:0"><h2>Danger zone</h2></div>
    <div class="chefs-setcard">
      <button type="button" class="chefs-wide-btn danger" data-action="delete-group">Delete group</button>
    </div>
  `
  wireChefsGroupSettings(bodyEl, groupId, g)
}

function chefsSettingsMemberRowHtml(m) {
  return `
    <div class="chefs-mrow">
      <img src="${m.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="fn">${escapeHtml(chefName(m.display_name))}</div>
      ${m.role === 'owner'
        ? '<span class="chefs-rel-tag pending">Owner</span>'
        : `<button type="button" class="chefs-req-btn decline" data-remove-member="${m.user_id}" data-remove-name="${escapeHtml(chefName(m.display_name))}">Remove</button>`}
    </div>`
}

function wireChefsGroupSettings(bodyEl, groupId, g) {
  let selectedEmoji = g.emoji
  let selectedPrivacy = g.privacy === 'public' ? 'public' : 'private'

  bodyEl.querySelectorAll('#gs-emoji-picker [data-emoji]').forEach(btn => btn.addEventListener('click', () => {
    selectedEmoji = btn.dataset.emoji
    bodyEl.querySelectorAll('#gs-emoji-picker [data-emoji]').forEach(b => b.classList.toggle('on', b === btn))
  }))
  // Privacy applies instantly on tap (matches the approved mockup) rather
  // than waiting for a separate Save.
  bodyEl.querySelectorAll('#gs-privacy [data-privacy-opt]').forEach(row => row.addEventListener('click', async () => {
    const val = row.dataset.privacyOpt
    if (val === selectedPrivacy) return
    selectedPrivacy = val
    bodyEl.querySelectorAll('#gs-privacy [data-privacy-opt]').forEach(r => {
      const on = r.dataset.privacyOpt === selectedPrivacy
      r.classList.toggle('on', on)
      r.querySelector('.chefs-radio').classList.toggle('on', on)
    })
    const name = bodyEl.querySelector('#gs-name').value.trim() || g.name
    const { error } = await supabase.rpc('update_group_settings', { group_id: groupId, name, emoji: selectedEmoji, privacy: selectedPrivacy })
    if (error) { toast(error.message || 'Could not change privacy.'); return }
    toast(selectedPrivacy === 'public' ? 'Now public — anyone can join' : 'Now private')
  }))
  bodyEl.querySelector('[data-action="save-details"]').addEventListener('click', async () => {
    const name = bodyEl.querySelector('#gs-name').value.trim()
    if (!name) { toast('Group name is required'); return }
    if (!isNameAllowed(name)) { toast("That name isn't allowed — please choose another."); return }
    const { error } = await supabase.rpc('update_group_settings', { group_id: groupId, name, emoji: selectedEmoji, privacy: selectedPrivacy })
    if (error) { toast(error.message || 'Could not save changes.'); return }
    toast('Group updated!')
    loadChefsGroupSettings(groupId)
  })
  bodyEl.querySelector('[data-action="copy-code"]').addEventListener('click', () => {
    const code = g.join_code || ''
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('Code copied!')).catch(() => toast('Code copied!'))
    else toast('Code copied!')
  })
  bodyEl.querySelectorAll('[data-remove-member]').forEach(btn => btn.addEventListener('click', () => {
    confirmRemoveGroupMember(groupId, btn.dataset.removeMember, btn.dataset.removeName)
  }))
  bodyEl.querySelector('[data-action="delete-group"]').addEventListener('click', () => confirmDeleteGroupStep1(groupId, g.name))
}

function confirmRemoveGroupMember(groupId, targetId, name) {
  const o = overlay(`
    <h3>Remove ${escapeHtml(name)}?</h3>
    <p>They'll lose access to this group's leaderboard. They can rejoin with the group code.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Remove ${escapeHtml(name)}</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const { error } = await supabase.rpc('remove_group_member', { group_id: groupId, target_id: targetId })
    if (error) { toast(error.message || 'Could not remove member.'); return }
    o.remove()
    toast(`${name} removed from group`)
    loadChefsGroupSettings(groupId)
  })
}

// Delete is destructive and irreversible, so it needs two separate
// confirmations - same pattern as confirmDeleteAccount/confirmDeleteAccountFinal.
function confirmDeleteGroupStep1(groupId, name) {
  const o = overlay(`
    <h3>Delete ${escapeHtml(name)}? ⚠️</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>This permanently deletes the group, its leaderboard and all membership. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Delete group</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', () => { o.remove(); confirmDeleteGroupStep2(groupId, name) })
}
function confirmDeleteGroupStep2(groupId, name) {
  const o = overlay(`
    <h3>Are you absolutely sure? ⚠️</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>Last chance — <b>${escapeHtml(name)}</b> and everything in it will be permanently deleted. This cannot be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, delete forever</button>
      <button type="button" class="btn-secondary" data-action="no">Keep the group</button>
    </div>
  `)
  warmDeleteClip()
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', () => {
    o.remove()
    const clipPromise = playDeleteClipFor('delete-group')
    const rpcPromise = supabase.rpc('delete_group', { group_id: groupId })
    Promise.allSettled([rpcPromise, clipPromise]).then(([rpcResult]) => {
      const { error } = rpcResult.value || {}
      if (error) { toast(error.message || 'Could not delete group.'); return }
      toast(`${name} deleted.`)
      chefsTab = 'groups'
      renderChefsScreen()
    })
  })
}

// ---------------- Requests tab ----------------
async function loadChefsRequestsTab() {
  const body = app.querySelector('#chefs-body')
  if (!body) return
  hideChefsPill()
  body.innerHTML = `<p class="log-empty">Loading&hellip;</p>`
  const { friendRequests, groupInvites } = await fetchChefsPending()
  const items = [
    ...friendRequests.map(r => ({ kind: 'friend', r, at: r.requested_at })),
    ...groupInvites.map(r => ({ kind: 'group', r, at: r.created_at })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at))

  if (!items.length) {
    body.innerHTML = `<p class="chefs-empty-hint">Nothing waiting on you.<br>Share your code <b>${escapeHtml(currentProfile?.friend_code || '')}</b> so chefs can add you.</p>`
    return
  }
  body.innerHTML = items.map(({ kind, r }) => kind === 'friend' ? chefsFriendReqRowHtml(r) : chefsGroupInviteRowHtml(r)).join('')
  body.querySelectorAll('[data-approve-friend]').forEach(btn => btn.addEventListener('click', () => respondChefsFriendRequest(btn.dataset.approveFriend, true)))
  body.querySelectorAll('[data-decline-friend]').forEach(btn => btn.addEventListener('click', () => respondChefsFriendRequest(btn.dataset.declineFriend, false)))
  body.querySelectorAll('[data-accept-group]').forEach(btn => btn.addEventListener('click', () => respondChefsGroupInvite(btn.dataset.acceptGroup, true)))
  body.querySelectorAll('[data-decline-group]').forEach(btn => btn.addEventListener('click', () => respondChefsGroupInvite(btn.dataset.declineGroup, false)))
}

function chefsFriendReqRowHtml(r) {
  return `
    <div class="frow chefs-req-row">
      <img src="${r.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="finfo"><div class="fn">${escapeHtml(chefName(r.display_name))}</div><div class="fp">Wants to be friends · ${chefsTimeAgo(r.requested_at)}</div></div>
      <div class="chefs-req-actions">
        <button type="button" class="chefs-req-btn approve" data-approve-friend="${r.requester_id}">Approve</button>
        <button type="button" class="chefs-req-btn decline" data-decline-friend="${r.requester_id}">Decline</button>
      </div>
    </div>`
}
function chefsGroupInviteRowHtml(r) {
  return `
    <div class="frow chefs-req-row">
      <div class="chefs-gavatar sm">${escapeHtml(r.emoji || '🍕')}</div>
      <div class="finfo"><div class="fn">${escapeHtml(r.name)}</div><div class="fp">Group invite from ${escapeHtml(r.invited_by_name)} · ${chefsTimeAgo(r.created_at)}</div></div>
      <div class="chefs-req-actions">
        <button type="button" class="chefs-req-btn approve" data-accept-group="${r.group_id}">Accept</button>
        <button type="button" class="chefs-req-btn decline" data-decline-group="${r.group_id}">Decline</button>
      </div>
    </div>`
}

async function respondChefsFriendRequest(requesterId, accept) {
  const { error } = await supabase.rpc('respond_to_friend_request', { requester_id: requesterId, accept })
  if (error) { toast('That request is no longer available.'); return }
  toast(accept ? 'Friend added!' : 'Request declined')
  loadChefsRequestsTab()
  refreshChefsPendingBadge()
}
async function respondChefsGroupInvite(groupId, accept) {
  const { error } = await supabase.rpc('respond_to_group_invite', { group_id: groupId, accept })
  if (error) { toast('That invite is no longer available.'); return }
  toast(accept ? 'Joined the group!' : 'Invite declined')
  loadChefsRequestsTab()
  refreshChefsPendingBadge()
}

function wireFriendRow(row, friend, pendingNootTargets) {
  row.addEventListener('click', () => renderFriendHome(friend))
  const moreBtn = row.querySelector('.frow-more')
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    openFriendActions(friend, pendingNootTargets.has(friend.id))
  })
}

// Press-and-hold action menu for a friend: every friend action lives here.
function openFriendActions(friend, alreadyNooted) {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <img class="popup-profile-avatar" src="${friend.avatar_url || DEFAULT_AVATAR}" alt="" />
    <div class="popup-profile-name">${escapeHtml(chefName(friend.display_name))}</div>
    <div class="home-btn-col">
      <button type="button" data-action="visit">🏠 Visit Pizzeria</button>
      <button type="button" data-action="noot">🐧 Noot</button>
      <button type="button" data-action="gift">🎁 Gift Coins</button>
      <button type="button" data-action="report">🚩 Report</button>
      <button type="button" class="btn-danger" data-action="remove">🗑 Remove</button>
      <button type="button" class="btn-danger" data-action="block">🚫 Block</button>
    </div>
  `, { popupClass: 'popup-profile' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="visit"]').addEventListener('click', () => { o.remove(); renderFriendHome(friend) })
  o.querySelector('[data-action="gift"]').addEventListener('click', () => { o.remove(); playNootSound(); confirmGiftCoin(friend) })
  o.querySelector('[data-action="noot"]').addEventListener('click', () => {
    o.remove()
    playNootSound()
    if (alreadyNooted) { openNootCooldownInfo(chefName(friend.display_name)); return }
    confirmNoot(friend)
  })
  o.querySelector('[data-action="report"]').addEventListener('click', () => { o.remove(); openReportPopup(friend) })
  o.querySelector('[data-action="remove"]').addEventListener('click', () => { o.remove(); confirmRemoveFriend(friend.id, chefName(friend.display_name)) })
  o.querySelector('[data-action="block"]').addEventListener('click', () => { o.remove(); confirmBlockFriend(friend) })
}

const REPORT_REASONS = ['Spam', 'Harassment', 'Inappropriate name', 'Other']
const REPORT_MIN_DETAILS = 10

function openReportPopup(friend) {
  let selected = null
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Report ${escapeHtml(chefName(friend.display_name))}</h3>
    <p>What's going on? Our team will review this.</p>
    <div class="report-reasons">
      ${REPORT_REASONS.map(r => `<button type="button" class="chip report-reason" data-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
    </div>
    <textarea id="report-details" class="rename-input report-details" maxlength="300" placeholder="Add details (required, min ${REPORT_MIN_DETAILS} characters)"></textarea>
    <div class="home-btn-col" style="margin-top:0.25rem">
      <button type="button" class="btn-danger" data-action="submit" disabled>Submit report</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  const submitBtn = o.querySelector('[data-action="submit"]')
  const detailsEl = o.querySelector('#report-details')
  // Submit unlocks only once a reason is picked AND at least REPORT_MIN_DETAILS
  // characters of detail are written, so reports carry enough context to action.
  const refreshSubmit = () => { submitBtn.disabled = !(selected && detailsEl.value.trim().length >= REPORT_MIN_DETAILS) }
  o.querySelectorAll('.report-reason').forEach(btn => {
    btn.addEventListener('click', () => {
      selected = btn.dataset.reason
      o.querySelectorAll('.report-reason').forEach(b => b.classList.toggle('selected', b === btn))
      refreshSubmit()
    })
  })
  detailsEl.addEventListener('input', refreshSubmit)
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  submitBtn.addEventListener('click', async () => {
    const details = detailsEl.value.trim().slice(0, 300)
    if (!selected || details.length < REPORT_MIN_DETAILS) return
    const { error } = await supabase.rpc('report_user', { target_id: friend.id, reason: selected, details })
    if (error) { toast(error.message); return }
    o.remove()
    toast('Report submitted. Thank you.')
  })
}

function confirmBlockFriend(friend) {
  const o = overlay(`
    <h3>Block ${escapeHtml(chefName(friend.display_name))}?</h3>
    <p>They'll be removed as a friend and won't be able to add you back or contact you. You can unblock them later in Settings.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, block</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const { error } = await supabase.rpc('block_user', { target_id: friend.id })
    if (error) { toast(error.message); return }
    o.remove()
    toast(`Blocked ${chefName(friend.display_name)}`)
    loadFriendsList()
  })
}

async function openBlockedUsers() {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Blocked users</h3>
    <div class="blocked-list" id="blocked-list"><p class="editpic-empty">Loading&hellip;</p></div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  await renderBlockedList(o)
}

async function renderBlockedList(o) {
  const list = o.querySelector('#blocked-list')
  if (!list) return
  const { data, error } = await supabase
    .from('blocked_users')
    .select('blocked_id, blocked_name')
    .eq('blocker_id', currentUser.id)
    .order('created_at', { ascending: false })
  if (error) { list.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) { list.innerHTML = '<p class="editpic-empty">You haven\'t blocked anyone.</p>'; return }
  list.innerHTML = data.map(b => `
    <div class="blocked-row">
      <span class="blocked-name">${escapeHtml(chefName(b.blocked_name))}</span>
      <button type="button" class="btn-secondary blocked-unblock" data-id="${escapeHtml(b.blocked_id)}">Unblock</button>
    </div>
  `).join('')
  list.querySelectorAll('.blocked-unblock').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      const { error: unErr } = await supabase.rpc('unblock_user', { target_id: btn.dataset.id })
      if (unErr) { btn.disabled = false; toast(unErr.message); return }
      toast('Unblocked')
      await renderBlockedList(o)
    })
  })
}

function confirmDeleteAccount() {
  const o = overlay(`
    <h3>Delete account? ⚠️</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>This permanently erases your account, progress, friends and coins. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Delete my account</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  // First confirm just opens a SECOND confirmation - account deletion is
  // irreversible, so we require two deliberate taps.
  o.querySelector('[data-action="yes"]').addEventListener('click', () => { o.remove(); confirmDeleteAccountFinal() })
}

function confirmDeleteAccountFinal() {
  const o = overlay(`
    <h3>Are you absolutely sure? ⚠️</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>Last chance &mdash; this will permanently delete everything and you will be signed out. This cannot be undone.</p>
    <p class="delete-note">Signing in with Google again creates a brand new, empty account. To also remove Chef Penguino's access to your Google account, visit <b>Google Account &rsaquo; Data &amp; privacy &rsaquo; Third-party apps</b> &mdash; only you can do that, we can't.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, delete forever</button>
      <button type="button" class="btn-secondary" data-action="no">Keep my account</button>
    </div>
  `)
  warmDeleteClip()
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const btn = o.querySelector('[data-action="yes"]')
    btn.disabled = true
    btn.textContent = 'Deleting…'
    const { error } = await supabase.rpc('delete_own_account')
    if (error) { btn.disabled = false; btn.textContent = 'Yes, delete forever'; toast(error.message); return }
    // Unlike the other deletes this can't run the clip alongside the RPC: this
    // popup stays up to surface an RPC error, and the sign-out below re-renders
    // the app, which would tear the clip layer off mid-play. So the clip runs
    // after a confirmed delete and before the sign-out.
    o.remove()
    await playDeleteClipFor('delete-account')
    await supabase.auth.signOut()
    currentUser = null
    currentProfile = null
    clearNotifBadges()
    renderHome()
    toast('Your account has been deleted.')
  })
}

function confirmGiftCoin(friend) {
  const bal = coinBalance()
  if (bal < 1) {
    const o = overlay(`
      ${coinImg('xl')}
      <h3>No coins to gift</h3>
      <p>You need at least 1 Penguino Coin to gift. Bake more pizzas to earn coins!</p>
      <button type="button" data-action="ok">Got it</button>
    `)
    o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
    return
  }
  const o = overlay(`
    ${coinImg('xl')}
    <h3>Gift 1 Penguino Coin to ${escapeHtml(chefName(friend.display_name))}?</h3>
    <p>You have ${bal} coin${bal === 1 ? '' : 's'}. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" data-action="yes">Yes, gift 1 coin</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    playNootSound()
    const { error } = await supabase.rpc('gift_coin', { target_id: friend.id })
    if (error) { toast(error.message); return }
    await refreshProfile()
    const chip = app.querySelector('.coin-chip span:last-child')
    if (chip) chip.textContent = coinBalance()
    toast(`Gifted 1 coin to ${chefName(friend.display_name)}! 🎁`)
  })
}

function confirmNoot(friend) {
  const o = overlay(`
    <h3>Do you want to Noot ${escapeHtml(chefName(friend.display_name))}?</h3>
    <div class="popup-emoji-xl">🐧</div>
    <div class="home-btn-col">
      <button type="button" data-action="yes">Yes</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    playNootSound()
    const { error } = await supabase.rpc('send_noot', { target_id: friend.id })
    if (error) { toast(error.message); return }
    toast(`Nooted ${chefName(friend.display_name)}!`)
  })
}

const nootSound = new Audio(`${BASE}assets/noot.mp3`)
function playNootSound() {
  if (state.muted) return
  try { nootSound.currentTime = 0; nootSound.play().catch(() => {}) } catch {}
}

// Guards so a Realtime event + the boot/subscribe catch-up check can't stack
// two copies of the same popup on top of each other.
let nootPopupOpen = false
let coinGiftPopupOpen = false
let warningPopupOpen = false

async function checkPendingNoots() {
  if (!currentUser || nootPopupOpen) return
  const { data: noot } = await supabase
    .from('noots')
    .select('id, created_at, sender:sender_id(display_name, avatar_url)')
    .eq('recipient_id', currentUser.id)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!noot || nootPopupOpen) return
  showNootReceivedPopup(noot)
}

function showNootReceivedPopup(noot) {
  nootPopupOpen = true
  playNootSound()
  const when = new Date(noot.created_at).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const o = overlay(`
    <img class="popup-profile-avatar" src="${noot.sender?.avatar_url || DEFAULT_AVATAR}" alt="" />
    <h3>${escapeHtml(noot.sender?.display_name ? chefName(noot.sender.display_name) : 'A friend')} Nooted you!</h3>
    <p>${escapeHtml(when)}</p>
    <button type="button" data-action="ok">Got it!</button>
  `, { popupClass: 'popup-profile', dismissable: false })
  o.querySelector('[data-action="ok"]').addEventListener('click', async () => {
    await supabase.rpc('acknowledge_noot', { noot_id: noot.id })
    o.remove()
    nootPopupOpen = false
    checkPendingNoots()
  })
}

async function checkPendingCoinGifts() {
  if (!currentUser || coinGiftPopupOpen) return
  const { data: gift } = await supabase
    .from('coin_gifts')
    .select('id, created_at, sender:sender_id(display_name, avatar_url)')
    .eq('recipient_id', currentUser.id)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!gift || coinGiftPopupOpen) return
  showCoinGiftReceivedPopup(gift)
}

function showCoinGiftReceivedPopup(gift) {
  coinGiftPopupOpen = true
  playNootSound()
  const o = overlay(`
    <img class="popup-profile-avatar" src="${gift.sender?.avatar_url || DEFAULT_AVATAR}" alt="" />
    <h3>${escapeHtml(gift.sender?.display_name ? chefName(gift.sender.display_name) : 'A friend')} gifted you a Penguino Coin! 🎁</h3>
    <div class="gift-coin-wrap">${coinImg('lg')}</div>
    <button type="button" data-action="ok">Got it!</button>
  `, { popupClass: 'popup-profile', dismissable: false })
  o.querySelector('[data-action="ok"]').addEventListener('click', async () => {
    await supabase.rpc('acknowledge_coin_gift', { gift_id: gift.id })
    o.remove()
    coinGiftPopupOpen = false
    await refreshProfile()
    const chip = app.querySelector('.coin-chip span:last-child')
    if (chip) chip.textContent = coinBalance()
    checkPendingCoinGifts()
  })
}

async function checkPendingWarnings() {
  if (!currentUser || warningPopupOpen) return
  const { data: warning } = await supabase
    .from('warnings')
    .select('id, message, created_at')
    .eq('user_id', currentUser.id)
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!warning || warningPopupOpen) return
  showWarningPopup(warning)
}

function showWarningPopup(warning) {
  warningPopupOpen = true
  const o = overlay(`
    <div class="popup-emoji-xl">⚠️</div>
    <h3>A warning from the Chef Penguino team</h3>
    <p class="warning-msg">${escapeHtml(warning.message)}</p>
    <p class="warning-note">Please follow our community rules so everyone can cook in peace.</p>
    <button type="button" data-action="ok">I understand</button>
  `, { dismissable: false })
  o.querySelector('[data-action="ok"]').addEventListener('click', async () => {
    await supabase.rpc('acknowledge_warning', { warning_id: warning.id })
    o.remove()
    warningPopupOpen = false
    checkPendingWarnings()
  })
}

function openNootCooldownInfo(name) {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    <div class="popup-emoji-xl">🐧</div>
    <h3>Already Nooted</h3>
    <p>You can Noot ${escapeHtml(name)} again once they've acknowledged your last Noot.</p>
    <button type="button" data-action="ok">Got it</button>
  `, { popupClass: 'popup-wide popup-centered' })
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

function renderFriendHome(friend) {
  const stash = Math.floor(friend.pizzas) % 12
  const toNext = 12 - stash
  const pct = Math.round((stash / 12) * 100)
  const heroSrc = pizzaImagePath(stash)
  // Only play/offer an emote on a friend's page if THEY actually own one -
  // never assume the raw equipped_emote DB field is playable, since a new
  // signup who hasn't bought anything yet still has it defaulted to 'waving'.
  const friendEmote = effectiveEmoteFor(friend)

  const content = `
    <div class="viewing-banner" id="viewing-banner" role="button" tabindex="0" aria-label="Back to Chefs">
      <span class="viewing-back" aria-hidden="true">‹</span>
      <span class="viewing-title">${escapeHtml(chefName(friend.display_name))}'s Pizzeria</span>
    </div>
    <div class="hero-card" id="hero-card" role="button" tabindex="0">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      ${friendEmote ? `<button class="hero-tap" type="button" data-action="emote">💃 Tap to emote</button>` : ''}
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="lab">🍕 Lifetime pizzas</div>
        <div class="big">${formatScore(friend.pizzas)}</div>
        <div class="sub">All-time made</div>
      </div>
      <div class="tile coin-tile">
        <div class="lab">Pizzas in stash</div>
        <div class="big">${stash}<span style="font-size:16px;color:var(--muted)">/12</span></div>
        <div class="sub">${toNext} more → 1 coin</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
    </div>

    <div class="section-h"><h2 class="section-h-lg">Recent sessions</h2></div>
    <div class="log-list" id="home-log"><p class="log-empty">Loading&hellip;</p></div>
  `

  mountScreen('friends', content, () => {
    loadHomeLog(friend.id)
    // Wire the way OUT of this screen before anything cosmetic runs. The
    // emote autoplay below is decoration; the back button is the only exit.
    // If decoration throws, it must not be able to strand someone here.
    app.querySelector('#viewing-banner')?.addEventListener('click', () => renderFriends())
    app.querySelector('#viewing-banner')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderFriends() }
    })
    app.querySelector('#hero-card')?.addEventListener('click', () => {
      if (!friendEmote) return
      const img = app.querySelector('#hero-card .hero-still')
      if (img && img.tagName === 'IMG') playEmoteInto(img, friendEmote, heroSrc)
    })
    // Same welcome on a friend's Pizzeria: preload, then play once. Skip
    // entirely if the friend owns no emote - nothing to preload or play.
    if (friendEmote) autoplayEmoteWhenReady(app.querySelector('#hero-card .hero-still'), friendEmote, heroSrc)
  }, { hideStatusBar: true, key: 'friend-home' })
}

function confirmRemoveFriend(friendId, name) {
  const o = overlay(`
    <h3>Do you want to remove ${escapeHtml(name)} as friend?</h3>
    <img class="delete-illus" src="${BASE}assets/delete-barrel-poster.jpg" alt="" />
    <p>You can add them back anytime with their friend code.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, remove</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  warmDeleteClip()
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', () => {
    o.remove()
    const clipPromise = playDeleteClipFor('remove-friend')
    const rpcPromise = supabase.rpc('remove_friend', { target_id: friendId })
    Promise.allSettled([rpcPromise, clipPromise]).then(([rpcResult]) => {
      const { error } = rpcResult.value || {}
      if (error) { toast(error.message); return }
      toast(`Removed ${name}`)
      loadFriendsList()
    })
  })
}

async function fetchLog(userId) {
  if (!userId) {
    // Backfill ids on older local sessions logged before edit/delete existed.
    let changed = false
    for (const e of state.log) { if (!e.id) { e.id = crypto.randomUUID(); changed = true } }
    if (changed) save()
    return state.log
  }
  // Falls back to the pre-migration column set if `icon` doesn't exist yet
  // (migration_session_edit.sql hasn't been run), so the log still loads.
  let { data, error } = await supabase
    .from('sessions')
    .select('id, completed_at, minutes, pizzas, task, icon, type')
    .eq('user_id', userId)
    .order('completed_at', { ascending: false })
  if (error) {
    ({ data } = await supabase
      .from('sessions')
      .select('id, completed_at, minutes, pizzas, task')
      .eq('user_id', userId)
      .order('completed_at', { ascending: false }))
  }
  if (!data) return []
  return data.map(r => ({
    id: r.id,
    completedAt: new Date(r.completed_at).getTime(),
    minutes: r.minutes,
    pizzas: r.pizzas,
    task: r.task,
    icon: r.icon,
    type: r.type,
  }))
}

function groupLogByDate(log) {
  const groups = []
  let currentLabel = null
  let currentGroup = null
  for (const entry of log) {
    const label = dateLabel(entry.completedAt)
    if (label !== currentLabel) {
      currentGroup = { label, entries: [] }
      groups.push(currentGroup)
      currentLabel = label
    }
    currentGroup.entries.push(entry)
  }
  return groups
}

function dateLabel(ts) {
  const d = new Date(ts)
  const now = new Date()
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (isSameDay(d, now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

const LOG_ROW_ICONS = ['🍅', '🥦', '🍄‍🟫', '🧀', '🥖']
const LOG_ICON_NAMES = { '🍅': 'Tomato', '🥦': 'Broccoli', '🍄‍🟫': 'Mushroom', '🧀': 'Cheese', '🥖': 'Baguette' }

// The row icon must stay faithful to what a session was originally shown as -
// so it's derived deterministically from the entry's own identity (its id, or
// completedAt as a fallback), NOT from its position in the list. Position-based
// icons shifted every row when a session above was deleted. An explicit
// entry.icon (set via edit or admin) always wins.
function stableIconFor(entry) {
  if (entry.icon) return entry.icon
  // A tagged session shows its task-type emoji (the emoji<->type mapping is
  // fixed). Untagged/legacy sessions fall back to a deterministic hash below.
  if (entry.type && TASK_TYPE_EMOJI[entry.type]) return TASK_TYPE_EMOJI[entry.type]
  const key = String(entry.id || entry.completedAt || '')
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return LOG_ROW_ICONS[h % LOG_ROW_ICONS.length]
}

// entry.id -> { entry, icon } for the currently-rendered home log, so the
// swipe actions (edit/delete) can look up full session data without
// round-tripping it through HTML attributes.
const logEntriesById = new Map()

function renderDateGroup(group, editable) {
  return `
    <div class="log-date-group">
      <div class="log-date-heading">${group.label}</div>
      ${group.entries.map(entry => renderLogRow(entry, editable)).join('')}
    </div>
  `
}

// Right-side metric for a log row. Admin coin adjustments show a coin + signed
// amount; admin pizza adjustments show a signed pizza amount; normal sessions
// show their earned pizzas as before.
// Admin coin adjustments are stored as a session whose task carries the signed
// amount, e.g. "Admin Edit (+1 coin)" - no dedicated DB column needed, so it
// works without any migration. Detect + parse that here.
const COIN_TASK_RE = / \(([+-]?\d+(?:\.\d+)?) coins?\)$/

// True for any admin-authored row (pizza or coin adjustment), including ones
// stored before this labeling existed (task === plain 'Admin Edit').
function isAdminEditEntry(entry) { return /^Admin Edit\b/.test(entry.task || '') }

// Coin rows (admin coin adjustments and pizza->coin conversions) are an audit
// trail, not user sessions, so they can't be edited or deleted.
function isCoinEntry(entry) { return entry.icon === '🪙' || COIN_TASK_RE.test(entry.task || '') }

function logRowMetric(entry) {
  const m = COIN_TASK_RE.exec(entry.task || '')
  if (m) return `${coinImg('log-coin')} ${m[1]}`
  // Older coin-adjustment rows carried the coin marker only in the icon, with
  // no stored amount - still show a coin, never a misleading "pizza 0". The
  // exact delta wasn't recorded for these, so it can't be shown retroactively.
  if (entry.icon === '🪙') return `${coinImg('log-coin')}`
  if (isAdminEditEntry(entry)) return `🍕 ${signedScore(entry.pizzas)}`
  return `🍕 ${formatScore(entry.pizzas)}`
}

function renderLogRow(entry, editable) {
  const time = new Date(entry.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  // Strip the "(+1 coin)" storage suffix from the title - the amount shows on the right.
  const task = escapeHtml((entry.task || '').replace(COIN_TASK_RE, '')) || 'Focus session'
  const isAdminEdit = isAdminEditEntry(entry)
  // Always the tools icon for an admin-edit row, regardless of what icon (if
  // any) got stored for it - guarantees a consistent, unambiguous glyph even
  // for rows written before this rule existed.
  // Coin conversions show the app's gold coin image (not the coin emoji, which
  // can render as a dull/silver glyph on some platforms).
  const adminHasType = isAdminEdit && entry.type && TASK_TYPE_EMOJI[entry.type]
  const icon = (isAdminEdit && !adminHasType) ? '🛠️' : (isCoinEntry(entry) ? coinImg('log-coin') : stableIconFor(entry))
  // Admin-edit rows are an audit trail, not a session the user created — the
  // name stays locked, but the category is now editable. Coin rows remain
  // fully locked (not a user session).
  const canEdit = editable && entry.id && !isCoinEntry(entry)
  if (canEdit) logEntriesById.set(entry.id, { entry, icon })

  const actions = canEdit ? `
    <div class="log-row-actions2">
      <button class="log-action2 edit" type="button" data-action="edit-log" aria-label="Edit session">${PENCIL_SVG}<span>Edit</span></button>
      ${isAdminEdit ? '' : `<button class="log-action2 delete" type="button" data-action="delete-log" aria-label="Delete session">${TRASH_SVG}<span>Delete</span></button>`}
    </div>
  ` : ''

  return `
    <div class="log-row-wrap" ${canEdit ? `data-log-id="${entry.id}"` : ''}>
      ${actions}
      <div class="log-row">
        <div class="log-row-main">
          <span class="log-row-icon">${icon}</span>
          <span class="log-row-task">${task}</span>
          <span class="log-row-time">${time}</span>
        </div>
        <div class="log-row-meta">
          <span>${formatDuration(entry.minutes)}</span>
          <span class="log-row-pizzas">${logRowMetric(entry)}</span>
        </div>
      </div>
    </div>
  `
}

// =================================================================
//  Recent-session swipe actions (edit / delete)
// =================================================================
let openSwipeRow = null
function closeOpenSwipe() {
  if (openSwipeRow) {
    openSwipeRow.style.transform = 'translateX(0)'
    openSwipeRow.classList.remove('open')
    openSwipeRow = null
  }
}

function wireLogSwipe(listEl) {
  listEl.querySelectorAll('.log-row-wrap[data-log-id]').forEach(wrap => {
    const row = wrap.querySelector('.log-row')
    const actionsEl = wrap.querySelector('.log-row-actions2')
    // Reveal distance is the actual rendered width of the action buttons, so
    // it stays correct under the app's dynamic (viewport-scaled) rem sizing.
    let startX = 0, startY = 0, dx = 0, active = false, decided = false, dragging = false

    let onMove = null, onUp = null

    row.addEventListener('pointerdown', (e) => {
      active = true; decided = false; dragging = false; dx = 0
      startX = e.clientX; startY = e.clientY
      row.style.transition = 'none'
      // Mouse pointers (unlike touch, which gets implicit capture from the
      // browser) stop delivering events to the row the instant the cursor
      // leaves its box mid-drag - trivial here, since the row slides out
      // from under the cursor on every drag. setPointerCapture() was tried
      // and reverted: lostpointercapture fires whenever the captured
      // element's own transform moves it out from under the pointer -
      // which is every single pointermove on this row - so it kept ending
      // the drag mid-gesture and the row could never be held open. Window-
      // level listeners solve the same desktop problem (pointerup on
      // window always fires, wherever the cursor ends up) with none of
      // that. Attached fresh per gesture and removed in endDrag.
      onMove = (e) => handleMove(e)
      onUp = (e) => endDrag(e)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    })
    const handleMove = (e) => {
      if (!active) return
      const reveal = actionsEl ? actionsEl.offsetWidth : 112
      const deltaX = e.clientX - startX
      const deltaY = e.clientY - startY
      if (!decided) {
        if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) return
        decided = true
        dragging = Math.abs(deltaX) > Math.abs(deltaY)
        if (!dragging) { active = false; return }
        if (openSwipeRow && openSwipeRow !== row) closeOpenSwipe()
      }
      const base = row.classList.contains('open') ? -reveal : 0
      dx = Math.min(0, Math.max(-reveal, base + deltaX))
      row.style.transform = `translateX(${dx}px)`
    }
    const endDrag = () => {
      // Idempotent - guarded on `active` so a double-fire (e.g. both
      // pointerup and pointercancel landing for the same gesture) can't
      // double-settle the row.
      if (!active) return
      active = false
      row.style.transition = ''
      if (onMove) { window.removeEventListener('pointermove', onMove); onMove = null }
      if (onUp) {
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        onUp = null
      }
      if (!dragging) return
      const reveal = actionsEl ? actionsEl.offsetWidth : 112
      if (dx <= -reveal / 2) {
        row.style.transform = `translateX(-${reveal}px)`
        row.classList.add('open')
        openSwipeRow = row
      } else {
        row.style.transform = 'translateX(0)'
        row.classList.remove('open')
        if (openSwipeRow === row) openSwipeRow = null
      }
    }
    // Tap-to-close, but NOT the synthetic click the browser fires at the end
    // of a mouse drag. mousedown+mouseup on the same element always produces
    // a click, so on desktop the drag that just opened the row would
    // immediately close it again - the row could never be held open and the
    // Delete button was unreachable. Touch doesn't hit this because browsers
    // suppress the click after a touch drag, which is why it only ever
    // reproduced on desktop.
    let justDragged = false
    row.addEventListener('pointerup', () => { if (dragging) justDragged = true })
    row.addEventListener('click', (e) => {
      if (justDragged) { justDragged = false; e.preventDefault(); e.stopPropagation(); return }
      if (row.classList.contains('open')) { e.preventDefault(); closeOpenSwipe() }
    })
  })

  listEl.querySelectorAll('[data-action="edit-log"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.log-row-wrap').dataset.logId
      closeOpenSwipe()
      openEditLogPopup(id)
    })
  })
  listEl.querySelectorAll('[data-action="delete-log"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.log-row-wrap').dataset.logId
      closeOpenSwipe()
      confirmDeleteLog(id)
    })
  })
}

const iconName = (ic) => LOG_ICON_NAMES[ic] || 'Custom'

function openEditLogPopup(id) {
  const rec = logEntriesById.get(id)
  if (!rec) return
  const isAdminEdit = isAdminEditEntry(rec.entry)
  const types = resolvedTaskTypes()
  // The session's category: its stored type, else inferred from its displayed icon.
  let selectedType = (rec.entry.type && TASK_TYPE_EMOJI[rec.entry.type])
    ? rec.entry.type
    : (EMOJI_TO_TYPE[rec.icon] || 'planning')
  const o = overlay(`
    <h3>${isAdminEdit ? 'Recategorise' : 'Edit Record'}</h3>
    ${isAdminEdit ? '' : `<label class="field-label" for="edit-log-name">Name:</label>
    <input id="edit-log-name" class="rename-input" type="text" maxlength="30" value="${escapeHtml(rec.entry.task || '')}" placeholder="Focus session" />`}
    <label class="field-label">Task type:</label>
    <div class="tt-type-list tt-type-list-compact">
      ${types.map(t => `
        <div class="tt-type-row${t.key === selectedType ? ' selected' : ''}" data-type="${t.key}" role="button" tabindex="0">
          <span class="tt-type-emoji">${t.emoji}</span>
          <div class="tt-type-txt"><div class="tt-type-title">${escapeHtml(t.title)}</div></div>
        </div>
      `).join('')}
    </div>
    <div class="home-btn-col" style="margin-top:1rem">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })

  o.querySelectorAll('.tt-type-row').forEach(row => {
    row.addEventListener('click', () => {
      selectedType = row.dataset.type
      o.querySelectorAll('.tt-type-row').forEach(r => r.classList.toggle('selected', r === row))
    })
  })

  const input = o.querySelector('#edit-log-name')
  if (input) setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const updates = { icon: TASK_TYPE_EMOJI[selectedType], type: selectedType }
    if (!isAdminEdit) updates.task = (input.value.trim().slice(0, 30) || 'Focus session')
    const ok = await saveLogEdit(id, updates)
    if (!ok) return
    o.remove()
    afterLogChange()
  })
}

async function saveLogEdit(id, updates) {
  if (currentUser) {
    const { error } = await supabase.from('sessions').update(updates).eq('id', id)
    if (error) { toast(error.message); return false }
    return true
  }
  const entry = state.log.find(e => e.id === id)
  if (!entry) return false
  Object.assign(entry, updates)
  save()
  return true
}

function confirmDeleteLog(id) {
  const rec = logEntriesById.get(id)
  if (!rec) return
  const o = overlay(`
    <h3>Delete this session?</h3>
    <p>This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, delete</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    const ok = await deleteLogEntry(id, rec.entry.pizzas)
    if (!ok) return
    afterLogChange()
  })
}

async function deleteLogEntry(id, pizzas) {
  if (currentUser) {
    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) { toast(error.message); return false }
    await refreshProfile()
    return true
  }
  const idx = state.log.findIndex(e => e.id === id)
  if (idx < 0) return false
  state.log.splice(idx, 1)
  state.pizzas = Math.max(0, state.pizzas - pizzas)
  save()
  return true
}

// =================================================================
//  Avatar upload + crop (unchanged mechanics)
// =================================================================
// Users can only choose from the admin-curated preset list - no custom photo
// upload - so nobody can set a profane/inappropriate picture.
function openEditPicturePopup() {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Edit Picture</h3>
    <div class="editpic-avatar-wrap">
      <img class="editpic-avatar" src="${myAvatar()}" alt="" />
    </div>
    <label class="field-label">Pick a preset</label>
    <div class="editpic-presets" id="editpic-presets"><p class="editpic-empty">Loading&hellip;</p></div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  loadEditPicPresets(o)
}

async function loadEditPicPresets(editPopupEl) {
  const grid = app.querySelector('#editpic-presets')
  if (!grid) return
  // Ordered by the ladder the admin arranged, not upload order.
  const { data, error } = await supabase.from('preset_avatars').select('id, url, unlock_level').order('unlock_level', { ascending: true })
  if (error) { grid.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) { grid.innerHTML = '<p class="editpic-empty">No presets available yet.</p>'; return }
  const current = myAvatar()
  const level = myLevel() // null for guests; not reachable here but guarded anyway
  // No grandfathering exception: a picture above your level reads as locked
  // even while you're wearing it. Exempting the equipped one meant a chef who
  // ended up in an above-level picture saw one more unlocked than they'd
  // actually earned. ensureAvatarWithinLevel() moves anyone in that position
  // back down, so this shouldn't be reachable - it's the honest display either way.
  const isLocked = (p) => (level == null ? (p.unlock_level || 1) > 1 : (p.unlock_level || 1) > level)
  // Unlocked first, then locked - each group in ladder order, so the grid
  // reads level 1 upward and the next picture to earn is the first locked one.
  const sorted = [...data].sort((a, b) => {
    const aLocked = isLocked(a), bLocked = isLocked(b)
    if (aLocked !== bLocked) return aLocked ? 1 : -1
    return (a.unlock_level || 1) - (b.unlock_level || 1)
  })
  grid.innerHTML = sorted.map(p => {
    const locked = isLocked(p)
    return `
    <button class="editpic-preset ${p.url === current ? 'selected' : ''} ${locked ? 'locked' : ''}" type="button" data-url="${escapeHtml(p.url)}" data-unlock="${p.unlock_level || 1}">
      <img src="${p.url}" alt="" />
      ${locked ? '<span class="editpic-lock">🔒</span>' : ''}
    </button>
  `}).join('')
  grid.querySelectorAll('[data-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('locked')) openLockedPresetPreview(btn.dataset.url, Number(btn.dataset.unlock) || 1)
      else confirmPresetSelection(btn.dataset.url, editPopupEl)
    })
  })
}

// Preview popup shown when tapping a locked preset - no equip path, just the
// requirement to unlock it.
function openLockedPresetPreview(url, unlockLevel) {
  const remaining = Math.max(0, pizzasForLevel(unlockLevel) - displayPizzas())
  const o = overlay(`
    <h3>Locked</h3>
    <div class="editpic-preview-wrap">
      <img class="editpic-preview" src="${url}" alt="" />
      <span class="editpic-preview-lock">🔒</span>
    </div>
    <p class="editpic-req">Unlocks at Level ${unlockLevel}</p>
    <p class="editpic-req-sub">${formatScore(remaining)} more ${remaining === 1 ? 'pizza' : 'pizzas'} to go</p>
    <button type="button" class="btn-secondary" data-action="close">Close</button>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
}

// Shows a preview + Confirm/Cancel before actually applying the picked
// preset, rather than committing on first tap.
function confirmPresetSelection(url, editPopupEl) {
  const o = overlay(`
    <h3>Use this picture?</h3>
    <img class="editpic-preview" src="${url}" alt="" />
    <div class="home-btn-col">
      <button type="button" data-action="confirm">Confirm</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    const ok = await selectPresetAvatar(url)
    o.remove()
    if (ok) editPopupEl.remove()
  })
}

async function selectPresetAvatar(url) {
  const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', currentUser.id)
  if (error) { toast(error.message); return false }
  currentProfile.avatar_url = url
  renderSettings()
  return true
}

function openAvatarCropper(file, onCropped) {
  const objectUrl = URL.createObjectURL(file)

  app.insertAdjacentHTML('beforeend', `
    <div class="crop-overlay">
      <div class="crop-stage-wrap">
        <div class="crop-stage" id="crop-stage">
          <img id="crop-img" src="${objectUrl}" draggable="false" alt="" />
        </div>
        <div class="crop-circle-guide"></div>
      </div>
      <p class="crop-hint">Drag to move &middot; pinch or scroll to zoom</p>
      <div class="home-btn-col">
        <button class="start-btn" id="crop-confirm" type="button">Use Photo</button>
        <button class="start-btn" id="crop-cancel" type="button">Cancel</button>
      </div>
    </div>
  `)

  const overlayEl = app.querySelector('.crop-overlay')
  const stageWrap = overlayEl.querySelector('.crop-stage-wrap')
  const stage = overlayEl.querySelector('#crop-stage')
  const img = overlayEl.querySelector('#crop-img')
  const circleGuide = overlayEl.querySelector('.crop-circle-guide')

  const STAGE = stageWrap.getBoundingClientRect().width
  const CIRCLE = circleGuide.getBoundingClientRect().width

  let naturalW = 0, naturalH = 0, baseScale = 1, scale = 1, tx = 0, ty = 0
  const MAX_ZOOM_FACTOR = 3

  function clampScale() { scale = Math.min(Math.max(scale, baseScale), baseScale * MAX_ZOOM_FACTOR) }
  function clampPos() {
    const w = naturalW * scale, h = naturalH * scale
    const minTx = Math.min(0, STAGE - w), minTy = Math.min(0, STAGE - h)
    tx = Math.min(0, Math.max(minTx, tx))
    ty = Math.min(0, Math.max(minTy, ty))
  }
  function apply() { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})` }
  function zoomAt(stageX, stageY, newScale) {
    const imgX = (stageX - tx) / scale, imgY = (stageY - ty) / scale
    scale = newScale; clampScale()
    tx = stageX - imgX * scale; ty = stageY - imgY * scale
    clampPos(); apply()
  }
  img.onload = () => {
    naturalW = img.naturalWidth; naturalH = img.naturalHeight
    baseScale = Math.max(STAGE / naturalW, STAGE / naturalH)
    scale = baseScale
    tx = (STAGE - naturalW * scale) / 2
    ty = (STAGE - naturalH * scale) / 2
    clampPos(); apply()
  }

  const pointers = new Map()
  let panStart = null, pinchStart = null
  function stagePoint(e) { const rect = stage.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top } }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

  stage.addEventListener('pointerdown', (e) => {
    try { stage.setPointerCapture(e.pointerId) } catch {}
    pointers.set(e.pointerId, stagePoint(e))
    if (pointers.size === 1) { const p = [...pointers.values()][0]; panStart = { x: p.x, y: p.y, tx, ty } }
    else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchStart = { dist: distance(a, b), scale, mid: midpoint(a, b), tx, ty } }
  })
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, stagePoint(e))
    if (pointers.size === 1 && panStart) {
      const p = [...pointers.values()][0]
      tx = panStart.tx + (p.x - panStart.x); ty = panStart.ty + (p.y - panStart.y)
      clampPos(); apply()
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()]
      const ratio = distance(a, b) / (pinchStart.dist || 1)
      zoomAt(pinchStart.mid.x, pinchStart.mid.y, pinchStart.scale * ratio)
    }
  })
  function releasePointer(e) {
    pointers.delete(e.pointerId)
    if (pointers.size === 1) { const p = [...pointers.values()][0]; panStart = { x: p.x, y: p.y, tx, ty }; pinchStart = null }
    else if (pointers.size === 0) { panStart = null; pinchStart = null }
  }
  stage.addEventListener('pointerup', releasePointer)
  stage.addEventListener('pointercancel', releasePointer)
  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const p = stagePoint(e)
    zoomAt(p.x, p.y, scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08))
  }, { passive: false })

  function cleanup() { URL.revokeObjectURL(objectUrl); overlayEl.remove() }
  overlayEl.querySelector('#crop-cancel').addEventListener('click', cleanup)
  overlayEl.querySelector('#crop-confirm').addEventListener('click', () => {
    const OUTPUT = 512
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT; canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    const margin = (STAGE - CIRCLE) / 2
    ctx.drawImage(img, (margin - tx) / scale, (margin - ty) / scale, CIRCLE / scale, CIRCLE / scale, 0, 0, OUTPUT, OUTPUT)
    canvas.toBlob((blob) => { cleanup(); if (blob) onCropped(blob) }, 'image/jpeg', 0.9)
  })
}

// =================================================================
//  Settings
// =================================================================
function renderSettings(highlightProfile, highlightHomescreen) {
  const signed = isSignedIn()
  const avatarSrc = myAvatar()

  const profileGroup = signed ? `
    <div class="group">
      <p class="glab">Profile</p>
      <div class="glist">
        <div class="grow" id="profile-row">
          <div class="avatar-wrap" role="button" tabindex="0" data-action="change-photo" aria-label="Change profile picture">
            <img class="av" src="${avatarSrc}" alt="" />
            <span class="avatar-cam" aria-hidden="true">${CAMERA_SVG}</span>
          </div>
          <div class="profile-text">
            <div class="gt-row">
              <span class="gt">${escapeHtml(myName())}</span>
              <button class="icon-btn" type="button" data-action="rename" aria-label="Edit name">${PENCIL_SVG}</button>
            </div>
            ${(() => {
              const { level, next, into, need } = levelProgress()
              return `<div class="profile-level">
                <div class="profile-level-lab"><b>Level ${level}</b><span>${formatScore(into)} / ${need} pizzas to Level ${next}</span></div>
                <div class="lv-bar wide"><span class="lv-bar-fill" style="width:${need ? Math.min(100, Math.max(0, (into / need) * 100)) : 0}%"></span></div>
              </div>`
            })()}
          </div>
        </div>
      </div>
    </div>
  ` : ''

  const tutorialsGroup = `
    <div class="group">
      <p class="glab">Tutorials</p>
      <div class="glist">
        <div class="grow" id="add-homescreen-row" role="button" tabindex="0" data-action="add-to-homescreen">
          <div><div class="gt">Add to Homescreen</div><div class="gs">How to add this webapp to phone's homescreen</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="replay-tutorial">
          <div><div class="gt">Replay Tutorial</div><div class="gs">See the app basics again</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
      </div>
    </div>
  `

  const accountGroup = `
    <div class="group">
      <p class="glab">Account</p>
      <div class="glist">
        ${signed
          ? `<div class="grow"><div><div class="gt">Signed in</div><div class="gs">${escapeHtml(currentUser.email || '')}</div></div><div class="right"><span class="linkish signout" data-action="sign-out">Sign out</span></div></div>
             <div class="grow" role="button" tabindex="0" data-action="blocked-users">
               <div><div class="gt">Blocked users</div><div class="gs">Manage who you've blocked</div></div>
               <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
             </div>
             <div class="grow" role="button" tabindex="0" data-action="system-notifications">
               <div><div class="gt">System Notifications</div><div class="gs">View messages from the Admin team</div></div>
               <div class="right"><span class="notif-badge" id="settings-notif-badge" hidden></span><span class="chevron" aria-hidden="true">›</span></div>
             </div>
             <div class="grow" role="button" tabindex="0" data-action="delete-account">
               <div><div class="gt danger-text">Delete account ⚠️</div><div class="gs">Permanently erase your account and data</div></div>
               <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
             </div>`
          : `<div class="account-guest"><p class="gs">Sign in to sync your progress across devices and add friends.</p>${googleBtn()}</div>`}
      </div>
    </div>
  `

  const content = `
    <div class="section-h" style="margin-top:6px"><h2>Settings</h2></div>
    ${profileGroup}
    <div class="group">
      <p class="glab">Audio</p>
      <div class="glist">
        <div class="grow">
          <div><div class="gt">On/Off all sounds</div></div>
          <div class="right"><div class="switch ${state.muted ? 'off' : ''}" role="button" tabindex="0" data-action="toggle-music"></div></div>
        </div>
        <div class="grow">
          <div><div class="gt">Volume</div></div>
          <div class="right">🔈<input class="srange" id="volume-slider" type="range" min="0" max="100" value="${Math.round(state.volume * 100)}" />🔊</div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="soundtrack">
          <div><div class="gt">Background Music</div><div class="gs">${escapeHtml(soundtrackById(currentProfile?.soundtrack).title)}</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
      </div>
    </div>
    <div class="group">
      <p class="glab">Appearance</p>
      <div class="glist">
        <div class="grow">
          <div><div class="gt">Dark mode</div></div>
          <div class="right"><div class="switch ${state.lightMode ? 'off' : ''}" role="button" tabindex="0" data-action="toggle-theme"></div></div>
        </div>
        <div class="grow">
          <div><div class="gt">Delete animations</div><div class="gs">Play a short clip when you delete something</div></div>
          <div class="right"><div class="switch ${state.deleteAnimations ? '' : 'off'}" role="button" tabindex="0" data-action="toggle-delete-animations"></div></div>
        </div>
      </div>
    </div>
    <div class="group">
      <p class="glab">Focus session</p>
      <div class="glist">
        <div class="grow">
          <div><div class="gt">Auto-darken screen</div><div class="gs">Dims after 5s to save battery</div></div>
          <div class="right"><div class="switch ${state.autoDarken ? '' : 'off'}" role="button" tabindex="0" data-action="toggle-darken"></div></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="task-types">
          <div><div class="gt">Task types</div><div class="gs">Rename your task categories</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
      </div>
    </div>
    ${tutorialsGroup}
    ${accountGroup}
    <div class="group">
      <p class="glab">About</p>
      <div class="glist about-glist">
        <div class="grow" role="button" tabindex="0" data-action="lore">
          <div><div class="gt">Lore</div><div class="gs">Click to learn about Chef Penguino lore</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="steam">
          <div><div class="gt">Credits for characters</div><div class="gs">Characters are taken from "The Greatest Penguin Heist of All Time", by That Other Fish</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="legal">
          <div><div class="gt">Legal and Disclaimers</div><div class="gs">We do not own the copyright</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" id="version-row"><div><div class="gt">Version</div><div class="gs">${APP_VERSION}</div></div></div>
        ${isAdmin() ? `
        <div class="grow" role="button" tabindex="0" data-action="admin-dashboard">
          <div><div class="gt">Admin Dashboard</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        ` : ''}
      </div>
    </div>
    <div style="height:8px"></div>
  `

  mountScreen('settings', content, () => {
    app.querySelector('[data-action="task-types"]')?.addEventListener('click', renderTaskTypesEditor)
    app.querySelector('[data-action="lore"]')?.addEventListener('click', renderLore)
    // Hidden toggle for the ?uidebug=1 layout readout: 5 quick taps on the
    // Version row. Needed because the URL param only works in a Safari tab -
    // the standalone Home Screen app (where iOS layout bugs actually differ)
    // always launches the bare start_url and keeps its own storage, so there
    // was no way to enable the diagnostic in the exact mode being debugged.
    const versionRow = app.querySelector('#version-row')
    if (versionRow) {
      let taps = 0, tapTimer = null
      versionRow.addEventListener('click', () => {
        taps++
        clearTimeout(tapTimer)
        tapTimer = setTimeout(() => { taps = 0 }, 1200)
        if (taps >= 5) {
          taps = 0
          toggleUiDebug()
          toast(uiDebugEnabled() ? 'Layout debug ON' : 'Layout debug OFF')
        }
      })
    }
    app.querySelector('[data-action="add-to-homescreen"]')?.addEventListener('click', triggerAddToHomescreen)
    app.querySelector('[data-action="replay-tutorial"]')?.addEventListener('click', () => {
      startOnboardingTour()
    })
    app.querySelector('[data-action="steam"]')?.addEventListener('click', () => {
      window.open('https://store.steampowered.com/app/1451480/The_Greatest_Penguin_Heist_of_All_Time/', '_blank', 'noopener')
    })
    app.querySelector('[data-action="legal"]')?.addEventListener('click', renderLegal)
    app.querySelector('[data-action="admin-dashboard"]')?.addEventListener('click', renderAdminDashboard)
    app.querySelector('#volume-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value) / 100
      state.volume = v
      state.muted = v === 0
      if (v > 0) state.lastVolume = v
      save(); syncMusic()
      app.querySelector('[data-action="toggle-music"]')?.classList.toggle('off', state.muted)
    })
    app.querySelector('[data-action="soundtrack"]')?.addEventListener('click', () => {
      if (!isSignedIn()) { toast('Sign in to customise background music'); return }
      renderSoundtrackPicker()
    })
    app.querySelector('[data-action="toggle-music"]').addEventListener('click', (e) => {
      state.muted = !state.muted
      state.volume = state.muted ? 0 : (state.lastVolume || 0.5)
      save(); syncMusic()
      e.currentTarget.classList.toggle('off', state.muted)
      const slider = app.querySelector('#volume-slider')
      if (slider) slider.value = Math.round(state.volume * 100)
    })
    app.querySelector('[data-action="toggle-darken"]').addEventListener('click', (e) => {
      state.autoDarken = !state.autoDarken; save(); e.currentTarget.classList.toggle('off', !state.autoDarken)
    })
    app.querySelector('[data-action="toggle-theme"]').addEventListener('click', (e) => {
      state.lightMode = !state.lightMode; save(); applyTheme(); e.currentTarget.classList.toggle('off', state.lightMode)
    })
    app.querySelector('[data-action="toggle-delete-animations"]').addEventListener('click', (e) => {
      state.deleteAnimations = !state.deleteAnimations; save(); e.currentTarget.classList.toggle('off', !state.deleteAnimations)
    })
    wireSignInButtons(app)
    app.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut)
    app.querySelector('[data-action="rename"]')?.addEventListener('click', openRenamePopup)

    app.querySelector('[data-action="change-photo"]')?.addEventListener('click', openEditPicturePopup)
    app.querySelector('[data-action="blocked-users"]')?.addEventListener('click', openBlockedUsers)
    app.querySelector('[data-action="system-notifications"]')?.addEventListener('click', renderSystemNotifications)
    app.querySelector('[data-action="delete-account"]')?.addEventListener('click', confirmDeleteAccount)

    if (highlightProfile) {
      const row = app.querySelector('#profile-row')
      if (row) {
        row.classList.remove('highlight'); void row.offsetWidth; row.classList.add('highlight')
        setTimeout(() => row.classList.remove('highlight'), 3600)
      }
    }
    if (highlightHomescreen) {
      const row = app.querySelector('#add-homescreen-row')
      if (row) {
        // #add-homescreen-row lives well down the Tutorials section, below
        // the fold on a phone - Settings opens scrolled to the top, so
        // without this the 3.6s glow animation played entirely off-screen
        // and expired before the chef ever scrolled down to see it.
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        row.classList.remove('highlight'); void row.offsetWidth; row.classList.add('highlight')
        setTimeout(() => row.classList.remove('highlight'), 3600)
      }
    }
  })
}

// =================================================================
//  System Notifications page (renderSystemNotifications) - the archive.
//  The live ⚠️ popup (showWarningPopup, above) is untouched; this page is
//  just where every message ever sent - warning or plain announcement -
//  can be re-read.
// =================================================================
let notifReadObserver = null
// True only while renderSystemNotifications' screen is mounted - lets the
// realtime DELETE handlers in subscribeToSocial() know whether to bother
// re-running loadSystemNotificationsPage() when an admin unsends something.
let systemNotificationsPageOpen = false

function notifTime(ts) {
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

function notifMsgRowHtml({ id, kind, title, body, ts, unread, details }) {
  return `
    <div class="notif-msg ${kind === 'sys' ? 'sys' : ''}" data-notif-id="${escapeHtml(id)}" data-notif-kind="${kind}" data-unread="${unread ? '1' : '0'}">
      <div class="notif-msg-top">
        <span class="notif-msg-title">${unread ? '<span class="notif-unread-dot"></span>' : ''}${escapeHtml(title)}</span>
        <span class="notif-msg-time">${notifTime(ts)}</span>
      </div>
      <div class="notif-msg-body">${escapeHtml(body)}</div>
      ${details ? `<div class="notif-msg-details">${escapeHtml(details)}</div>` : ''}
    </div>
  `
}

function renderSystemNotifications() {
  if (!isSignedIn()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>System Notifications</h2></div>
    <div class="notif-card">
      <div class="notif-card-head"><span class="notif-card-ic">📣</span><span class="notif-card-title">System Notifications</span></div>
      <div class="notif-msg-list" id="notif-sys-list"><p class="editpic-empty">Loading&hellip;</p></div>
    </div>
    <div class="notif-card">
      <div class="notif-card-head"><span class="notif-card-ic">⚠️</span><span class="notif-card-title">Past warnings</span></div>
      <div class="notif-msg-list" id="notif-warn-list"><p class="editpic-empty">Loading&hellip;</p></div>
    </div>
    <div style="height:8px"></div>
  `
  systemNotificationsPageOpen = true
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', () => {
      systemNotificationsPageOpen = false
      if (notifReadObserver) { notifReadObserver.disconnect(); notifReadObserver = null }
      renderSettings()
    })
    loadSystemNotificationsPage()
  }, { key: 'sysnotif' })
}

async function loadSystemNotificationsPage() {
  if (notifReadObserver) { notifReadObserver.disconnect(); notifReadObserver = null }
  const sysListEl = app.querySelector('#notif-sys-list')
  const warnListEl = app.querySelector('#notif-warn-list')
  const [{ data: notifs, error: notifErr }, { data: warnings, error: warnErr }] = await Promise.all([
    supabase.from('system_notifications').select('id, title, body, created_at, read_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('warnings').select('id, message, details, created_at, acknowledged_at, read_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(100),
  ])
  if (sysListEl) {
    if (notifErr) sysListEl.innerHTML = `<p class="editpic-empty">${escapeHtml(notifErr.message)}</p>`
    else if (!notifs || !notifs.length) sysListEl.innerHTML = '<p class="editpic-empty">No messages yet.</p>'
    else sysListEl.innerHTML = notifs.map(n => notifMsgRowHtml({
      id: n.id, kind: 'sys', title: n.title, body: n.body, ts: n.created_at, unread: !n.read_at, details: null,
    })).join('')
  }
  if (warnListEl) {
    if (warnErr) warnListEl.innerHTML = `<p class="editpic-empty">${escapeHtml(warnErr.message)}</p>`
    else if (!warnings || !warnings.length) warnListEl.innerHTML = '<p class="editpic-empty">No warnings — keep it up! 🐧</p>'
    else warnListEl.innerHTML = warnings.map(w => {
      const ackPart = w.acknowledged_at ? `You acknowledged this on ${calFmtShortDate(w.acknowledged_at)}` : 'Not yet acknowledged'
      const detailsLine = [w.details ? `Reason: ${w.details}` : null, ackPart].filter(Boolean).join(' · ')
      return notifMsgRowHtml({
        id: w.id, kind: 'warn', title: 'Warning', body: w.message, ts: w.created_at, unread: !w.read_at, details: detailsLine,
      })
    }).join('')
  }
  wireNotifReadObserver()
}

// Scroll-to-read: a message only clears its unread dot (and its share of the
// badge) once it has actually dwelt in view, not the instant the page opens
// - see migration_system_notifications.sql's read_at columns for why
// acknowledged_at alone can't drive this.
function wireNotifReadObserver() {
  const rows = app.querySelectorAll('.notif-msg[data-unread="1"]')
  if (!rows.length) return
  const scrollRoot = app.querySelector('.scroll.view.active') || null
  const timers = new Map()
  notifReadObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const row = entry.target
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        if (!timers.has(row)) {
          timers.set(row, setTimeout(() => { timers.delete(row); markNotifRowRead(row) }, 450))
        }
      } else if (timers.has(row)) {
        clearTimeout(timers.get(row))
        timers.delete(row)
      }
    })
  }, { root: scrollRoot, threshold: [0.6] })
  rows.forEach(row => notifReadObserver.observe(row))
}

async function markNotifRowRead(row) {
  if (!row.isConnected || row.dataset.unread !== '1') return
  // Optimistically clear the dot + badge so scrolling feels instant.
  row.dataset.unread = '0'
  const titleEl = row.querySelector('.notif-msg-title')
  row.querySelector('.notif-unread-dot')?.remove()
  notifReadObserver?.unobserve(row)
  notifUnread = Math.max(0, notifUnread - 1)
  updateNotifBadgeDom()

  const kind = row.dataset.notifKind
  const id = row.dataset.notifId
  const { error } = kind === 'sys'
    ? await supabase.rpc('mark_system_notification_read', { notif_id: id })
    : await supabase.rpc('mark_warning_read', { warning_id: id })

  // Roll back on failure so the client doesn't silently diverge from the
  // server (row would otherwise read as "read" locally but stay unread in the
  // DB, and never retry). Restoring the dot + re-observing lets it try again.
  if (error) {
    row.dataset.unread = '1'
    if (titleEl && !titleEl.querySelector('.notif-unread-dot')) {
      const dot = document.createElement('span')
      dot.className = 'notif-unread-dot'
      titleEl.prepend(dot)
    }
    notifUnread += 1
    updateNotifBadgeDom()
    if (notifReadObserver && row.isConnected) notifReadObserver.observe(row)
  }
}

// =================================================================
//  Task Types editor (Settings -> Focus session -> Task types)
// =================================================================
function renderTaskTypesEditor() {
  const types = resolvedTaskTypes()
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>Task Types</h2></div>
    <p class="tt-emoji-note">Each type's emoji is fixed — only the name and description can be edited.</p>
    <div class="tt-edit-list">
      ${types.map(t => `
        <div class="tt-edit-row" data-key="${t.key}"${t.fixed ? ' data-fixed="1"' : ''}>
          <div class="tt-edit-emoji">${t.emoji}</div>
          <div class="tt-edit-fields">
            <label class="field-label">Title</label>
            <input class="rename-input tt-title-input" maxlength="${TASK_TITLE_MAX}" value="${escapeHtml(t.title)}"${t.fixed ? ' disabled' : ''}>
            ${t.fixed
              ? `<div class="tt-counter">Fixed</div>`
              : `<div class="tt-counter"><span class="tt-title-count">${t.title.length}</span>/${TASK_TITLE_MAX}</div>`}
            <label class="field-label">Description</label>
            <input class="rename-input tt-desc-input" maxlength="${TASK_DESC_MAX}" placeholder="Optional" value="${escapeHtml(t.desc)}">
            <div class="tt-counter"><span class="tt-desc-count">${t.desc.length}</span>/${TASK_DESC_MAX}</div>
          </div>
        </div>
      `).join('')}
    </div>
    <button class="cta" id="tt-save-btn" type="button">Save</button>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)
    app.querySelectorAll('.tt-edit-row').forEach(row => {
      const titleInput = row.querySelector('.tt-title-input')
      const descInput = row.querySelector('.tt-desc-input')
      const titleCount = row.querySelector('.tt-title-count')
      const descCount = row.querySelector('.tt-desc-count')
      if (titleCount) titleInput.addEventListener('input', () => { titleCount.textContent = titleInput.value.length })
      descInput.addEventListener('input', () => { descCount.textContent = descInput.value.length })
    })
    app.querySelector('#tt-save-btn').addEventListener('click', async () => {
      const overrides = {}
      app.querySelectorAll('.tt-edit-row').forEach(row => {
        const key = row.dataset.key
        const desc = row.querySelector('.tt-desc-input').value.trim().slice(0, TASK_DESC_MAX)
        if (row.dataset.fixed) {
          overrides[key] = { desc }
        } else {
          const title = row.querySelector('.tt-title-input').value.trim().slice(0, TASK_TITLE_MAX)
          overrides[key] = { title, desc }
        }
      })
      try {
        await saveTaskTypeLabels(overrides)
        toast('Task types saved')
      } catch {
        toast('Could not save — try again')
      }
    })
  }, { key: 'task-types' })
}

// =================================================================
//  Bug reports — persistent "!" FAB, report popup, admin review
// =================================================================
// The FAB lives on <body> (a sibling of #app) so it survives every
// mountScreen()/app.innerHTML rebuild. Because it sits outside the app's
// stacking context it would paint over in-app popups, so a MutationObserver
// hides it whenever a modal surface (overlay / calendar sheet / lore player)
// is on screen. It only shows for signed-in users — a bug report needs an
// identity so the reporter can receive the ack + admin reply.
let bugFabEl = null
function ensureBugFab() {
  if (!bugFabEl) {
    bugFabEl = document.createElement('button')
    bugFabEl.id = 'bug-fab'
    bugFabEl.type = 'button'
    bugFabEl.setAttribute('aria-label', 'Report a bug or suggestion')
    // Lucide "bug" icon, verbatim from the reference the user supplied -
    // all-stroke, no fills. Do not substitute a solid silhouette: an
    // earlier "more legible at small size" redraw was rejected outright.
    bugFabEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.4rem" height="1.4rem" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m8 2 1.88 1.88"/>
        <path d="M14.12 3.88 16 2"/>
        <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>
        <path d="M12 20v-9"/>
        <path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>
        <path d="M6 13H2"/>
        <path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>
        <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>
        <path d="M22 13h-4"/>
        <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>
      </svg>
    `
    bugFabEl.addEventListener('click', openBugReport)
    document.body.appendChild(bugFabEl)
    new MutationObserver(updateBugFabVisibility).observe(app, { childList: true, subtree: true })
  }
  updateBugFabVisibility()
}
function updateBugFabVisibility() {
  if (!bugFabEl) return
  const modalOpen = !!app.querySelector('.bug-report-overlay')
  bugFabEl.style.display = modalOpen ? 'none' : '' // shown for guests too — anyone can report a bug
}

async function openBugReport() {
  // Capture the current screen (.app, which excludes the body-level FAB)
  // BEFORE the popup is added to the DOM, so the shot shows the real screen.
  // The soundtrack mini-player now lives inside .app, so it appears in this
  // capture natively - no separate composite pass. One quirk remains:
  // html2canvas throws (InvalidStateError: createPattern on a 0-width
  // canvas) on the picker's #st-fill progress bar - its width is 0% until
  // playback progresses, and combined with its large border-radius that
  // hits a genuine html2canvas edge case, killing the WHOLE capture. Hide
  // just that element for the duration of the shot; restored right after.
  let shotCanvas = null
  const target = shellEl()
  if (target) {
    const fillEl = target.querySelector('#st-fill')
    const prevFillDisplay = fillEl?.style.display
    if (fillEl) fillEl.style.display = 'none'
    try {
      const { default: html2canvas } = await import('html2canvas')
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim() || '#120c09'
      shotCanvas = await html2canvas(target, {
        backgroundColor: bg, logging: false, useCORS: true,
        scale: Math.min(2, window.devicePixelRatio || 1),
        windowWidth: target.offsetWidth, windowHeight: target.offsetHeight,
      })
    } catch { shotCanvas = null }
    if (fillEl) fillEl.style.display = prevFillDisplay || ''
  }

  const o = overlay(`
    <button class="popup-close" data-action="close" aria-label="Close">✕</button>
    <h3>Report Bugs/Suggestions</h3>
    <div class="bug-shot" id="bug-shot"><div class="bug-shot-badge">📷</div></div>
    <div class="bug-shot-cap">${shotCanvas ? 'Screenshot of this screen attached' : 'Screenshot unavailable — describe what you saw'}</div>
    <label class="field-label">Description</label>
    <textarea class="rename-input report-details bug-field-gap" id="bug-desc" maxlength="300" placeholder="What went wrong, or what would you like to see? (min 10 characters)"></textarea>
    <div class="home-btn-col">
      <button type="button" id="bug-submit-btn" disabled>Submit</button>
      <button type="button" class="btn-secondary" data-action="close">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.classList.add('bug-report-overlay')

  if (shotCanvas) {
    shotCanvas.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:top center;display:block'
    o.querySelector('#bug-shot').insertBefore(shotCanvas, o.querySelector('.bug-shot-badge'))
  } else {
    o.querySelector('#bug-shot').style.display = 'none'
  }

  const ta = o.querySelector('#bug-desc')
  const submitBtn = o.querySelector('#bug-submit-btn')
  o.querySelectorAll('[data-action="close"]').forEach(b => b.addEventListener('click', () => o.remove()))
  ta.addEventListener('input', () => { submitBtn.disabled = ta.value.trim().length < 10 })
  ta.focus()

  submitBtn.addEventListener('click', async () => {
    const desc = ta.value.trim()
    if (desc.length < 10) return
    submitBtn.disabled = true
    submitBtn.textContent = 'Sending…'
    let screenshotUrl = null
    try {
      if (shotCanvas) {
        const blob = await new Promise(res => shotCanvas.toBlob(res, 'image/jpeg', 0.85))
        if (blob) {
          const path = `${currentUser ? currentUser.id : 'guest'}/${Date.now()}.jpg`
          const { error: upErr } = await supabase.storage.from('bug-shots').upload(path, blob, { contentType: 'image/jpeg' })
          if (!upErr) screenshotUrl = supabase.storage.from('bug-shots').getPublicUrl(path).data.publicUrl
        }
      }
      const { error } = await supabase.rpc('submit_bug_report', { description: desc, screenshot_url: screenshotUrl })
      if (error) throw error
      o.remove()
      toast('Bug report sent 🐧')
      if (isSignedIn()) refreshNotifBadges()
    } catch {
      submitBtn.disabled = false
      submitBtn.textContent = 'Submit'
      toast('Could not send — try again')
    }
  })
}

// ---------- admin: bug reports review ----------
let bugTab = 'open' // 'open' | 'in_progress' | 'resolved' | 'dismissed'
async function renderBugReports() {
  if (!isAdmin()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Bug Reports</h2></div>
    <div class="cal-seg cal-seg-4" style="margin-bottom:0.5rem">
      <button type="button" class="${bugTab === 'open' ? 'on' : ''}" data-bugtab="open"><span>Open</span><span class="seg-badge" id="bugtab-open-n" hidden></span></button>
      <button type="button" class="${bugTab === 'in_progress' ? 'on' : ''}" data-bugtab="in_progress"><span>Fixing</span><span class="seg-badge" id="bugtab-prog-n" hidden></span></button>
      <button type="button" class="${bugTab === 'resolved' ? 'on' : ''}" data-bugtab="resolved"><span>Resolved</span></button>
      <button type="button" class="${bugTab === 'dismissed' ? 'on' : ''}" data-bugtab="dismissed"><span>Dismissed</span></button>
    </div>
    <div class="bug-adm-list" id="bug-adm-list"><p class="editpic-empty">Loading&hellip;</p></div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    app.querySelectorAll('[data-bugtab]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.bugtab === bugTab) return
      bugTab = b.dataset.bugtab
      renderBugReports()
    }))
    loadBugReports()
  }, { key: 'bug-reports' })
}

function bugAdmCardHtml(r) {
  const who = escapeHtml(r.reporter?.display_name || 'Guest')
  const when = dateLabel(new Date(r.created_at).getTime())
  const closed = r.status === 'resolved' || r.status === 'dismissed'
  const sent = !!r.sent_to_claude_at
  const chips = [
    r.status === 'replied' ? '✅ Replied' : '',
    r.status === 'resolved' ? '☑️ Resolved' : '',
    r.status === 'dismissed' ? '🚫 Dismissed' : '',
    sent ? '🤖 Sent to Claude' : '',
  ].filter(Boolean).map(c => ` &middot; ${c}`).join('')
  const shot = (!closed && r.screenshot_url)
    ? `<div class="bug-adm-shot" data-shot role="button" tabindex="0" aria-label="View full screenshot"><img src="${escapeHtml(r.screenshot_url)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top center;display:block" /></div>`
    : ''
  return `<div class="bug-adm-card${closed ? ' bug-adm-dismissed' : ''}" data-report="${r.id}">
    ${shot}
    <div class="bug-adm-desc">${escapeHtml(r.description)}</div>
    <div class="bug-adm-meta">${who} &middot; ${when}${chips}</div>
    <div class="bug-adm-actions"><button type="button" data-action="manage">Manage &#9662;</button></div>
  </div>`
}

async function loadBugReports() {
  // `sent_to_claude_at` may not exist pre-migration; fall back so the list
  // still loads if migration_bug_claude.sql hasn't been run yet.
  let { data, error } = await supabase
    .from('bug_reports')
    .select('id, description, screenshot_url, status, admin_reply, created_at, replied_at, sent_to_claude_at, reporter:reporter_id(display_name)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    ({ data, error } = await supabase
      .from('bug_reports')
      .select('id, description, screenshot_url, status, admin_reply, created_at, replied_at, reporter:reporter_id(display_name)')
      .order('created_at', { ascending: false })
      .limit(200))
  }
  const list = app.querySelector('#bug-adm-list')
  if (!list) return
  if (error) { list.innerHTML = `<p class="editpic-empty">Couldn't load reports.</p>`; return }
  // Resolved/Dismissed are terminal. Among still-active reports, those the
  // admin has sent to Claude are "In Progress" (being fixed); the rest are the
  // untriaged "Open" queue. Sending to Claude moves a report Open → In Progress.
  const tabOf = r => r.status === 'dismissed' ? 'dismissed'
    : r.status === 'resolved' ? 'resolved'
    : r.sent_to_claude_at ? 'in_progress'
    : 'open'
  // Surface the counts that need action: untriaged Open, and In Progress.
  const openCount = (data || []).filter(r => tabOf(r) === 'open').length
  const progressCount = (data || []).filter(r => tabOf(r) === 'in_progress').length
  // Counts render as badges beside the label (not "(3)" in the text), so the
  // four tabs keep identical widths whatever the numbers are.
  setSegBadge('bugtab-open-n', openCount)
  setSegBadge('bugtab-prog-n', progressCount)
  const shown = (data || []).filter(r => tabOf(r) === bugTab)
  if (!shown.length) {
    const empty = { open: 'No open reports 🎉', in_progress: 'Nothing being fixed — send a report to Claude to start.', resolved: 'No resolved reports yet.', dismissed: 'No dismissed reports.' }[bugTab]
    list.innerHTML = `<p class="editpic-empty">${empty}</p>`
    return
  }
  list.innerHTML = shown.map(bugAdmCardHtml).join('')
  shown.forEach(r => {
    const card = list.querySelector(`[data-report="${r.id}"]`)
    if (!card) return
    card.querySelector('[data-action="manage"]')?.addEventListener('click', () => openBugManageMenu(r))
    if (!(r.status === 'resolved' || r.status === 'dismissed') && r.screenshot_url) {
      card.querySelector('[data-shot]')?.addEventListener('click', () => openScreenshotLightbox(r.screenshot_url))
    }
  })
}

// Consolidated per-report action menu (replaces the old stacked buttons).
function openBugManageMenu(r) {
  const sent = !!r.sent_to_claude_at
  const resolved = r.status === 'resolved'
  const dismissed = r.status === 'dismissed'
  // A dismissed report used to be a dead end - the only action offered was
  // "Dismiss" again. Every terminal state now has a way back out.
  const o = overlay(`
    <button class="popup-close" data-action="close" aria-label="Close">✕</button>
    <h3>Manage report</h3>
    <div class="home-btn-col" style="margin-top:0.5rem">
      ${dismissed ? '' : `<button type="button" data-action="respond">${r.status === 'replied' ? 'Reply again' : 'Respond'}</button>`}
      ${dismissed ? '' : `<button type="button" class="btn-secondary" data-action="claude">${sent ? '↩︎ Unsend from Claude' : '🤖 Send to Claude'}</button>`}
      ${dismissed ? '' : `<button type="button" class="${resolved ? 'btn-secondary' : 'btn-success'}" data-action="resolve">${resolved ? '↩︎ Move to unresolved' : '☑️ Mark Resolved'}</button>`}
      ${dismissed
        ? '<button type="button" class="btn-success" data-action="undismiss">↩︎ Restore to Open</button>'
        : '<button type="button" class="btn-danger" data-action="dismiss">🚫 Dismiss</button>'}
    </div>
  `, { popupClass: 'popup-wide' })
  const close = () => o.remove()
  o.querySelector('[data-action="close"]').addEventListener('click', close)
  o.querySelector('[data-action="undismiss"]')?.addEventListener('click', async () => {
    close()
    const { error } = await supabase.rpc('undismiss_bug_report', { report_id: r.id })
    if (error) { toast('Could not restore — try again'); return }
    toast('Restored to Open')
    loadBugReports()
  })
  o.querySelector('[data-action="respond"]')?.addEventListener('click', () => { close(); openBugReplyPopup(r) })
  o.querySelector('[data-action="claude"]')?.addEventListener('click', async () => {
    close()
    const rpc = sent ? 'unflag_bug_report_for_claude' : 'flag_bug_report_for_claude'
    const { error } = await supabase.rpc(rpc, { report_id: r.id })
    if (error) { toast('Could not update — try again'); return }
    toast(sent ? 'Unsent from Claude' : 'Sent to Claude 🤖')
    loadBugReports()
  })
  o.querySelector('[data-action="resolve"]')?.addEventListener('click', async () => {
    close()
    const rpc = resolved ? 'unresolve_bug_report' : 'resolve_bug_report'
    const { error } = await supabase.rpc(rpc, { report_id: r.id })
    if (error) { toast('Could not update — try again'); return }
    toast(resolved ? 'Moved back to open' : 'Marked resolved ☑️')
    loadBugReports()
  })
  // Dismissed reports never render this button (the undismiss branch above
  // renders "Restore to Open" instead), so this is always the fresh-dismiss path.
  o.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => { close(); confirmDismissBugReport(r) })
}

// In-app screenshot viewer — an overlay so tapping a report's shot never
// navigates away from the Bug Reports page.
function openScreenshotLightbox(url) {
  const o = overlay(`
    <button class="popup-close" data-action="close" aria-label="Close">✕</button>
    <img src="${escapeHtml(url)}" alt="Report screenshot" style="width:100%;max-height:74vh;object-fit:contain;border-radius:0.75rem;display:block;margin-top:0.75rem" />
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
}

function confirmDismissBugReport(r) {
  const o = overlay(`
    <h3>Dismiss report?</h3>
    <p class="swipe-line" style="margin-bottom:0.75rem">No reply is sent to ${escapeHtml(r.reporter?.display_name || 'this chef')} — this just closes it out of your queue.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="confirm-dismiss">Dismiss</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="confirm-dismiss"]').addEventListener('click', async () => {
    const { error } = await supabase.rpc('dismiss_bug_report', { report_id: r.id })
    o.remove()
    if (error) { toast('Could not dismiss — try again'); return }
    toast('Report dismissed')
    loadBugReports()
  })
}

function openBugReplyPopup(r) {
  const o = overlay(`
    <button class="popup-close" data-action="close" aria-label="Close">✕</button>
    <h3>Respond</h3>
    <p class="swipe-line" style="margin-bottom:0.75rem">Replying to ${escapeHtml(r.reporter?.display_name || 'this chef')}. They'll see it in their System Notifications.</p>
    <label class="field-label">Message</label>
    <textarea class="rename-input report-details bug-field-gap" id="bug-reply" maxlength="500" placeholder="Type a reply">${escapeHtml(r.admin_reply || '')}</textarea>
    <div class="home-btn-col">
      <button type="button" id="bug-send-btn">Send reply</button>
      <button type="button" class="btn-secondary" data-action="close">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelectorAll('[data-action="close"]').forEach(b => b.addEventListener('click', () => o.remove()))
  o.querySelector('#bug-send-btn').addEventListener('click', async () => {
    const msg = o.querySelector('#bug-reply').value.trim()
    if (!msg) return
    const btn = o.querySelector('#bug-send-btn')
    btn.disabled = true
    btn.textContent = 'Sending…'
    const { error } = await supabase.rpc('reply_bug_report', { report_id: r.id, message: msg })
    if (error) { btn.disabled = false; btn.textContent = 'Send reply'; toast('Could not send — try again'); return }
    o.remove()
    toast('Reply sent 🐧')
    loadBugReports()
  })
}

// =================================================================
//  Lore
// =================================================================
function renderLore() {
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>Lore</h2></div>
    <div class="lore-list">
      ${LORE_VIDEOS.map((v, i) => `
        <div class="lore-card" data-lore="${i}" role="button" tabindex="0">
          <img class="lore-thumb" src="${BASE}assets/${v.thumb}" alt="" />
          <span class="lore-play" aria-hidden="true">▶</span>
          <div class="lore-title">${escapeHtml(v.title)}</div>
        </div>
      `).join('')}
    </div>
  `

  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)
    app.querySelectorAll('[data-lore]').forEach(card => {
      card.addEventListener('click', () => playLoreVideo(LORE_VIDEOS[Number(card.dataset.lore)]))
    })
  }, { key: 'lore' })
}

// =================================================================
//  Background Music picker (Settings -> Background Music)
// =================================================================
// Registered by teardownSoundtrackPreview itself and torn down together -
// tracks whichever track the picker most recently pointed bgMusic at, so
// teardown knows whether it needs to restore the saved track or can leave
// bgMusic alone (nothing was previewed this visit).
let stPreviewTrackId
let stAudioHandlers = null
let stVisibilityHandler = null
let stPagehideHandler = null

// Idempotent - safe to call more than once (mountScreen's generic hook,
// pagehide and a real navigation can all race to call this for the same
// visit). Restores the chef's actual saved track + real mute/volume prefs,
// which is the whole point: leaving the picker, in any way, must never
// leave a muted chef's music audibly playing, nor a different track parked
// in bgMusic than the one they actually saved.
function teardownSoundtrackPreview() {
  document.body.classList.remove('soundtrack-mini-open')
  document.body.style.removeProperty('--st-mini-h') // measured per-visit by showMini()
  // Removed from the DOM outright, not just un-.show'd: the hidden state is
  // max-height:0, which collapses the CONTENT box but not the player's own
  // padding/border, so a stubborn sliver of it kept rendering over the
  // Settings list after the chef left the picker. It's re-created on the
  // next mount anyway (see renderSoundtrackPicker), so nothing is lost.
  document.getElementById('soundtrack-mini')?.remove()
  if (stAudioHandlers) {
    bgMusic.removeEventListener('playing', stAudioHandlers.playing)
    bgMusic.removeEventListener('waiting', stAudioHandlers.waiting)
    bgMusic.removeEventListener('pause', stAudioHandlers.pause)
    bgMusic.removeEventListener('play', stAudioHandlers.play)
    bgMusic.removeEventListener('loadedmetadata', stAudioHandlers.loadedmetadata)
    bgMusic.removeEventListener('durationchange', stAudioHandlers.loadedmetadata)
    bgMusic.removeEventListener('timeupdate', stAudioHandlers.timeupdate)
    stAudioHandlers = null
  }
  if (stVisibilityHandler) { document.removeEventListener('visibilitychange', stVisibilityHandler); stVisibilityHandler = null }
  if (stPagehideHandler) { window.removeEventListener('pagehide', stPagehideHandler); stPagehideHandler = null }
  soundtrackPreviewBoost = false
  soundtrackPreviewPaused = false
  if (stPreviewTrackId !== undefined && bgMusic.src !== currentTrackSrc) {
    bgMusic.src = currentTrackSrc
    bgMusic.loop = true
    updateMediaSessionTrack(soundtrackById(currentProfile?.soundtrack).title)
  }
  stPreviewTrackId = undefined
  syncMusic()
}

function renderSoundtrackPicker() {
  if (!isSignedIn()) { renderSettings(); return }
  let savedId = currentProfile?.soundtrack ?? null
  let previewId // undefined until a row is tapped this visit; may be null (the default track)
  let stLoading = false // true while a freshly-picked track is still buffering

  const rows = SOUNDTRACKS.map((t, i) => `
    <button type="button" class="st-row" data-i="${i}">
      <img class="st-art" src="${t.art}" alt="" />
      <span class="st-title">${escapeHtml(t.title)}</span>${t.isDefault ? '<em class="st-def">Default</em>' : ''}
      <span class="st-bars" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="st-tick" aria-hidden="true">✓</span>
    </button>
  `).join('')

  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>Background Music</h2></div>
    <p class="gs st-sub">Tap a track to hear it. Save to make it yours.</p>
    <div class="st-savebar">
      <button type="button" class="st-save" id="st-save" disabled>Save as my soundtrack</button>
    </div>
    <div class="st-list">${rows}</div>
    <div style="height:6.5rem"></div>
  `

  mountScreen('settings', content, () => {
    const rowEls = Array.from(app.querySelectorAll('.st-row'))
    const saveBtn = app.querySelector('#st-save')

    // Mini-player lives INSIDE .app (position:absolute against .app's own
    // position:relative), NOT on document.body. It used to live on body "to
    // survive navigation" - that one decision caused an entire family of
    // real-device bugs: body-level z-index can't be beaten by popups that
    // live inside .app's stacking context (so the player rendered over the
    // bug-report popup on iOS - a MutationObserver "duck" papered over it
    // and raced, passing on Chromium and failing on Safari), html2canvas
    // couldn't see it in bug-report screenshots, and leaving the page could
    // strand a sliver of it. Inside .app: popups (z 70) beat it (z 40)
    // by plain CSS in every engine, the bug-shot capture includes it
    // natively, and mountScreen's innerHTML wipe destroys it on any
    // navigation so nothing can linger. Save repaints this screen in place
    // (no re-mount), so it survives the one moment it must.
    let miniEl = document.getElementById('soundtrack-mini')
    if (!miniEl) {
      miniEl = document.createElement('div')
      miniEl.id = 'soundtrack-mini'
      miniEl.className = 'st-mini'
      miniEl.innerHTML = `
        <div class="st-mini-row">
          <img class="st-mini-art" id="st-mini-art" src="" alt="" />
          <div>
            <div class="st-mini-title" id="st-mini-title">-</div>
            <div class="st-mini-sub">Previewing</div>
          </div>
          <button type="button" class="st-playbtn" id="st-playbtn" aria-label="Play or pause preview"></button>
        </div>
        <div class="st-scrub" id="st-scrub">
          <div class="st-track"><div class="st-fill" id="st-fill"></div><div class="st-knob" id="st-knob"></div></div>
        </div>
        <div class="st-times"><span id="st-tcur">0:00</span><span id="st-tdur">0:00</span></div>
      `
      shellEl().appendChild(miniEl)
    }
    const miniArt = miniEl.querySelector('#st-mini-art')
    const miniTitle = miniEl.querySelector('#st-mini-title')
    const playBtn = miniEl.querySelector('#st-playbtn')
    const fillEl = miniEl.querySelector('#st-fill')
    const knobEl = miniEl.querySelector('#st-knob')
    const tCur = miniEl.querySelector('#st-tcur')
    const tDur = miniEl.querySelector('#st-tdur')
    const scrubEl = miniEl.querySelector('#st-scrub')

    function fmtTime(s) {
      s = Math.max(0, s | 0)
      return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0')
    }

    function paint() {
      rowEls.forEach((r, i) => {
        const t = SOUNDTRACKS[i]
        const isSaved = (t.id || null) === (savedId || null)
        const isPreviewing = previewId !== undefined && (t.id || null) === (previewId || null)
        r.classList.toggle('is-selected', isSaved)
        r.classList.toggle('is-playing', isPreviewing)
        r.classList.toggle('paused', isPreviewing && bgMusic.paused)
      })
      saveBtn.disabled = previewId === undefined || (previewId || null) === (savedId || null)
      playBtn.classList.toggle('loading', stLoading)
      playBtn.innerHTML = stLoading ? '' : (bgMusic.paused ? '&#9654;' : '&#10074;&#10074;')
    }

    function showMini(t) {
      miniArt.src = t.art
      miniTitle.textContent = t.title
      miniEl.classList.add('show')
      document.body.classList.add('soundtrack-mini-open')
      // Feed the player's MEASURED height to the CSS that lifts the bug FAB
      // and toast clear of it (see --st-mini-h in style.css). A hardcoded
      // height already shipped wrong once: it was tuned against a headless
      // viewport and left the FAB floating far above the real player on an
      // actual iPhone (larger fonts/Dynamic Type change the true height).
      // Measured twice: once right away (best-effort while the 0.25s slide-in
      // is still running - offsetHeight mid-transition is partial, hence the
      // >40 guard so a half-open 1px never gets recorded), and again after
      // the transition has settled, which is the value that sticks.
      const measureMini = () => {
        if (miniEl.offsetHeight > 40) document.body.style.setProperty('--st-mini-h', miniEl.offsetHeight + 'px')
      }
      requestAnimationFrame(measureMini)
      setTimeout(measureMini, 320)
    }

    rowEls.forEach((r, i) => {
      r.addEventListener('click', () => {
        const t = SOUNDTRACKS[i]
        if (previewId !== undefined && (previewId || null) === (t.id || null)) {
          // Same row tapped again - toggle play/pause on the existing preview.
          // soundtrackPreviewPaused (not a bare .pause()) so the global click
          // listener's syncMusic() doesn't immediately resume it.
          soundtrackPreviewBoost = true
          soundtrackPreviewPaused = !bgMusic.paused
          syncMusic()
          paint()
          return
        }
        previewId = t.id
        stPreviewTrackId = previewId
        soundtrackPreviewBoost = true // audible even if the chef has muted - see syncMusic()
        soundtrackPreviewPaused = false
        stLoading = true
        bgMusic.src = t.src
        bgMusic.loop = true
        bgMusic.currentTime = 0
        updateMediaSessionTrack(t.title)
        showMini(t)
        syncMusic()
        bgMusic.play().catch(() => {})
        paint()
      })
    })

    playBtn.addEventListener('click', () => {
      if (previewId === undefined) return
      soundtrackPreviewBoost = true
      soundtrackPreviewPaused = !bgMusic.paused
      syncMusic()
      paint()
    })

    // ---- scrubber (pointer drag to seek), ported from the mockup ----
    let scrubbing = false
    function seekAt(clientX) {
      const r = scrubEl.getBoundingClientRect()
      const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
      fillEl.style.width = (p * 100) + '%'
      knobEl.style.left = (p * 100) + '%'
      tCur.textContent = fmtTime(p * (bgMusic.duration || 0))
      return p
    }
    scrubEl.addEventListener('pointerdown', (e) => {
      if (previewId === undefined) return
      scrubbing = true
      scrubEl.setPointerCapture(e.pointerId)
      seekAt(e.clientX)
    })
    scrubEl.addEventListener('pointermove', (e) => { if (scrubbing) seekAt(e.clientX) })
    scrubEl.addEventListener('pointerup', (e) => {
      if (!scrubbing) return
      scrubbing = false
      bgMusic.currentTime = seekAt(e.clientX) * (bgMusic.duration || 0)
    })

    // ---- bgMusic listeners, named so teardownSoundtrackPreview can remove them ----
    const onPlaying = () => { stLoading = false; paint() }
    const onWaiting = () => { stLoading = true; paint() }
    const onPause = () => paint()
    const onPlay = () => paint()
    const onLoadedMeta = () => { tDur.textContent = fmtTime(bgMusic.duration) }
    const onTimeUpdate = () => {
      if (scrubbing) return
      const p = bgMusic.duration ? bgMusic.currentTime / bgMusic.duration * 100 : 0
      fillEl.style.width = p + '%'
      knobEl.style.left = p + '%'
      tCur.textContent = fmtTime(bgMusic.currentTime)
    }
    bgMusic.addEventListener('playing', onPlaying)
    bgMusic.addEventListener('waiting', onWaiting)
    bgMusic.addEventListener('pause', onPause)
    bgMusic.addEventListener('play', onPlay)
    bgMusic.addEventListener('loadedmetadata', onLoadedMeta)
    bgMusic.addEventListener('durationchange', onLoadedMeta)
    bgMusic.addEventListener('timeupdate', onTimeUpdate)
    stAudioHandlers = { playing: onPlaying, waiting: onWaiting, pause: onPause, play: onPlay, loadedmetadata: onLoadedMeta, timeupdate: onTimeUpdate }

    // Backgrounding the tab must never leave the mute-override on - clear it
    // (syncMusic re-pauses for real, same as it would anyway once actually
    // backgrounded) but keep the preview selection so coming back can resume
    // it with one more tap rather than losing the spot entirely.
    const onVisibility = () => { if (document.hidden) { soundtrackPreviewBoost = false; syncMusic() } }
    document.addEventListener('visibilitychange', onVisibility)
    stVisibilityHandler = onVisibility
    const onPagehide = () => { soundtrackPreviewBoost = false; syncMusic() }
    window.addEventListener('pagehide', onPagehide)
    stPagehideHandler = onPagehide

    // No popup-vs-mini-player handling needed here: the player now lives
    // inside .app, the same stacking context as every popup, so the
    // overlay's z-index 70 beats the player's 40 by plain CSS - the old
    // body-level placement needed a MutationObserver "duck" for this, which
    // raced on real Safari (class applied, style not yet - the exact
    // on-device bug where the player sat on top of the bug-report popup).

    saveBtn.addEventListener('click', async () => {
      if (previewId === undefined) return
      const track = soundtrackById(previewId)
      const { error } = await supabase.from('profiles').update({ soundtrack: previewId }).eq('id', currentUser.id)
      if (error) { toast("Couldn't save — try again"); return }
      currentProfile.soundtrack = previewId
      currentTrackSrc = soundtrackAbsUrl(track.src) // the preview IS now the saved/applied track
      savedId = previewId
      paint()
      toast(`Saved — "${track.title}" is your soundtrack`)
    })

    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)

    stPreviewTrackId = previewId
    paint()
    screenTeardown = teardownSoundtrackPreview
  }, { key: 'soundtrack' })
}

let addToHomescreenTab = 'ios' // 'ios' | 'android' - defaults to iOS on open

// Ordered captions for ios-1.jpg..ios-5.jpg (app/public/assets/homescreen/).
// Step 4 calls out that "Open as Web App" must stay ON, or iOS falls back to
// a plain Safari bookmark - no standalone chrome, no fullscreen.
const IOS_A2HS_STEPS = [
  { img: 'ios-1.jpg', caption: `Tap the <b>•••</b> menu in Safari` },
  { img: 'ios-2.jpg', caption: `Tap <b>Share</b>` },
  { img: 'ios-3.jpg', caption: `Tap <b>Add to Home Screen</b>` },
  { img: 'ios-4.jpg', caption: `Keep <b>"Open as Web App"</b> switched on, then tap <b>Add</b> - turning it off gives you a plain bookmark, not the full app` },
  { img: 'ios-5.jpg', caption: `The icon's now on your homescreen, ready to cook!` },
]

const ANDROID_A2HS_STEPS = [
  { img: 'android-1.png', caption: `Tap the <b>⋮</b> menu in your browser` },
  { img: 'android-2.png', caption: `Tap <b>Add to Home screen</b>` },
  { img: 'android-3.png', caption: `Tap <b>Add</b> - the icon's now on your homescreen, ready to cook!` },
]

function renderAddToHomescreenGuide() {
  addToHomescreenTab = 'ios'
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>Add to Homescreen</h2></div>
    <div class="cal-seg cal-seg-2" id="a2hs-seg">
      <button type="button" class="on" data-v="ios">iOS</button>
      <button type="button" data-v="android">Android</button>
    </div>
    <div class="a2hs-panel" data-panel="ios">
      <div class="a2hs-steps">
        ${IOS_A2HS_STEPS.map((s, i) => `
          <div class="a2hs-step">
            <img class="a2hs-shot" src="${BASE}assets/homescreen/${s.img}" alt="Step ${i + 1}" loading="lazy" />
            <p class="a2hs-caption"><span class="a2hs-num">${i + 1}</span>${s.caption}</p>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="a2hs-panel" data-panel="android" hidden>
      ${deferredInstallPrompt
        ? `<div class="a2hs-native">
            <p>Your browser can install Chef Penguino directly - no bookmarking needed.</p>
            <button type="button" class="a2hs-install-btn" data-action="native-install">Install</button>
          </div>`
        : ''}
      <div class="a2hs-steps">
        ${ANDROID_A2HS_STEPS.map((s, i) => `
          <div class="a2hs-step">
            <img class="a2hs-shot" src="${BASE}assets/homescreen/${s.img}" alt="Step ${i + 1}" loading="lazy" />
            <p class="a2hs-caption"><span class="a2hs-num">${i + 1}</span>${s.caption}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)
    app.querySelector('[data-action="native-install"]')?.addEventListener('click', triggerAddToHomescreen)
    app.querySelectorAll('#a2hs-seg button').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.v === addToHomescreenTab) return
        addToHomescreenTab = b.dataset.v
        app.querySelectorAll('#a2hs-seg button').forEach(x => x.classList.toggle('on', x === b))
        app.querySelectorAll('.a2hs-panel').forEach(p => { p.hidden = p.dataset.panel !== addToHomescreenTab })
      })
    })
  }, { key: 'add-to-homescreen' })
}

function renderLegal() {
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="section-h" style="margin-top:2px"><h2>Legal and Disclaimers</h2></div>
    <div class="legal-list">
      <div class="legal-card">
        <div class="legal-card-title">Copyright</div>
        <p>Chef Penguino (original name = Chef Panguino) and other characters in this app are from the game "The Greatest Penguin Heist of All Time", by the indie development team That Other Fish.</p>
        <p>This app is fan-made and NOT officially from That Other Fish.</p>
        <p>Therefore, all copyright and character rights belong to That Other Fish.</p>
      </div>
      <div class="legal-card">
        <div class="legal-card-title">Non-profit</div>
        <p>As this app is fan-made and solely for fun, we do not charge users anything nor do we profit in any way. Any future commercialisation of this app will require consent from That Other Fish, as long as we continue using their characters.</p>
      </div>
    </div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)
  }, { key: 'legal' })
}

// Plays the short barrel-explosion clip (with its own audio) for the three
// destructive confirms in DELETE_CLIP_ACTIONS. Mirrors renderIntro()'s inline
// portrait-video pattern (~6580, .intro/.intro-video/.intro-skip in
// style.css) rather than the lore player's fullscreen dance (playLoreVideo
// above, never called here) or a document.body overlay - it's appended as an
// absolutely-positioned layer OVER the current screen (inside #app, which is
// already `position:relative`) and removed on cleanup, so whatever screen the
// user was on (Friends, Groups, ...) is still there underneath and untouched.
// Resolves (never rejects) once the clip ends, is skipped, the backdrop is
// tapped, autoplay is blocked, or the safety timeout fires - callers can
// always proceed.
function playDeleteClip() {
  if (!state.deleteAnimations || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve()
  }

  const wasMusicPlaying = !bgMusic.paused
  // Must be set BEFORE bgMusic.pause(): this same click event is still
  // bubbling up to document's global click listener, which calls
  // syncMusic() and would otherwise immediately call bgMusic.play() again
  // (see the comment on that listener) before this function even returns.
  musicSuspendedByOther = true
  bgMusic.pause()

  const wrap = document.createElement('div')
  wrap.className = 'delete-clip'
  wrap.innerHTML = `
    <video class="delete-clip-video" src="${BASE}assets/delete-barrel.mp4" poster="${BASE}assets/delete-barrel-poster.jpg" playsinline></video>
    <button class="delete-clip-skip intro-skip" type="button">Skip</button>
  `
  app.appendChild(wrap)
  const video = wrap.querySelector('video')
  video.muted = state.muted

  return new Promise((resolve) => {
    let cleaned = false
    let safetyTimer
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(safetyTimer)
      video.removeEventListener('ended', onEnded)
      video.pause()
      wrap.remove()
      musicSuspendedByOther = false
      if (wasMusicPlaying && !state.muted) bgMusic.play().catch(() => {})
      resolve()
    }
    const onEnded = () => cleanup()
    const onAutoplayBlocked = () => cleanup()

    video.addEventListener('ended', onEnded)
    wrap.querySelector('.delete-clip-skip').addEventListener('click', cleanup)
    wrap.addEventListener('click', (e) => { if (e.target === wrap) cleanup() })

    // Safety net in case `ended` never fires (stalled network, odd codec
    // support, etc.) - never let a caller hang on this promise.
    safetyTimer = setTimeout(cleanup, 6000)

    // Called synchronously from within the confirm click handler so the
    // user gesture still counts for autoplay policy; if it rejects
    // (autoplay blocked), resolve immediately rather than hang - same
    // treatment renderIntro() gives its own autoplay-blocked case.
    video.play().catch(onAutoplayBlocked)
  })
}

// Gate for the three call sites below - keeps DELETE_CLIP_ACTIONS as the
// single real switch. Removing an action from that array turns this into a
// no-op at its call site without touching the confirm function itself.
function playDeleteClipFor(action) {
  if (!DELETE_CLIP_ACTIONS.includes(action)) return Promise.resolve()
  return playDeleteClip()
}

// Plays a lore video fullscreen with sound, ducking the bg music for the
// duration. iOS Safari only supports fullscreen via the video element's own
// webkitEnterFullscreen (the generic Fullscreen API doesn't work there), so
// both paths are wired; the overlay itself is also a full-viewport fallback
// in case neither fullscreen API is available.
function playLoreVideo(entry) {
  const wasMusicPlaying = !bgMusic.paused
  // Must be set BEFORE bgMusic.pause(): this same click event is still
  // bubbling up to document's global click listener, which calls
  // syncMusic() and would otherwise immediately call bgMusic.play() again
  // (see the comment on that listener) before this function even returns.
  musicSuspendedByOther = true
  bgMusic.pause()

  const wrap = document.createElement('div')
  wrap.className = 'lore-player'
  wrap.innerHTML = `
    <button class="lore-player-close" type="button" aria-label="Close">✕</button>
    <video class="lore-player-video" src="${BASE}assets/${entry.clip}" playsinline controls></video>
  `
  document.body.appendChild(wrap)
  const video = wrap.querySelector('video')

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    video.removeEventListener('webkitendfullscreen', onWebkitEnd)
    video.removeEventListener('ended', onEnded)
    video.pause()
    wrap.remove()
    musicSuspendedByOther = false
    if (wasMusicPlaying && !state.muted) bgMusic.play().catch(() => {})
  }
  const onFullscreenChange = () => { if (!document.fullscreenElement) cleanup() }
  const onWebkitEnd = () => cleanup()
  const exitFullscreen = () => {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(cleanup)
    else if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen()
    else cleanup()
  }
  const onEnded = () => exitFullscreen()

  document.addEventListener('fullscreenchange', onFullscreenChange)
  video.addEventListener('webkitendfullscreen', onWebkitEnd)
  video.addEventListener('ended', onEnded)
  wrap.querySelector('.lore-player-close').addEventListener('click', exitFullscreen)

  video.play().catch(() => {})
  if (video.requestFullscreen) video.requestFullscreen().catch(() => {})
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
  else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen()
}

// =================================================================
//  Admin Dashboard (admin-only; see migration_admin.sql)
// =================================================================
// Start of "today" in Singapore time - used ONLY by the KPI strip's "pizzas
// baked today" figure. `d` must be a real instant (e.g. `new Date()`), not a
// device-local calendar Date - this is just sgtStartOfDay(), kept under its
// old name since it's an established call site.
//
// NOTE (deliberate mismatch): the KPI tile stays a TODAY number, but the
// leaderboard it opens (renderAdminWeeklyLeaderboard) is scoped to the
// current SGT week via sgtStartOfWeek(), matching the Chefs-page Weekly
// Leaderboard. Don't "fix" that difference - it's intentional.
function admStartOfDay(d) { return sgtStartOfDay(d) }

function renderAdminDashboard() {
  if (!isAdmin()) { renderSettings(); return }

  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-settings">‹ Settings</div>
    <div class="adm-hq-head">
      <div><h1>Kitchen HQ</h1><div class="sub">Admin Dashboard</div></div>
      <div class="adm-live-dot" role="button" tabindex="0" data-action="open-pizzas-cal" title="View baking stats"><i></i><span id="hq-baking-n">– baking</span></div>
    </div>

    <div class="group" style="margin-top:1.375rem">
      <p class="glab">Today at a glance</p>
      <div class="adm-kpi-grid">
        <div class="adm-kpi" role="button" tabindex="0" data-action="open-chefs">
          <span class="adm-kpi-ic">🐧</span>
          <div class="adm-kpi-val" id="kpi-chefs-val">–</div>
          <div class="adm-kpi-lab">Active chefs this week<span class="adm-kpi-sub" id="kpi-chefs-sub" hidden></span></div>
        </div>
        <div class="adm-kpi accent" role="button" tabindex="0" data-action="open-pizzas-leaderboard">
          <span class="adm-kpi-ic">🍕</span>
          <div class="adm-kpi-val" id="kpi-pizzas-val">–</div>
          <div class="adm-kpi-lab">Pizzas baked today<span class="adm-kpi-drill" role="button" tabindex="0" data-action="open-pizzas-cal-detail">stats ›</span></div>
        </div>
      </div>
    </div>

    <div class="group">
      <p class="glab">Needs your attention</p>
      <div class="adm-action hot" role="button" tabindex="0" data-action="open-bug-reports">
        <div class="adm-badge-ic">🐞</div>
        <div class="body"><div class="t">Bug Reports <span class="adm-count-pill" id="bug-count-pill" hidden></span></div><div class="s" id="bug-sub">Loading&hellip;</div></div>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
      <div class="adm-action hot" role="button" tabindex="0" data-action="open-moderation">
        <div class="adm-badge-ic">🛡️</div>
        <div class="body"><div class="t">Moderation <span class="adm-count-pill" id="mod-count-pill" hidden></span></div><div class="s" id="mod-sub">Loading&hellip;</div></div>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
    </div>

    <div class="group">
      <p class="glab">Manage the pizzeria</p>
      <div class="adm-action" role="button" tabindex="0" data-action="open-users">
        <div class="adm-badge-ic">👥</div>
        <div class="body"><div class="t">Users</div><div class="s" id="users-sub">Edit pizzas, coins &amp; names</div></div>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
      <div class="adm-action" role="button" tabindex="0" data-action="open-compose">
        <div class="adm-badge-ic">📣</div>
        <div class="body"><div class="t">Send Notification</div><div class="s">Message one chef, a few, or everyone</div></div>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
    </div>

    <div class="group">
      <p class="glab">Setup</p>
      <div class="adm-setup-list">
        <div class="adm-srow" role="button" tabindex="0" data-action="open-presets">
          <span class="adm-sic">🖼️</span><span class="adm-st">Preset Pictures</span><span class="adm-sn" id="setup-presets-n">–</span><span class="chevron" aria-hidden="true">›</span>
        </div>
        <div class="adm-srow" role="button" tabindex="0" data-action="open-emotes">
          <span class="adm-sic">🏷️</span><span class="adm-st">Emote Types</span><span class="adm-sn" id="setup-emotes-n">–</span><span class="chevron" aria-hidden="true">›</span>
        </div>
        <div class="adm-srow" role="button" tabindex="0" data-action="open-group-icons">
          <span class="adm-sic">🧩</span><span class="adm-st">Group Icons</span><span class="adm-sn" id="setup-groupicons-n">–</span><span class="chevron" aria-hidden="true">›</span>
        </div>
      </div>
    </div>
    <div style="height:8px"></div>
  `

  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-settings"]').addEventListener('click', renderSettings)
    app.querySelector('[data-action="open-pizzas-cal"]').addEventListener('click', renderAdminPizzasCal)
    app.querySelector('[data-action="open-pizzas-leaderboard"]').addEventListener('click', renderAdminWeeklyLeaderboard)
    // Inner "stats ›" affordance inside the KPI tile: keeps the pizzas
    // calendar reachable from the tile (as it was before) without it eating
    // the card's own tap target, which now opens the new leaderboard.
    app.querySelector('[data-action="open-pizzas-cal-detail"]').addEventListener('click', (e) => {
      e.stopPropagation()
      renderAdminPizzasCal()
    })
    app.querySelector('[data-action="open-chefs"]').addEventListener('click', renderAdminChefs)
    app.querySelector('[data-action="open-bug-reports"]').addEventListener('click', renderBugReports)
    app.querySelector('[data-action="open-moderation"]').addEventListener('click', () => renderModerationCenter())
    app.querySelector('[data-action="open-users"]').addEventListener('click', renderAdminUsers)
    app.querySelector('[data-action="open-compose"]').addEventListener('click', renderComposeNotification)
    app.querySelector('[data-action="open-presets"]').addEventListener('click', renderAdminPresets)
    app.querySelector('[data-action="open-emotes"]').addEventListener('click', renderAdminEmotes)
    app.querySelector('[data-action="open-group-icons"]').addEventListener('click', renderAdminGroupIcons)

    loadModSummary()
    loadBugSummary()
    loadAdminDashboardStats()
  }, { key: 'admin' })
}

// Populates the KPI strip, the "N baking" pill, the Users row's chef count,
// and the Setup row counts. Every query here is a light head:true/small
// select run in parallel, so one slow table never blocks the rest of the
// dashboard from painting.
async function loadAdminDashboardStats() {
  const start = admStartOfDay(new Date())
  const [chefsRes, activeWeekRes, pizzasRes, presetsRes, tagsRes, iconsRes, bakingRes] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    // Chefs who cooked at all this week, however briefly - not signups. Shares
    // startOfThisWeek() with the Weekly Scoreboard so both roll over together
    // on Monday rather than drifting apart. Rows, not a head-count: Postgrest
    // has no count-distinct, so the distinct user_ids are tallied client-side.
    supabase.from('sessions').select('user_id').gte('completed_at', startOfThisWeek().toISOString()),
    // Needs "admin can view all sessions" (see migration_admin_sessions.sql) -
    // until that's run, RLS quietly limits this to the admin's own (+
    // friends') sessions, so the total under-counts rather than erroring.
    supabase.from('sessions').select('pizzas').gte('completed_at', start.toISOString()),
    supabase.from('preset_avatars').select('id', { count: 'exact', head: true }),
    supabase.from('emote_tags').select('id', { count: 'exact', head: true }),
    supabase.from('group_icons').select('id', { count: 'exact', head: true }), // errors pre-migration_group_icons.sql - handled below
    // Chefs mid-session right now. Errors pre-migration_baking_now.sql, which
    // is handled below by falling back to a dash rather than a wrong number.
    supabase.from('profiles').select('id', { count: 'exact', head: true }).gt('baking_since', bakingCutoffISO()),
  ])

  const chefsN = chefsRes.count || 0
  const activeWeekN = new Set((activeWeekRes.data || []).map(r => r.user_id)).size
  const pizzasToday = (pizzasRes.data || []).reduce((sum, r) => sum + Number(r.pizzas), 0)

  const set = (id, txt) => { const el = app.querySelector('#' + id); if (el) el.textContent = txt }
  set('kpi-chefs-val', activeWeekN.toLocaleString())
  set('kpi-pizzas-val', formatScore(pizzasToday))
  // A dash, not 0, when the column isn't there yet: "0 baking" would read as
  // a real measurement of nobody baking rather than "not tracked here".
  set('hq-baking-n', (bakingRes.error ? '–' : (bakingRes.count || 0).toLocaleString()) + ' baking')
  set('users-sub', `Edit pizzas, coins & names · ${chefsN} chef${chefsN === 1 ? '' : 's'}`)
  set('setup-presets-n', presetsRes.error ? '–' : String(presetsRes.count || 0))
  set('setup-emotes-n', tagsRes.error ? '–' : String(tagsRes.count || 0))
  set('setup-groupicons-n', iconsRes.error ? '–' : String(iconsRes.count || 0))

  // Denominator for the headline number - "3" alone doesn't say whether that's
  // most of the pizzeria or a handful of it.
  const chefsSub = app.querySelector('#kpi-chefs-sub')
  if (chefsSub) { chefsSub.textContent = `of ${chefsN} chef${chefsN === 1 ? '' : 's'}`; chefsSub.hidden = false }
}

// =================================================================
//  Admin: Chefs (placeholder subpage - Task 3)
// =================================================================
function renderAdminChefs() {
  if (!isAdmin()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Chefs</h2></div>
    <div class="adm-soon">
      <span class="ic">🐧</span>
      <div class="t">Chef stats coming soon</div>
      <div class="s">Signups, retention and activity trends will live here.<br>Not needed to run the pizzeria today.</div>
    </div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
  }, { key: 'admin-chefs' })
}

// =================================================================
//  Admin: Users (moved off the dashboard - reuses loadAdminUsers() /
//  renderAdminUserList() / openAdminAdjustPopup(), which are all agnostic
//  to which screen mounted their target ids)
// =================================================================
function renderAdminUsers() {
  if (!isAdmin()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Users</h2></div>
    <div class="admin-dash">
      <div class="group" style="margin-top:0">
        <div class="adm-search-card">
          <span class="adm-search-ic" aria-hidden="true">🔍</span>
          <input id="admin-search-input" type="text" placeholder="Filter by name or friend code" />
        </div>
        <div class="adm-list-count" id="admin-user-count"></div>
        <div class="adm-user-scroll" id="admin-user-scroll"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    loadAdminUsers()
    app.querySelector('#admin-search-input').addEventListener('input', (e) => renderAdminUserList(e.target.value))
  }, { key: 'admin-users' })
}

// =================================================================
//  Admin: Preset Pictures (moved off the dashboard - Setup)
// =================================================================
function renderAdminPresets() {
  if (!isAdmin()) { renderSettings(); return }
  presetEditMode = false
  presetArrangeMode = false
  presetArrangeAbort?.abort()
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Preset Pictures</h2></div>
    <div class="admin-dash">
      <div class="group" style="margin-top:0">
        <p class="adm-preset-summary" id="preset-ladder-summary">Loading&hellip;</p>
        <div class="adm-preset-grid" id="preset-grid"><p class="log-empty">Loading&hellip;</p></div>
        <div class="adm-preset-actions">
          <button class="admin-upload-btn" type="button" data-action="toggle-preset-edit">Edit Pictures</button>
          <button class="admin-upload-btn" type="button" data-action="toggle-preset-arrange">Arrange</button>
        </div>
        <input type="file" accept="image/*" id="preset-input" hidden />
      </div>
    </div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    loadPresetAvatars()
    app.querySelector('#preset-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''
      if (file) openAvatarCropper(file, (blob) => uploadPresetAvatar(blob))
    })
    app.querySelector('[data-action="toggle-preset-edit"]').addEventListener('click', () => {
      presetEditMode = !presetEditMode
      if (presetEditMode) presetArrangeMode = false
      renderPresetGrid()
    })
    app.querySelector('[data-action="toggle-preset-arrange"]').addEventListener('click', () => {
      presetArrangeMode = !presetArrangeMode
      if (presetArrangeMode) presetEditMode = false
      else presetArrangeAbort?.abort()
      renderPresetGrid()
    })
  }, { key: 'admin-presets' })
}

// =================================================================
//  Admin: Emote Types (moved off the dashboard - Setup)
// =================================================================
function renderAdminEmotes() {
  if (!isAdmin()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Emote Types</h2></div>
    <div class="admin-dash">
      <div class="group" style="margin-top:0">
        <p class="glab">Types</p>
        <div class="adm-tags" id="adm-tags"><p class="editpic-empty">Loading&hellip;</p></div>
        <div class="adm-search-card" style="margin-top:0.75rem">
          <input id="adm-new-tag" type="text" placeholder="New type name" maxlength="20" />
          <button type="button" data-action="add-tag">Add</button>
        </div>
      </div>
      <div class="group">
        <p class="glab">Tag Emotes</p>
        <div class="glist" id="adm-emote-list"></div>
      </div>
    </div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    loadEmoteData(true).then(renderAdminEmoteTypes)
    app.querySelector('[data-action="add-tag"]').addEventListener('click', addEmoteTag)
    app.querySelector('#adm-new-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter') addEmoteTag() })
  }, { key: 'admin-emotes' })
}

// =================================================================
//  Admin: Group Icons (Setup) - Task 4
//  A curated emoji set for a future "pick a group icon" picker (see
//  migration_groups.sql's groups.emoji, currently free text). Table + RPCs
//  live in migration_group_icons.sql, which hasn't necessarily been run
//  yet - loadGroupIcons() falls back to a small hardcoded default set (and
//  hides the remove/add controls) rather than throwing.
// =================================================================
const GROUP_ICONS_FALLBACK = ['🐧', '🍕', '🔥', '⭐', '🏆', '🎉']
let groupIconsCache = []
let groupIconsFromDb = true // false once group_icons 404s - Add/Remove no-op instead of hitting a table that doesn't exist

async function loadGroupIcons() {
  const { data, error } = await supabase.from('group_icons').select('id, emoji').order('created_at', { ascending: true })
  if (error) {
    groupIconsFromDb = false
    groupIconsCache = GROUP_ICONS_FALLBACK.map(e => ({ id: null, emoji: e }))
  } else {
    groupIconsFromDb = true
    groupIconsCache = data || []
  }
  renderGroupIconTiles()
}

function renderGroupIconTiles() {
  const grid = app.querySelector('#group-icons-grid')
  if (!grid) return
  grid.innerHTML = groupIconsCache.length
    ? groupIconsCache.map(g => `
        <span class="adm-tag-chip" data-icon-id="${g.id || ''}">
          <span class="adm-tag-emoji">${escapeHtml(g.emoji)}</span>
          ${groupIconsFromDb ? `<button type="button" class="adm-tag-del" data-action="remove-icon" aria-label="Remove icon">✕</button>` : ''}
        </span>`).join('')
    : '<p class="editpic-empty">No icons yet. Add one below.</p>'
  grid.querySelectorAll('[data-action="remove-icon"]').forEach(b => b.addEventListener('click', () => {
    removeGroupIcon(b.closest('[data-icon-id]').dataset.iconId)
  }))
  const note = app.querySelector('#group-icons-note')
  if (note) note.hidden = groupIconsFromDb
}

async function addGroupIcon() {
  const input = app.querySelector('#group-icon-input')
  const emoji = input.value.trim()
  if (!emoji) return
  if (!groupIconsFromDb) { toast('Run migration_group_icons.sql first'); return }
  const { error } = await supabase.rpc('add_group_icon', { emoji })
  if (error) { toast(error.message); return }
  input.value = ''
  await loadGroupIcons()
}

async function removeGroupIcon(id) {
  if (!id || !groupIconsFromDb) return
  const { error } = await supabase.rpc('remove_group_icon', { id })
  if (error) { toast(error.message); return }
  loadGroupIcons()
}

function renderAdminGroupIcons() {
  if (!isAdmin()) { renderSettings(); return }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Group Icons</h2></div>
    <p class="adm-cal-note" id="group-icons-note" hidden style="margin:0 0.25rem 0.875rem">Showing a default set — run migration_group_icons.sql in Supabase to make this editable.</p>
    <div class="adm-tags" id="group-icons-grid"><p class="editpic-empty">Loading&hellip;</p></div>
    <div class="adm-search-card" style="margin-top:0.875rem">
      <input id="group-icon-input" type="text" placeholder="Type an emoji…" maxlength="8" />
      <button type="button" data-action="add-icon">Add</button>
    </div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    app.querySelector('[data-action="add-icon"]').addEventListener('click', addGroupIcon)
    app.querySelector('#group-icon-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addGroupIcon() })
    loadGroupIcons()
  }, { key: 'admin-group-icons' })
}

// =================================================================
//  Admin: Pizzas Baked calendar (Task 2) - a read-only, AGGREGATE copy of
//  the chef-facing History calendar (renderHistory() above). Same
//  Month/Week/Day shape and the same cal-* CSS/date helpers (calKey,
//  calDateFromKey, calWeekDays, calIntensity, CAL_MONTHS...), but every
//  query sums public.sessions across ALL chefs instead of the signed-in
//  user's own log, and per-day/session detail is never shown - totals only.
//
//  NOTE: this needs the "admin can view all sessions" RLS policy - see
//  migration_admin_sessions.sql. Until that's run, RLS quietly limits every
//  query below to the admin's own (+ friends') sessions, so totals
//  under-count rather than erroring - there's nothing for the client to
//  detect and warn about there, since a RLS-filtered result isn't an error.
// =================================================================
let admCalView = 'month'      // 'month' | 'week' | 'day'
let admCalY = null            // month-view anchor year
let admCalMo = null           // month-view anchor month (0-11)
let admCalWeekKey = null      // any 'YYYY-MM-DD' key inside the displayed week
let admCalDayKey = null       // day-view anchor
let admCalFilter = 'all'      // 'all' or a TASK_TYPES key - persists across Month/Week/Day
let admCalSelectedDay = null  // day key currently "pinned" in the top total line, or null = whole period
let admCalTypeColOk = true    // false once a `type`-column query fails (pre-migration_task_types.sql) - disables the filter rather than crashing

// Snapshot of the currently-rendered period, refreshed on every
// renderAdminPizzasCal() call - the per-chef leaderboard sheet (opened by
// tapping the total card) reads these instead of recomputing its own
// range/label, so the sheet always matches exactly what's on screen
// (including a pinned single day within Month/Week view).
let admCalLbRange = null   // { start, end } Date instants for whichever period the total card is currently showing
let admCalLbTitle = ''     // heading text, reusing the calendar's own period/label formatting

// Sessions in [start, endExclusive) across every chef, summed per day and
// filtered by admCalFilter. Falls back to a type-less query (and disables
// the filter) if the `type` column doesn't exist yet, so the calendar still
// renders pre-migration instead of showing an error screen.
async function admCalFetchDayTotals(start, endExclusive) {
  const range = (q) => q.gte('completed_at', start.toISOString()).lt('completed_at', endExclusive.toISOString())
  let data, error
  if (admCalTypeColOk) {
    let q = range(supabase.from('sessions').select('completed_at, pizzas, type'))
    if (admCalFilter !== 'all') q = q.eq('type', admCalFilter)
    ;({ data, error } = await q)
    if (error) admCalTypeColOk = false
  }
  if (!admCalTypeColOk) {
    ;({ data, error } = await range(supabase.from('sessions').select('completed_at, pizzas')))
  }
  const map = new Map()
  ;(data || []).forEach(r => {
    // Bucket by the SGT calendar day the bake fell on, not the device's
    // local day - two admins in different timezones must see the same
    // per-day totals.
    const { y, mo, day } = sgtDateParts(new Date(r.completed_at))
    const k = calKey(y, mo, day)
    map.set(k, (map.get(k) || 0) + Number(r.pizzas))
  })
  return map
}

// Query-range boundaries below are built straight from calendar y/m/d
// numbers via sgtDateFromYMD(), rather than from device-local Date
// instants, so the [start, endExclusive) window always lines up with real
// Singapore-time day boundaries regardless of the admin's device timezone.
function admCalMonthRange() { return { start: sgtDateFromYMD(admCalY, admCalMo, 1), end: sgtDateFromYMD(admCalY, admCalMo + 1, 1) } }
function admCalWeekRange() {
  const days = calWeekDays(admCalWeekKey)
  const first = days[0], last = days[6]
  return {
    start: sgtDateFromYMD(first.getFullYear(), first.getMonth(), first.getDate()),
    end: sgtDateFromYMD(last.getFullYear(), last.getMonth(), last.getDate() + 1),
    days,
  }
}
function admCalDayRange() {
  const dt = calDateFromKey(admCalDayKey)
  return {
    start: sgtDateFromYMD(dt.getFullYear(), dt.getMonth(), dt.getDate()),
    end: sgtDateFromYMD(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1),
  }
}

// Only the date number - never a per-day count in the cell itself (that
// read as clutter/confusing in the mockup); volume is conveyed purely by the
// heat-map background.
//
// Intensity is scaled to the busiest day IN THIS MONTH rather than reusing
// calIntensity(), which saturates at 4 pizzas. That threshold is right for a
// single chef's calendar but meaningless once every day is the sum across all
// chefs - every cell would hit maximum and the heat map would say nothing.
// The week view already scales this way; this matches it.
function admCalMonthBodyHtml(dayMap, todayKey) {
  const dim = new Date(admCalY, admCalMo + 1, 0).getDate()
  const off = (new Date(admCalY, admCalMo, 1).getDay() + 6) % 7
  const monthMax = Math.max(
    ...Array.from({ length: dim }, (_, i) => dayMap.get(calKey(admCalY, admCalMo, i + 1)) || 0),
    1,
  )
  const relIntensity = (pz) => (pz <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((pz / monthMax) * 4))))

  let h = '<div class="cal-monthpanel"><div class="cal-dow">' + CAL_DOW.map(d => `<span>${d}</span>`).join('') + '</div><div class="cal-grid">'
  for (let i = 0; i < off; i++) h += '<div class="cal-cell cal-empty-month"></div>'
  for (let d = 1; d <= dim; d++) {
    const key = calKey(admCalY, admCalMo, d)
    const pz = dayMap.get(key) || 0
    const inten = relIntensity(pz)
    // Only days with bakes are tappable, so an empty day doesn't get the
    // pointer cursor and brighter number of a day that has data.
    const cls = 'cal-cell' + (pz ? ' cal-has' : '') + (inten ? ' cal-i' + inten : '')
      + (key === todayKey ? ' cal-today' : '') + (key === admCalSelectedDay ? ' cal-sel' : '')
    h += `<div class="${cls}" data-day="${key}"><div class="cal-dnum">${d}</div></div>`
  }
  h += '</div></div>'
  return h
}

function admCalWeekBodyHtml(days, todayKey, dayMap) {
  const vals = days.map(d => dayMap.get(calKeyFromDate(d)) || 0)
  const max = Math.max(...vals, 1)
  let h = '<div class="adm-wk-panel">'
  days.forEach((dt, i) => {
    const key = calKeyFromDate(dt)
    const val = vals[i]
    const pct = val ? Math.max(Math.round((val / max) * 100), 4) : 0
    const cls = 'adm-wk-row' + (key === todayKey ? ' today' : '') + (key === admCalSelectedDay ? ' sel' : '')
    h += `<div class="${cls}" data-day="${key}">
      <span class="adm-wk-d">${CAL_DOW_FULL[dt.getDay()].slice(0, 3)}</span>
      <span class="adm-wk-bar"><i style="width:${pct}%"></i></span>
      <span class="adm-wk-n">${formatScore(val)}</span>
    </div>`
  })
  h += '</div>'
  return h
}

function admCalDayBodyHtml(val) {
  const filterSuffix = admCalFilter !== 'all' ? ` · ${escapeHtml(taskTypeLabel(admCalFilter)?.title || '')}` : ''
  return `<div class="adm-daybig"><div class="dv">${formatScore(val)}</div><div class="dk">pizzas baked${filterSuffix}</div></div>`
}

// Single-select "All" + the 5 task types - unlike the chef calendar's
// multi-select pills (calTypeFilter), this always narrows to exactly one
// bucket, matching the approved mockup's chip row.
function admCalFilterChipsHtml() {
  const chips = [`<button type="button" class="tt-chip${admCalFilter === 'all' ? ' active' : ''}" data-tf="all">All</button>`]
    .concat(TASK_TYPES.map(t => `<button type="button" class="tt-chip${admCalFilter === t.key ? ' active' : ''}" data-tf="${t.key}">${calTypeChipLabel(t.key)}</button>`))
  return `<div class="tt-cal-filter"><div class="tt-chip-row">${chips.join('')}</div></div>`
}

// The pill at the top of the page - shows the whole period's total by
// default, or (the key interaction) the tapped day's total once one is
// selected, with a label that says which.
function admCalTotalLineHtml(periodTotal, dayMap) {
  let val = periodTotal
  let label = admCalView === 'month' ? 'this month' : admCalView === 'week' ? 'this week' : 'this day'
  if (admCalSelectedDay && admCalView !== 'day') {
    val = dayMap.get(admCalSelectedDay) || 0
    const dt = calDateFromKey(admCalSelectedDay)
    label = `on ${CAL_DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${CAL_MONTHS_SHORT[dt.getMonth()]}`
  }
  const filterSuffix = admCalFilter !== 'all' ? ` · ${escapeHtml(taskTypeLabel(admCalFilter)?.title || '')}` : ''
  return `<div class="adm-cal-total" role="button" tabindex="0" data-action="adm-cal-open-lb"><span class="v">${formatScore(val)}</span><span class="k">🍕 pizzas ${label}${filterSuffix}</span><span class="adm-cal-total-chev" aria-hidden="true">›</span></div>`
}

async function renderAdminPizzasCal() {
  if (!isAdmin()) { renderSettings(); return }
  // "Today" anchors on the SGT calendar date, not the device's local date -
  // see the sgt* helpers near nextMondayLabel().
  const { y: todayY, mo: todayMo, day: todayDay } = sgtDateParts(new Date())
  const todayKey = calKey(todayY, todayMo, todayDay)
  if (admCalY === null) { admCalY = todayY; admCalMo = todayMo }
  if (admCalWeekKey === null) admCalWeekKey = todayKey
  if (admCalDayKey === null) admCalDayKey = todayKey

  const range = admCalView === 'month' ? admCalMonthRange() : admCalView === 'week' ? admCalWeekRange() : admCalDayRange()
  const dayMap = await admCalFetchDayTotals(range.start, range.end)

  let navLabel, bodyHtml, periodTotal, legendHtml = ''
  if (admCalView === 'month') {
    navLabel = `${CAL_MONTHS[admCalMo]} ${admCalY}`
    bodyHtml = admCalMonthBodyHtml(dayMap, todayKey)
    periodTotal = [...dayMap.values()].reduce((s, v) => s + v, 0)
    legendHtml = `<div class="cal-legend"><span>Less 🍕</span>
      <span class="cal-legend-sw"></span><span class="cal-legend-sw cal-i1"></span>
      <span class="cal-legend-sw cal-i2"></span><span class="cal-legend-sw cal-i3"></span>
      <span class="cal-legend-sw cal-i4"></span><span>More 🍕</span></div>`
  } else if (admCalView === 'week') {
    const { days } = range
    const first = days[0], last = days[6]
    navLabel = (first.getMonth() === last.getMonth())
      ? `${first.getDate()}–${last.getDate()} ${CAL_MONTHS_SHORT[first.getMonth()]}`
      : `${first.getDate()} ${CAL_MONTHS_SHORT[first.getMonth()]} – ${last.getDate()} ${CAL_MONTHS_SHORT[last.getMonth()]}`
    bodyHtml = admCalWeekBodyHtml(days, todayKey, dayMap)
    periodTotal = days.reduce((s, d) => s + (dayMap.get(calKeyFromDate(d)) || 0), 0)
  } else {
    const dt = calDateFromKey(admCalDayKey)
    navLabel = `${CAL_DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${CAL_MONTHS[dt.getMonth()]}`
    periodTotal = dayMap.get(admCalDayKey) || 0
    bodyHtml = admCalDayBodyHtml(periodTotal)
  }

  // Mirrors admCalTotalLineHtml()'s own val/label logic exactly, so the
  // leaderboard sheet (triggered by tapping that same total card) always
  // ranks chefs over precisely the range the card is displaying - including
  // a pinned single day within Month/Week view.
  if (admCalSelectedDay && admCalView !== 'day') {
    const dt = calDateFromKey(admCalSelectedDay)
    admCalLbRange = { start: sgtDateFromYMD(dt.getFullYear(), dt.getMonth(), dt.getDate()), end: sgtDateFromYMD(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1) }
    admCalLbTitle = `${CAL_DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${CAL_MONTHS[dt.getMonth()]}`
  } else if (admCalView === 'month') {
    admCalLbRange = { start: range.start, end: range.end }
    admCalLbTitle = navLabel
  } else if (admCalView === 'week') {
    const first = range.days[0]
    admCalLbRange = { start: range.start, end: range.end }
    admCalLbTitle = `Week of ${first.getDate()} ${CAL_MONTHS_SHORT[first.getMonth()]}`
  } else {
    admCalLbRange = { start: range.start, end: range.end }
    admCalLbTitle = navLabel
  }

  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Pizzas Baked</h2><span class="meta">All chefs · totals only</span></div>
    <div class="cal-seg" id="adm-cal-seg">
      <button type="button" class="${admCalView === 'month' ? 'on' : ''}" data-v="month">Month</button>
      <button type="button" class="${admCalView === 'week' ? 'on' : ''}" data-v="week">Week</button>
      <button type="button" class="${admCalView === 'day' ? 'on' : ''}" data-v="day">Day</button>
    </div>
    <div class="cal-navbar">
      <button class="cal-chev" type="button" data-action="adm-cal-prev">‹</button>
      <div class="cal-navlabel">${navLabel}</div>
      <button class="cal-chev" type="button" data-action="adm-cal-next">›</button>
    </div>
    ${admCalTotalLineHtml(periodTotal, dayMap)}
    <p class="glab" style="margin-top:1.125rem">Filter by task type</p>
    ${admCalFilterChipsHtml()}
    <div class="cal-viewbody">${bodyHtml}</div>
    ${legendHtml}
    <p class="adm-cal-note">Totals only — individual chefs' tasks aren't shown here.</p>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => admWireCal(), { key: 'admin-pizzas-cal' })
}

function admCalStep(delta) {
  admCalSelectedDay = null
  if (admCalView === 'month') {
    admCalMo += delta
    if (admCalMo < 0) { admCalMo = 11; admCalY-- } else if (admCalMo > 11) { admCalMo = 0; admCalY++ }
  } else if (admCalView === 'week') {
    const dt = calDateFromKey(admCalWeekKey); dt.setDate(dt.getDate() + delta * 7); admCalWeekKey = calKeyFromDate(dt)
  } else {
    const dt = calDateFromKey(admCalDayKey); dt.setDate(dt.getDate() + delta); admCalDayKey = calKeyFromDate(dt)
  }
  renderAdminPizzasCal()
}

function admWireCal() {
  app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
  app.querySelectorAll('#adm-cal-seg button').forEach(b => {
    b.addEventListener('click', () => {
      if (b.dataset.v === admCalView) return
      admCalView = b.dataset.v
      admCalSelectedDay = null
      renderAdminPizzasCal()
    })
  })
  app.querySelector('[data-action="adm-cal-prev"]')?.addEventListener('click', () => admCalStep(-1))
  app.querySelector('[data-action="adm-cal-next"]')?.addEventListener('click', () => admCalStep(1))
  app.querySelectorAll('.tt-cal-filter .tt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      admCalFilter = chip.dataset.tf
      renderAdminPizzasCal()
    })
  })
  // Tapping a day (month cell or week row) pins the top total to that day;
  // tapping the same day again clears it back to the period total.
  app.querySelectorAll('[data-day]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.day
      admCalSelectedDay = admCalSelectedDay === key ? null : key
      renderAdminPizzasCal()
    })
  })
  const openLb = app.querySelector('[data-action="adm-cal-open-lb"]')
  openLb?.addEventListener('click', admOpenCalLbSheet)
  openLb?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); admOpenCalLbSheet() } })
}

// =================================================================
//  Admin: per-chef leaderboard sheet, opened by tapping the Pizzas Baked
//  calendar's total card. Ranks every chef over exactly the range the total
//  card is currently showing (admCalLbRange/admCalLbTitle, set fresh by
//  renderAdminPizzasCal() on every render) - see admFetchPerChefTotals(),
//  the generalized {start,end}-range version of loadAdminWeeklyLeaderboard's
//  profiles+sessions join.
function admOpenCalLbSheet() {
  shellEl()?.insertAdjacentHTML('beforeend', `
    <div class="cal-scrim adm-lb-scrim" id="adm-lb-scrim"></div>
    <div class="cal-sheet adm-lb-sheet" id="adm-lb-sheet">
      <div class="cal-grab" id="adm-lb-grab"></div>
      <div class="cal-sheet-hd"><h3 id="adm-lb-sheet-title">${escapeHtml(admCalLbTitle)}</h3></div>
      <div class="adm-search-card" style="margin:0 1.25rem 0.75rem">
        <span class="adm-search-ic" aria-hidden="true">🔍</span>
        <input id="adm-cal-lb-search" type="text" placeholder="Search chefs" autocomplete="off" />
      </div>
      <div class="cal-sheet-list" id="adm-cal-lb-list"><p class="log-empty">Loading&hellip;</p></div>
    </div>
  `)
  const scrim = app.querySelector('#adm-lb-scrim')
  const sheet = app.querySelector('#adm-lb-sheet')
  requestAnimationFrame(() => { scrim.classList.add('show'); sheet.classList.add('show') })
  scrim.addEventListener('click', admCloseCalLbSheet)
  admWireCalLbSheetDrag(sheet)
  app.querySelector('#adm-cal-lb-search').addEventListener('input', (e) => admRenderCalLbList(e.target.value))
  admLoadCalLbSheet()
}

function admCloseCalLbSheet() {
  app.querySelector('#adm-lb-scrim')?.classList.remove('show')
  app.querySelector('#adm-lb-sheet')?.classList.remove('show')
  setTimeout(() => {
    app.querySelector('#adm-lb-scrim')?.remove()
    app.querySelector('#adm-lb-sheet')?.remove()
  }, 260)
}

// Drag-to-dismiss, identical mechanics to calWireSheetDrag() above.
function admWireCalLbSheetDrag(sheet) {
  if (!sheet) return
  const wire = (handle) => {
    if (!handle) return
    handle.style.touchAction = 'none'
    let startY = 0, dy = 0, dragging = false
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; dy = 0
      sheet.style.transition = 'none'
      try { handle.setPointerCapture(e.pointerId) } catch {}
    })
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return
      dy = Math.max(0, e.clientY - startY)
      sheet.style.transform = `translateY(${dy}px)`
    })
    const end = () => {
      if (!dragging) return
      dragging = false
      sheet.style.transition = ''
      sheet.style.transform = ''
      if (dy > Math.min(120, (sheet.offsetHeight || 400) * 0.25)) admCloseCalLbSheet()
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  wire(app.querySelector('#adm-lb-grab'))
  wire(app.querySelector('.adm-lb-sheet .cal-sheet-hd'))
}

let admCalLbCache = [] // [{ id, display_name, avatar_url, pizzas }] for the currently-open sheet's range+filter

async function admLoadCalLbSheet() {
  const listEl = app.querySelector('#adm-cal-lb-list')
  if (!admCalLbRange) { if (listEl) listEl.innerHTML = '<p class="log-empty">Nothing to show.</p>'; return }
  admCalLbCache = await admFetchPerChefTotals(admCalLbRange.start, admCalLbRange.end, admCalFilter === 'all' ? null : admCalFilter)
  admRenderCalLbList(app.querySelector('#adm-cal-lb-search')?.value || '')
}

function admRenderCalLbList(filter) {
  const listEl = app.querySelector('#adm-cal-lb-list')
  if (!listEl) return
  const q = (filter || '').trim().toLowerCase()
  const list = q ? admCalLbCache.filter(p => (p.display_name || '').toLowerCase().includes(q)) : admCalLbCache
  if (!admCalLbCache.length) { listEl.innerHTML = '<p class="log-empty">No chefs yet.</p>'; return }
  if (!list.length) { listEl.innerHTML = '<p class="log-empty">No chefs match that search.</p>'; return }
  // Same non-zero-first ranking rule as the Chefs-page/dashboard leaderboard.
  const ranked = [...list].sort((a, b) => (b.pizzas - a.pizzas) || (a.display_name || '').localeCompare(b.display_name || ''))
  listEl.innerHTML = ranked.map((p, i) => adminWeeklyLeaderboardRowHtml(p, i)).join('')
}

// =================================================================
//  Admin: Weekly/Daily Leaderboard (opened from the "Pizzas baked today" tile)
// =================================================================
// Every chef, ranked by pizzas baked - modeled closely on the Chefs-page
// Weekly Leaderboard (chefsMemberRowHtml/.frow et al) so it feels native,
// but scoped to all chefs rather than just friends/a group, with a name
// search since the full roster can be long, and two tabs (Weekly/Daily)
// sharing that same search + row treatment. Defaults to the Weekly tab on
// open, matching the screen's original (pre-tabs) behavior.
//
// The KPI tile that opens this screen still shows "Pizzas baked today" (a
// real today number, see admStartOfDay/loadAdminDashboardStats) regardless
// of which tab is active here - that's intentional, not a bug.
let admLbCache = { week: [], day: [] } // { week: [{ id, display_name, avatar_url, pizzas }], day: [...] }
let admLbTab = 'week' // 'week' | 'day' - which tab is active; defaults to Weekly on open (matches prior behavior)

function renderAdminWeeklyLeaderboard() {
  if (!isAdmin()) { renderSettings(); return }
  admLbTab = 'week'
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Leaderboard</h2><span class="meta" id="adm-lb-meta">Resets&nbsp;${nextMondayLabel()}</span></div>
    <div class="cal-seg cal-seg-2" id="adm-lb-seg">
      <button type="button" class="on" data-v="week">Weekly</button>
      <button type="button" data-v="day">Daily</button>
    </div>
    <div class="admin-dash">
      <div class="group" style="margin-top:0">
        <div class="adm-search-card">
          <span class="adm-search-ic" aria-hidden="true">🔍</span>
          <input id="adm-lb-search" type="text" placeholder="Search chefs" autocomplete="off" />
        </div>
        <div id="adm-lb-list"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    app.querySelector('#adm-lb-search').addEventListener('input', (e) => renderAdminWeeklyLeaderboardList(e.target.value))
    app.querySelectorAll('#adm-lb-seg button').forEach(b => {
      b.addEventListener('click', () => {
        if (b.dataset.v === admLbTab) return
        admLbTab = b.dataset.v
        app.querySelectorAll('#adm-lb-seg button').forEach(x => x.classList.toggle('on', x === b))
        const meta = app.querySelector('#adm-lb-meta')
        if (meta) meta.textContent = admLbTab === 'week' ? `Resets ${nextMondayLabel()}` : 'Today so far'
        renderAdminWeeklyLeaderboardList(app.querySelector('#adm-lb-search')?.value || '')
      })
    })
    loadAdminWeeklyLeaderboard()
  }, { key: 'admin-weekly-leaderboard' })
}

// Every chef's summed pizzas over an arbitrary [start, endExclusive) range
// (optionally narrowed to one task-type), joined against `profiles` -
// generalizes the week-start/day-start-only query this function used to run
// inline so it also covers a full calendar MONTH (see admOpenCalLbSheet /
// admLoadCalLbSheet, the Pizzas Baked calendar's per-chef leaderboard sheet).
// Falls back to a type-less query (like admCalFetchDayTotals) if the `type`
// column doesn't exist yet.
async function admFetchPerChefTotals(start, endExclusive, typeFilter = null) {
  const [profRes, sessRes] = await Promise.all([
    supabase.from('profiles').select('id, display_name, avatar_url').order('display_name', { ascending: true }).limit(1000),
    (async () => {
      // Needs "admin can view all sessions" (see migration_admin_sessions.sql) -
      // until that's run, RLS quietly limits this to the admin's own (+
      // friends') sessions, so totals under-count rather than erroring.
      const range = (q) => q.gte('completed_at', start.toISOString()).lt('completed_at', endExclusive.toISOString())
      if (typeFilter && admCalTypeColOk) {
        const r = await range(supabase.from('sessions').select('user_id, pizzas, type')).eq('type', typeFilter)
        if (!r.error) return r
        admCalTypeColOk = false
      }
      return range(supabase.from('sessions').select('user_id, pizzas'))
    })(),
  ])
  if (profRes.error) return []
  const sumByUser = new Map()
  ;(sessRes.data || []).forEach(r => sumByUser.set(r.user_id, (sumByUser.get(r.user_id) || 0) + Number(r.pizzas)))
  return (profRes.data || []).map(p => ({ ...p, pizzas: sumByUser.get(p.id) || 0 }))
}

async function loadAdminWeeklyLeaderboard() {
  const listEl = app.querySelector('#adm-lb-list')
  if (listEl) listEl.innerHTML = '<p class="log-empty">Loading&hellip;</p>'
  const weekStart = sgtStartOfWeek(new Date())
  const dayStart = sgtStartOfDay(new Date())
  const farFuture = new Date(Date.now() + 100 * 365 * 86400000)
  const [week, day] = await Promise.all([
    admFetchPerChefTotals(weekStart, farFuture),
    admFetchPerChefTotals(dayStart, farFuture),
  ])
  if (!week.length && !day.length) {
    if (listEl) listEl.innerHTML = '<p class="log-empty">No chefs yet.</p>'
    return
  }
  admLbCache = { week, day }
  renderAdminWeeklyLeaderboardList(app.querySelector('#adm-lb-search')?.value || '')
}

function renderAdminWeeklyLeaderboardList(filter) {
  const listEl = app.querySelector('#adm-lb-list')
  if (!listEl) return
  const cache = admLbCache[admLbTab] || []
  const q = (filter || '').trim().toLowerCase()
  const list = q ? cache.filter(p => (p.display_name || '').toLowerCase().includes(q)) : cache
  if (!cache.length) { listEl.innerHTML = '<p class="log-empty">No chefs yet.</p>'; return }
  if (!list.length) { listEl.innerHTML = '<p class="log-empty">No chefs match that search.</p>'; return }
  // Non-zero bakers first (ranked highest-to-lowest), then everyone else
  // alphabetically - so a 0-pizza search hit is still findable, but the
  // ranked list up top isn't diluted with a wall of zeroes.
  const ranked = [...list].sort((a, b) => (b.pizzas - a.pizzas) || (a.display_name || '').localeCompare(b.display_name || ''))
  listEl.innerHTML = ranked.map((p, i) => adminWeeklyLeaderboardRowHtml(p, i)).join('')
}

function adminWeeklyLeaderboardRowHtml(p, i) {
  const rank = (p.pizzas > 0 && i < 3) ? `<div class="medal">${['🥇', '🥈', '🥉'][i]}</div>` : `<div class="rank">${i + 1}</div>`
  return `
    <div class="frow" style="cursor:default">
      ${rank}
      <img src="${p.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="finfo">
        <div class="chefs-fn-row"><span class="fn">${escapeHtml(chefName(p.display_name))}</span></div>
        <div class="chefs-meta-row"><span class="chefs-score">🍕 ${formatScore(p.pizzas)}</span></div>
      </div>
    </div>`
}

// The dashboard's one-line "Reports and Blocks" summary AND the Moderation
// Center's segmented-control counts share this: pending reports = open
// queue size; new blocks = blocks created after this admin's last visit to
// the Blocks tab (admin_meta.blocks_seen_at - everything is "new" if that
// row doesn't exist yet).
async function fetchModerationCounts() {
  const [{ count: openReports }, metaRes] = await Promise.all([
    supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('admin_meta').select('blocks_seen_at').eq('admin_id', currentUser.id).maybeSingle(),
  ])
  let blocksQuery = supabase.from('blocked_users').select('id', { count: 'exact', head: true })
  if (metaRes.data?.blocks_seen_at) blocksQuery = blocksQuery.gt('created_at', metaRes.data.blocks_seen_at)
  const { count: newBlocks } = await blocksQuery
  return { openReports: openReports || 0, newBlocks: newBlocks || 0 }
}

async function loadModSummary() {
  const pill = app.querySelector('#mod-count-pill')
  const sub = app.querySelector('#mod-sub')
  if (!pill && !sub) return
  const { openReports, newBlocks } = await fetchModerationCounts()
  if (pill) { pill.textContent = `${openReports} report${openReports === 1 ? '' : 's'}`; pill.hidden = !openReports }
  if (sub) sub.textContent = `${openReports} pending report${openReports === 1 ? '' : 's'} · ${newBlocks} new block${newBlocks === 1 ? '' : 's'}`
}

// Dashboard row breakdown mirroring the Bug Reports tabs: untriaged Open vs.
// In Progress (sent to Claude). Both exclude resolved/dismissed. Falls back to
// a single "unresolved" count if the sent_to_claude_at column isn't there yet
// (pre-migration_bug_claude.sql).
async function loadBugSummary() {
  const pill = app.querySelector('#bug-count-pill')
  const sub = app.querySelector('#bug-sub')
  if (!pill && !sub) return
  const base = () => supabase.from('bug_reports').select('id', { count: 'exact', head: true }).not('status', 'in', '(resolved,dismissed)')
  const [openRes, progRes] = await Promise.all([
    base().is('sent_to_claude_at', null),
    base().not('sent_to_claude_at', 'is', null),
  ])
  if (openRes.error || progRes.error) {
    // Column missing / query unsupported — fall back to the combined count.
    const { count, error } = await base()
    const n = error ? 0 : (count || 0)
    if (pill) { pill.textContent = `${n} unresolved`; pill.hidden = !n }
    if (sub) sub.textContent = `${n} unresolved report${n === 1 ? '' : 's'}`
    return
  }
  const openN = openRes.count || 0
  const progN = progRes.count || 0
  if (pill) { pill.textContent = `${openN} open`; pill.hidden = !openN }
  if (sub) sub.textContent = `${openN} open · ${progN} sent to Claude`
}

// Removes a report row that just got resolved (warned or dismissed) from
// whichever Moderation Center list is currently mounted, decrements the
// Reports segment count, and swaps in the empty state if the queue is now
// empty. Shared by dismissReportInCenter() and openWarnUserPopup() above.
function removeResolvedReportRow(reportId) {
  const row = app.querySelector(`.adm-mod-row[data-report-id="${cssEscape(reportId)}"]`)
  row?.remove()
  bumpSegCount('seg-reports-n', -1)
  const body = app.querySelector('#mod-body')
  if (body && !body.querySelector('.adm-mod-row')) body.innerHTML = '<p class="editpic-empty">No open reports. Nice and quiet. 🐧</p>'
}

function bumpSegCount(id, delta) {
  const el = document.getElementById(id)
  if (!el) return
  // Goes through setSegBadge so decrementing the last one to 0 removes the
  // badge instead of leaving a "0" sitting there.
  setSegBadge(id, Math.max(0, (parseInt(el.textContent, 10) || 0) + delta))
}

// CSS.escape isn't available in every test/SSR-ish environment this file
// might run under - a tiny inline fallback keeps the selector safe either way.
function cssEscape(s) { return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&') }

// =================================================================
//  Moderation Center (admin-only) - renderModerationCenter()
//  Reports (open queue) / Blocks (read-only, "new" flagged) / History (log)
// =================================================================
function calFmtShortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

let modCurrentTab = 'reports'

function renderModerationCenter(tab = 'reports') {
  if (!isAdmin()) { renderSettings(); return }
  modCurrentTab = tab
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Reports &amp; Blocks</h2></div>
    <div class="seg" id="mod-seg">
      <span data-seg="reports" class="${tab === 'reports' ? 'on' : ''}">Reports<span class="seg-badge" id="seg-reports-n" hidden></span></span>
      <span data-seg="blocks" class="${tab === 'blocks' ? 'on' : ''}">Blocks<span class="seg-badge" id="seg-blocks-n" hidden></span></span>
      <span data-seg="history" class="${tab === 'history' ? 'on' : ''}">History</span>
    </div>
    <div id="mod-body"><p class="editpic-empty">Loading&hellip;</p></div>
    <div style="height:8px"></div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    app.querySelectorAll('#mod-seg [data-seg]').forEach(btn => {
      btn.addEventListener('click', () => switchModTab(btn.dataset.seg))
    })
    loadModSegCounts()
    switchModTab(tab)
  }, { key: 'moderation' })
}

async function loadModSegCounts() {
  const { openReports, newBlocks } = await fetchModerationCounts()
  setSegBadge('seg-reports-n', openReports)
  setSegBadge('seg-blocks-n', newBlocks)
}

function switchModTab(tab) {
  modCurrentTab = tab
  app.querySelectorAll('#mod-seg [data-seg]').forEach(el => el.classList.toggle('on', el.dataset.seg === tab))
  if (tab === 'reports') loadModReportsTab()
  else if (tab === 'blocks') loadModBlocksTab()
  else loadModHistoryTab()
}

// ---------- Reports tab: the open queue ----------
async function loadModReportsTab() {
  const body = app.querySelector('#mod-body')
  if (!body) return
  body.innerHTML = '<p class="editpic-empty">Loading&hellip;</p>'
  const { data, error } = await supabase
    .from('reports')
    .select('id, reason, details, created_at, reported_id, reporter:reporter_id(display_name), reported:reported_id(display_name)')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(100)
  if (modCurrentTab !== 'reports') return // tab switched away while this was in flight
  if (error) { body.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) { body.innerHTML = '<p class="editpic-empty">No open reports. Nice and quiet. 🐧</p>'; return }
  body.innerHTML = `<div class="adm-mod-list">${data.map(r => {
    const reportedName = chefName(r.reported?.display_name)
    return `
    <div class="adm-mod-row" data-report-id="${escapeHtml(r.id)}">
      <div class="adm-mod-head">
        <span class="adm-mod-reason">🚩 ${escapeHtml(r.reason)}</span>
        <span class="adm-mod-chip open">● Open</span>
      </div>
      <div class="adm-mod-who">${escapeHtml(chefName(r.reporter?.display_name))} <span class="adm-mod-arrow">reported</span> ${escapeHtml(reportedName)} · ${calFmtShortDate(r.created_at)}</div>
      ${r.details ? `<div class="adm-mod-details">${escapeHtml(r.details)}</div>` : ''}
      <div class="adm-mod-actions">
        <button type="button" class="adm-mod-btn warn" data-action="warn" data-reported="${escapeHtml(r.reported_id)}" data-name="${escapeHtml(reportedName)}">⚠️ Warn ${escapeHtml(reportedName)}</button>
        <button type="button" class="adm-mod-btn dismiss" data-action="dismiss">Dismiss</button>
      </div>
    </div>`
  }).join('')}</div>`
  body.querySelectorAll('[data-action="dismiss"]').forEach(btn => {
    btn.addEventListener('click', () => dismissReportInCenter(btn.closest('.adm-mod-row')))
  })
  body.querySelectorAll('[data-action="warn"]').forEach(btn => {
    const row = btn.closest('.adm-mod-row')
    btn.addEventListener('click', () => openWarnUserPopup(btn.dataset.reported, btn.dataset.name, row.dataset.reportId))
  })
}

async function dismissReportInCenter(rowEl) {
  const id = rowEl?.dataset.reportId
  if (!id) return
  const { error } = await supabase.rpc('dismiss_report', { report_id: id })
  if (error) { toast(error.message); return }
  toast('Report dismissed')
  removeResolvedReportRow(id)
}

// ---------- Blocks tab: read-only context, flags new ones ----------
async function loadModBlocksTab() {
  const body = app.querySelector('#mod-body')
  if (!body) return
  body.innerHTML = '<p class="editpic-empty">Loading&hellip;</p>'
  // Read blocks_seen_at BEFORE marking seen below, so rows added since the
  // admin's last visit here still render with the "New" chip this time.
  const { data: meta } = await supabase.from('admin_meta').select('blocks_seen_at').eq('admin_id', currentUser.id).maybeSingle()
  const seenAt = meta?.blocks_seen_at ? new Date(meta.blocks_seen_at) : null
  const { data, error } = await supabase
    .from('blocked_users')
    .select('id, created_at, blocked_name, blocker:blocker_id(display_name), blocked:blocked_id(display_name)')
    .order('created_at', { ascending: false })
    .limit(100)
  if (modCurrentTab !== 'blocks') return
  if (error) { body.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) {
    body.innerHTML = '<p class="editpic-empty">No blocks yet.</p>'
    // Still mark seen so the behaviour matches the non-empty case (count is
    // already 0 here, but this keeps the "opening this tab marks blocks as
    // seen" contract honest).
    await supabase.rpc('mark_blocks_seen')
    return
  }
  body.innerHTML = `<div class="adm-mod-list">${data.map(b => {
    const isNew = !seenAt || new Date(b.created_at) > seenAt
    return `
    <div class="adm-mod-row">
      <div class="adm-mod-head">
        <span class="adm-mod-reason">🚫 Block</span>
        ${isNew ? '<span class="adm-mod-chip new">New</span>' : `<span class="adm-mod-date">${calFmtShortDate(b.created_at)}</span>`}
      </div>
      <div class="adm-mod-who">${escapeHtml(chefName(b.blocker?.display_name))} <span class="adm-mod-arrow">blocked</span> ${escapeHtml(chefName(b.blocked?.display_name || b.blocked_name))} · ${calFmtShortDate(b.created_at)}</div>
    </div>`
  }).join('')}</div>
  <p class="mod-blocks-note">Opening this tab marks blocks as seen — the dashboard "new blocks" count clears to 0.</p>`
  const { error: seenError } = await supabase.rpc('mark_blocks_seen')
  if (!seenError) setSegBadge('seg-blocks-n', 0)
}

// ---------- History tab: a client-side merge of 3 admin-visible queries ----------
async function loadModHistoryTab() {
  const body = app.querySelector('#mod-body')
  if (!body) return
  body.innerHTML = '<p class="editpic-empty">Loading&hellip;</p>'
  const [reportsRes, warningsRes] = await Promise.all([
    supabase.from('reports').select('id, reason, resolution, status, resolved_at, reported:reported_id(display_name)').neq('status', 'open').order('resolved_at', { ascending: false }).limit(100),
    supabase.from('warnings').select('id, message, created_at, acknowledged_at, report_id, user:user_id(display_name)').order('created_at', { ascending: false }).limit(100),
  ])
  if (modCurrentTab !== 'history') return
  const err = reportsRes.error || warningsRes.error
  if (err) { body.innerHTML = `<p class="editpic-empty">${escapeHtml(err.message)}</p>`; return }

  const entries = []
  // A report that ended in 'actioned' is already fully represented by its
  // linked warning entry below (same event, admin's point of view) - only
  // 'dismissed' reports get their own log line. Dismissed reports aren't
  // "messages" - nothing was ever sent to a user - so they get no unsend.
  ;(reportsRes.data || []).forEach(r => {
    if (r.status !== 'dismissed') return
    const targetName = chefName(r.reported?.display_name)
    entries.push({
      ts: r.resolved_at, icon: '✕', cls: 'dismiss',
      title: `Dismissed report on <b>${escapeHtml(targetName)}</b>`,
      sub: `${escapeHtml(r.reason)}${r.resolution ? ` · "${escapeHtml(r.resolution)}"` : ''}`,
      key: `dismiss-${r.id}`,
    })
  })
  ;(warningsRes.data || []).forEach(w => {
    const targetName = chefName(w.user?.display_name)
    const source = w.report_id ? 'from report' : 'direct'
    const ack = w.acknowledged_at ? 'acknowledged ✓' : 'not yet acknowledged'
    entries.push({
      ts: w.created_at, icon: '⚠️', cls: 'warn',
      title: `Warned <b>${escapeHtml(targetName)}</b> <span class="adm-log-tag">· ${source}</span>`,
      sub: `"${escapeHtml(w.message)}" · ${ack}`,
      key: `warn-${w.id}`,
      unsend: { kind: 'warn', id: w.id },
    })
  })
  // Sent notifications no longer appear here - they moved to their own
  // "Sent" tab on the Notifications screen (see loadSentNotifications() /
  // renderComposeNotification()), which also shows read counts. History is
  // now strictly dismissed reports + warnings.

  entries.sort((a, b) => new Date(b.ts) - new Date(a.ts))
  const capped = entries.slice(0, 100)
  if (!capped.length) { body.innerHTML = '<p class="editpic-empty">No moderation history yet.</p>'; return }
  body.innerHTML = `<div class="adm-log-list">${capped.map(e => `
    <div class="adm-log" data-entry-key="${escapeHtml(e.key)}">
      <div class="adm-log-ic ${e.cls}">${e.icon}</div>
      <div class="adm-log-mid">
        <div class="adm-log-lt">${e.title}</div>
        <div class="adm-log-ls">${e.sub}</div>
      </div>
      <div class="adm-log-right">
        <div class="adm-log-ts">${calFmtShortDate(e.ts)}</div>
        ${e.unsend ? `<button type="button" class="adm-log-unsend" data-action="unsend" data-kind="${e.unsend.kind}" data-id="${escapeHtml(e.unsend.id)}">Unsend</button>` : ''}
      </div>
    </div>
  `).join('')}</div>`
  body.querySelectorAll('[data-action="unsend"]').forEach(btn => {
    btn.addEventListener('click', () => confirmUnsendHistoryEntry(btn.dataset.kind, btn.dataset.id, btn.closest('.adm-log')))
  })
}

// Unsend = permanent delete (see migration_unsend_messages.sql's
// unsend_system_notifications / unsend_warning RPCs). Destructive, so it
// gets the same confirm-popup treatment as block/delete-account elsewhere.
function confirmUnsendHistoryEntry(kind, id, rowEl) {
  const isWarn = kind === 'warn'
  const o = overlay(`
    <h3>Unsend this ${isWarn ? 'warning' : 'message'}?</h3>
    <p>It will be removed for everyone who received it and disappear from their records. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Unsend</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const btn = o.querySelector('[data-action="yes"]')
    btn.disabled = true
    const { error } = isWarn
      ? await supabase.rpc('unsend_warning', { p_warning_id: id })
      : await supabase.rpc('unsend_system_notifications', { p_batch_id: id })
    if (error) { btn.disabled = false; toast(error.message); return }
    o.remove()
    toast(isWarn ? 'Warning unsent' : 'Message unsent')
    rowEl?.remove()
    const body = app.querySelector('#mod-body')
    if (body && modCurrentTab === 'history' && !body.querySelector('.adm-log')) {
      body.innerHTML = '<p class="editpic-empty">No moderation history yet.</p>'
    }
  })
}

// =================================================================
//  Compose a System Notification (admin-only) - renderComposeNotification()
//  Everyone (broadcast_system_notification) or Specific chefs
//  (send_system_notification), reusing the same profiles data the admin
//  user list already loads.
// =================================================================
let composeState = { audience: 'everyone', selectedIds: new Set(), usersCache: [] }

// Screen has two tabs: Compose (the form below, unchanged behaviour) and
// Sent (loadSentNotifications() - a history of past sends with read
// counts). Both tab bodies are rendered upfront and toggled with [hidden]
// rather than swapped in/out, so switching tabs never wipes an in-progress
// draft in the Compose form.
function renderComposeNotification() {
  if (!isAdmin()) { renderSettings(); return }
  composeState = { audience: 'everyone', selectedIds: new Set(), usersCache: [] }
  const content = `
    <div class="back-link" role="button" tabindex="0" data-action="back-to-admin">‹ Admin Dashboard</div>
    <div class="section-h" style="margin-top:2px"><h2>Notifications</h2></div>
    <div class="seg" id="compose-tab-seg">
      <span data-tab="compose" class="on">Compose</span>
      <span data-tab="sent">Sent</span>
    </div>

    <div id="compose-tab-compose">${composeFormHtml()}</div>
    <div id="compose-tab-sent" hidden>
      <div id="sent-list"><p class="editpic-empty">Loading&hellip;</p></div>
    </div>
  `
  mountScreen('settings', content, () => {
    app.querySelector('[data-action="back-to-admin"]').addEventListener('click', renderAdminDashboard)
    app.querySelectorAll('#compose-tab-seg [data-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchComposeTab(btn.dataset.tab))
    })
    wireComposeNotification()
  }, { key: 'compose' })
}

function composeFormHtml() {
  return `
    <p class="field-lab-standalone">Audience</p>
    <div class="seg" id="compose-audience-seg">
      <span data-aud="everyone" class="on">📣 Everyone</span>
      <span data-aud="specific">👤 Specific chefs</span>
    </div>
    <p class="aud-help" id="compose-aud-help">Goes to everyone. Appears in each chef's System Notifications.</p>

    <div id="compose-picker-wrap" hidden>
      <p class="field-lab-standalone" id="compose-recipients-lab">Recipients</p>
      <div class="compose-picker">
        <div class="picker-search"><span aria-hidden="true">🔍</span><input type="text" id="compose-search" placeholder="Search chefs by name or code…" /></div>
        <div class="chip-row" id="compose-chip-row"></div>
        <div class="u-opt-list" id="compose-user-list"><p class="editpic-empty">Loading&hellip;</p></div>
      </div>
    </div>

    <p class="field-lab-standalone">Title</p>
    <input class="compose-input" id="compose-title" type="text" maxlength="60" placeholder="e.g. Server maintenance tonight" />
    <p class="field-lab-standalone">Message</p>
    <textarea class="compose-input compose-textarea" id="compose-body" maxlength="300" placeholder="Write your announcement…"></textarea>

    <button class="send-big" type="button" id="compose-send" disabled>Send to everyone</button>
    <p class="recip-note" id="compose-recip-note"></p>
    <div style="height:8px"></div>
  `
}

// Tab bodies are both already in the DOM (see renderComposeNotification) -
// switching just toggles which one is visible, and kicks off a fresh Sent
// load each time that tab is opened so an admin sees any just-sent message.
function switchComposeTab(tab) {
  app.querySelectorAll('#compose-tab-seg [data-tab]').forEach(el => el.classList.toggle('on', el.dataset.tab === tab))
  const composeBody = app.querySelector('#compose-tab-compose')
  const sentBody = app.querySelector('#compose-tab-sent')
  if (composeBody) composeBody.hidden = tab !== 'compose'
  if (sentBody) sentBody.hidden = tab !== 'sent'
  if (tab === 'sent') loadSentNotifications()
}

function wireComposeNotification() {
  const segEl = app.querySelector('#compose-audience-seg')
  const pickerWrap = app.querySelector('#compose-picker-wrap')
  const audHelp = app.querySelector('#compose-aud-help')
  const titleEl = app.querySelector('#compose-title')
  const bodyEl = app.querySelector('#compose-body')
  const sendBtn = app.querySelector('#compose-send')
  const recipNote = app.querySelector('#compose-recip-note')
  let totalUsers = null

  async function loadTotalUserCount() {
    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true })
    totalUsers = count || 0
    updateEverything()
  }

  async function loadComposeUsers() {
    const { data, error } = await supabase.from('profiles').select('id, display_name, friend_code, avatar_url').order('display_name', { ascending: true }).limit(200)
    if (!error) composeState.usersCache = data || []
    renderUserOptions()
  }

  function renderUserOptions(filterText) {
    const listEl = app.querySelector('#compose-user-list')
    if (!listEl) return
    const q = (filterText || '').trim().toLowerCase()
    const list = q
      ? composeState.usersCache.filter(u => (u.display_name || '').toLowerCase().includes(q) || (u.friend_code || '').toLowerCase().includes(q))
      : composeState.usersCache
    if (!list.length) { listEl.innerHTML = '<p class="editpic-empty">No chefs found.</p>'; return }
    listEl.innerHTML = list.map(u => `
      <div class="u-opt" data-uid="${u.id}">
        <img class="u-opt-av" src="${u.avatar_url || DEFAULT_AVATAR}" alt="" />
        <div class="u-opt-info"><div class="u-opt-name">${escapeHtml(chefName(u.display_name))}</div><div class="u-opt-code">${escapeHtml(u.friend_code || '')}</div></div>
        <span class="u-opt-tick ${composeState.selectedIds.has(u.id) ? 'on' : ''}">✓</span>
      </div>
    `).join('')
    listEl.querySelectorAll('.u-opt').forEach(row => {
      row.addEventListener('click', () => toggleUser(row.dataset.uid))
    })
  }

  function toggleUser(id) {
    if (composeState.selectedIds.has(id)) composeState.selectedIds.delete(id)
    else composeState.selectedIds.add(id)
    renderChips()
    renderUserOptions(app.querySelector('#compose-search')?.value)
    updateEverything()
  }

  function renderChips() {
    const chipRow = app.querySelector('#compose-chip-row')
    if (!chipRow) return
    const byId = Object.fromEntries(composeState.usersCache.map(u => [u.id, u]))
    chipRow.innerHTML = [...composeState.selectedIds].map(id => `
      <span class="u-chip" data-uid="${id}">${escapeHtml(chefName(byId[id]?.display_name))}<span class="u-chip-x">✕</span></span>
    `).join('')
    chipRow.querySelectorAll('.u-chip').forEach(chip => {
      chip.addEventListener('click', () => toggleUser(chip.dataset.uid))
    })
    const lab = app.querySelector('#compose-recipients-lab')
    if (lab) lab.textContent = `Recipients${composeState.selectedIds.size ? ' · ' + composeState.selectedIds.size + ' selected' : ''}`
  }

  function updateEverything() {
    const title = titleEl.value.trim()
    const body = bodyEl.value.trim()
    const hasContent = title.length > 0 && body.length > 0
    if (composeState.audience === 'everyone') {
      sendBtn.textContent = 'Send to everyone'
      recipNote.textContent = totalUsers != null ? `Sends to ${totalUsers} chef${totalUsers === 1 ? '' : 's'} · can't be undone` : ''
      sendBtn.disabled = !hasContent || !totalUsers
    } else {
      const n = composeState.selectedIds.size
      sendBtn.textContent = `Send to ${n} chef${n === 1 ? '' : 's'}`
      const byId = Object.fromEntries(composeState.usersCache.map(u => [u.id, u]))
      recipNote.textContent = n ? [...composeState.selectedIds].map(id => chefName(byId[id]?.display_name)).join(', ') : ''
      sendBtn.disabled = !hasContent || n === 0
    }
  }

  segEl.querySelectorAll('[data-aud]').forEach(seg => {
    seg.addEventListener('click', () => {
      composeState.audience = seg.dataset.aud
      segEl.querySelectorAll('[data-aud]').forEach(s => s.classList.toggle('on', s === seg))
      const isEveryone = composeState.audience === 'everyone'
      pickerWrap.hidden = isEveryone
      audHelp.hidden = !isEveryone
      audHelp.textContent = totalUsers != null
        ? `Goes to all ${totalUsers} chefs. Appears in each one's System Notifications.`
        : `Goes to everyone. Appears in each chef's System Notifications.`
      updateEverything()
    })
  })

  titleEl.addEventListener('input', updateEverything)
  bodyEl.addEventListener('input', updateEverything)
  app.querySelector('#compose-search')?.addEventListener('input', (e) => renderUserOptions(e.target.value))

  sendBtn.addEventListener('click', async () => {
    const title = titleEl.value.trim().slice(0, 60)
    const body = bodyEl.value.trim().slice(0, 300)
    if (!title || !body) return
    sendBtn.disabled = true
    const { error } = composeState.audience === 'everyone'
      ? await supabase.rpc('broadcast_system_notification', { title, body })
      : await supabase.rpc('send_system_notification', { target_ids: [...composeState.selectedIds], title, body })
    if (error) { sendBtn.disabled = false; toast(error.message); return }
    toast('Notification sent')
    renderAdminDashboard()
  })

  loadTotalUserCount()
  loadComposeUsers()
  updateEverything()
}

// =================================================================
//  Sent tab - loadSentNotifications() / openSentNotificationDetail()
//  A history of past sends (one card per SEND, not per recipient), with
//  read counts and an Unsend action. Admin has an all-rows SELECT policy on
//  system_notifications (migration_system_notifications.sql).
// =================================================================
let sentNotifsCache = []

async function loadSentNotifications() {
  const listEl = app.querySelector('#sent-list')
  if (!listEl) return
  listEl.innerHTML = '<p class="editpic-empty">Loading&hellip;</p>'
  // Capped at the most recent rows. Since a send fans out to one row per
  // recipient, this is a per-row (not per-send) cap: newest sends are always
  // complete, but a card old enough to fall past the cap could undercount its
  // "X / Y read". 5000 is comfortable headroom at this app's scale (dozens of
  // chefs = dozens of rows per broadcast); if history ever grows past that,
  // move to a server-side per-batch aggregate RPC instead of pulling every
  // recipient row into the client.
  const { data, error } = await supabase
    .from('system_notifications')
    .select('id, title, body, created_at, batch_id, audience, read_at, user:user_id(display_name)')
    .order('created_at', { ascending: false })
    .limit(5000)
  if (!app.querySelector('#sent-list')) return // tab/screen changed while this was in flight
  if (error) { listEl.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }

  // A single send fans out into one row per recipient sharing one batch_id
  // (see migration_unsend_messages.sql) - group those back into one card per
  // SEND. Older rows that predate batch_id fall back to their own id, same
  // pattern as the Moderation History grouping this replaces.
  const groups = new Map()
  ;(data || []).forEach(n => {
    const key = n.batch_id || n.id
    if (!groups.has(key)) groups.set(key, { batchId: key, title: n.title, body: n.body, ts: n.created_at, audience: n.audience, total: 0, readCount: 0, recipients: [] })
    const g = groups.get(key)
    g.total += 1
    if (n.read_at) g.readCount += 1
    g.recipients.push({ name: chefName(n.user?.display_name), read_at: n.read_at })
  })
  sentNotifsCache = [...groups.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts))

  if (!sentNotifsCache.length) { listEl.innerHTML = '<p class="editpic-empty">You haven\'t sent any notifications yet.</p>'; return }
  listEl.innerHTML = `<div class="sent-card-list">${sentNotifsCache.map(sentCardHtml).join('')}</div>`
  wireSentCards(listEl)
}

// null audience means the send predates the audience column (see
// migration_sent_audience.sql) - treat it the same as 'specific', not
// 'everyone', since every pre-migration send here was to a chosen list.
function sentAudienceChip(g) {
  if (g.audience === 'everyone') return 'Everyone'
  const names = g.recipients.map(r => r.name)
  const shown = names.slice(0, 2).join(', ') + (names.length > 2 ? '…' : '')
  return `${g.total} chef${g.total === 1 ? '' : 's'}${shown ? ` · ${shown}` : ''}`
}

function truncateText(str, max) {
  const s = (str || '').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function sentCardHtml(g) {
  const pct = g.total ? Math.round((g.readCount / g.total) * 100) : 0
  return `
    <div class="sent-card" data-batch-id="${escapeHtml(g.batchId)}" role="button" tabindex="0">
      <div class="sent-card-top">
        <span class="sent-aud-chip">${escapeHtml(sentAudienceChip(g))}</span>
        <span class="sent-card-ts">${calFmtShortDate(g.ts)}</span>
      </div>
      <div class="sent-card-title">${escapeHtml(g.title)}</div>
      <div class="sent-card-body">${escapeHtml(truncateText(g.body, 90))}</div>
      <div class="sent-readstat">
        <span>${g.readCount} / ${g.total} read</span>
        <div class="sent-readbar"><i style="width:${pct}%"></i></div>
      </div>
      <button type="button" class="adm-log-unsend" data-action="unsend" data-batch="${escapeHtml(g.batchId)}">Unsend</button>
    </div>
  `
}

function wireSentCards(listEl) {
  listEl.querySelectorAll('.sent-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="unsend"]')) return
      const g = sentNotifsCache.find(x => x.batchId === card.dataset.batchId)
      if (g) openSentNotificationDetail(g)
    })
  })
  listEl.querySelectorAll('[data-action="unsend"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      confirmUnsendBatch(btn.dataset.batch, () => {
        btn.closest('.sent-card')?.remove()
        if (!app.querySelector('#sent-list .sent-card')) {
          const listEl2 = app.querySelector('#sent-list')
          if (listEl2) listEl2.innerHTML = '<p class="editpic-empty">You haven\'t sent any notifications yet.</p>'
        }
      })
    })
  })
}

// Unsend = permanent delete (unsend_system_notifications RPC, see
// migration_unsend_messages.sql) - destructive, so it gets the same
// confirm-popup treatment as elsewhere (e.g. confirmUnsendHistoryEntry).
// onSuccess lets the caller decide how to update its own view (remove a
// card from the list, or close the detail popup and refresh the list).
function confirmUnsendBatch(batchId, onSuccess) {
  const o = overlay(`
    <h3>Unsend this message?</h3>
    <p>It will be removed for everyone who received it and disappear from their records. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Unsend</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const btn = o.querySelector('[data-action="yes"]')
    btn.disabled = true
    const { error } = await supabase.rpc('unsend_system_notifications', { p_batch_id: batchId })
    if (error) { btn.disabled = false; toast(error.message); return }
    o.remove()
    toast('Message unsent')
    sentNotifsCache = sentNotifsCache.filter(g => g.batchId !== batchId)
    onSuccess?.()
  })
}

// Detail popup - modelled on openBlockedUsers/renderBlockedList: popup-wide,
// with a scrollable recipient list below the send's own summary.
function openSentNotificationDetail(group) {
  const pct = group.total ? Math.round((group.readCount / group.total) * 100) : 0
  const audienceLabel = group.audience === 'everyone' ? 'Everyone' : `${group.total} chef${group.total === 1 ? '' : 's'}`
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>${escapeHtml(group.title)}</h3>
    <p class="sent-detail-body">${escapeHtml(group.body)}</p>
    <div class="sent-detail-meta">
      <span>${escapeHtml(audienceLabel)}</span>
      <span>${calFmtShortDate(group.ts)}</span>
    </div>
    <div class="sent-readstat">
      <span>${group.readCount} / ${group.total} read</span>
      <div class="sent-readbar"><i style="width:${pct}%"></i></div>
    </div>
    <p class="field-lab-standalone" style="margin-top:1rem">Recipients</p>
    <div class="sent-recip-list" id="sent-recip-list">${group.recipients.map(r => `
      <div class="sent-recip-row">
        <span class="sent-recip-dot ${r.read_at ? 'read' : ''}"></span>
        <span class="sent-recip-name">${escapeHtml(r.name)}</span>
        <span class="sent-recip-when">${r.read_at ? `Read · ${calFmtShortDate(r.read_at)}` : 'Unread'}</span>
      </div>
    `).join('')}</div>
    <button type="button" class="btn-danger sent-detail-unsend" data-action="unsend" style="margin-top:1rem">Unsend</button>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="unsend"]').addEventListener('click', () => {
    confirmUnsendBatch(group.batchId, () => {
      o.remove()
      const card = app.querySelector(`.sent-card[data-batch-id="${cssEscape(group.batchId)}"]`)
      card?.remove()
      if (!app.querySelector('#sent-list .sent-card')) {
        const listEl = app.querySelector('#sent-list')
        if (listEl) listEl.innerHTML = '<p class="editpic-empty">You haven\'t sent any notifications yet.</p>'
      }
    })
  })
}

// reportId is optional - passed when warning is raised from a specific open
// report (Moderation Center), so warn_user() can resolve that one report to
// "actioned" in the same transaction. Omitted, it's just a direct warning.
function openWarnUserPopup(reportedId, name, reportId) {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Warn ${escapeHtml(name || 'this user')}</h3>
    <p>They'll see this as a warning popup next time they open the app.</p>
    <textarea id="warn-msg" class="rename-input report-details" maxlength="300" placeholder="Write your warning message&hellip;"></textarea>
    <div class="home-btn-col" style="margin-top:0.25rem">
      <button type="button" class="btn-danger" data-action="send" disabled>Send warning</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  const msgEl = o.querySelector('#warn-msg')
  const sendBtn = o.querySelector('[data-action="send"]')
  msgEl.addEventListener('input', () => { sendBtn.disabled = msgEl.value.trim().length < 3 })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  sendBtn.addEventListener('click', async () => {
    const message = msgEl.value.trim().slice(0, 300)
    if (message.length < 3) return
    sendBtn.disabled = true
    const { error } = await supabase.rpc('warn_user', { target_id: reportedId, message, report_id: reportId ?? null })
    if (error) { sendBtn.disabled = false; toast(error.message); return }
    o.remove()
    toast('Warning sent')
    // If this warning resolved a specific report, the Moderation Center's
    // Reports tab (if that's where we were called from) needs to drop the
    // row and decrement its live count, same as a Dismiss.
    if (reportId) removeResolvedReportRow(reportId)
  })
}

// ---------- admin: emote type tags + per-emote overrides ----------
function renderAdminEmoteTypes() {
  const tagsEl = app.querySelector('#adm-tags')
  if (tagsEl) {
    tagsEl.innerHTML = emoteTags.length
      ? emoteTags.map(t => `
          <span class="adm-tag-chip" data-tag-id="${t.id}">
            <button type="button" class="adm-tag-name" data-action="rename-tag">${escapeHtml(t.name)}</button>
            <button type="button" class="adm-tag-del" data-action="delete-tag" aria-label="Delete type">✕</button>
          </span>`).join('')
      : '<p class="editpic-empty">No types yet. Add one below.</p>'
    tagsEl.querySelectorAll('[data-action="rename-tag"]').forEach(b => b.addEventListener('click', () => {
      const chip = b.closest('.adm-tag-chip'); openRenameTagPopup(chip.dataset.tagId, b.textContent)
    }))
    tagsEl.querySelectorAll('[data-action="delete-tag"]').forEach(b => b.addEventListener('click', () => {
      const chip = b.closest('.adm-tag-chip'); confirmDeleteTag(chip.dataset.tagId, chip.querySelector('.adm-tag-name').textContent)
    }))
  }

  const listEl = app.querySelector('#adm-emote-list')
  if (listEl) {
    listEl.innerHTML = EMOTES.map(e => {
      const tagId = emoteTagId(e)
      const typeChip = tagId
        ? `<span class="adm-emote-type">${escapeHtml(tagNameById(tagId) || '—')}</span>`
        : `<span class="adm-emote-type none">No type</span>`
      // Emotes have no still thumbnail - only the clip - so the preview is a
      // muted video parked on its first frame (preload=metadata, never played).
      // Without it the admin is renaming/tagging rows by title alone with no
      // idea which animation they're actually looking at.
      return `
        <div class="adm-emote-row" data-emote-id="${e.id}" role="button" tabindex="0">
          <video class="adm-emote-thumb" src="${BASE}assets/${e.clip}#t=0.1" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>
          <div class="adm-emote-info"><div class="adm-emote-name">${escapeHtml(emoteName(e))}</div><div class="adm-emote-sub">${escapeHtml(emoteDesc(e))}</div></div>
          <div class="adm-emote-right">${typeChip}<span class="chevron" aria-hidden="true">›</span></div>
        </div>`
    }).join('')
    listEl.querySelectorAll('[data-emote-id]').forEach(row => {
      row.addEventListener('click', () => openEmoteEditPopup(EMOTE_BY_ID[row.dataset.emoteId]))
    })
  }
}

async function addEmoteTag() {
  const input = app.querySelector('#adm-new-tag')
  const name = input.value.trim().slice(0, 20)
  if (!name) return
  const { error } = await supabase.from('emote_tags').insert({ name })
  if (error) { toast(error.message); return }
  input.value = ''
  await loadEmoteData(true)
  renderAdminEmoteTypes()
}

function openRenameTagPopup(id, current) {
  const o = overlay(`
    <h3>Rename type</h3>
    <input id="rename-tag-input" class="rename-input" type="text" maxlength="20" value="${escapeHtml(current)}" />
    <div class="home-btn-col">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  const input = o.querySelector('#rename-tag-input')
  setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const name = input.value.trim().slice(0, 20)
    if (!name) return
    const { error } = await supabase.from('emote_tags').update({ name }).eq('id', id)
    if (error) { toast(error.message); return }
    o.remove()
    await loadEmoteData(true)
    renderAdminEmoteTypes()
  })
}

function confirmDeleteTag(id, name) {
  const o = overlay(`
    <h3>Delete "${escapeHtml(name)}"?</h3>
    <p>This type will be removed from any emotes using it. The emotes themselves aren't affected.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, delete</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    const { error } = await supabase.from('emote_tags').delete().eq('id', id)
    if (error) { toast(error.message); return }
    await loadEmoteData(true)
    renderAdminEmoteTypes()
  })
}

function openEmoteEditPopup(emote) {
  let selectedTag = emoteTagId(emote)   // tag id or null
  const typeOpts = [{ id: '', label: 'No type' }, ...emoteTags.map(t => ({ id: t.id, label: t.name }))]
  const o = overlay(`
    <h3>Edit Emote</h3>
    <!-- Autoplaying loop, not a still: the whole point of the preview is to
         show WHICH animation this row is, and these clips are short. -->
    <video class="adm-emote-preview" src="${BASE}assets/${emote.clip}" muted playsinline loop autoplay preload="auto" aria-hidden="true"></video>
    <label class="field-label" for="em-title">Title</label>
    <input id="em-title" class="rename-input" type="text" maxlength="40" value="${escapeHtml(emoteName(emote))}" />
    <label class="field-label" for="em-desc">Description</label>
    <input id="em-desc" class="rename-input" type="text" maxlength="80" value="${escapeHtml(emoteDesc(emote))}" />
    <label class="field-label" for="em-type">Type</label>
    <!-- A native select, not a stack of full-width buttons: with five-plus
         types those buttons made the popup taller than the screen. -->
    <select id="em-type" class="rename-input em-type-select">
      ${typeOpts.map(op => `<option value="${escapeHtml(op.id)}" ${(selectedTag || '') === op.id ? 'selected' : ''}>${escapeHtml(op.label)}</option>`).join('')}
    </select>
    <div class="home-btn-col" style="margin-top:1.25rem">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('#em-type').addEventListener('change', (e) => {
    selectedTag = e.target.value || null
  })
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    // Store null for a field left equal to the hardcoded default, so defaults
    // keep flowing through if they're later changed in code.
    const titleVal = o.querySelector('#em-title').value.trim()
    const descVal = o.querySelector('#em-desc').value.trim()
    const row = {
      emote_id: emote.id,
      tag_id: selectedTag,
      title: (titleVal && titleVal !== emote.name) ? titleVal : null,
      description: (descVal && descVal !== emote.desc) ? descVal : null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase.from('emote_meta').upsert(row)
    if (error) { toast(error.message); return }
    o.remove()
    await loadEmoteData(true)
    renderAdminEmoteTypes()
    toast('Saved')
  })
}

// Whether the preset grid shows the remove/add controls - gated behind the
// "Edit Pictures" button so a stray tap can't land on a delete affordance.
let presetEditMode = false
// Whether the preset grid is in iPhone-homescreen-style drag-to-reorder mode -
// gated behind the "Arrange" button. Mutually exclusive with presetEditMode
// (see the two toggle handlers in renderAdminPresets).
let presetArrangeMode = false
let presetAvatarsCache = []

async function loadPresetAvatars() {
  const grid = app.querySelector('#preset-grid')
  if (!grid) return
  const { data, error } = await supabase.from('preset_avatars').select('id, path, url, unlock_level, created_at')
    .order('unlock_level', { ascending: true }).order('created_at', { ascending: true })
  if (error) { grid.innerHTML = `<p class="log-empty">${escapeHtml(error.message)}</p>`; return }
  presetAvatarsCache = data || []
  renderPresetGrid()
}

function renderPresetGrid() {
  const grid = app.querySelector('#preset-grid')
  if (!grid) return
  const n = presetAvatarsCache.length
  const summaryEl = app.querySelector('#preset-ladder-summary')
  if (summaryEl) {
    if (!n) {
      summaryEl.textContent = 'No pictures yet.'
    } else {
      const lo = presetAvatarsCache[0].unlock_level || 1
      const hi = presetAvatarsCache[n - 1].unlock_level || 1
      const cost = pizzasForLevel(hi)
      summaryEl.textContent = `${n} picture${n === 1 ? '' : 's'} — unlocking at levels ${lo} to ${hi} (${cost} pizzas to fully complete)`
    }
  }
  const items = presetAvatarsCache.map((p, i) => `
    <div class="adm-preset-item${presetArrangeMode ? ' is-arrange' : ''}" data-preset-id="${p.id}" data-preset-path="${escapeHtml(p.path)}">
      <span class="adm-preset-lv">Lv. ${p.unlock_level || 1}</span>
      <img src="${p.url}" alt="" draggable="false" />
      ${presetEditMode ? `<button class="adm-preset-remove" type="button" data-action="remove-preset" aria-label="Remove preset">✕</button>` : ''}
    </div>
  `).join('')
  grid.innerHTML = items + (presetEditMode ? `<button class="adm-preset-add" type="button" data-action="upload-preset" aria-label="Upload new preset">+</button>` : '')
  grid.querySelector('[data-action="upload-preset"]')?.addEventListener('click', () => app.querySelector('#preset-input').click())
  grid.querySelectorAll('[data-action="remove-preset"]').forEach(btn => {
    btn.addEventListener('click', () => confirmRemovePreset(btn.closest('.adm-preset-item')))
  })
  const editBtn = app.querySelector('[data-action="toggle-preset-edit"]')
  if (editBtn) editBtn.textContent = presetEditMode ? 'Done Editing' : 'Edit Pictures'
  const arrangeBtn = app.querySelector('[data-action="toggle-preset-arrange"]')
  if (arrangeBtn) arrangeBtn.textContent = presetArrangeMode ? 'Done Arranging' : 'Arrange'
  if (presetArrangeMode) initPresetArrangeDrag(grid)
}

// iPhone-homescreen-style drag-to-reorder for the Arrange mode. Pointer
// Events (not HTML5 draggable/dragstart, which is unreliable on touch) drive
// a dragged tile that follows the pointer while the rest of the grid
// reflows live around it; drop commits the new order via renumberPresetLadder.
// Aborts the previous render's document-level drag listeners before a fresh
// renderPresetGrid() call wires up new ones - otherwise every re-render
// while arrange mode stays on (e.g. the reload after a drop persists) would
// pile up another set of document listeners with their own stale closures.
let presetArrangeAbort = null

function initPresetArrangeDrag(grid) {
  presetArrangeAbort?.abort()
  presetArrangeAbort = new AbortController()
  const { signal } = presetArrangeAbort
  const LONG_PRESS_MS = 180
  let dragEl = null
  let grabOffsetX = 0, grabOffsetY = 0
  let pressTimer = null
  let dragging = false

  const tiles = () => Array.from(grid.querySelectorAll('.adm-preset-item'))

  function updateLvBadges() {
    tiles().forEach((el, i) => {
      const lv = el.querySelector('.adm-preset-lv')
      if (lv) lv.textContent = `Lv. ${i + 1}`
    })
  }

  function pointForEvent(e) { return { x: e.clientX, y: e.clientY } }

  // Strictly "is the pointer inside this tile", NOT "which tile is nearest".
  // Nearest-centre always returns something, so the moment the dragged tile
  // shifted the pointer was instantly judged to be over a different tile,
  // which reordered again, which shifted it again - the tiles visibly
  // flickered as that fought itself every pointermove. Requiring a real
  // overlap gives the drag a dead zone between tiles and it settles.
  function tileUnderPoint(x, y, exclude) {
    return tiles().find(el => {
      if (el === exclude) return false
      const r = el.getBoundingClientRect()
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }) || null
  }

  // Drag state lives at document level rather than being captured on the
  // dragged tile itself: reordering moves `item` in the DOM (target.after/
  // .before), and per spec that remove-and-reinsert releases any
  // setPointerCapture on it mid-drag, so a captured pointerup would silently
  // land on whatever's now under the cursor instead of the tile. Tracking
  // the drag with document-level move/up listeners sidesteps that entirely.
  grid.querySelectorAll('.adm-preset-item').forEach(item => {
    item.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.adm-preset-remove')) return
      const p = pointForEvent(e)
      clearTimeout(pressTimer)
      pressTimer = setTimeout(() => {
        dragEl = item
        dragging = true
        // Where inside the tile the finger landed, so the tile can be kept
        // under that same spot no matter where it ends up in the DOM.
        const r = item.getBoundingClientRect()
        grabOffsetX = p.x - r.left
        grabOffsetY = p.y - r.top
        item.classList.add('is-dragging')
      }, LONG_PRESS_MS)
    })
  })

  // Arrange-mode tiles set touch-action:none so a drag isn't stolen by the
  // page scroller - which also means a finger on a tile can't scroll. With 20
  // pictures the ladder is several screens tall, so without this the admin
  // could never drag a picture from level 2 down to level 21. Dragging near
  // the top or bottom edge scrolls the page toward it, the way iOS does when
  // you drag an app icon to the edge of the screen.
  function autoScrollNearEdge(y) {
    const EDGE = 90   // px from the viewport edge that starts scrolling
    const SPEED = 12  // px per pointermove
    const scroller = shellEl() || document.scrollingElement || document.documentElement
    if (y < EDGE) scroller.scrollTop -= SPEED
    else if (y > window.innerHeight - EDGE) scroller.scrollTop += SPEED
  }

  document.addEventListener('pointermove', (e) => {
    if (!dragging || !dragEl) return
    const p = pointForEvent(e)
    // Measured fresh from the tile's CURRENT layout box every move, with the
    // transform cleared first. Offsetting from the original grab point instead
    // was the other half of the flicker: a reorder relocates the tile in the
    // grid, so the same translate suddenly pointed somewhere else and the tile
    // leapt away from the finger, which triggered another reorder.
    dragEl.style.transform = ''
    const r = dragEl.getBoundingClientRect()
    const tx = p.x - grabOffsetX - r.left
    const ty = p.y - grabOffsetY - r.top
    dragEl.style.transform = `translate(${tx}px, ${ty}px) scale(1.08)`
    autoScrollNearEdge(p.y)
    const target = tileUnderPoint(p.x, p.y, dragEl)
    if (target) {
      const items = tiles()
      const from = items.indexOf(dragEl)
      const to = items.indexOf(target)
      if (from !== to) {
        if (from < to) target.after(dragEl)
        else target.before(dragEl)
        updateLvBadges()
      }
    }
  }, { signal })

  const endDrag = () => {
    clearTimeout(pressTimer)
    if (!dragging || !dragEl) return
    dragging = false
    const el = dragEl
    dragEl = null
    el.classList.remove('is-dragging')
    el.style.transform = ''
    const newOrder = tiles().map(node => node.dataset.presetId)
    presetAvatarsCache = newOrder.map(id => presetAvatarsCache.find(p => p.id === id))
    renumberPresetLadder()
  }
  document.addEventListener('pointerup', endDrag, { signal })
  document.addEventListener('pointercancel', endDrag, { signal })
}

// Reassigns unlock_level sequentially (2, 3, 4, ...) in current display
// order, batches all writes together, and re-renders once. Level 1 is the
// default silhouette everyone starts with, so the ladder starts at 2.
async function renumberPresetLadder() {
  const updates = presetAvatarsCache
    // Base 1, not 2: the first picture in the ladder IS the starting picture
    // every chef is given, rather than a separate grey silhouette nobody chose.
    .map((p, i) => ({ id: p.id, level: i + 1 }))
    .filter(u => u.level !== (presetAvatarsCache.find(p => p.id === u.id).unlock_level || 1))
  if (updates.length) {
    const results = await Promise.all(updates.map(u => supabase.from('preset_avatars').update({ unlock_level: u.level }).eq('id', u.id)))
    const failed = results.find(r => r.error)
    if (failed) { toast(failed.error.message); return }
  }
  toast('Ladder renumbered')
  loadPresetAvatars()
}

async function uploadPresetAvatar(blob) {
  const path = `presets/${crypto.randomUUID()}.jpg`
  const { error: uploadError } = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' })
  if (uploadError) { toast(uploadError.message); return }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const maxLevel = presetAvatarsCache.reduce((m, p) => Math.max(m, p.unlock_level || 1), 1)
  const { error } = await supabase.from('preset_avatars').insert({ path, url: data.publicUrl, unlock_level: maxLevel + 1 })
  if (error) { toast(error.message); return }
  loadPresetAvatars()
}

function confirmRemovePreset(el) {
  const id = el.dataset.presetId
  const path = el.dataset.presetPath
  const imgSrc = el.querySelector('img')?.src || ''
  const o = overlay(`
    <h3>Remove this picture?</h3>
    <img class="editpic-preview" src="${imgSrc}" alt="" />
    <p>Users will no longer be able to pick this preset. This can't be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, remove</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    await removePresetAvatar(id, path)
  })
}

async function removePresetAvatar(id, path) {
  const { error } = await supabase.from('preset_avatars').delete().eq('id', id)
  if (error) { toast(error.message); return }
  await supabase.storage.from('avatars').remove([path])
  presetAvatarsCache = presetAvatarsCache.filter(p => p.id !== id)
  await renumberPresetLadder()
}

// Coins aren't a stored column - they're earned pizzas minus owned emotes,
// plus any adjustment (gifts, or this admin tool). Mirrors coinBalance()
// but for an arbitrary looked-up profile instead of the signed-in one.
function adminCoinBalance(profile) {
  const earned = Math.floor(Math.floor(profile.pizzas) / 12)
  const owned = Array.isArray(profile.owned_emotes) ? profile.owned_emotes.length : 0
  return Math.max(0, earned - owned + (profile.coin_adjustment || 0))
}

// All profiles, loaded once when the dashboard mounts so the Users list is
// always visible & scrollable; the search input then just filters this
// cache client-side instead of re-querying on every keystroke.
let adminUsersCache = []

async function loadAdminUsers() {
  const scrollEl = app.querySelector('#admin-user-scroll')
  if (scrollEl) scrollEl.innerHTML = '<p class="log-empty">Loading&hellip;</p>'
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code, pizzas, coin_adjustment, owned_emotes, avatar_url')
    .order('display_name', { ascending: true })
    .limit(200)
  if (error) {
    if (scrollEl) scrollEl.innerHTML = `<p class="log-empty">${escapeHtml(error.message)}</p>`
    return
  }
  adminUsersCache = data || []
  renderAdminUserList(app.querySelector('#admin-search-input')?.value || '')
}

function renderAdminUserList(filter) {
  const scrollEl = app.querySelector('#admin-user-scroll')
  const countEl = app.querySelector('#admin-user-count')
  if (!scrollEl) return
  const q = (filter || '').trim().toLowerCase()
  const list = q
    ? adminUsersCache.filter(p => (p.display_name || '').toLowerCase().includes(q) || (p.friend_code || '').toLowerCase().includes(q))
    : adminUsersCache
  if (countEl) countEl.textContent = q ? `${list.length} of ${adminUsersCache.length} users` : `${adminUsersCache.length} users`
  if (!list.length) { scrollEl.innerHTML = '<p class="log-empty">No users found.</p>'; return }
  scrollEl.innerHTML = `<div class="glist">${list.map(p => `
    <div class="adm-userrow" data-admin-user="${p.id}" role="button" tabindex="0">
      <img src="${p.avatar_url || DEFAULT_AVATAR}" alt="" />
      <div class="adm-u-info"><div class="adm-u-name">${escapeHtml(p.display_name)}</div><div class="adm-u-code">Code ${escapeHtml(p.friend_code || '')}</div></div>
      <div class="adm-u-stats">
        <span class="adm-stat">🍕 ${formatScore(p.pizzas)}</span>
        <span class="adm-stat"><i class="adm-coin-dot"></i> ${adminCoinBalance(p)}</span>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
    </div>
  `).join('')}</div>`
  const byId = Object.fromEntries(list.map(p => [p.id, p]))
  scrollEl.querySelectorAll('[data-admin-user]').forEach(row => {
    row.addEventListener('click', () => openAdminAdjustPopup(byId[row.dataset.adminUser]))
  })
}

// Per-user edit popup: pizzas & coins (original purpose) plus display name
// and profile picture, so an admin can also clean up a profane name/avatar.
function openAdminAdjustPopup(profile) {
  const curPizzas = Number(profile.pizzas) || 0
  const curCoins = adminCoinBalance(profile)
  // undefined = unchanged, a url string = set to that preset, null = remove
  // (revert to default penguin). Committed to the DB on Save, not on pick.
  let avatarChange
  const o = overlay(`
    <h3>Edit ${escapeHtml(profile.display_name)}</h3>
    <div class="editpic-avatar-wrap" style="margin-bottom:1.25rem">
      <img class="editpic-avatar" id="admin-edit-avatar" src="${profile.avatar_url || DEFAULT_AVATAR}" alt="" />
      <button class="editpic-cam" type="button" data-action="edit-pic" aria-label="Edit picture">${CAMERA_SVG}</button>
    </div>

    <label class="field-label" for="admin-name" style="margin-top:0.375rem">Display Name</label>
    <input id="admin-name" class="rename-input" type="text" maxlength="13" value="${escapeHtml(profile.display_name || '')}" />

    <label class="field-label" for="admin-pizzas">Pizzas</label>
    <input id="admin-pizzas" class="rename-input" type="number" step="0.01" value="${curPizzas}" />
    <label class="field-label" for="admin-coins">Coins</label>
    <input id="admin-coins" class="rename-input" type="number" step="1" value="${curCoins}" />
    <div class="home-btn-col" style="margin-top:0.25rem">
      <button type="button" data-action="apply">Save changes</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })

  const openPicker = () => {
    openAdminPicPicker(profile, avatarChange, (choice) => {
      avatarChange = choice
      const avatarImg = o.querySelector('#admin-edit-avatar')
      if (avatarImg) avatarImg.src = choice || DEFAULT_AVATAR
    })
  }
  o.querySelector('#admin-edit-avatar').addEventListener('click', openPicker)
  o.querySelector('[data-action="edit-pic"]').addEventListener('click', openPicker)

  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="apply"]').addEventListener('click', async () => {
    const newName = o.querySelector('#admin-name').value.trim().slice(0, 13) || profile.display_name
    const newPizzas = Number(o.querySelector('#admin-pizzas').value)
    const newCoins = Number(o.querySelector('#admin-coins').value)
    if (Number.isNaN(newPizzas) || Number.isNaN(newCoins)) { toast('Enter valid numbers'); return }
    const pizzaDelta = Math.round((newPizzas - curPizzas) * 100) / 100
    const coinDelta = Math.round(newCoins - curCoins)

    const profileUpdates = {}
    if (newName !== profile.display_name) profileUpdates.display_name = newName
    if (avatarChange !== undefined && (avatarChange || null) !== (profile.avatar_url || null)) profileUpdates.avatar_url = avatarChange
    const hasProfileUpdates = Object.keys(profileUpdates).length > 0

    if (!pizzaDelta && !coinDelta && !hasProfileUpdates) { o.remove(); return }

    // Admins can update any profile (RLS policy already grants this) - no
    // migration needed here.
    if (hasProfileUpdates) {
      const { error } = await supabase.from('profiles').update(profileUpdates).eq('id', profile.id)
      if (error) { toast(friendlyNameError(error)); return }
      Object.assign(profile, profileUpdates)
    }
    const ok = (pizzaDelta || coinDelta) ? await applyAdminEdit(profile, pizzaDelta, coinDelta) : true
    o.remove()
    if (ok) { toast('Applied'); renderAdminUserList(app.querySelector('#admin-search-input')?.value || '') }
  })
}

// Sub-popup opened from the avatar/camera in openAdminAdjustPopup. Only
// STAGES a choice via onChoose (url / null for remove) - no DB write here,
// the parent popup's "Save changes" is what commits it.
async function openAdminPicPicker(profile, stagedUrl, onChoose) {
  const current = stagedUrl !== undefined ? stagedUrl : (profile.avatar_url || null)
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Edit Picture</h3>
    <div class="editpic-avatar-wrap">
      <img class="editpic-avatar" src="${current || DEFAULT_AVATAR}" alt="" />
    </div>
    <button type="button" class="btn-secondary" data-action="remove-pic" style="margin-top:0.875rem">Remove picture</button>
    <label class="field-label" style="margin-top:1.75rem">Or pick a preset</label>
    <div class="editpic-presets" id="admin-pic-presets" style="margin-top:0.625rem"><p class="editpic-empty">Loading&hellip;</p></div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="remove-pic"]').addEventListener('click', () => { onChoose(null); o.remove() })

  const grid = o.querySelector('#admin-pic-presets')
  let list = presetAvatarsCache
  if (!list || !list.length) {
    const { data, error } = await supabase.from('preset_avatars').select('id, url').order('created_at', { ascending: false })
    if (error) { grid.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
    list = data || []
  }
  if (!list.length) { grid.innerHTML = '<p class="editpic-empty">No presets available yet.</p>'; return }
  grid.innerHTML = list.map(p => `
    <button class="editpic-preset ${p.url === current ? 'selected' : ''}" type="button" data-url="${escapeHtml(p.url)}">
      <img src="${p.url}" alt="" />
    </button>
  `).join('')
  grid.querySelectorAll('[data-url]').forEach(btn => {
    btn.addEventListener('click', () => { onChoose(btn.dataset.url); o.remove() })
  })
}

async function applyAdminEdit(profile, pizzaDelta, coinDelta) {
  if (pizzaDelta) {
    // 1 pizza = 1 hour, so a pizza adjustment moves focus time by the same
    // amount (positive add, negative deduction). The row then shows e.g. "1h"
    // for a +1 pizza edit and the day/week/month totals stay consistent.
    const minutes = Math.round(pizzaDelta * 60)
    const ok = await insertSessionRow({ user_id: profile.id, completed_at: new Date().toISOString(), minutes, pizzas: pizzaDelta, task: 'Admin Edit', icon: '🛠️' })
    if (!ok) return false
  }
  if (coinDelta) {
    // pizzas:0 so the bump_pizzas trigger is a no-op; the signed amount lives in
    // the task text so the user's log shows a coin (not a pizza), no migration needed.
    const label = `Admin Edit (${signedScore(coinDelta)} ${Math.abs(coinDelta) === 1 ? 'coin' : 'coins'})`
    const ok = await insertSessionRow({ user_id: profile.id, completed_at: new Date().toISOString(), minutes: 0, pizzas: 0, task: label, icon: '🛠️' })
    if (!ok) return false
    const nextAdjustment = (profile.coin_adjustment || 0) + coinDelta
    const { error } = await supabase.from('profiles').update({ coin_adjustment: nextAdjustment }).eq('id', profile.id)
    if (error) { toast(error.message); return false }
  }
  return true
}

async function insertSessionRow(row) {
  let { error } = await supabase.from('sessions').insert(row)
  if (error && 'icon' in row) {
    const { icon, ...base } = row
    ;({ error } = await supabase.from('sessions').insert(base))
  }
  if (error) { toast(error.message); return false }
  return true
}

// Small, tasteful (non-exhaustive) blocklist for self-chosen display names.
// Substring match on the lowercased name - keeps moderation simple without a
// migration or external service. Admins editing OTHER users' names (see
// openAdminAdjustPopup) are exempt on purpose, so they can fix a bad name.
const NAME_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'asshole', 'assh0le', 'cunt', 'dick', 'pussy',
  'nigger', 'nigga', 'fag', 'faggot', 'whore', 'slut', 'retard', 'rape',
  'nazi', 'cock', 'twat', 'bastard', 'dyke', 'chink', 'spic', 'kike',
  // Anatomy/sexual terms - substring match, so e.g. "boobs" and "boobies"
  // are both caught by "boob".
  'penis', 'vagina', 'breast', 'boob', 'dildo', 'porn', 'sex',
  'blowjob', 'handjob', 'anal', 'clit', 'testicle', 'scrotum', 'semen',
  'orgasm', 'nude', 'naked', 'xxx', 'jizz',
]
// Letters, numbers and single spaces only. Emoji in particular are excluded:
// they render far wider than a letter and each one eats two of the character
// budget (maxlength counts UTF-16 units), so "Chef ****" would blow past the
// width the row is measured against - and the same applies to symbols and
// zero-width/control characters pasted in from a keyboard or clipboard.
const NAME_CHARS_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/
function isNameCharsOk(name) {
  return NAME_CHARS_RE.test((name || '').trim())
}
function isNameAllowed(name) {
  if (!isNameCharsOk(name)) return false
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return !NAME_BLOCKLIST.some(w => n.includes(w))
}

// migration_unique_names.sql adds a case-insensitive unique index on
// display_name, so two chefs can never share a name (renaming away from one
// frees it immediately for someone else - that's the point of a plain
// uniqueness constraint, no separate reservation table needed). Postgres
// reports that collision as a raw "duplicate key value violates unique
// constraint..." error, which would be confusing shown as-is.
function friendlyNameError(error) {
  if (error?.code === '23505' || /duplicate key|already exists/i.test(error?.message || '')) {
    return 'That name is already taken — try another.'
  }
  return error?.message || 'Could not save — try again.'
}

function openRenamePopup() {
  // The "Chef" prefix is fixed and shown as a non-editable label; the user
  // only edits the [name] part (max 15 chars), stored raw in display_name.
  const o = overlay(`
    <h3>Edit name</h3>
    <div class="rename-chef-row">
      <span class="rename-chef-prefix">Chef</span>
      <input id="rename-input" class="rename-input" type="text" maxlength="13" value="${escapeHtml(myRawName())}" placeholder="Your name" />
    </div>
    <p class="inline-error" id="rename-error"></p>
    <p class="name-status" id="rename-status" hidden></p>
    <div class="home-btn-col">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  const input = o.querySelector('#rename-input')
  const errEl = o.querySelector('#rename-error')
  const statusEl = o.querySelector('#rename-status')
  const saveBtn = o.querySelector('[data-action="save"]')
  const originalName = myRawName()

  const setStatus = (state, text) => {
    statusEl.hidden = !text
    statusEl.textContent = text || ''
    statusEl.classList.toggle('ok', state === 'ok')
    statusEl.classList.toggle('bad', state === 'bad')
  }

  // Availability is checked as you type. Each keystroke bumps a token so a
  // slow earlier response can't overwrite the verdict for what's now in the box.
  let checkToken = 0
  let debounce = null
  const checkAvailability = (val) => {
    const myCall = ++checkToken
    clearTimeout(debounce)
    // Unchanged name is trivially yours - no round trip, no "taken" flash.
    if (val.toLowerCase() === originalName.toLowerCase()) { setStatus(null, ''); saveBtn.disabled = false; return }
    setStatus(null, 'Checking\u2026')
    debounce = setTimeout(async () => {
      const { data, error } = await supabase.rpc('is_display_name_available', { candidate: val })
      if (myCall !== checkToken) return   // a newer keystroke already superseded this
      if (error) {
        // Pre-migration or offline: stay quiet and let the save-time unique
        // constraint be the backstop rather than claiming a wrong verdict.
        setStatus(null, '')
        saveBtn.disabled = false
        return
      }
      const free = data === true
      setStatus(free ? 'ok' : 'bad', free ? `Chef ${val} is available \u2713` : `Chef ${val} is taken`)
      saveBtn.disabled = !free
    }, 300)
  }

  const validate = () => {
    const val = input.value.trim()
    const blocked = !!val && !isNameAllowed(input.value)
    // Say WHICH rule was broken - "not allowed" alone leaves someone who
    // typed an emoji or an apostrophe with no idea what to change.
    errEl.textContent = !blocked ? '' : (isNameCharsOk(input.value)
      ? "That name isn't allowed \u2014 please choose another."
      : 'Letters, numbers and spaces only.')
    errEl.classList.toggle('show', blocked)
    input.classList.toggle('err', blocked)
    const ok = !!val && !blocked
    saveBtn.disabled = !ok
    if (!ok) { clearTimeout(debounce); checkToken++; setStatus(null, '') }
    else checkAvailability(val)
    return ok
  }
  input.addEventListener('input', validate)
  validate()
  setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newName = stripChef(input.value).slice(0, 13)
    if (!newName) return
    if (!validate()) return
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', currentUser.id)
    if (error) { toast(friendlyNameError(error)); return }
    currentProfile.display_name = newName
    o.remove()
    renderSettings()
    toast('Name updated')
  })
}

function showNotSignedInWarning() {
  // Mid-tour, this popup is an unguided dead-end the tutorial never
  // mentions (the unified tour never offers sign-in mid-run at all any
  // more - see buildOnboardingSteps()) - skip straight to what "I'll risk
  // it" does instead of showing it.
  if (tour) { renderDurationPicker(); return }
  const o = overlay(`
    <h3>Not signed in</h3>
    <p>Your progress may not be saved since you're not signed in.</p>
    <div class="home-btn-col">
      ${googleBtn()}
      <button type="button" class="btn-secondary" data-action="risk">I'll risk it</button>
    </div>
  `)
  wireSignInButtons(o)
  o.querySelector('[data-action="risk"]').addEventListener('click', () => { o.remove(); renderIntro(renderDurationPicker, false) })
}

// =================================================================
//  Intro / results (unchanged mechanics)
// =================================================================
function renderIntro(onEnd, isAlarm, videoSrc = 'intro.mp4', sessionSummary) {
  app.innerHTML = `
    <div class="intro">
      <video class="intro-video" src="${BASE}assets/${videoSrc}" playsinline autoplay></video>
      <button class="intro-skip" type="button">Skip</button>
    </div>
  `
  const video = app.querySelector('.intro-video')
  video.muted = state.muted
  const skipBtn = app.querySelector('.intro-skip')

  let transitioned = false
  const continueAfterPlaythrough = () => {
    if (transitioned) return
    transitioned = true
    video.pause()
    if (isAlarm) renderTapToContinue(onEnd, isAlarm, sessionSummary)
    else onEnd()
  }
  const onAutoplayBlocked = () => {
    if (transitioned) return
    transitioned = true
    video.pause()
    renderTapToContinue(onEnd, isAlarm, sessionSummary)
  }
  video.addEventListener('ended', continueAfterPlaythrough)
  skipBtn.addEventListener('click', continueAfterPlaythrough)
  video.play().catch(onAutoplayBlocked)
}

function renderTapToContinue(onContinue, isAlarm, sessionSummary) {
  const resultText = isAlarm && sessionSummary
    ? `Worked for ${formatWorkedDuration(sessionSummary.minutes)}, ${formatScoreFixed2(sessionSummary.pizzas)} pizzas made`
    : ''
  app.innerHTML = `
    <div class="intro-start" data-intro-stage="${isAlarm ? 'results' : 'intro'}">
      <img src="${BASE}assets/penguin-icon.png" alt="Chef Penguino" />
      <h1>${isAlarm ? resultText : 'Chef Penguino'}</h1>
      <button type="button">${isAlarm ? 'Tap for Results' : 'Tap to Continue'}</button>
    </div>
  `
  app.querySelector('button').addEventListener('click', onContinue)
}

// ---------- Duration picker ----------
function renderDurationPicker() {
  renderTimePickerUI({
    title: 'How long do you want to work?',
    onPick: (minutes) => renderTaskPrompt(minutes),
    onBack: renderHome,
    stage: 'duration',
  })
}

function renderTimePickerUI({ title, onPick, onBack, stage }) {
  app.innerHTML = `
    <div class="picker"${stage ? ` data-picker-stage="${stage}"` : ''}>
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      ${onBack ? '<button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>' : ''}
      <div class="picker-content">
        <h2>${title}</h2>
        <div class="picker-grid">
          ${DURATIONS.map(d => `<button class="picker-btn" data-minutes="${d.minutes}">${d.label}</button>`).join('')}
          <button class="picker-btn" data-custom="1">Custom</button>
        </div>
        <div class="custom-row" hidden>
          <input type="number" min="0" max="6" inputmode="numeric" placeholder="Hrs" class="custom-input custom-hrs" />
          <input type="number" min="0" max="59" inputmode="numeric" placeholder="Min" class="custom-input custom-mins" />
          <button class="custom-go" type="button">Go</button>
        </div>
      </div>
    </div>
  `
  const customRow = app.querySelector('.custom-row')
  const customHrs = app.querySelector('.custom-hrs')
  const customMins = app.querySelector('.custom-mins')
  app.querySelectorAll('.picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.custom) { customRow.hidden = false; customHrs.focus(); return }
      onPick(Number(btn.dataset.minutes))
    })
  })
  app.querySelector('.custom-go').addEventListener('click', () => {
    const hrs = Math.floor(Number(customHrs.value)) || 0
    const mins = Math.floor(Number(customMins.value)) || 0
    const minutes = hrs * 60 + mins
    if (minutes > 0) onPick(Math.min(minutes, 360))
  })
  if (onBack) app.querySelector('.back-arrow-btn').addEventListener('click', onBack)
}

// ---------- Task prompt ----------
function renderTaskPrompt(minutes, prefill = '') {
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
      <div class="picker-content">
        <h2>What are you working on?</h2>
        <p class="home-tag">Short phrase, max 30 characters</p>
        <input type="text" maxlength="30" class="task-input" placeholder="e.g. Essay writing" value="${escapeHtml(prefill)}" />
        <button class="start-btn" data-done type="button">Done</button>
      </div>
    </div>
  `
  const input = app.querySelector('.task-input')
  input.focus()
  app.querySelector('.back-arrow-btn').addEventListener('click', renderDurationPicker)
  app.querySelector('[data-done]').addEventListener('click', () => {
    renderTypePicker(minutes, input.value.trim().slice(0, 30))
  })
}

// ---------- Task-type picker (after duration + task name, before the timer) ----------
function renderTypePicker(minutes, task) {
  const types = resolvedTaskTypes()
  let selected = TASK_TYPES[0].key
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
      <div class="picker-content">
        <h2>What kind of task?</h2>
        <p class="home-tag">Pick what you're about to cook up. Customise tags in settings.</p>
        <div class="tt-type-list">
          ${types.map(t => `
            <div class="tt-type-row${t.key === selected ? ' selected' : ''}" data-key="${t.key}" role="button" tabindex="0">
              <span class="tt-type-emoji">${t.emoji}</span>
              <div class="tt-type-txt">
                <div class="tt-type-title">${escapeHtml(t.title)}</div>
                ${t.desc ? `<div class="tt-type-desc">${escapeHtml(t.desc)}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
        <button class="start-btn" data-start type="button">🔥 Start cooking</button>
      </div>
    </div>
  `
  app.querySelector('.back-arrow-btn').addEventListener('click', () => renderTaskPrompt(minutes, task))
  app.querySelectorAll('.tt-type-row').forEach(row => {
    row.addEventListener('click', () => {
      selected = row.dataset.key
      app.querySelectorAll('.tt-type-row').forEach(r => r.classList.toggle('selected', r.dataset.key === selected))
    })
  })
  app.querySelector('[data-start]').addEventListener('click', () => startSession(minutes, task, selected))
}

function startSession(minutes, task, type) {
  state.timer = {
    task: task || '',
    type: type || null,
    elapsedMs: 0,
    segmentPlannedMs: minutes * 60 * 1000,
    segmentStartedAt: Date.now(),
    remainingMsSnapshot: null,
  }
  save()
  setBakingNow(true)
  renderTimerLoop(true)
}

// Marks this chef as mid-session so friends'/admin "N baking" counts have
// something to read - a sessions row only exists once a session finishes.
// Fire-and-forget: a failed write must never block or break the timer, and
// the staleness cutoff in bakingCutoffISO() cleans up anything left behind.
function setBakingNow(on) {
  if (!currentUser) return
  supabase.from('profiles')
    .update({ baking_since: on ? new Date().toISOString() : null })
    .eq('id', currentUser.id)
    .then(() => {}, () => {})
}

// Anything older than this is treated as abandoned (app closed mid-session)
// rather than still baking, so a stale row can't inflate the count forever.
const BAKING_STALE_HOURS = 4
function bakingCutoffISO() {
  return new Date(Date.now() - BAKING_STALE_HOURS * 3600 * 1000).toISOString()
}

// ---------- Timer + looping gameplay video (unchanged mechanics) ----------
function renderTimerLoop(justStarted) {
  const startedPaused = state.timer.segmentStartedAt == null

  app.innerHTML = `
    <div class="kitchen">
      <video class="kitchen-loop" src="${BASE}assets/gameplay-loop.mp4" playsinline autoplay loop muted></video>
      <div class="session-pizza-badge">
        <img src="${BASE}assets/pizza-pop.png" alt="" />
        <span class="session-pizza-value">0</span>
      </div>
      <div class="timer-hud">
        <button class="timer-value" type="button">--:--</button>
        <span class="timer-caption">Cook with Chef Penguino!</span>
        ${state.timer.type && taskTypeLabel(state.timer.type) ? `<div class="tt-timer-chip">${TASK_TYPE_EMOJI[state.timer.type]} ${escapeHtml(taskTypeLabel(state.timer.type).title)}</div>` : ''}
      </div>
      <button class="mute-btn" type="button" aria-label="Toggle music"></button>
      <div class="darken-overlay" hidden>
        <p class="darken-text">Auto-darken enabled to save battery and reduce distraction. Tap anywhere to brighten.</p>
        <div class="darken-slider-row">
          <span class="darken-slider-icon">☀️</span>
          <input class="darken-slider" type="range" min="0" max="100" value="${Math.round(state.darkenLevel * 100)}" aria-label="Darkness level" />
          <span class="darken-slider-icon">🌙</span>
        </div>
      </div>
      ${justStarted ? '<div class="start-cooking">Start Cooking!</div>' : ''}
    </div>
  `

  if (justStarted) {
    const splash = app.querySelector('.start-cooking')
    setTimeout(() => splash.classList.add('fade-out'), 1200)
    setTimeout(() => splash.remove(), 1800)
  }

  const kitchenEl = app.querySelector('.kitchen')
  const loopVideo = app.querySelector('.kitchen-loop')
  const muteBtn = app.querySelector('.mute-btn')
  const timerBtn = app.querySelector('.timer-value')
  const sessionPizzaValue = app.querySelector('.session-pizza-value')

  loopVideo.muted = true

  const music = bgMusic
  if (!startedPaused) syncMusic()
  const updateMuteIcon = () => { muteBtn.textContent = state.muted ? '🔇' : '🔊' }
  updateMuteIcon()

  let isPausedNow = startedPaused
  let intervalId

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted
    state.volume = state.muted ? 0 : (state.lastVolume || 0.5)
    updateMuteIcon()
    save()
    if (!isPausedNow) syncMusic()
  })

  const darkenOverlay = app.querySelector('.darken-overlay')
  const darkenSlider = app.querySelector('.darken-slider')
  let darkenTimeoutId = null

  function applyDarkenLevel() {
    const brightness = 1 - (state.darkenLevel * 0.85)
    kitchenEl.style.setProperty('--darken-brightness', brightness)
    kitchenEl.style.setProperty('--darken-scrim', state.darkenLevel * 0.4)
  }
  applyDarkenLevel()

  function armDarkenTimer() {
    clearTimeout(darkenTimeoutId)
    if (!state.autoDarken) return
    darkenTimeoutId = setTimeout(() => {
      kitchenEl.classList.add('darkened')
      darkenOverlay.hidden = false
    }, 5000)
  }

  function disarmDarken() {
    clearTimeout(darkenTimeoutId)
    kitchenEl.classList.remove('darkened')
    darkenOverlay.hidden = true
  }

  darkenOverlay.addEventListener('click', () => {
    disarmDarken()
    if (!isPausedNow) armDarkenTimer()
  })

  app.querySelector('.darken-slider-row').addEventListener('click', (e) => e.stopPropagation())
  darkenSlider.addEventListener('input', (e) => {
    e.stopPropagation()
    state.darkenLevel = Number(e.target.value) / 100
    save()
    applyDarkenLevel()
  })

  function formatTime(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000))
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  function currentRemaining() {
    if (state.timer.segmentStartedAt == null) return state.timer.remainingMsSnapshot ?? 0
    return state.timer.segmentPlannedMs - (Date.now() - state.timer.segmentStartedAt)
  }

  function sessionElapsedMs() {
    if (state.timer.segmentStartedAt == null) return state.timer.elapsedMs
    return state.timer.elapsedMs + (Date.now() - state.timer.segmentStartedAt)
  }

  function updateSessionPizzaBadge() {
    sessionPizzaValue.textContent = formatScore1(sessionElapsedMs() / 3600000)
  }

  function tick() {
    const remaining = currentRemaining()
    timerBtn.textContent = formatTime(remaining)
    updateSessionPizzaBadge()
    if (remaining <= 0) {
      clearInterval(intervalId)
      music.pause()
      disarmDarken()
      state.timer.elapsedMs += state.timer.segmentPlannedMs
      finalizeSession(true)
    }
  }

  function startTicking() {
    loopVideo.play().catch(() => {})
    kitchenEl.classList.remove('paused')
    syncMusic()
    clearInterval(intervalId)
    intervalId = setInterval(tick, 250)
    tick()
    armDarkenTimer()
  }

  function pauseNow() {
    if (isPausedNow) return
    isPausedNow = true
    const remaining = Math.max(0, currentRemaining())
    state.timer.elapsedMs += (state.timer.segmentPlannedMs - remaining)
    state.timer.remainingMsSnapshot = remaining
    state.timer.segmentStartedAt = null
    save()
    clearInterval(intervalId)
    disarmDarken()
    loopVideo.pause()
    music.pause()
    kitchenEl.classList.add('paused')
    timerBtn.textContent = formatTime(remaining)
    showPausedOverlay()
  }

  timerBtn.addEventListener('click', pauseNow)

  function showPausedOverlay() {
    const overlayEl = document.createElement('div')
    overlayEl.className = 'pause-overlay'
    overlayEl.innerHTML = `
      <div class="pause-content">
        <h2>Timer Paused</h2>
        <div class="home-btn-col">
          <button class="start-btn" data-action="resume" type="button">Resume</button>
          <button class="start-btn" data-action="edit" type="button">Edit Time</button>
          <button class="start-btn" data-action="end" type="button">End Early</button>
        </div>
      </div>
    `
    kitchenEl.appendChild(overlayEl)

    overlayEl.querySelector('[data-action="resume"]').addEventListener('click', () => {
      overlayEl.remove()
      isPausedNow = false
      state.timer.segmentStartedAt = Date.now()
      state.timer.segmentPlannedMs = state.timer.remainingMsSnapshot
      state.timer.remainingMsSnapshot = null
      save()
      startTicking()
    })

    overlayEl.querySelector('[data-action="edit"]').addEventListener('click', () => {
      renderTimePickerUI({
        title: 'Set new remaining time',
        onPick: (minutes) => {
          state.timer.segmentPlannedMs = minutes * 60 * 1000
          state.timer.segmentStartedAt = Date.now()
          state.timer.remainingMsSnapshot = null
          save()
          renderTimerLoop(false)
        },
        onBack: () => renderTimerLoop(false),
        stage: 'edit',
      })
    })

    overlayEl.querySelector('[data-action="end"]').addEventListener('click', () => {
      showEndEarlyConfirm(overlayEl)
    })
  }

  function showEndEarlyConfirm(pauseOverlay) {
    pauseOverlay.hidden = true
    const confirmOverlay = document.createElement('div')
    confirmOverlay.className = 'pause-overlay'
    confirmOverlay.innerHTML = `
      <div class="pause-content">
        <h2>Are you sure?</h2>
        <p class="confirm-sub">Your pizzas made will be saved.</p>
        <div class="home-btn-col">
          <button class="start-btn" data-action="confirm-end" type="button">Yes, End Session</button>
          <button class="start-btn" data-action="cancel" type="button">Cancel</button>
        </div>
      </div>
    `
    kitchenEl.appendChild(confirmOverlay)
    confirmOverlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      confirmOverlay.remove()
      pauseOverlay.hidden = false
    })
    confirmOverlay.querySelector('[data-action="confirm-end"]').addEventListener('click', () => {
      finalizeSession(true)
    })
  }

  if (startedPaused) {
    loopVideo.pause()
    kitchenEl.classList.add('paused')
    timerBtn.textContent = formatTime(currentRemaining())
    updateSessionPizzaBadge()
    showPausedOverlay()
  } else {
    startTicking()
  }
}

// =================================================================
//  Onboarding tour engine (spotlight coach-marks) — steps 1-6, the
//  "cooking half". Steps 7+ (coin claim, forced waving purchase, equip,
//  tap-to-emote demo, Add to Homescreen) are a separate later task - see the
//  TODO at the bottom of buildOnboardingSteps().
//
//  The whole overlay lives outside #app, appended straight to <body>, so it
//  survives every app.innerHTML swap the tour walks through (home -> intro
//  video -> pickers -> timer -> results -> history -> day sheet) instead of
//  getting wiped by mountScreen()/renderIntro()/etc.
//
//  z-index 90: above every ordinary screen and popup/sheet it may need to
//  sit over or point at (.overlay 70, #bug-fab 65, .cal-sheet 60,
//  .cal-scrim 50, .pause-overlay 4, .darken-overlay 5, .tabbar 3), but below
//  .lore-player (999), which must never be covered.
//
//  Two step kinds:
//    - explain: a description card only, no target. A document-level click
//      listener (bubble phase, never preventDefault/stopPropagation'd)
//      advances the tour on ANY tap - it never swallows the tap, so if that
//      tap also lands on a real control (e.g. a duration button) that
//      control's own handler still runs normally and the real screen still
//      advances too.
//    - action: the user must perform the REAL action on a real target. Four
//      fixed "blocker" rectangles surround the target's bounding rect - an
//      actual gap in the DOM with nothing overlaid on it, not just a
//      transparent hit-test hole - so the target is genuinely the only
//      clickable thing on screen; taps elsewhere hit an opaque blocker and
//      go nowhere. The tour advances only when the real target itself is
//      clicked (or, for the swipe-to-reveal step, when it detects the row's
//      own "open" class actually appears).
// =================================================================

let tour = null // non-null while active: { steps, index, entered, timers, savedAutoDarken, cleanupStep, obs }

function onboardingDoneForCurrentUser() {
  return isSignedIn() ? currentProfile?.onboarding_done === true : !!state.onboardingDone
}

// Fire-and-forget for signed-in users (mirrors setBakingNow()'s pattern) -
// never blocks ending the tour on a slow/failed network write.
function markOnboardingDone() {
  if (isSignedIn() && currentUser) {
    if (currentProfile) currentProfile.onboarding_done = true
    supabase.from('profiles').update({ onboarding_done: true }).eq('id', currentUser.id).then(() => {}, () => {})
  } else {
    state.onboardingDone = true
    save()
  }
}

// Called once at boot, only on a fresh Home landing (never mid-session, and
// never more than once, since onboardingDoneForCurrentUser() flips true the
// moment a tour finishes or is skipped).
function maybeAutoStartOnboardingTour() {
  if (tour) return
  if (onboardingDoneForCurrentUser()) return
  // Only brand-new chefs get pulled into the tour unasked. Both flags default
  // to false, so without this every existing user would be auto-started into a
  // tutorial for an app they already know - the migration grandfathers signed-in
  // profiles, and this covers guests, whose flag lives in localStorage and so
  // can't be backfilled. Anyone with pizzas or a session behind them has
  // clearly used the app before; they can still replay it from Settings.
  if (displayPizzas() > 0 || (state.log && state.log.length > 0)) {
    markOnboardingDone()
    return
  }
  startOnboardingTour()
}

// One unified step list, identical for signed-in or guest, owner or not -
// there is no more resume seam: the tour never spans a redirect (nothing in
// it triggers one - Google sign-in isn't offered mid-tour any more), so it
// always starts fresh at Welcome.
function startOnboardingTour() {
  if (tour) return
  // A replayed tour must re-arm its own capture from scratch - a stale id
  // left over from a PREVIOUS run (e.g. Settings -> Tutorials -> Replay
  // Tutorial after already having gone through it once) would let the
  // results step read an id that has nothing to do with the NEW practice
  // session about to be created.
  lastLoggedSessionId = null
  const steps = buildOnboardingSteps()
  tour = {
    steps,
    index: 0,
    entered: -1,
    timers: [],
    cleanupStep: null,
    savedAutoDarken: state.autoDarken,
    obs: null,
    notReadyCount: 0,
    scanning: false,
    backJumps: 0,
    retryId: null,
    maxIndexReached: 0,
    lastOcclusionCheckAt: 0,
    // Economics (see coinBalance()/renderShop()/completeOnboardingPurchase()):
    // coinBonusShown flips true once the coin-popup step is dismissed (never
    // for an existing owner - see that step's enter()); wavingPurchased
    // flips true once the real purchase actually lands. Nothing is written
    // to either profile/state until wavingPurchased does.
    coinBonusShown: false,
    wavingPurchased: false,
  }
  // Suppressed for the whole tour, not just the timer steps - simplest way
  // to guarantee the screen never auto-darkens mid-instruction. Restored to
  // the user's real setting (not hardcoded true) the moment the tour ends.
  state.autoDarken = false
  save()
  document.addEventListener('visibilitychange', onTourVisibilityChange)
  tourMount()
  tourSync()
}

// Navigating away from the app entirely (backgrounding, switching tabs) ends
// the tour silently - and, now that nothing is written server/state-side
// until the purchase actually completes (see completeOnboardingPurchase()),
// an INCOMPLETE tour must NOT mark onboarding done: markDone=false here so
// it simply restarts from Welcome next time Home loads. Abandoning forfeits
// nothing (nothing was granted yet) and grants nothing (nothing was
// written). Any practice session already logged during the abandoned run is
// left as-is - not cleaned up.
function onTourVisibilityChange() {
  if (document.hidden && tour) endOnboardingTour(false)
}

function tourClearTimers() {
  if (!tour) return
  tour.timers.forEach(clearTimeout)
  tour.timers = []
  tour.retryId = null
}

function endOnboardingTour(markDone) {
  if (!tour) return
  tourClearTimers()
  if (tour.cleanupStep) { try { tour.cleanupStep() } catch {} }
  if (tour.obs) tour.obs.disconnect()
  document.removeEventListener('visibilitychange', onTourVisibilityChange)
  document.removeEventListener('click', tourExplainClickHandler)
  window.removeEventListener('resize', tourReposition)
  window.removeEventListener('scroll', tourReposition, true)
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', tourReposition)
    window.visualViewport.removeEventListener('scroll', tourReposition)
  }
  state.autoDarken = tour.savedAutoDarken
  save()
  document.getElementById('tour-root')?.remove()
  tour = null
  if (markDone) markOnboardingDone()
}

// Advancing NEVER ends the tour early except off the very last step - only
// Skip Tutorial / "I'm a pro." end it before that.
function tourAdvance() {
  if (!tour) return
  if (tour.index >= tour.steps.length - 1) { endOnboardingTour(true); return }
  tour.index += 1
  tour.maxIndexReached = Math.max(tour.maxIndexReached, tour.index)
  tour.entered = -1
  tourSync()
}

function tourExplainClickHandler() { tourAdvance() }
function tourReposition() { tourSync() }

function tourMount() {
  const root = document.createElement('div')
  root.id = 'tour-root'
  root.className = 'tour-root'
  root.innerHTML = `
    <div class="tour-block tour-block-t" hidden></div>
    <div class="tour-block tour-block-b" hidden></div>
    <div class="tour-block tour-block-l" hidden></div>
    <div class="tour-block tour-block-r" hidden></div>
    <div class="tour-block tour-block-corner" id="tour-corner-tl" hidden></div>
    <div class="tour-block tour-block-corner" id="tour-corner-tr" hidden></div>
    <div class="tour-block tour-block-corner" id="tour-corner-bl" hidden></div>
    <div class="tour-block tour-block-corner" id="tour-corner-br" hidden></div>
    <div class="tour-ring" id="tour-ring" hidden></div>
    <div class="tour-arrow" id="tour-arrow" hidden>👇</div>
    <div class="popup tour-card" id="tour-card" hidden><p></p></div>
    <div class="tour-topright">
      <button class="tour-skip-btn" type="button" id="tour-skip">Skip Tutorial</button>
      <button class="tour-pro-btn" type="button" id="tour-pro">I'm a pro.</button>
    </div>
    <p class="tour-hint" id="tour-hint" hidden>Tap anywhere to continue</p>
    <pre class="tour-debug" id="tour-debug" hidden></pre>
  `
  document.body.appendChild(root)
  root.querySelector('#tour-skip').addEventListener('click', (e) => { e.stopPropagation(); endOnboardingTour(true) })
  root.querySelector('#tour-pro').addEventListener('click', (e) => { e.stopPropagation(); endOnboardingTour(true) })
  window.addEventListener('resize', tourReposition)
  window.addEventListener('scroll', tourReposition, true)
  // On-screen keyboard resizes the viewport (not window) on most mobile
  // browsers - keep the ring/card following the target through that too.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', tourReposition)
    window.visualViewport.addEventListener('scroll', tourReposition)
  }
  // Re-syncs on every real screen change (new picker, timer, results,
  // history, day sheet…) without the tour needing to know each screen's
  // internals. Mutations caused by the tour's own DOM (repositioning the
  // ring/card each sync) are filtered out below so this can't feedback-loop
  // on itself.
  tour.obs = new MutationObserver((records) => {
    const tourRoot = document.getElementById('tour-root')
    const external = records.some(r => !tourRoot || !tourRoot.contains(r.target))
    if (external) tourSync()
  })
  tour.obs.observe(document.body, { childList: true, subtree: true })
}

// Bottom-layout diagnostic, opt-in via ?uidebug=1 (persisted). The gap BELOW
// the tab bar on real iOS cannot be reproduced in a headless browser (there
// the tab bar's bottom lands exactly at innerHeight in both engines), so this
// prints the real device's own numbers on screen for a single screenshot to
// diagnose from - which of these is true decides the fix:
//   tabbarBottom < vh      -> fixed bottom:0 isn't reaching the true bottom
//   vh < visualViewport    -> a UI band (Safari toolbar) is eating the bottom
//   safeBottom large/odd   -> the home-indicator inset is the whole gap
// Pinned to the TOP so the very gap it's diagnosing can't hide it.
function uiDebugEnabled() {
  try {
    if (new URLSearchParams(location.search).get('uidebug') === '1') localStorage.setItem('cp-uidebug', '1')
    if (new URLSearchParams(location.search).get('uidebug') === '0') localStorage.removeItem('cp-uidebug')
    return localStorage.getItem('cp-uidebug') === '1'
  } catch { return false }
}
let uiDebugInterval = null
function removeUiDebug() {
  if (uiDebugInterval) { clearInterval(uiDebugInterval); uiDebugInterval = null }
  document.getElementById('ui-debug')?.remove()
  document.getElementById('ui-debug-probe')?.remove()
}
// Flip the persisted flag AND apply it live (no reload needed - the standalone
// webapp can't be relaunched with a URL param anyway). See the version-row
// tap handler in renderSettings.
function toggleUiDebug() {
  try {
    if (localStorage.getItem('cp-uidebug') === '1') { localStorage.removeItem('cp-uidebug'); removeUiDebug() }
    else { localStorage.setItem('cp-uidebug', '1'); installUiDebug() }
  } catch {}
}
function installUiDebug() {
  if (!uiDebugEnabled()) return
  if (document.getElementById('ui-debug')) return // idempotent - already shown
  const el = document.createElement('pre')
  el.id = 'ui-debug'
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;margin:0;padding:6px 8px;' +
    'background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;' +
    'pointer-events:none;text-shadow:0 1px 1px #000'
  document.body.appendChild(el)
  // Probe element to read the real env(safe-area-inset-*) values as computed px.
  const probe = document.createElement('div')
  probe.id = 'ui-debug-probe'
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;' +
    'padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top);visibility:hidden'
  document.body.appendChild(probe)
  const render = () => {
    const vv = window.visualViewport
    const tb = document.querySelector('.tabbar')
    const tbr = tb ? tb.getBoundingClientRect() : null
    const appEl = document.getElementById('app')
    const ar = appEl ? appEl.getBoundingClientRect() : null
    const ps = getComputedStyle(probe)
    const safeBottom = parseFloat(ps.paddingBottom) || 0
    const safeTop = parseFloat(ps.paddingTop) || 0
    const tbhVar = getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h').trim()
    const standalone = (matchMedia('(display-mode: standalone)').matches) ||
      (typeof navigator.standalone !== 'undefined' && navigator.standalone)
    el.textContent =
      `vh(innerHeight)=${innerHeight}  screen=${screen.height}  dpr=${devicePixelRatio}\n` +
      `visualViewport h=${vv ? Math.round(vv.height) : '-'} offsetTop=${vv ? Math.round(vv.offsetTop) : '-'}\n` +
      `docEl.clientHeight=${document.documentElement.clientHeight}\n` +
      `safe-area bottom=${safeBottom.toFixed(1)}  top=${safeTop.toFixed(1)}\n` +
      `--tabbar-h=${tbhVar || '(unset)'}\n` +
      `tabbar: top=${tbr ? Math.round(tbr.top) : '-'} bottom=${tbr ? Math.round(tbr.bottom) : '-'} h=${tbr ? Math.round(tbr.height) : '-'}\n` +
      `GAP below tabbar (vh - bottom)=${tbr ? Math.round(innerHeight - tbr.bottom) : '-'}\n` +
      `GAP below tabbar (vv - bottom)=${tbr && vv ? Math.round(vv.height - tbr.bottom) : '-'}\n` +
      `#app: bottom=${ar ? Math.round(ar.bottom) : '-'} h=${ar ? Math.round(ar.height) : '-'}\n` +
      `standalone=${standalone}`
  }
  render()
  uiDebugInterval = setInterval(render, 500)
  ;['resize', 'scroll', 'orientationchange'].forEach(e => window.addEventListener(e, render, { passive: true }))
  if (window.visualViewport) window.visualViewport.addEventListener('resize', render)
}

// Diagnostic readout, opt-in via ?tourdebug=1 (persisted). Renders the
// tour's ACTUAL state into the corner of the screen so a screenshot of a
// stuck tour carries its own diagnosis - a stranded tour and a working one
// are visually identical once the chrome hides, which is exactly why
// several "fixed" strand bugs kept coming back. Also prints the shell
// metrics, since iOS standalone letterboxing cannot be reproduced in a
// headless browser at all.
function tourDebugEnabled() {
  try {
    if (new URLSearchParams(location.search).get('tourdebug') === '1') localStorage.setItem('cp-tourdebug', '1')
    return localStorage.getItem('cp-tourdebug') === '1'
  } catch { return false }
}
function tourDebugRender() {
  const el = document.getElementById('tour-debug')
  if (!el) return
  if (!tourDebugEnabled() || !tour) { el.hidden = true; return }
  const step = tour.steps[tour.index]
  let ready = 'n/a'
  try { ready = step && step.ready ? String(step.ready()) : 'true' } catch (e) { ready = 'THREW' }
  const probes = tour.steps
    .map((st, i) => (i > tour.index && st.probe && (() => { try { return st.probe() } catch { return false } })()) ? `${i}:${st.id}` : null)
    .filter(Boolean).slice(0, 3).join(',') || 'none'
  const vv = window.visualViewport
  const appEl = document.getElementById('app')
  const tb = document.querySelector('.tabbar')
  const gap = tb ? Math.round((vv ? vv.height : innerHeight) - tb.getBoundingClientRect().bottom) : '?'
  el.hidden = false
  el.textContent =
    `${tour.index + 1}/${tour.steps.length} ${step ? step.id : 'END'} ready=${ready}\n` +
    `probes=${probes} notReady=${tour.notReadyCount || 0}\n` +
    `vh=${innerHeight} vv=${vv ? Math.round(vv.height) : '-'} app=${appEl ? Math.round(appEl.getBoundingClientRect().height) : '-'} gap=${gap}`
}

function tourSetVisible(show) {
  const root = document.getElementById('tour-root')
  if (!root) return
  // .tour-hint is handled separately in tourPositionForStep (only shown for
  // explain, non-silent steps) - don't force it visible here.
  root.querySelectorAll('.tour-card, .tour-ring, .tour-arrow').forEach(el => { el.hidden = !show })
  const hint = root.querySelector('.tour-hint')
  if (hint && !show) hint.hidden = true
  if (!show) tourClearBlockers()
}

function tourSync() {
  if (!tour) return
  let step = tour.steps[tour.index]
  if (!step) { endOnboardingTour(true); return }
  let ready = step.ready ? step.ready() : true
  if (!ready) {
    tour.notReadyCount = (tour.notReadyCount || 0) + 1
    // Generic backstop for the LAST step only: if it's the final step (e.g.
    // add-to-homescreen, whose target vanishes once the chef taps through to
    // the guide subpage) and it's stayed not-ready for ~5s of retries (20 *
    // 250ms), the tour would otherwise hide its chrome but leave #tour-root
    // (and the Skip Tutorial button) mounted forever with nothing left to
    // recover it. End the tour instead of waiting indefinitely.
    if (tour.index === tour.steps.length - 1 && tour.notReadyCount >= 20) {
      endOnboardingTour(true)
      return
    }
    // Self-healing: if the real screen has moved on faster than the tour
    // card was tapped, the current step's ready() can go permanently
    // false (e.g. mid-tour the chef already advanced past this screen).
    // Scan FORWARD ONLY for the first later step whose PURE, side-effect-
    // free `probe()` says its target already exists, and jump to it,
    // rather than stranding the tour hidden forever. Only after two
    // consecutive not-ready syncs, so a step's ready() that's merely
    // momentarily false (e.g. pause-timer's 2s arming window) isn't
    // mistaken for "the chef skipped ahead".
    //
    // Deliberately does NOT call ready() in the scan: several steps have no
    // ready() at all (welcome, coin-popup) and `candidate.ready ?
    // candidate.ready() : true` would treat those as unconditionally ready,
    // teleporting the tour to the end. Only steps that opt in with an
    // explicit `probe` are ever considered a match; every other step
    // (including side-effecting ready()s like pause-timer's timer-arm or
    // the shopKicked/homeKicked/settingsKicked screen kickers) is skipped
    // by the scan entirely. Re-entrancy guard (tour.scanning) is scoped
    // ONLY to the scan loop below, not the render/enter path further down,
    // so a step's enter() that synchronously calls tourAdvance() can still
    // recurse into tourSync() and render normally.
    //
    // The lookahead window is capped at 3 steps, not scanned to the end of
    // the array: this scan is meant to recover across ONE screen
    // transition, not to teleport across the whole tutorial. An unbounded
    // scan let a step whose target happens to live on a persistent screen
    // (e.g. see-all's "See All Sessions" button, which is always present on
    // Home) act as a magnet - a spurious not-ready blip anywhere earlier in
    // the tour could jump 8 steps ahead to it and strand everything in
    // between with no way back.
    // Forward scan finding nothing doesn't necessarily mean the tour is
    // merely waiting on the next screen - the tour's index can also end up
    // AHEAD of the screen the chef is actually on (e.g. replaying the tour
    // signed-in and landing back on an earlier picker). A forward-only scan
    // can never recover that case: it looks past the step that would
    // match and finds nothing, stranding the tour with chrome still
    // mounted. So a BACKWARD scan runs next, same probe-only rule, bounded
    // both in range (index-1..index-3) and in total jumps for the whole
    // tour run (tour.backJumps, capped at 3) - backward jumps are how a
    // scan can start oscillating, so this keeps any back-and-forth to a
    // handful of moves at most. Forward always runs first and wins a tie.
    if (tour.notReadyCount >= 2 && !tour.scanning) {
      tour.scanning = true
      try {
        // A probe() match only means "this step's target exists on screen" -
        // it is NOT a promise the step is ready to display. Some steps
        // (pause-timer) have a ready() that gates on more than DOM
        // existence - a deliberate ~2s arming delay so the spotlight
        // doesn't fight the "Start Cooking!" splash. Forcing ready = true
        // on a scan match rendered pause-timer instantly (a visible flash),
        // only for the very next sync's honest ready() call to arm the
        // delay and hide it again, before it reappeared correctly 2s later.
        // So a match re-evaluates the candidate's OWN ready() honestly
        // instead of assuming it - if that's false, this falls through to
        // the existing hide-and-wait path below, and the 250ms retry tick
        // picks it up the instant the step's own gate actually opens. This
        // is structural, not a pause-timer special case: it protects any
        // future step whose ready() gates on timing rather than DOM alone.
        const scanEnd = Math.min(tour.index + 3, tour.steps.length - 1)
        for (let i = tour.index + 1; i <= scanEnd; i++) {
          const candidate = tour.steps[i]
          if (candidate.probe && candidate.probe()) {
            tour.index = i
            tour.maxIndexReached = Math.max(tour.maxIndexReached, i)
            tour.entered = -1
            tour.notReadyCount = 0
            step = candidate
            ready = step.ready ? step.ready() : true
            break
          }
        }
        // Never let a backward jump target a step the tour has already
        // moved past in this run (further back than maxIndexReached - 1) -
        // e.g. during the results video, results.ready() is false and
        // pause-timer's probe (.timer-value) can still momentarily match if
        // that DOM hasn't been torn down yet, which would otherwise yank
        // the tour backwards to an already-completed step and require a
        // second recovery.
        if (!ready && tour.backJumps < 3) {
          const backEnd = Math.max(tour.index - 3, 0, tour.maxIndexReached - 1)
          for (let i = tour.index - 1; i >= backEnd; i--) {
            const candidate = tour.steps[i]
            if (candidate.probe && candidate.probe()) {
              tour.index = i
              tour.entered = -1
              tour.notReadyCount = 0
              tour.backJumps += 1
              step = candidate
              ready = step.ready ? step.ready() : true
              break
            }
          }
        }
      } finally {
        tour.scanning = false
      }
    }
    if (!ready) {
      // A step's watch() is its "the goal state was reached" trigger, and
      // for several steps reaching that goal is EXACTLY what makes ready()
      // go false (confirm-delete: the delete succeeds, so the confirm popup
      // - its own target - disappears). Running watch() only on the ready
      // path therefore made those watches unreachable at the one moment
      // they mattered, stranding the tour with nothing able to advance it.
      // Run it here first; if it advances, the sync for the new step takes
      // over and this one must not continue tearing chrome down.
      if (step.watch) {
        const before = tour.index
        try { step.watch() } catch {}
        if (!tour || tour.index !== before) return
      }
      tourDebugRender()
      tourSetVisible(false)
      if (tour.cleanupStep) { try { tour.cleanupStep() } catch {}; tour.cleanupStep = null }
      document.removeEventListener('click', tourExplainClickHandler)
      tour.entered = -1
      // tourSync is otherwise purely event-driven (MutationObserver records,
      // window resize/scroll) - if the current step's ready() is false at
      // the moment of the last such event (the screen is mid-render, an
      // async/late render, a multi-second video playing before the DOM the
      // step targets ever shows up), nothing re-checks it and the tour sits
      // idle until some UNRELATED event happens to fire (which is why
      // tapping the dead screen "fixes" it). Self-retry so it recovers
      // without needing that. Goes through the normal tourSync path, so the
      // forward/backward scans above still apply on each tick. Deliberately
      // UNCAPPED - it retries every 250ms for as long as the tour stays
      // mounted and the step stays not-ready. A cap bought nothing (a
      // 250ms no-op check is free) and could only ever cause a strand: the
      // results step, gated behind a multi-second results video on device,
      // could legitimately stay not-ready longer than any fixed cap.
      if (tour.retryId == null) {
        tour.retryId = setTimeout(() => {
          if (!tour) return
          tour.retryId = null
          tourSync()
        }, 250)
        tour.timers.push(tour.retryId)
      }
      return
    }
  }
  tour.notReadyCount = 0
  tourSyncEnter(step)
  tourDebugRender()
}

function tourSyncEnter(step) {
  tourSetVisible(true)
  if (tour.entered !== tour.index) {
    tour.entered = tour.index
    tourClearTimers()
    if (tour.cleanupStep) { try { tour.cleanupStep() } catch {}; tour.cleanupStep = null }
    document.removeEventListener('click', tourExplainClickHandler)
    // Silent steps (a real popup/screen elsewhere is doing the talking - e.g.
    // the reused coin-info popup, or a background coin-claim RPC with nothing
    // to show at all) drive their own advance from enter(); the generic
    // tap-anywhere handler would just be a second, redundant way to dismiss.
    // Deferred by a tick: if THIS step was entered as a consequence of a
    // click (e.g. tapping "Continue without signing in" jumps the tour
    // straight to add-to-homescreen via tour.index = idx; tourSync()), that
    // same click event is still bubbling up the DOM. Attaching the handler
    // synchronously let it catch that same bubbling click and immediately
    // advance past the step the chef was never shown. The setTimeout(...,0)
    // pushes the attach past the current event's bubble phase; the guard
    // re-checks the tour still exists and is still on this exact step
    // object, so a fast subsequent transition can't attach a handler for a
    // step that's already been left.
    if (step.kind === 'explain' && !step.silent) {
      const attachId = setTimeout(() => {
        if (tour && tour.steps[tour.index] === step) document.addEventListener('click', tourExplainClickHandler)
      }, 0)
      tour.timers.push(attachId)
    }
    const enterCleanup = step.enter ? step.enter() : null

    // Modal cards animate in with a scale transform - `.popup`'s `pop`
    // keyframes and `.pause-content`'s springy content-pop-in - and
    // getBoundingClientRect() taken right now (the instant the step is
    // entered) can measure the target mid-animation: still scaled down, or
    // overshooting on the springy cubic-bezier. The ring/card were
    // positioned from that transitional rect and then never re-measured,
    // since the retry tick only fires while a step is NOT ready - once
    // ready, the engine goes idle until an external event. Re-measure a
    // few times on a fixed schedule as the animation settles; tourSync()
    // on an already-entered, still-ready step is a cheap no-op (just
    // re-runs tourPositionForStep, which is idempotent) when nothing moved.
    const retimer = (ms) => { const id = setTimeout(() => { if (tour) tourSync() }, ms); tour.timers.push(id); return id }
    retimer(120); retimer(300); retimer(500)

    // Belt and braces: a one-shot `animationend` listener on the modal
    // container itself (not purely time-based), guarded so it can't leak
    // across steps - removed via tour.cleanupStep below, which every next
    // step's entry (and endOnboardingTour) already calls before doing
    // anything else.
    let animCleanup = null
    const target = step.getTarget ? step.getTarget() : null
    const modalEl = target ? (target.closest('.popup') || target.closest('.pause-content')) : null
    if (modalEl) {
      const onAnimEnd = () => { if (tour) tourSync() }
      modalEl.addEventListener('animationend', onAnimEnd, { once: true })
      animCleanup = () => modalEl.removeEventListener('animationend', onAnimEnd)
    }

    tour.cleanupStep = () => {
      if (enterCleanup) { try { enterCleanup() } catch {} }
      if (animCleanup) { try { animCleanup() } catch {} }
    }
  }
  // A step's spotlight target can change WITHOUT the tour re-entering the
  // step - buy-waving's getTarget()/text are getters that switch from the
  // "Buy" button to the confirm popup's "Yes, unlock it" once that popup
  // opens (see its definition). The retimer/animationend re-measure above
  // only runs on step ENTRY (tour.entered !== tour.index), so a target swap
  // like that skipped it entirely: the confirm popup's own pop-in scale
  // animation was measured once, mid-animation, and never re-measured -
  // this is what produced a ring permanently sized to the popup's smaller,
  // pre-animation state. Detect the swap here and re-arm the same settle
  // schedule for the new target.
  const liveTarget = step.getTarget ? step.getTarget() : null
  if (liveTarget && liveTarget !== tour.lastPositionedTarget) {
    tour.lastPositionedTarget = liveTarget
    const retimer = (ms) => { const id = setTimeout(() => { if (tour) tourSync() }, ms); tour.timers.push(id) }
    retimer(120); retimer(300); retimer(500)
    const modalEl = liveTarget.closest('.popup') || liveTarget.closest('.pause-content')
    if (modalEl) {
      const onAnimEnd = () => { if (tour) tourSync() }
      modalEl.addEventListener('animationend', onAnimEnd, { once: true })
    }
  }
  tourPositionForStep(step)
  // Runs on every sync (not just on entering the step), so a step can watch
  // for a real state change - e.g. a purchase completing elsewhere on
  // screen - and advance itself without needing its own click handler.
  if (step.watch) { try { step.watch() } catch {} }
}

function tourApplyBlockers(rect, pad, vp, cornerRadiusPx) {
  // rect and vw/vh are all in visual-viewport-relative space (see
  // tourTargetRect/tourViewport); convert back to layout-viewport
  // coordinates (add the offset back) only at the point of painting, since
  // position:fixed elements are painted relative to the layout viewport.
  const vw = vp.width, vh = vp.height
  const ox = vp.offsetLeft, oy = vp.offsetTop
  const top = document.querySelector('.tour-block-t')
  const bottom = document.querySelector('.tour-block-b')
  const left = document.querySelector('.tour-block-l')
  const right = document.querySelector('.tour-block-r')
  const x0 = Math.max(0, rect.left - pad), x1 = Math.min(vw, rect.right + pad)
  const y0 = Math.max(0, rect.top - pad), y1 = Math.min(vh, rect.bottom + pad)
  top.hidden = false; bottom.hidden = false; left.hidden = false; right.hidden = false
  top.style.cssText = `left:${ox}px; top:${oy}px; width:${vw}px; height:${Math.max(0, y0)}px;`
  bottom.style.cssText = `left:${ox}px; top:${oy + y1}px; width:${vw}px; height:${Math.max(0, vh - y1)}px;`
  left.style.cssText = `left:${ox}px; top:${oy + y0}px; width:${Math.max(0, x0)}px; height:${Math.max(0, y1 - y0)}px;`
  right.style.cssText = `left:${ox + x1}px; top:${oy + y0}px; width:${Math.max(0, vw - x1)}px; height:${Math.max(0, y1 - y0)}px;`
  // The four rects above cut a perfectly RECTANGULAR hole - but the ring
  // drawn inside it is rounded (border-radius, up to a full pill). That
  // mismatch leaves the hole's four square corners dimmed by nothing at
  // all: real, undimmed app background peeking through in a faint
  // rectangle exactly at the hole's bounding box, behind every rounded
  // spotlighted button. A quarter-circle "cap" patch at each hole corner -
  // same dim colour, rounded only on the corner facing the hole's centre -
  // fills exactly that gap. Sized to `pad` (the hole's own inset from the
  // target rect) - NOT the ring's full corner radius, which was the bug:
  // a pill/rounded button's ring radius is often much larger than the 10px
  // gap between the hole edge and the button's own edge, so capping to it
  // painted dim colour past the hole boundary and onto the button's own
  // face/corners. `pad` is the one value guaranteed to fit inside the gap
  // on every side.
  const r = Math.max(0, Math.min(pad || 0, (x1 - x0) / 2, (y1 - y0) / 2))
  const tl = document.getElementById('tour-corner-tl')
  const tr = document.getElementById('tour-corner-tr')
  const bl = document.getElementById('tour-corner-bl')
  const br = document.getElementById('tour-corner-br')
  if (r > 0.5) {
    tl.hidden = false; tr.hidden = false; bl.hidden = false; br.hidden = false
    tl.style.cssText = `left:${ox + x0}px; top:${oy + y0}px; width:${r}px; height:${r}px; border-bottom-right-radius:${r}px;`
    tr.style.cssText = `left:${ox + x1 - r}px; top:${oy + y0}px; width:${r}px; height:${r}px; border-bottom-left-radius:${r}px;`
    bl.style.cssText = `left:${ox + x0}px; top:${oy + y1 - r}px; width:${r}px; height:${r}px; border-top-right-radius:${r}px;`
    br.style.cssText = `left:${ox + x1 - r}px; top:${oy + y1 - r}px; width:${r}px; height:${r}px; border-top-left-radius:${r}px;`
  } else {
    tl.hidden = true; tr.hidden = true; bl.hidden = true; br.hidden = true
  }
}

function tourClearBlockers() {
  document.querySelectorAll('.tour-block').forEach(b => { b.hidden = true; b.style.cssText = '' })
}

// No target (explain steps only, e.g. `welcome`): a single full-viewport
// dim. NET RULE for the whole tour engine: at every point, exactly three
// things are tappable on screen - the current step's real target (if it
// has one), Skip Tutorial, and I'm a pro. Nothing else. This dim used to be
// pointer-events:none "so explain steps let the real underlying control
// still receive it" - that was the bug: with no target to protect, that
// meant EVERYTHING behind the tour (Settings rows, tab bar, every button)
// stayed live while the tour looked modal. Now pointer-events:auto - the
// dim swallows the tap instead of passing it through. tourExplainClickHandler
// is bound to `document`, not to this element, and nothing here calls
// stopPropagation/preventDefault, so a tap on the dim still bubbles up to
// document and still advances the tour exactly as before - only taps on
// the REAL app underneath are now blocked.
function tourDimFull() {
  const top = document.querySelector('.tour-block-t')
  document.querySelector('.tour-block-b').hidden = true
  document.querySelector('.tour-block-l').hidden = true
  document.querySelector('.tour-block-r').hidden = true
  top.hidden = false
  top.style.cssText = 'left:0; top:0; width:100%; height:100%; pointer-events:auto; background:rgba(8,5,3,0.5);'
}

function tourPositionCard(card, rect, arrowBelow, vp, avoidRect) {
  const vw = vp.width, vh = vp.height
  const cardW = Math.min(320, vw - 32)
  const estH = card.offsetHeight || 120
  let top
  if (avoidRect) {
    // Target sits inside a real modal card (see tourPositionForStep) - the
    // tour's own card must never overlap the modal's layout, so it's placed
    // OUTSIDE the modal's bounding rect entirely: below its bottom edge if
    // there's room, otherwise above its top edge. Never relative to the
    // target's own (smaller) rect, which would still land inside the modal.
    top = avoidRect.bottom + 16
    if (top + estH > vh - 104) top = Math.max(64, avoidRect.top - estH - 16)
  } else {
    // Vertical placement: below the target, flipping above when it would run
    // off the bottom of the viewport. When the directional arrow itself has
    // been flipped below the target (no room above it - see
    // tourPositionForStep), the card's usual rect.bottom + 16 start would
    // stack directly on top of the arrow (which occupies roughly
    // rect.bottom+8..rect.bottom+42), rendering it invisible underneath the
    // card - start lower to clear it instead.
    top = arrowBelow ? rect.bottom + 50 : rect.bottom + 16
    if (top + estH > vh - 104) top = Math.max(64, rect.top - estH - 16)
  }
  // Horizontal placement is unconditionally centered on the VIEWPORT
  // (never anchored to the target's horizontal center) - anchoring to an
  // off-center target's position made the card look misaligned rather than
  // deliberate.
  const left = (vw - cardW) / 2
  card.style.cssText = `left:${vp.offsetLeft + left}px; top:${vp.offsetTop + top}px; width:${cardW}px;`
}

// Positions .tour-hint immediately below the tour card, horizontally
// centered on the card, clamped to stay on-screen and never overlap the
// spotlight ring/target. Only called for steps where the hint is visible
// (kind 'explain' && !step.silent - see tourPositionForStep).
function tourPositionHint(hint, card, ringRect, vp) {
  const vw = vp.width, vh = vp.height
  const cardRect = card.getBoundingClientRect()
  const hintH = hint.offsetHeight || 20
  let top = cardRect.bottom + 8 - vp.offsetTop
  // Keep clear of the spotlight ring if it would otherwise overlap.
  if (ringRect && top < ringRect.bottom + 8 && top + hintH > ringRect.top - 8) {
    top = ringRect.bottom + 8
  }
  top = Math.min(top, vh - hintH - 8)
  const cardCenter = cardRect.left - vp.offsetLeft + cardRect.width / 2
  const hintW = Math.min(280, vw - 32)
  const left = Math.min(Math.max(16, cardCenter - hintW / 2), vw - hintW - 16)
  hint.style.cssText = `left:${vp.offsetLeft + left}px; top:${vp.offsetTop + top}px; width:${hintW}px;`
}

// Single source of truth for all tour positioning math. iOS's on-screen
// keyboard shrinks the VISUAL viewport (window.visualViewport) and offsets
// it from the layout viewport's origin (offsetLeft/offsetTop) without
// changing window.innerWidth/innerHeight - every clamp below must use the
// visual viewport's size, or chrome gets clamped against space the keyboard
// has actually covered. Falls back to window.innerWidth/innerHeight when
// visualViewport isn't supported.
function tourViewport() {
  const vv = window.visualViewport
  if (vv) return { width: vv.width, height: vv.height, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop }
  return { width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 }
}

// getBoundingClientRect() is relative to the LAYOUT viewport's origin.
// Every positioning calculation below works in visual-viewport-relative
// space (0,0 = the visual viewport's top-left), so subtract the offset here
// once, up front - callers add it back only at the moment they paint fixed-
// position tour chrome (position:fixed is painted relative to the layout
// viewport, not the visual one, so the two conversions cancel out and the
// chrome lines up with the real target regardless of what the keyboard has
// scrolled/shrunk).
function tourTargetRect(target, vp) {
  const r = target.getBoundingClientRect()
  return {
    top: r.top - vp.offsetTop,
    bottom: r.bottom - vp.offsetTop,
    left: r.left - vp.offsetLeft,
    right: r.right - vp.offsetLeft,
    width: r.width,
    height: r.height,
  }
}

function tourPositionForStep(step) {
  const card = document.getElementById('tour-card')
  const ring = document.getElementById('tour-ring')
  const arrow = document.getElementById('tour-arrow')
  const hint = document.getElementById('tour-hint')
  if (!card || !ring || !arrow) return
  // A silent step reuses a REAL popup/screen to explain itself (e.g. the
  // existing coin-info popup) rather than drawing the tour's own card over
  // it, so hide every bit of tour chrome (it'd otherwise sit at a higher
  // z-index than that real popup and visually stack on top of it).
  if (step.silent) {
    card.hidden = true
    ring.hidden = true
    arrow.hidden = true
    if (hint) hint.hidden = true
    tourClearBlockers()
    document.querySelectorAll('.tour-block').forEach(b => { b.hidden = true })
    return
  }
  card.querySelector('p').innerHTML = step.text
  const showHint = step.kind === 'explain' && !step.silent
  // Per-step override (e.g. equipped-shown's "Tap anywhere to dismiss") -
  // falls back to the original universal copy for every other explain step.
  if (hint) hint.textContent = step.hintText || 'Tap anywhere to continue'
  const target = step.getTarget ? step.getTarget() : null
  if (!target) {
    ring.hidden = true
    arrow.hidden = true
    tourDimFull()
    card.classList.add('tour-card-center')
    card.style.cssText = ''
    if (hint) {
      hint.hidden = !showHint
      if (showHint) tourPositionHint(hint, card, null, tourViewport())
    }
    return
  }
  card.classList.remove('tour-card-center')
  const vp = tourViewport()
  // With the iOS soft keyboard open, the visual viewport shrinks by however
  // much the keyboard covers - computing a "correct" ring/card position in
  // that state proved unreliable in practice for every step tried (not just
  // the input-focused one: e.g. task-done's Done button also renders with
  // the ring floating over the wrong content while the keyboard is up).
  // Rather than keep chasing exact positioning against a viewport that's
  // actively changing, drop the spotlight entirely while the keyboard is
  // open and pin a plain instruction card to the top of the visual
  // viewport instead - a card that's definitely readable beats a ring
  // that's potentially in the wrong place. Normal ring+blockers behaviour
  // resumes the instant the keyboard closes (the visualViewport resize
  // listener re-syncs then).
  const vv = window.visualViewport
  const keyboardOpen = !!vv && (window.innerHeight - vv.height) > 150
  if (keyboardOpen) {
    ring.hidden = true
    arrow.hidden = true
    tourClearBlockers()
    if (hint) hint.hidden = true
    card.classList.remove('tour-card-center')
    const cardW = Math.min(320, vp.width - 32)
    const left = vp.offsetLeft + (vp.width - cardW) / 2
    const top = vp.offsetTop + 12
    card.style.cssText = `left:${left}px; top:${top}px; width:${cardW}px;`
    return
  }
  let rect = tourTargetRect(target, vp)
  // If the target is wholly or partly outside the visible (visual) viewport
  // - e.g. "See All Sessions" sitting below the fold on a real phone -
  // scroll it into view before positioning, otherwise the ring/card render
  // off-screen and the tour looks dead. Guarded to only fire when the
  // target is actually out of view, so it never fights the chef's own
  // scrolling on every sync.
  const outOfView = rect.top < 0 || rect.bottom > vp.height || rect.left < 0 || rect.right > vp.width
  if (outOfView) {
    target.scrollIntoView({ block: 'center', behavior: 'auto' })
    rect = tourTargetRect(target, vp)
  }
  // Occlusion check: a target can sit fully inside the visual viewport (the
  // outOfView guard above finds nothing wrong) yet still be hidden behind
  // fixed chrome like .tabbar - e.g. "See All Sessions" spotlighted while
  // sitting behind the tab bar. Blockers then swallow scroll gestures, so
  // the chef can't rescue it manually. Probe the target's centre point with
  // elementFromPoint; if something else is on top, scroll the target into
  // view and re-measure. Modal targets never scroll, so skip there. Rate
  // limited to once per 800ms per step-entry so it can't fight re-syncs.
  if (target && !target.closest('.popup')) {
    const now = Date.now()
    if (!tour.lastOcclusionCheckAt || now - tour.lastOcclusionCheckAt > 800) {
      tour.lastOcclusionCheckAt = now
      const cx = vp.offsetLeft + rect.left + rect.width / 2
      const cy = vp.offsetTop + rect.top + rect.height / 2
      const topEl = document.elementFromPoint(cx, cy)
      const occluded = topEl && topEl !== target && !target.contains(topEl) && !topEl.contains(target)
      if (occluded) {
        target.scrollIntoView({ block: 'center', behavior: 'auto' })
        rect = tourTargetRect(target, vp)
      }
    }
  }
  // Uniform pad on all four sides so the ring stays concentric with the
  // target - an earlier asymmetric bottom pad (meant to cover buttons'
  // raised 3D shadow lip) skewed the box off-center, which on a pill button
  // read as the ring cutting through it rather than framing it. A slightly
  // generous, perfectly concentric ring is correct even if the lip still
  // peeks outside it; a tight skewed one is not.
  const pad = 10
  ring.hidden = false
  const cs = getComputedStyle(target)
  const parsedRadius = parseFloat(cs.borderRadius) || 0
  // Pill-shaped buttons report a huge (browser-clamped) border-radius -
  // snap those to a full 999px pill so the ring's corners don't visibly
  // undershoot the button's actual rounding.
  const isPill = parsedRadius >= Math.min(rect.width, rect.height) / 2 - 1
  const ringRadius = isPill ? '999px' : `${parsedRadius + pad}px`
  // Numeric px version for the blocker corner patches below - "999px" as a
  // CSS string clamps itself automatically in the browser, but JS needs a
  // real number to size those patches, so pill buttons use the same
  // half-of-the-smaller-side clamp the browser would apply.
  const ringRadiusPx = isPill ? Math.min(rect.width + pad * 2, rect.height + pad * 2) / 2 : parsedRadius + pad
  ring.style.cssText = `left:${vp.offsetLeft + rect.left - pad}px; top:${vp.offsetTop + rect.top - pad}px; width:${rect.width + pad * 2}px; height:${rect.height + pad * 2}px; border-radius:${ringRadius}; --tour-ring-radius:${ringRadius};`
  // When the target lives inside a real modal CARD - overlay()'s `.popup`
  // markup, which has an actual visual boundary (background, radius,
  // shadow) - unlike `.pause-content` (see below), so it CAN be reasoned
  // about geometrically. But cutting a rectangular, sharp-cornered hole
  // around it still doesn't agree with the popup card's own rounded
  // corners/padding - the hole sits visibly inside the card's shape no
  // matter how it's sized, an artifact that can't be fixed by adjusting
  // the rect. overlay() already renders its own dim backdrop and already
  // blocks all interaction with everything behind it, so the tour's own
  // blockers add nothing there except that artifact - skip them
  // entirely for `.popup` targets. The ring still stays on the real
  // target exactly as before, and the card is still positioned outside
  // the modal (that part was already correct). Deliberately NOT applied to
  // `.pause-content` (the pause/End-Early/confirm-end screens' wrapper) -
  // unlike `.popup` it has no background/border/visible boundary of its
  // own, so cutting a hole around its full bounding box produced a large,
  // unjustified rectangle with no edge to explain its shape either. Those
  // steps go back to the original per-target behavior (hole around just
  // the button) instead.
  const modal = target.closest('.popup')
  const blockerRect = modal ? tourTargetRect(modal, vp) : rect
  // NET RULE for the whole tour engine: at every point, exactly three
  // things are tappable - the current step's real target, Skip Tutorial,
  // and I'm a pro. Nothing else. Explain steps WITH a target (e.g.
  // add-to-homescreen) used to skip blockers entirely on the theory that
  // "explain steps let the real underlying control still receive it" -
  // that left the ENTIRE rest of the app live behind the tour (Settings
  // rows, the tab bar, everything), a real trap since a tap meant to
  // dismiss the card could fire a real app action instead. Blockers now
  // apply the same way for kind:'action' and kind:'explain' with a target -
  // the real target stays reachable either way (a tap on it fires its own
  // handler same as before; for explain steps the document-level
  // tourExplainClickHandler ALSO still advances on that same tap, since
  // it's not stopped/prevented), only the rest of the screen is blocked.
  // A target-less explain step (e.g. `welcome`) has nothing to protect, so
  // tourDimFull() above already blocks everything except tour-topright.
  if (modal) {
    tourClearBlockers()
  } else {
    // Blockers use the SAME uniform pad as the ring so the tappable hole
    // exactly matches what's visually lit - different pads would let the
    // hole and the highlight disagree.
    tourApplyBlockers(blockerRect, pad, vp, ringRadiusPx)
  }
  let arrowBelow = false
  if (step.arrow) {
    arrow.hidden = false
    const fitsAbove = rect.top - 46 >= 4
    if (fitsAbove) {
      arrow.textContent = '👇'
      arrow.style.cssText = `left:${vp.offsetLeft + rect.left + rect.width / 2 - 14}px; top:${vp.offsetTop + rect.top - 46}px;`
    } else {
      // No room above the target (e.g. pause-timer's chip sits right at the
      // top of the screen) - flip the arrow below the target instead of
      // clamping it on top, covering the thing it's meant to point at.
      arrowBelow = true
      arrow.textContent = '👆'
      arrow.style.cssText = `left:${vp.offsetLeft + rect.left + rect.width / 2 - 14}px; top:${vp.offsetTop + rect.bottom + 8}px;`
    }
  } else {
    arrow.hidden = true
  }
  // Card placement: normally relative to the target itself. Inside a modal,
  // that would render the tour's own card on top of/overlapping the
  // modal's layout - place it OUTSIDE the modal instead (below its bottom
  // edge if there's room, else above its top edge), never overlapping it.
  tourPositionCard(card, rect, arrowBelow, vp, modal ? blockerRect : null)
  if (hint) {
    hint.hidden = !showHint
    if (showHint) {
      const ringRect = { top: rect.top - pad, bottom: rect.bottom + pad }
      tourPositionHint(hint, card, ringRect, vp)
    }
  }
}

// Wires a tap on `selector` to advance the tour, WITHOUT touching the real
// handler already wired elsewhere for that element - both simply fire.
// Delegated to `document` (queried fresh via e.target.closest() on every
// click) rather than bound to the specific node that exists at enter()
// time: several real screens (the calendar day cell -> day sheet is the
// one that surfaced this) re-render the DOM between enter() and the
// chef's actual tap, which leaves a node-bound listener attached to a
// now-detached element while the visible one is a fresh node with no
// listener at all. getTarget() re-queries every sync, so the RING still
// looks perfectly correct while the advance is silently dead - exactly
// why this was hard to spot. Delegation is immune to this: it only cares
// whether the click's real target matches the selector, never which node
// it was originally bound to.
function tourAdvanceOnRealClick(selector) {
  if (!document.querySelector(selector)) return null
  // Idempotent per step instance - a delegated document listener could
  // otherwise double-fire (e.g. a click that somehow re-dispatches, or a
  // lingering listener from a race with cleanup).
  let advanced = false
  const onClick = (e) => {
    if (advanced) return
    const t = e.target
    if (!(t instanceof Element) || !t.closest(selector)) return
    advanced = true
    tourAdvance()
  }
  // Deferred by a tick, same hazard/guard as tourExplainClickHandler's
  // deferred attach: if THIS step was entered as a consequence of a click
  // (e.g. a previous step's own tourAdvanceOnRealClick firing tourAdvance()
  // from inside a real click handler), that same click event is still
  // bubbling when enter() runs synchronously - attaching immediately would
  // let this new listener catch that same stale click and misfire. The
  // setTimeout(...,0) pushes the attach past the current event's bubble
  // phase; re-checking `tour.steps[tour.index] === step` (captured by
  // reference now, before any async gap) means a fast subsequent step
  // change can't attach a listener for a step that's already been left.
  const step = tour ? tour.steps[tour.index] : null
  const attachId = setTimeout(() => {
    if (tour && tour.steps[tour.index] === step) document.addEventListener('click', onClick, true)
  }, 0)
  if (tour) tour.timers.push(attachId)
  return () => document.removeEventListener('click', onClick, true)
}

function buildOnboardingSteps() {
  // One unified step list, identical for signed-in or guest, owner or not -
  // see the "ONE step list" note at the top of this section. No more
  // eligible/guestQualifies branching: everyone sees the same welcome copy,
  // walks the same coin-popup/buy-waving/equipped-shown sequence, and the
  // economics (who actually gets a coin) are decided entirely inside
  // completeOnboardingPurchase() at purchase time, never here.
  //
  // Closure-scoped (fresh per tour run) so a replayed tour re-arms its own
  // 2-second "let the session actually run" delay from scratch.
  let pauseArmedAt = null
  // Guards pause-timer's advance so it can only ever fire once - it has
  // TWO independent advance triggers (the click handler and watch()'s "the
  // pause overlay is already open" check), same pattern/reason as
  // confirmDeleteAdvanced below.
  let pauseTimerAdvanced = false
  // Same double-advance guard, shared between open-day's click-delegation
  // path and its belt-and-braces watch() (see that step below).
  let openDayAdvanced = false
  // Rate-limited (not index-scoped one-shot) re-kick: on real network
  // latency an async delete's late re-render (afterLogChange) can clobber a
  // screen kicked via renderHome()/renderSettings()/renderShop() AFTER the
  // kick already ran, stranding the tour since a one-shot guard is spent.
  // The 250ms retry tick keeps calling ready(), so a floor of 1200ms between
  // kicks recovers from any late clobber while preventing render-loop
  // thrash. See tap-cook/tap-emote-demo/add-to-homescreen/buy-waving below.
  let cookHomeLastKickAt = 0
  // Captured in the results step's enter() once the practice session has
  // definitely been written - the specific entry the later swipe-row/
  // tap-delete/confirm-delete steps must target, so they can't drift onto
  // some OTHER real session the chef has that day (see those steps below).
  let tourLogId = null
  // Guards confirm-delete's advance so it can only ever fire once - it has
  // TWO independent advance triggers (the click handler and watch()'s
  // "the row is actually gone" check) that can both fire for the same
  // delete, which without this double-advances past the following step.
  let confirmDeleteAdvanced = false
  // Rate-limited re-kicks (see cookHomeLastKickAt above for the full
  // rationale) for the tail steps' own screens.
  let shopLastKickAt = 0
  let homeLastKickAt = 0
  let settingsLastKickAt = 0
  // Tracks the coin popup's own overlay element so its step can self-heal
  // (watch()) if it ever disappears from the DOM out from under it - e.g. a
  // screen re-render elsewhere replacing app.innerHTML while the overlay
  // was appended to the old .app wrapper.
  let coinPopupOverlayEl = null
  // Per-visit state for tap-emote-demo's own advance logic (reset in
  // enter(), not shared across replays of that step).
  let emoteTappedAt = null
  let emoteSawVideo = false
  let emoteDemoAdvanced = false

  const steps = [
    // ---------- 1. Welcome ----------
    {
      id: 'welcome',
      kind: 'explain',
      getTarget: () => null,
      // One promise for everyone - the actual grant (or not, for an
      // existing owner) is decided at purchase time, not here.
      text: `${coinImg('lg')}<br><b>Welcome to Chef Penguino!</b><br>Every minute you focus, your penguin bakes pizzas. Finish this quick tour and earn a <b>FREE Penguino Coin</b>!`,
    },
    // ---------- 2. Point at the Cook button ----------
    {
      id: 'tap-cook',
      kind: 'action',
      ready: () => {
        const btn = document.querySelector('.tab-fab[data-action="cook"]')
        if (btn) return true
        // Rate-limited re-kick (see cookHomeLastKickAt above): recovers even
        // if a late async re-render clobbers the Home screen after the kick.
        if (Date.now() - cookHomeLastKickAt > 1200) { cookHomeLastKickAt = Date.now(); renderHome() }
        return false
      },
      getTarget: () => document.querySelector('.tab-fab[data-action="cook"]'),
      text: `Tap <b>Cook</b> to start a focus session.`,
      enter: () => tourAdvanceOnRealClick('.tab-fab[data-action="cook"]'),
    },
    // ---------- 3. Through the pickers (real actions) ----------
    {
      id: 'duration',
      kind: 'action',
      // Scoped to .picker[data-picker-stage="duration"] - renderTimePickerUI
      // is reused verbatim by the pause-overlay's "Set new remaining time"
      // Edit action, which renders the same .picker-grid [data-minutes="15"]
      // markup; the unscoped selector let the mid-session edit picker match
      // this step's probe and yank the tour backwards.
      ready: () => !!document.querySelector('.picker[data-picker-stage="duration"] .picker-grid [data-minutes="15"]'),
      probe: () => !!document.querySelector('.picker[data-picker-stage="duration"] .picker-grid [data-minutes="15"]'),
      getTarget: () => document.querySelector('.picker[data-picker-stage="duration"] .picker-grid [data-minutes="15"]'),
      text: `Let's run a test session. You won't have to go through the whole thing - we'll end it early. Tap <b>15 min</b>.`,
      enter: () => tourAdvanceOnRealClick('.picker[data-picker-stage="duration"] .picker-grid [data-minutes="15"]'),
    },
    {
      id: 'task-name',
      kind: 'action',
      ready: () => !!document.querySelector('.task-input'),
      probe: () => !!document.querySelector('.task-input'),
      getTarget: () => document.querySelector('.task-input'),
      text: `Type anything - it's just a label for this session.`,
      enter: () => {
        const el = document.querySelector('.task-input')
        if (!el) return null
        const onInput = () => { if (el.value.trim().length > 0) tourAdvance() }
        el.addEventListener('input', onInput)
        return () => el.removeEventListener('input', onInput)
      },
    },
    {
      id: 'task-done',
      kind: 'action',
      ready: () => !!document.querySelector('.picker [data-done]'),
      probe: () => !!document.querySelector('.picker [data-done]'),
      getTarget: () => document.querySelector('.picker [data-done]'),
      text: `Tap <b>Done</b>.`,
      enter: () => tourAdvanceOnRealClick('.picker [data-done]'),
    },
    // task-type step removed - Deep Work is already selected by default on
    // this screen, so asking the chef to pick a category was a pointless
    // extra tap. start-cook is now the active step here.
    {
      id: 'start-cook',
      kind: 'action',
      ready: () => !!document.querySelector('.picker [data-start]'),
      probe: () => !!document.querySelector('.picker [data-start]'),
      getTarget: () => document.querySelector('.picker [data-start]'),
      text: `Tap <b>Start cooking</b>.`,
      enter: () => tourAdvanceOnRealClick('.picker [data-start]'),
    },
    // ---------- 4. On the timer (two-part action) ----------
    {
      id: 'pause-timer',
      kind: 'action',
      // Waits until the real timer has actually been running for ~2s before
      // the spotlight appears, so it never fights the "Start Cooking!"
      // splash or shows up before there's anything worth pausing.
      // ALSO requires the pause overlay not already be open (the chef
      // paused on their own before the step armed - no click listener was
      // attached yet, so the tour never saw that tap). Now that blockers
      // apply properly to every action step, letting this spotlight the
      // TIMER while the chef is actually looking at the pause overlay's
      // Resume/Edit Time/End Early buttons would block all three and trap
      // them with only Skip Tutorial reachable - spotlighting a control
      // they've already used, with an instruction that's no longer true.
      // Going not-ready here lets the forward self-heal scan (3-step
      // lookahead) land on end-early instead, whose probe matches the
      // overlay that's actually on screen - exactly where they should be.
      ready: () => {
        const el = document.querySelector('.timer-value')
        if (!el) { pauseArmedAt = null; return false }
        if (document.querySelector('.pause-overlay:not([hidden])')) return false
        if (pauseArmedAt == null) {
          pauseArmedAt = Date.now()
          const id = setTimeout(tourSync, 2100)
          if (tour) tour.timers.push(id)
          return false
        }
        return Date.now() - pauseArmedAt >= 2000
      },
      // Pure - only decides which step the forward self-heal scan lands on,
      // never when the spotlight appears (that's still gated by ready()'s
      // 2s arming above). Without this the scan had no probe anywhere
      // between start-cook (dies the instant the timer mounts) and the
      // history steps, so straying near the timer stranded the tour.
      probe: () => !!document.querySelector('.timer-value'),
      getTarget: () => document.querySelector('.timer-value'),
      arrow: true,
      text: `Tap the timer to pause your session.`,
      enter: () => {
        // Reset on every fresh entry (a replayed tour re-runs this step
        // from scratch).
        pauseTimerAdvanced = false
        const el = document.querySelector('.timer-value')
        if (!el) return null
        const onClick = () => {
          if (pauseTimerAdvanced) return
          pauseTimerAdvanced = true
          tourAdvance()
        }
        el.addEventListener('click', onClick)
        return () => el.removeEventListener('click', onClick)
      },
      // Covers the case where the step is already entered/armed and the
      // chef pauses via any route the click listener above didn't catch
      // (e.g. a route that doesn't dispatch a plain click on .timer-value).
      // Guarded by the SAME pauseTimerAdvanced flag as the click handler -
      // both are independent triggers for the same "the chef paused" event
      // and either can fire first; without the shared guard, both firing
      // double-advances the tour and skips end-early entirely.
      watch: () => {
        if (pauseTimerAdvanced) return
        if (document.querySelector('.pause-overlay:not([hidden])')) {
          pauseTimerAdvanced = true
          tourAdvance()
        }
      },
    },
    {
      id: 'end-early',
      kind: 'action',
      ready: () => !!document.querySelector('.pause-overlay .home-btn-col [data-action="end"]'),
      probe: () => !!document.querySelector('.pause-overlay .home-btn-col [data-action="end"]'),
      getTarget: () => document.querySelector('.pause-overlay .home-btn-col [data-action="end"]'),
      text: `Tap <b>End Early</b> to finish this practice session.`,
      enter: () => tourAdvanceOnRealClick('.pause-overlay .home-btn-col [data-action="end"]'),
    },
    {
      id: 'confirm-end',
      kind: 'action',
      ready: () => !!document.querySelector('.pause-overlay [data-action="confirm-end"]'),
      probe: () => !!document.querySelector('.pause-overlay [data-action="confirm-end"]'),
      getTarget: () => document.querySelector('.pause-overlay [data-action="confirm-end"]'),
      text: `Tap <b>Yes, End Session</b> to see your results. Unlike most focus timer apps, your time will not be discarded!`,
      enter: () => tourAdvanceOnRealClick('.pause-overlay [data-action="confirm-end"]'),
    },
    // ---------- 5. Results ----------
    {
      id: 'results',
      kind: 'action',
      // Scoped to data-intro-stage="results" - renderTapToContinue() renders
      // the SAME .intro-start markup for the pre-session intro screen too
      // (isAlarm false); the unscoped selector matched that intro screen and
      // let the probe scan teleport the tour there before any session ran.
      // Anchored to the real button (action, not explain) rather than
      // relying on the document-level tap-anywhere handler - that handler
      // gets torn down during the not-ready window while the results video
      // is playing (tourSync's not-ready branch removes it and resets
      // tour.entered), which silently ate the step and it never rendered.
      ready: () => !!document.querySelector('.intro-start[data-intro-stage="results"] button'),
      probe: () => !!document.querySelector('.intro-start[data-intro-stage="results"] button'),
      getTarget: () => document.querySelector('.intro-start[data-intro-stage="results"] button'),
      text: `You just baked your first (tiny) pizza! Every session you focus adds up. Tap <b>Tap for Results</b>.`,
      enter: () => {
        // Capture the id of the practice session just run - the session
        // has definitely been written by this point. The later swipe-row/
        // tap-delete/confirm-delete steps scope themselves to THIS
        // specific entry: an unqualified "first row in the day sheet"
        // selector would, for a chef with prior sessions that day, demand
        // a REAL session be deleted once the practice one is gone (data-
        // loss-adjacent) - see those steps below.
        //
        // Reads lastLoggedSessionId (set at CREATION time, in logSession()/
        // finalizeSession() - see those) rather than guessing which log
        // entry is newest after the fact. The guess was wrong whenever any
        // other real entry happened to sort newer than the practice
        // session (entirely plausible - "newest" isn't guaranteed to mean
        // "just created", e.g. a clock skew or a session logged with a
        // manually-edited timestamp), and for signed-in chefs it also
        // depended on a background fetchLog() racing the tour, which could
        // resolve to the wrong id if it landed before the new session had
        // actually reached the DB. Both failure modes are gone now: this
        // is exactly the id that write actually produced. If it's null
        // (capture failed) tourLogId stays null and the later steps fall
        // back to their original unqualified selectors (see comments
        // there) rather than hard-stalling the tour.
        tourLogId = lastLoggedSessionId
        return tourAdvanceOnRealClick('.intro-start[data-intro-stage="results"] button')
      },
    },
    // ---------- 6. History + swipe-to-delete ----------
    {
      id: 'see-all',
      kind: 'action',
      ready: () => !!document.querySelector('.cal-seeall-btn[data-action="see-all-sessions"]'),
      probe: () => !!document.querySelector('.cal-seeall-btn[data-action="see-all-sessions"]'),
      getTarget: () => document.querySelector('.cal-seeall-btn[data-action="see-all-sessions"]'),
      text: `Tap <b>See All Sessions</b> to view your history.`,
      enter: () => tourAdvanceOnRealClick('.cal-seeall-btn[data-action="see-all-sessions"]'),
    },
    {
      id: 'open-day',
      kind: 'action',
      ready: () => !!document.querySelector(`.cal-cell.cal-has[data-day="${calKeyFromTs(Date.now())}"]`),
      probe: () => !!document.querySelector(`.cal-cell.cal-has[data-day="${calKeyFromTs(Date.now())}"]`),
      getTarget: () => document.querySelector(`.cal-cell.cal-has[data-day="${calKeyFromTs(Date.now())}"]`),
      text: `Tap today's date to see your session.`,
      // Where the original stranding bug (the tour just stops here for a
      // multi-session signed-in chef, while a one-session guest passes
      // fine) was actually found and reproduced with the review harness:
      // openDay() -> renderHistory() re-renders the WHOLE calendar screen
      // between enter() and the tap, which used to leave a click listener
      // bound to a node that no longer exists, silently dead, while
      // getTarget() kept re-querying and drawing a perfectly correct ring
      // over it - exactly why it was so hard to spot. Delegated to
      // `document` here directly (same technique as
      // tourAdvanceOnRealClick, inlined rather than reused so it can share
      // openDayAdvanced with watch() below) rather than bound to the cell
      // node, so a re-render in between can't leave it stranded.
      enter: () => {
        openDayAdvanced = false
        const cellSelector = `.cal-cell.cal-has[data-day="${calKeyFromTs(Date.now())}"]`
        if (!document.querySelector(cellSelector)) return null
        const onClick = (e) => {
          if (openDayAdvanced) return
          const t = e.target
          if (!(t instanceof Element) || !t.closest(cellSelector)) return
          openDayAdvanced = true
          tourAdvance()
        }
        // Deferred by a tick - same stale-click-still-bubbling hazard as
        // tourExplainClickHandler/tourAdvanceOnRealClick.
        const step = tour ? tour.steps[tour.index] : null
        const attachId = setTimeout(() => {
          if (tour && tour.steps[tour.index] === step) document.addEventListener('click', onClick, true)
        }, 0)
        if (tour) tour.timers.push(attachId)
        return () => document.removeEventListener('click', onClick, true)
      },
      // Belt and braces: advances the moment the real day sheet is
      // actually open, in case the click-delegation path above somehow
      // missed it (e.g. the tap dispatched some other way that never
      // bubbles a plain click). Shares openDayAdvanced with the click path
      // above - whichever fires first wins, the other is a no-op, so this
      // can never double-advance and skip swipe-row. #cal-sheet is
      // ID-scoped (not just .cal-sheet) - the admin calendar leaderboard
      // reuses the same .cal-sheet/.cal-sheet-list CLASSES for a totally
      // different sheet (never open at the same time as this tour step,
      // but the ID keeps this unambiguous regardless).
      watch: () => {
        if (openDayAdvanced) return
        if (document.querySelector('#cal-sheet.show #cal-sheet-list')) {
          openDayAdvanced = true
          tourAdvance()
        }
      },
    },
    {
      id: 'swipe-row',
      kind: 'action',
      // Scoped to the SPECIFIC row captured by results' enter() (tourLogId)
      // whenever capture succeeded - an unqualified "first row" selector
      // would re-match whatever session is first once the practice one is
      // deleted, walking the chef through deleting a REAL session too.
      // Falls back to the old unqualified selector only if capture failed
      // (tourLogId still null), so the tour can't hard-stall.
      ready: () => !!document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] .log-row` : '.cal-sheet-list .log-row-wrap[data-log-id] .log-row'),
      probe: () => !!document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] .log-row` : '.cal-sheet-list .log-row-wrap[data-log-id] .log-row'),
      getTarget: () => document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"]` : '.cal-sheet-list .log-row-wrap[data-log-id]'),
      text: `Swipe the session left to reveal Edit and Delete.`,
      enter: () => {
        const row = document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] .log-row` : '.cal-sheet-list .log-row-wrap[data-log-id] .log-row')
        if (!row) return null
        const obs = new MutationObserver(() => { if (row.classList.contains('open')) tourAdvance() })
        obs.observe(row, { attributes: true, attributeFilter: ['class'] })
        return () => obs.disconnect()
      },
    },
    {
      id: 'tap-delete',
      kind: 'action',
      // Same tourLogId scoping as swipe-row above, with the same
      // unqualified fallback if capture failed.
      //
      // Gated on the row actually being SWIPED OPEN (`.log-row.open`), not
      // merely on the Delete button existing. `.log-row-actions2` is
      // absolutely positioned behind the row at z-index 0, so
      // [data-action="delete-log"] is in the DOM even while the row is
      // shut - without this gate the tour spotlights an invisible button,
      // and a tap lands on the row (z-index 1), which closes the swipe and
      // leaves the chef pointing at nothing with no way back. With the
      // gate, closing the row makes this step not-ready and the backward
      // self-heal scan drops back to `swipe-row`, which tells them to
      // swipe again.
      ready: () => !!document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] .log-row.open` : '.cal-sheet-list .log-row.open')
        && !!document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] [data-action="delete-log"]` : '.cal-sheet-list [data-action="delete-log"]'),
      probe: () => !!document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] .log-row.open` : '.cal-sheet-list .log-row.open'),
      getTarget: () => document.querySelector(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] [data-action="delete-log"]` : '.cal-sheet-list [data-action="delete-log"]'),
      text: `Tap <b>Delete</b> to remove this practice session - it doesn't count for anything.`,
      enter: () => tourAdvanceOnRealClick(tourLogId ? `.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"] [data-action="delete-log"]` : '.cal-sheet-list [data-action="delete-log"]'),
    },
    {
      id: 'confirm-delete',
      kind: 'action',
      // Selector unchanged - it's the confirm popup, only one can be open
      // regardless of which row triggered it.
      ready: () => !!document.querySelector('.overlay.show [data-action="yes"]'),
      probe: () => !!document.querySelector('.overlay.show [data-action="yes"]'),
      getTarget: () => document.querySelector('.overlay.show [data-action="yes"]'),
      text: `Tap <b>Yes, delete</b> to finish up.`,
      enter: () => {
        // Reset on every fresh entry into this step (not just once per
        // tour run) - e.g. a replayed tour re-runs this step from scratch.
        confirmDeleteAdvanced = false
        const el = document.querySelector('.overlay.show [data-action="yes"]')
        if (!el) return null
        const onClick = () => {
          if (confirmDeleteAdvanced) return
          confirmDeleteAdvanced = true
          tourAdvance()
        }
        el.addEventListener('click', onClick)
        return () => el.removeEventListener('click', onClick)
      },
      // Advances the moment the specific captured entry is actually gone,
      // instead of only reacting to the confirm button click - covers both
      // the row disappearing from the day sheet once afterLogChange()
      // re-renders it (works for guest AND signed-in, since either backend
      // ultimately removes the row from the DOM) and, for guests
      // specifically, state.log directly. No-op when tourLogId is null
      // (capture failed - falls back to click-only advance as before).
      // Guarded by the SAME confirmDeleteAdvanced flag as the click handler
      // above - both are independent triggers for the same delete and
      // either can fire first; without the shared guard, both firing
      // double-advances the tour and skips the following step entirely.
      watch: () => {
        if (confirmDeleteAdvanced || !tourLogId) return
        const rowGone = !document.querySelector(`.cal-sheet-list .log-row-wrap[data-log-id="${tourLogId}"]`)
        const missingFromLocalLog = !currentUser && !state.log.some(e => e.id === tourLogId)
        if (rowGone || missingFromLocalLog) {
          confirmDeleteAdvanced = true
          tourAdvance()
        }
      },
    },
    // ---------- 7. Free coin popup (silent - a real overlay, not tour
    // chrome) ----------
    // Same shape/self-heal pattern as the old coin-explainer/guest-coin-
    // prompt it replaces: `silent` (tourSync hides all tour chrome and lets
    // this real popup do the talking), gated on the delete-clip not still
    // playing, self-healing via watch() if some unrelated re-render removes
    // it from the DOM. NO server/state write happens here - see the "write-
    // once-atomically" rule at completeOnboardingPurchase(). tour.
    // coinBonusShown (read by coinBalance()'s display-only +1 and by
    // buy-waving's Locked-card override) is only ever set for someone who
    // doesn't already own waving - an existing owner gets the same popup
    // (one unified flow) but never the illusion of a coin they won't
    // actually receive.
    {
      id: 'coin-popup',
      kind: 'explain',
      silent: true,
      ready: () => !document.querySelector('.delete-clip'),
      getTarget: () => null,
      text: '',
      enter: () => {
        const o = overlay(`
          ${coinImg('xl')}
          <h3>Free Penguino Coin!</h3>
          <p>Here's a free coin for you, let's see how to use this in the shop!</p>
          <div class="home-btn-col">
            <button type="button" data-action="ok">Got it!</button>
          </div>
        `, { dismissable: false })
        coinPopupOverlayEl = o
        o.querySelector('[data-action="ok"]').addEventListener('click', () => {
          o.remove()
          coinPopupOverlayEl = null
          // Unconditional - the +1 illusion (and the shop's matching Locked
          // card, see renderShop()) shows for EVERYONE the same way,
          // owners included, so the tour reads identically regardless of
          // what's really owned underneath. For an owner it disappears
          // again the instant wavingPurchased flips true (their real
          // balance never actually changed - see completeOnboardingPurchase()'s
          // no-coin/no-array-change branch), so "the coin" was always just
          // a teaching illusion for them, never a real grant.
          if (tour) tour.coinBonusShown = true
          tourAdvance()
        })
        return () => { coinPopupOverlayEl = null }
      },
      watch: () => {
        if (coinPopupOverlayEl && !document.body.contains(coinPopupOverlayEl)) {
          coinPopupOverlayEl = null
          tour.entered = -1
          tourSync()
        }
      },
    },
    // ---------- 8. Buy Waving (real purchase, popup exception for the
    // confirm) ----------
    // Advancing is driven by `watch()` (checked on every tourSync, not just
    // on entering the step) rather than a click handler, because the real
    // "buy" tap only opens a confirm popup - the purchase itself completes
    // a beat later (completeOnboardingPurchase(), via confirmBuyTour() -
    // see renderShop()), and that's the moment that should count.
    // getTarget/text are DYNAMIC (getters, since step.text is read as a
    // plain property, not called) - once the confirm popup is open, the
    // spotlight and copy switch to its "Yes, unlock it" button. That
    // button lives inside `.popup`, so the engine's existing popup
    // exception (see tourPositionForStep: `if (modal) tourClearBlockers()`)
    // takes over automatically - ring+card, no blockers, no extra code
    // needed here for that part.
    {
      id: 'buy-waving',
      kind: 'action',
      ready: () => {
        if (document.querySelector('.shop-sort-row')) return true
        if (Date.now() - shopLastKickAt > 1200) { shopLastKickAt = Date.now(); renderShop() }
        return false
      },
      // Pure, side-effect-free - lets the self-heal scan land here. Matches
      // only the pre-confirm shop screen (the scan should never land mid-
      // confirm), which is fine - watch()/enter() below handle that state
      // once the tour is actually current on this step.
      probe: () => !!document.querySelector('.shop-sort-row') && !!document.querySelector('[data-buy="waving"]'),
      get getTarget() {
        return () => document.querySelector('.overlay.show [data-action="yes"]') || document.querySelector('[data-buy="waving"]')
      },
      get text() {
        return document.querySelector('.overlay.show [data-action="yes"]')
          ? `Tap <b>Yes, unlock it</b> to spend your coin.`
          : `Spend it on the <b>Waving</b> emote - your chef needs a move!`
      },
      watch: () => {
        if (tour.wavingPurchased) tourAdvance()
      },
    },
    // ---------- 9. Equipped-shown (explain-with-target, dismiss on any
    // tap) ----------
    {
      id: 'equipped-shown',
      kind: 'explain',
      ready: () => !!document.querySelector('[data-equip="waving"].equipped'),
      getTarget: () => document.querySelector('[data-equip="waving"].equipped'),
      text: `Nice - <b>Waving</b> is now equipped, so it's the move your chef performs.`,
      hintText: 'Tap anywhere to dismiss',
    },
    // ---------- 10. Go Home ----------
    {
      id: 'go-home',
      kind: 'action',
      ready: () => !!document.querySelector('.tab[data-tab="home"]'),
      // No probe: the Home tab, like Settings below, exists on every
      // screen (the tabbar is omnipresent) - a probe here would make this
      // step a scan magnet the same way go-settings' would.
      getTarget: () => document.querySelector('.tab[data-tab="home"]'),
      text: `Tap <b>Home</b> to see your chef.`,
      enter: () => tourAdvanceOnRealClick('.tab[data-tab="home"]'),
    },
    // ---------- 11. Tap-to-emote demo ----------
    // Reachable by EVERYONE now (equipped-shown/buy-waving guarantee
    // equippedEmote() is 'waving' for literally every chef who reaches
    // here), so no more "if there's anything to demo" guard around pushing
    // this step.
    {
      id: 'tap-emote-demo',
      kind: 'action',
      ready: () => {
        const btn = document.querySelector('.hero-tap[data-action="emote"]')
        if (btn) return true
        if (Date.now() - homeLastKickAt > 1200) { homeLastKickAt = Date.now(); renderHome() }
        return false
      },
      // Pure, side-effect-free - lets the self-heal scan land here.
      probe: () => !!document.querySelector('.hero-tap[data-action="emote"]'),
      // Spotlight the WHOLE hero card, not just the small button - the
      // point of this step is watching the chef's move play out, and
      // ringing just the button dimmed the actual art the chef is meant to
      // see clearly. The click handler below still only fires on a real
      // tap on the button itself; only what gets lit up changes.
      getTarget: () => document.querySelector('#hero-card') || document.querySelector('.hero-tap[data-action="emote"]'),
      text: `Tap <b>Tap to emote</b> to see your chef's new move!`,
      // Deliberately does NOT advance on the real tap (unlike
      // tourAdvanceOnRealClick) - the tap only starts the clip
      // (playEmoteInto() swaps the hero <img> for a <video>, see ~line
      // 1110); advancing here would cut the demo off before the chef ever
      // sees it play. watch() below is what actually advances, once the
      // clip has genuinely played out.
      enter: () => {
        emoteTappedAt = null
        emoteSawVideo = false
        emoteDemoAdvanced = false
        // The generic occlusion-scroll only moves a target into view when
        // it's occluded - the emote button itself is usually already
        // visible after the chef scrolled down for See All Sessions
        // earlier in the tour, so it never triggers. That left the hero
        // art (the actual payoff of "watch your chef move") scrolled
        // off-screen above. Scroll straight to the top of Home instead.
        document.querySelector('.scroll')?.scrollTo({ top: 0, behavior: 'auto' })
        const step = tour ? tour.steps[tour.index] : null
        const onClick = (e) => {
          const t = e.target
          // The real app plays the emote on a tap ANYWHERE in #hero-card
          // (see its own click listener), and the spotlight now covers the
          // whole card to match - this must recognise the same tap the app
          // does, not just the small button, or the tour stalls on a tap
          // that visibly worked.
          if (!(t instanceof Element) || !t.closest('#hero-card')) return
          if (emoteTappedAt != null) return
          emoteTappedAt = Date.now()
          // Belt-and-braces: guarantees watch() gets re-evaluated at the 8s
          // cap even if nothing else (DOM mutation, resize, scroll) happens
          // to trigger a resync in the meantime - e.g. play().catch's
          // revert already fires fast via a mutation in the normal case,
          // but a stuck/hung decode with no further DOM change wouldn't
          // otherwise ever get rechecked.
          const id = setTimeout(() => { if (tour) tourSync() }, 8100)
          if (tour) tour.timers.push(id)
        }
        const attachId = setTimeout(() => {
          if (tour && tour.steps[tour.index] === step) document.addEventListener('click', onClick, true)
        }, 0)
        if (tour) tour.timers.push(attachId)
        return () => document.removeEventListener('click', onClick, true)
      },
      watch: () => {
        if (emoteDemoAdvanced || emoteTappedAt == null) return
        // #hero-card is the hero container both renderHome() and
        // renderFriendHome() use; playEmoteInto() swaps its .hero-still
        // <img> for a shared <video> node (same class/id) while playing,
        // and swaps it back to an <img> on 'ended' (or immediately via
        // play().catch on a decode failure - the common case headless).
        const hasVideo = !!document.querySelector('#hero-card video')
        if (hasVideo) emoteSawVideo = true
        const playedAndReverted = emoteSawVideo && !hasVideo
        const timedOut = Date.now() - emoteTappedAt > 8000
        if (playedAndReverted || timedOut) {
          emoteDemoAdvanced = true
          tourAdvance()
        }
      },
    },
    // ---------- 12. Go Settings ----------
    // Guides the chef to tap the real Settings tab themselves rather than
    // the tour silently teleporting them there. ready()/probe()
    // deliberately do NOT kick to Settings themselves - while this step is
    // current, nothing may navigate ahead of the chef's own tap (see
    // add-to-homescreen's kick below, which only ever fires once THIS
    // step's target - the add-to-homescreen row - is what's current).
    {
      id: 'go-settings',
      kind: 'action',
      ready: () => {
        const tab = document.querySelector('.tab[data-tab="settings"]')
        // Not-ready (rather than advancing here) if the add-to-homescreen
        // row is ALREADY visible - i.e. we're already on Settings, most
        // likely because a replayed tour landed mid-flow. Lets the forward
        // self-heal scan (tourSync) land directly on add-to-homescreen
        // instead of this step demanding a redundant tap on a tab the chef
        // is already sitting on.
        if (!tab) return false
        if (document.querySelector('[data-action="add-to-homescreen"]')) return false
        return true
      },
      // No probe: the Settings tab exists on every screen (the tabbar is
      // omnipresent), so a probe here would make this step a scan magnet -
      // the forward self-heal scan would vault straight to it from
      // anywhere, silently skipping the silent, probe-less coin-popup step
      // just before it that a real device would otherwise land on. This
      // step must only ever be reached sequentially.
      getTarget: () => document.querySelector('.tab[data-tab="settings"]'),
      text: `Tap <b>Settings</b> - one last thing!`,
      enter: () => tourAdvanceOnRealClick('.tab[data-tab="settings"]'),
    },
    // ---------- 13. Add to Homescreen (final step, ends the tour) ----------
    // tourAdvance() past it already calls endOnboardingTour(true) with no
    // extra code needed here. Action-style (not explain) - blockers apply
    // and it can't be dismissed by tapping elsewhere; go-settings above
    // already got the chef to Settings deliberately, so the final step
    // should ask for one more deliberate tap, not silently accept a stray
    // tap anywhere on the screen. Still spotlights the real row via
    // getTarget; a real tap on it opens the guide AND ends the tour (see
    // the delegated listener in enter() below).
    {
      id: 'add-to-homescreen',
      kind: 'action',
      ready: () => {
        const el = document.querySelector('[data-action="add-to-homescreen"]')
        if (el) return true
        // Rate-limited re-kick as a clobber backstop only - this step is
        // only ever CURRENT after go-settings has already gotten the chef
        // to Settings via their own real tap, so this just recovers from a
        // late async re-render clobbering that screen (see
        // cookHomeLastKickAt's rationale above), it never preempts the
        // chef's own navigation.
        if (Date.now() - settingsLastKickAt > 1200) { settingsLastKickAt = Date.now(); renderSettings() }
        return false
      },
      // Pure, side-effect-free - lets the self-heal scan land here. This
      // row sits below the fold in Settings' Tutorials section (same row
      // fixed for the non-tour recurring popup in bug report 89b30c3b) -
      // tourPositionForStep's generic out-of-view scrollIntoView already
      // handles bringing it on screen for the tour path too, since it
      // applies to every step with a real getTarget().
      probe: () => !!document.querySelector('[data-action="add-to-homescreen"]'),
      getTarget: () => document.querySelector('[data-action="add-to-homescreen"]'),
      text: `<b>Add to Homescreen</b> installs Chef Penguino like a real app!<br>That's it, happy cooking!`,
      // Tapping the spotlighted row navigates to the guide subpage, which
      // makes the target vanish - ready() then goes false forever (this is
      // the LAST step) and would otherwise leave #tour-root (Skip
      // Tutorial) mounted with nothing to end it. End the tour on that
      // same tap instead of waiting on the generic explain-step dismiss.
      // Deliberately does NOT preventDefault/stopPropagation - the row's
      // real handler must still fire and open the guide; this only ALSO
      // ends the tour alongside it. Same deferred-by-a-tick +
      // still-on-this-step guard as tourAdvanceOnRealClick, so a click
      // that entered this step doesn't get caught by this listener before
      // it's even attached.
      enter: () => {
        const step = tour ? tour.steps[tour.index] : null
        const onClick = (e) => {
          const t = e.target
          if (!(t instanceof Element) || !t.closest('[data-action="add-to-homescreen"]')) return
          endOnboardingTour(true)
        }
        const attachId = setTimeout(() => {
          if (tour && tour.steps[tour.index] === step) document.addEventListener('click', onClick, true)
        }, 0)
        if (tour) tour.timers.push(attachId)
        return () => document.removeEventListener('click', onClick, true)
      },
    },
  ]

  return steps
}
