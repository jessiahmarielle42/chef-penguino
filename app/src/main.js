import './style.css'
import { supabase } from './supabaseClient.js'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL
// Standard blank profile picture shown when a user hasn't chosen an avatar
// (or an admin removes theirs) - a neutral silhouette, like other apps.
const DEFAULT_AVATAR = `${BASE}assets/default-avatar.svg`
const APP_VERSION = 'v2.11.2'

const STORAGE_KEY = 'chef-penguino-save'

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
    options: { redirectTo: window.location.origin + BASE },
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
  clearNotifBadges()
  renderHome()
}

async function refreshProfile() {
  if (!currentUser) { currentProfile = null; return }
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code, pizzas, avatar_url, owned_emotes, equipped_emote, coin_adjustment')
    .eq('id', currentUser.id)
    .single()
  currentProfile = data || null
  if (currentProfile && !Array.isArray(currentProfile.owned_emotes)) currentProfile.owned_emotes = []
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
  state.cloudSynced = true
  save()
}

async function handleSignedIn(user) {
  currentUser = user
  await migrateLocalDataIfNeeded()
  await flushPendingSessions()
  await refreshProfile()
  subscribeToSocial()
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

const DURATIONS = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
]

const state = load()

function load() {
  const defaults = {
    pizzas: 0, muted: false, volume: 0.5, lastVolume: 0.5, darkenLevel: 1, autoDarken: true,
    timer: null, log: [], cloudSynced: false, lastSeenPizzaCount: null,
    pendingSessions: [], ownedEmotes: [], equippedEmote: 'waving', lastSeenCoins: null,
    lightMode: false,
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

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.lightMode ? 'light' : 'dark')
}
applyTheme()

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

function syncMusic() {
  if (musicGain) musicGain.gain.value = state.volume
  else bgMusic.volume = state.volume
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  if (state.muted) bgMusic.pause()
  else bgMusic.play().catch(() => {})
}

// Re-sync on every tap rather than once - any interruption (an intro video
// with its own sound taking over the audio focus, backgrounding the tab,
// etc.) would otherwise leave the music paused with nothing to resume it.
document.addEventListener('click', () => syncMusic())

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

function logSession({ completedAt, minutes, pizzas, task, icon }) {
  const entry = { id: crypto.randomUUID(), completedAt, minutes, pizzas, task }
  if (icon) entry.icon = icon
  state.log.unshift(entry)
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
  logSession({ completedAt, minutes, pizzas: pizzasEarned, task: t.task })
  state.timer = null
  save()

  if (currentUser) {
    const row = {
      completed_at: new Date(completedAt).toISOString(),
      minutes,
      pizzas: pizzasEarned,
      task: t.task || '',
    }
    const { error } = await supabase.from('sessions').insert({ ...row, user_id: currentUser.id })
    if (error) {
      state.pendingSessions.push(row)
      save()
    }
    // Optimistically reflect the new total so the coin chip updates right away,
    // even if the profile refresh below lags or fails; refreshProfile() then
    // reconciles against the authoritative DB value.
    if (currentProfile) currentProfile.pizzas = oldTotal + pizzasEarned
    await refreshProfile()
  }

  const coinsAfter = Math.floor(Math.floor(oldTotal + pizzasEarned) / 12)
  if (coinsAfter > coinsBefore) await logCoinConversion(coinsAfter - coinsBefore, completedAt)

  if (playAlarm) renderTapToContinue(() => renderHome(), true, { minutes, pizzas: pizzasEarned })
  else renderHome()
}

// ---------- boot ----------
async function boot() {
  const { data } = await supabase.auth.getSession()
  if (data.session?.user) {
    await handleSignedIn(data.session.user)
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      handleSignedIn(session.user).then(() => {
        if (!state.timer) renderHome()
        checkPendingNoots()
        checkPendingCoinGifts()
        checkPendingWarnings()
      })
    } else if (event === 'SIGNED_OUT') {
      unsubscribeFromSocial()
      currentUser = null
      currentProfile = null
      clearNotifBadges()
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
  }
  checkPendingNoots()
  checkPendingCoinGifts()
  checkPendingWarnings()
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
    setUser: (user, profile) => { currentUser = user; currentProfile = profile },
    renderers: { renderAdminDashboard, renderModerationCenter, renderSystemNotifications, renderComposeNotification, renderSettings },
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
function isOwned(id) { return id === 'waving' || ownedEmotes().includes(id) }
function coinsEarned() { return Math.floor(Math.floor(displayPizzas()) / 12) }
// coin_adjustment is the net of coins gifted away (-) and received (+); it
// only exists for signed-in profiles. Guests can't gift, so it's 0 for them.
function coinAdjustment() { return currentProfile ? (currentProfile.coin_adjustment || 0) : 0 }
function coinBalance() { return Math.max(0, coinsEarned() - ownedEmotes().length + coinAdjustment()) }
function stashCount() { return Math.floor(displayPizzas()) % 12 }
function equippedEmote() {
  const e = (currentProfile ? currentProfile.equipped_emote : state.equippedEmote) || 'waving'
  return isOwned(e) ? e : 'waving'
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
function parkVideo(v) {
  v.pause()
  try { v.currentTime = 0 } catch {}
  v.id = ''; v.className = ''
  v.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px'
  document.body.appendChild(v)
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

// Swap an <img> for the equipped/given emote clip, play it, then revert.
function playEmoteInto(imgEl, emoteId, revertSrc, onRevert) {
  const v = preloadedEmotes[emoteId]
  if (!v) return
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
    const img = document.createElement('img')
    img.className = v.className
    img.id = v.id
    img.alt = ''
    img.src = revertSrc
    if (objectPosition) img.style.objectPosition = objectPosition
    v.replaceWith(img)
    parkVideo(v)
    if (onRevert) onRevert(img)
  }
  v.addEventListener('ended', back, { once: true })
  v.play().catch(back)
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
    <button class="abtn" type="button" data-action="apple">${APPLE_SVG}<span>Sign in with Apple</span></button>
  `
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
          <div class="greet">${isSignedIn() ? 'Welcome back,' : 'Hello,'}</div>
          <div class="nm">${escapeHtml(myName())}</div>
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
  { id: 'friends', label: 'Friends', icon: '🐧' },
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

function mountScreen(active, contentHtml, after, opts = {}) {
  app.innerHTML = `
    <div class="app">
      ${opts.hideStatusBar ? '' : statusBarHtml()}
      <div class="scroll view active">${contentHtml}</div>
      ${tabBarHtml(active)}
    </div>
  `
  if (!opts.hideStatusBar) wireStatusBar()
  wireTabBar()
  if (after) after()
  // Keep the unread-notifications badges fresh on every screen render - see
  // refreshNotifBadges() below. No-ops instantly for guests.
  if (isSignedIn()) refreshNotifBadges()
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

function wireStatusBar() {
  app.querySelector('[data-action="profile"]')?.addEventListener('click', openProfilePopup)
  app.querySelector('[data-action="coin-info"]')?.addEventListener('click', openCoinInfo)
  app.querySelector('[data-action="pizza-info"]')?.addEventListener('click', openPizzaInfo)
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
  if (currentUser) renderIntro(renderDurationPicker, false)
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
function renderHome() {
  afterLogChange = renderHome
  const lifetime = displayPizzas()
  const stash = stashCount()
  const toNext = 12 - stash
  const pct = Math.round((stash / 12) * 100)
  const heroSrc = pizzaImagePath(stash)

  const content = `
    <div class="hero-card" id="hero-card" role="button" tabindex="0">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      <button class="hero-info" type="button" data-action="emote-info" aria-label="About emotes">i</button>
      <button class="hero-tap" type="button" data-action="emote">💃 Tap to emote</button>
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
    <div class="log-list" id="home-log"><p class="log-empty">Loading&hellip;</p></div>
    <button class="cal-seeall-btn" type="button" data-action="see-all-sessions">📅&nbsp; See All Sessions</button>
  `

  mountScreen('home', content, () => {
    app.querySelector('[data-action="see-all-sessions"]').addEventListener('click', renderHistory)
    app.querySelector('.cta[data-action="cook"]').addEventListener('click', startCookingFlow)
    app.querySelector('[data-action="tile-pizza-info"]')?.addEventListener('click', openPizzaInfo)
    app.querySelector('[data-action="stash-info"]')?.addEventListener('click', openStashInfo)
    app.querySelector('[data-action="emote-info"]')?.addEventListener('click', (e) => { e.stopPropagation(); openEmoteInfo() })

    // Tap the shopfront to play the equipped emote, then revert to the still.
    const attachEmoteTap = (btnHost) => {
      btnHost.addEventListener('click', () => {
        const img = app.querySelector('#hero-card .hero-still')
        if (img && img.tagName === 'IMG') {
          playEmoteInto(img, equippedEmote(), heroSrc)
        }
      })
    }
    attachEmoteTap(app.querySelector('#hero-card'))
    warmEmote(equippedEmote())

    loadHomeLog()
    maybeShowCoinMilestone()
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

const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const CAL_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CAL_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const CAL_DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const CAL_HPX_REM = 2.875 // week-view hour row height (46px at the app's 390px design width)

function calPad2(n) { return String(n).padStart(2, '0') }
function calKey(y, mo, d) { return `${y}-${calPad2(mo + 1)}-${calPad2(d)}` }
function calKeyFromDate(dt) { return calKey(dt.getFullYear(), dt.getMonth(), dt.getDate()) }
function calKeyFromTs(ts) { return calKeyFromDate(new Date(ts)) }
function calDateFromKey(key) { const [y, mo, d] = key.split('-').map(Number); return new Date(y, mo - 1, d) }
function calOrdinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }
function calFmtTime(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }
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
  return { pz, mn, n: arr.length, entries: arr }
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
  const today = new Date()
  if (calY === null) { calY = today.getFullYear(); calMo = today.getMonth() }
  if (calSelKey === null) calSelKey = calKeyFromDate(today)
  const todayKey = calKeyFromDate(today)

  const log = await fetchLog(currentUser?.id)
  const dayMap = calGroupByDay(log)

  let navHtml = ''
  let sumPz = 0, sumMn = 0
  if (calView === 'month') {
    navHtml = `
      <div class="cal-navbar">
        <button class="cal-chev" type="button" data-action="cal-prev">‹</button>
        <div class="cal-navlabel">${CAL_MONTHS[calMo]} ${calY}</div>
        <button class="cal-chev" type="button" data-action="cal-next">›</button>
      </div>`
    const t = calMonthTotals(dayMap, calY, calMo)
    sumPz = t.pz; sumMn = t.mn
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
    days.forEach(d => { const t = calDayTotals(dayMap, calKeyFromDate(d)); sumPz += t.pz; sumMn += t.mn })
  } else {
    const dt = calDateFromKey(calSelKey)
    navHtml = `
      <div class="cal-navbar">
        <button class="cal-chev" type="button" data-action="cal-prev">‹</button>
        <div class="cal-navlabel">${CAL_DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${CAL_MONTHS[dt.getMonth()]}</div>
        <button class="cal-chev" type="button" data-action="cal-next">›</button>
      </div>`
    const t = calDayTotals(dayMap, calSelKey)
    sumPz = t.pz; sumMn = t.mn
  }

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
    <div class="cal-viewbody">${bodyHtml}</div>
  `

  mountScreen('home', content, () => calWireHistory(dayMap, todayKey))
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
    const today = new Date()
    calY = today.getFullYear(); calMo = today.getMonth(); calSelKey = calKeyFromDate(today)
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
      const d = new Date(e.completedAt)
      const start = d.getHours() + d.getMinutes() / 60
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
    const icon = (isCoin && !isAdminEditEntry(e)) ? coinImg('log-coin') : stableIconFor(e)
    const coinAmt = (COIN_TASK_RE.exec(e.task || '') || [])[1] || ''
    const metric = isCoin ? `${coinImg('log-coin')} ${coinAmt}`.trim() : `🍕 ${formatScore(e.pizzas)}`
    const task = escapeHtml((e.task || '').replace(COIN_TASK_RE, '')) || 'Focus session'
    h += `<div class="cal-tl-item" data-id="${e.id}" role="button" tabindex="0">
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
  if (!isSignedIn()) {
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
  const cards = shopList.length ? shopList.map(e => {
    const owned = isOwned(e.id)
    const equipped = equippedEmote() === e.id

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
      btn.addEventListener('click', () => confirmBuy(btn.dataset.buy))
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
function openProfilePopup() {
  const signed = isSignedIn()
  const editOrGuest = signed
    ? `<button class="btn-edit-profile" type="button" data-action="edit-profile">${PENCIL_SVG}<span style="margin-left:8px">Edit Profile</span></button>
       <button class="btn-danger" type="button" data-action="sign-out" style="margin-top:0.625rem">Sign Out</button>`
    : `<p style="color:var(--muted);font-size:13px;line-height:1.5;margin:0 0 16px">Sign in to save your progress and customise your profile.</p>${googleBtn()}`

  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <div class="popup-profile-name">${escapeHtml(myName())}</div>
    <img class="popup-profile-avatar" src="${myAvatar()}" alt="" />
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

  const content = `
    <div class="friend-swipe-hint" style="margin-top:6px">
      <span class="info-badge" aria-hidden="true">i</span>
      <p>Tap a friend to view their Pizzeria. Tap the 3 dots to view more friend actions.</p>
    </div>
    <div class="section-h" style="margin-top:1.75rem"><h2>Leaderboard</h2></div>
    <div id="friends-list"><p class="log-empty">Loading&hellip;</p></div>
    <div class="section-h" style="margin-top:2.75rem"><h2>Add a friend</h2></div>
    <div class="addfriend"><input id="friend-code-input" placeholder="Friend's code" maxlength="6" /><button type="button" data-action="add">Add</button></div>
    <p class="friends-error" id="friends-error" hidden></p>
    <p class="code-note">Your code: <b id="friend-code-val">${currentProfile?.friend_code || '…'}</b> <button class="copy-btn" type="button" data-action="copy" aria-label="Copy friend code">${COPY_SVG}</button> — share it to compare pizzas.</p>
  `

  mountScreen('friends', content, () => {
    const errorEl = app.querySelector('#friends-error')
    app.querySelector('[data-action="add"]').addEventListener('click', async () => {
      const input = app.querySelector('#friend-code-input')
      const code = input.value.trim()
      if (!code) return
      errorEl.hidden = true
      const { error } = await supabase.rpc('add_friend_by_code', { code })
      if (error) { errorEl.textContent = error.message; errorEl.hidden = false; return }
      input.value = ''
      toast('Friend added!')
      loadFriendsList()
    })
    app.querySelector('[data-action="copy"]').addEventListener('click', () => {
      const code = app.querySelector('#friend-code-val').textContent.trim()
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('Code copied!')).catch(() => toast('Code copied!'))
      else toast('Code copied!')
    })
    loadFriendsList()
  })
}

async function loadFriendsList() {
  const listEl = app.querySelector('#friends-list')
  if (!listEl) return

  const [{ data: friendRows }, { data: pendingRows }] = await Promise.all([
    supabase.from('friends').select('friend_id, profiles:friend_id(id, display_name, pizzas, avatar_url, friend_code, equipped_emote)'),
    supabase.from('noots').select('recipient_id').eq('sender_id', currentUser.id).is('acknowledged_at', null),
  ])

  const friends = (friendRows || []).map(r => r.profiles).filter(Boolean)
  const pendingNootTargets = new Set((pendingRows || []).map(r => r.recipient_id))
  if (!friends.length) {
    listEl.innerHTML = `<div class="frow lonely-card">It's lonely here. Add friends to start climbing the ladder!</div>`
    return
  }

  const me = { id: currentUser.id, display_name: myName(), pizzas: displayPizzas(), avatar_url: myAvatar(), friend_code: currentProfile?.friend_code, isMe: true }
  const board = [...friends, me].sort((a, b) => b.pizzas - a.pizzas)

  const medals = ['🥇', '🥈', '🥉']
  listEl.innerHTML = board.map((f, i) => {
    const rank = i < 3 ? `<div class="medal">${medals[i]}</div>` : `<div class="rank">${i + 1}</div>`
    const name = f.isMe ? `${escapeHtml(f.display_name)} <span class="you-tag">(you)</span>` : escapeHtml(chefName(f.display_name))
    return `
      <div class="frow ${f.isMe ? 'me' : ''}" ${f.isMe ? 'role="button" tabindex="0"' : `data-friend="${f.id}" role="button" tabindex="0"`}>
        ${rank}
        <img src="${f.avatar_url || DEFAULT_AVATAR}" alt="" />
        <div><div class="fn">${name}</div><div class="fp">Code ${escapeHtml(f.friend_code || '')}</div></div>
        <div class="score">🍕 ${formatScore(Number(f.pizzas) || 0)}</div>
        <button type="button" class="frow-more" data-more="${f.id}" aria-label="More actions">⋮</button>
      </div>
    `
  }).join('')

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
    <p>Last chance &mdash; this will permanently delete everything and you will be signed out. This cannot be undone.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, delete forever</button>
      <button type="button" class="btn-secondary" data-action="no">Keep my account</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    const btn = o.querySelector('[data-action="yes"]')
    btn.disabled = true
    btn.textContent = 'Deleting…'
    const { error } = await supabase.rpc('delete_own_account')
    if (error) { btn.disabled = false; btn.textContent = 'Yes, delete forever'; toast(error.message); return }
    await supabase.auth.signOut()
    currentUser = null
    currentProfile = null
    clearNotifBadges()
    o.remove()
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

  const content = `
    <div class="viewing-banner" id="viewing-banner" role="button" tabindex="0">Viewing: ${escapeHtml(chefName(friend.display_name))}'s Pizzeria</div>
    <div class="hero-card" id="hero-card" role="button" tabindex="0">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      <button class="hero-tap" type="button" data-action="emote">💃 Tap to emote</button>
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
    warmEmote(friend.equipped_emote || 'waving')
    app.querySelector('#hero-card')?.addEventListener('click', () => {
      const img = app.querySelector('#hero-card .hero-still')
      if (img && img.tagName === 'IMG') playEmoteInto(img, friend.equipped_emote || 'waving', heroSrc)
    })
    app.querySelector('#viewing-banner')?.addEventListener('click', () => renderFriends())
    app.querySelector('#viewing-banner')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderFriends() }
    })
  }, { hideStatusBar: true })
}

function confirmRemoveFriend(friendId, name) {
  const o = overlay(`
    <h3>Do you want to remove ${escapeHtml(name)} as friend?</h3>
    <p>You can add them back anytime with their friend code.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, remove</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    const { error } = await supabase.rpc('remove_friend', { target_id: friendId })
    if (error) { toast(error.message); return }
    toast(`Removed ${name}`)
    loadFriendsList()
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
    .select('id, completed_at, minutes, pizzas, task, icon')
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

function chefSinceLabel() {
  if (!currentUser?.created_at) return 'Chef Penguino'
  const d = new Date(currentUser.created_at)
  const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return `Chef since ${formatted}`
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
  const icon = isAdminEdit ? '🛠️' : (isCoinEntry(entry) ? coinImg('log-coin') : stableIconFor(entry))
  // Admin-edit rows are an audit trail, not a session the user created - they
  // can't be renamed, re-iconed, or deleted.
  const canEdit = editable && entry.id && !isAdminEdit && !isCoinEntry(entry)
  if (canEdit) logEntriesById.set(entry.id, { entry, icon })

  const actions = canEdit ? `
    <div class="log-row-actions2">
      <button class="log-action2 edit" type="button" data-action="edit-log" aria-label="Edit session">${PENCIL_SVG}<span>Edit</span></button>
      <button class="log-action2 delete" type="button" data-action="delete-log" aria-label="Delete session">${TRASH_SVG}<span>Delete</span></button>
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

    row.addEventListener('pointerdown', (e) => {
      active = true; decided = false; dragging = false; dx = 0
      startX = e.clientX; startY = e.clientY
      row.style.transition = 'none'
    })
    row.addEventListener('pointermove', (e) => {
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
    })
    const endDrag = () => {
      if (!active) return
      active = false
      row.style.transition = ''
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
    row.addEventListener('pointerup', endDrag)
    row.addEventListener('pointercancel', endDrag)
    row.addEventListener('click', (e) => {
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
  let selectedIcon = rec.icon
  const o = overlay(`
    <h3>Edit Record</h3>
    <label class="field-label" for="edit-log-name">Name:</label>
    <input id="edit-log-name" class="rename-input" type="text" maxlength="30" value="${escapeHtml(rec.entry.task || '')}" placeholder="Focus session" />
    <label class="field-label">Icon:</label>
    <div class="icon-field" id="icon-field">
      <div class="icon-collapsed" data-action="toggle-icons" role="button" tabindex="0">
        <span class="icon-current-chip">${selectedIcon}</span>
        <span class="icon-collapsed-label">${iconName(selectedIcon)}</span>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
      <div class="icon-options-row" hidden>
        ${LOG_ROW_ICONS.map(ic => `<button type="button" class="icon-pick2 ${ic === selectedIcon ? 'selected' : ''}" data-icon="${ic}">${ic}</button>`).join('')}
      </div>
    </div>
    <div class="home-btn-col" style="margin-top:1.25rem">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })

  const field = o.querySelector('#icon-field')
  const optionsRow = o.querySelector('.icon-options-row')
  const chip = o.querySelector('.icon-current-chip')
  const label = o.querySelector('.icon-collapsed-label')
  o.querySelector('[data-action="toggle-icons"]').addEventListener('click', () => {
    const expand = optionsRow.hidden
    optionsRow.hidden = !expand
    field.classList.toggle('expanded', expand)
  })
  o.querySelectorAll('.icon-pick2').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedIcon = btn.dataset.icon
      chip.textContent = selectedIcon
      label.textContent = iconName(selectedIcon)
      o.querySelectorAll('.icon-pick2').forEach(b => b.classList.toggle('selected', b === btn))
      optionsRow.hidden = true
      field.classList.remove('expanded')
    })
  })

  const input = o.querySelector('#edit-log-name')
  setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newName = input.value.trim().slice(0, 30) || 'Focus session'
    const ok = await saveLogEdit(id, { task: newName, icon: selectedIcon })
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
  const { data, error } = await supabase.from('preset_avatars').select('id, url').order('created_at', { ascending: false })
  if (error) { grid.innerHTML = `<p class="editpic-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) { grid.innerHTML = '<p class="editpic-empty">No presets available yet.</p>'; return }
  const current = myAvatar()
  grid.innerHTML = data.map(p => `
    <button class="editpic-preset ${p.url === current ? 'selected' : ''}" type="button" data-url="${escapeHtml(p.url)}">
      <img src="${p.url}" alt="" />
    </button>
  `).join('')
  grid.querySelectorAll('[data-url]').forEach(btn => {
    btn.addEventListener('click', () => confirmPresetSelection(btn.dataset.url, editPopupEl))
  })
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
function renderSettings(highlightProfile) {
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
            <div class="gs">${chefSinceLabel()}</div>
          </div>
        </div>
      </div>
    </div>
  ` : ''

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
      </div>
    </div>
    <div class="group">
      <p class="glab">Focus session</p>
      <div class="glist">
        <div class="grow">
          <div><div class="gt">Auto-darken screen</div><div class="gs">Dims after 5s to save battery</div></div>
          <div class="right"><div class="switch ${state.autoDarken ? '' : 'off'}" role="button" tabindex="0" data-action="toggle-darken"></div></div>
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
      </div>
    </div>
    ${accountGroup}
    <div class="group">
      <p class="glab">About</p>
      <div class="glist about-glist">
        <div class="grow" role="button" tabindex="0" data-action="lore">
          <div><div class="gt">Lore</div><div class="gs">Click to learn about Chef Penguino lore</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="steam">
          <div><div class="gt">Check out the game!</div><div class="gs">Characters are taken from "The Greatest Penguin Heist of All Time", by That Other Fish</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow" role="button" tabindex="0" data-action="legal">
          <div><div class="gt">Legal and Disclaimers</div><div class="gs">We do not own the copyright</div></div>
          <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
        </div>
        <div class="grow"><div><div class="gt">Version</div><div class="gs">${APP_VERSION}</div></div></div>
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
    app.querySelector('[data-action="lore"]')?.addEventListener('click', renderLore)
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
  })
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
//  Lore
// =================================================================
function renderLore() {
  const content = `
    <div class="section-h" style="margin-top:6px"><h2>Lore</h2></div>
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
    app.querySelectorAll('[data-lore]').forEach(card => {
      card.addEventListener('click', () => playLoreVideo(LORE_VIDEOS[Number(card.dataset.lore)]))
    })
  })
}

function renderLegal() {
  const content = `
    <div class="section-h" style="margin-top:6px"><h2>Legal and Disclaimers</h2></div>
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
  mountScreen('settings', content)
}

// Plays a lore video fullscreen with sound, ducking the bg music for the
// duration. iOS Safari only supports fullscreen via the video element's own
// webkitEnterFullscreen (the generic Fullscreen API doesn't work there), so
// both paths are wired; the overlay itself is also a full-viewport fallback
// in case neither fullscreen API is available.
function playLoreVideo(entry) {
  const wasMusicPlaying = !bgMusic.paused
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
function renderAdminDashboard() {
  if (!isAdmin()) { renderSettings(); return }

  const content = `
    <div class="section-h" style="margin-top:6px"><h2>Admin Dashboard</h2></div>

    <div class="admin-dash">
      <div class="group">
        <p class="glab">Moderation</p>
        <div class="glist">
          <div class="grow mod-summary-row" role="button" tabindex="0" data-action="open-moderation">
            <div class="mod-summary-body">
              <div class="gt">Reports and Blocks</div>
              <div class="mod-summary-counts" id="mod-summary-counts">
                <span class="count-pip"><span class="pip-dot rep"></span>Loading&hellip;</span>
              </div>
            </div>
            <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
          </div>
        </div>
      </div>

      <div class="group">
        <p class="glab">Notifications</p>
        <div class="glist">
          <div class="grow" role="button" tabindex="0" data-action="open-compose">
            <div><div class="gt">Send Notification</div><div class="gs">Message one chef, a few, or everyone</div></div>
            <div class="right"><span class="chevron" aria-hidden="true">›</span></div>
          </div>
        </div>
      </div>

      <div class="group">
        <p class="glab">Preset Profile Pictures</p>
        <div class="adm-preset-grid" id="preset-grid"><p class="log-empty">Loading&hellip;</p></div>
        <button class="admin-upload-btn" type="button" data-action="toggle-preset-edit">Edit Pictures</button>
        <input type="file" accept="image/*" id="preset-input" hidden />
      </div>

      <div class="group">
        <p class="glab">Emote Types</p>
        <div class="adm-tags" id="adm-tags"><p class="editpic-empty">Loading&hellip;</p></div>
        <div class="adm-search-card" style="margin-top:0.75rem">
          <input id="adm-new-tag" type="text" placeholder="New type name" maxlength="20" />
          <button type="button" data-action="add-tag">Add</button>
        </div>
        <p class="glab" style="margin-top:1.5rem">Tag Emotes</p>
        <div class="glist" id="adm-emote-list"></div>
      </div>

      <!-- Users last: this list can get long, so it lives at the bottom -->
      <div class="group">
        <p class="glab">Edit User Pizzas, Coins &amp; Names</p>
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

  presetEditMode = false
  mountScreen('settings', content, () => {
    loadModSummary()
    app.querySelector('[data-action="open-moderation"]').addEventListener('click', () => renderModerationCenter())
    app.querySelector('[data-action="open-compose"]').addEventListener('click', renderComposeNotification)
    loadPresetAvatars()
    app.querySelector('#preset-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''
      if (file) openAvatarCropper(file, (blob) => uploadPresetAvatar(blob))
    })
    app.querySelector('[data-action="toggle-preset-edit"]').addEventListener('click', () => {
      presetEditMode = !presetEditMode
      renderPresetGrid()
    })

    loadEmoteData(true).then(renderAdminEmoteTypes)
    app.querySelector('[data-action="add-tag"]').addEventListener('click', addEmoteTag)
    app.querySelector('#adm-new-tag').addEventListener('keydown', (e) => { if (e.key === 'Enter') addEmoteTag() })

    loadAdminUsers()
    app.querySelector('#admin-search-input').addEventListener('input', (e) => renderAdminUserList(e.target.value))
  })
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
  const el = app.querySelector('#mod-summary-counts')
  if (!el) return
  const { openReports, newBlocks } = await fetchModerationCounts()
  el.innerHTML = `
    <span class="count-pip"><span class="pip-dot rep"></span><b>${openReports}</b>&nbsp;pending report${openReports === 1 ? '' : 's'}</span>
    <span class="count-pip"><span class="pip-dot blk"></span><b>${newBlocks}</b>&nbsp;new block${newBlocks === 1 ? '' : 's'}</span>
  `
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
  el.textContent = String(Math.max(0, (parseInt(el.textContent, 10) || 0) + delta))
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
      <span data-seg="reports" class="${tab === 'reports' ? 'on' : ''}">Reports · <b id="seg-reports-n">–</b></span>
      <span data-seg="blocks" class="${tab === 'blocks' ? 'on' : ''}">Blocks · <b id="seg-blocks-n">–</b></span>
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
  })
}

async function loadModSegCounts() {
  const { openReports, newBlocks } = await fetchModerationCounts()
  const rn = app.querySelector('#seg-reports-n'); if (rn) rn.textContent = openReports
  const bn = app.querySelector('#seg-blocks-n'); if (bn) bn.textContent = newBlocks
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
  if (!seenError) { const n = app.querySelector('#seg-blocks-n'); if (n) n.textContent = '0' }
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
  })
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
      return `
        <div class="adm-emote-row" data-emote-id="${e.id}" role="button" tabindex="0">
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
    <label class="field-label" for="em-title">Title</label>
    <input id="em-title" class="rename-input" type="text" maxlength="40" value="${escapeHtml(emoteName(emote))}" />
    <label class="field-label" for="em-desc">Description</label>
    <input id="em-desc" class="rename-input" type="text" maxlength="80" value="${escapeHtml(emoteDesc(emote))}" />
    <label class="field-label">Type</label>
    <div class="sort-options">
      ${typeOpts.map(op => `<button type="button" class="sort-option ${(selectedTag || '') === op.id ? 'active' : ''}" data-type="${op.id}">${escapeHtml(op.label)}</button>`).join('')}
    </div>
    <div class="home-btn-col" style="margin-top:1.25rem">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    selectedTag = b.dataset.type || null
    o.querySelectorAll('[data-type]').forEach(x => x.classList.toggle('active', x === b))
  }))
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
let presetAvatarsCache = []

async function loadPresetAvatars() {
  const grid = app.querySelector('#preset-grid')
  if (!grid) return
  const { data, error } = await supabase.from('preset_avatars').select('id, path, url').order('created_at', { ascending: false })
  if (error) { grid.innerHTML = `<p class="log-empty">${escapeHtml(error.message)}</p>`; return }
  presetAvatarsCache = data || []
  renderPresetGrid()
}

function renderPresetGrid() {
  const grid = app.querySelector('#preset-grid')
  if (!grid) return
  const items = presetAvatarsCache.map(p => `
    <div class="adm-preset-item" data-preset-id="${p.id}" data-preset-path="${escapeHtml(p.path)}">
      <img src="${p.url}" alt="" />
      ${presetEditMode ? `<button class="adm-preset-remove" type="button" data-action="remove-preset" aria-label="Remove preset">✕</button>` : ''}
    </div>
  `).join('')
  grid.innerHTML = items + (presetEditMode ? `<button class="adm-preset-add" type="button" data-action="upload-preset" aria-label="Upload new preset">+</button>` : '')
  grid.querySelector('[data-action="upload-preset"]')?.addEventListener('click', () => app.querySelector('#preset-input').click())
  grid.querySelectorAll('[data-action="remove-preset"]').forEach(btn => {
    btn.addEventListener('click', () => confirmRemovePreset(btn.closest('.adm-preset-item')))
  })
  const toggleBtn = app.querySelector('[data-action="toggle-preset-edit"]')
  if (toggleBtn) toggleBtn.textContent = presetEditMode ? 'Done Editing' : 'Edit Pictures'
}

async function uploadPresetAvatar(blob) {
  const path = `presets/${crypto.randomUUID()}.jpg`
  const { error: uploadError } = await supabase.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' })
  if (uploadError) { toast(uploadError.message); return }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const { error } = await supabase.from('preset_avatars').insert({ path, url: data.publicUrl })
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
  loadPresetAvatars()
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
    <input id="admin-name" class="rename-input" type="text" maxlength="15" value="${escapeHtml(profile.display_name || '')}" />

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
    const newName = o.querySelector('#admin-name').value.trim().slice(0, 15) || profile.display_name
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
      if (error) { toast(error.message); return }
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
]
function isNameAllowed(name) {
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return !NAME_BLOCKLIST.some(w => n.includes(w))
}

function openRenamePopup() {
  // The "Chef" prefix is fixed and shown as a non-editable label; the user
  // only edits the [name] part (max 15 chars), stored raw in display_name.
  const o = overlay(`
    <h3>Edit name</h3>
    <div class="rename-chef-row">
      <span class="rename-chef-prefix">Chef</span>
      <input id="rename-input" class="rename-input" type="text" maxlength="15" value="${escapeHtml(myRawName())}" placeholder="Your name" />
    </div>
    <p class="inline-error" id="rename-error">That name isn't allowed &mdash; please choose another.</p>
    <div class="home-btn-col">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  const input = o.querySelector('#rename-input')
  const errEl = o.querySelector('#rename-error')
  const saveBtn = o.querySelector('[data-action="save"]')
  const validate = () => {
    const val = input.value.trim()
    const ok = !!val && isNameAllowed(input.value)
    errEl.classList.toggle('show', !!val && !isNameAllowed(input.value))
    input.classList.toggle('err', !!val && !isNameAllowed(input.value))
    saveBtn.disabled = !ok
    return ok
  }
  input.addEventListener('input', validate)
  validate()
  setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newName = stripChef(input.value).slice(0, 15)
    if (!newName) return
    if (!validate()) return
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', currentUser.id)
    if (error) { toast(error.message); return }
    currentProfile.display_name = newName
    o.remove()
    renderSettings()
    toast('Name updated')
  })
}

function showNotSignedInWarning() {
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
    <div class="intro-start">
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
  })
}

function renderTimePickerUI({ title, onPick, onBack }) {
  app.innerHTML = `
    <div class="picker">
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
function renderTaskPrompt(minutes) {
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
      <div class="picker-content">
        <h2>What are you working on?</h2>
        <p class="home-tag">Short phrase, max 30 characters</p>
        <input type="text" maxlength="30" class="task-input" placeholder="e.g. Essay writing" />
        <button class="start-btn" data-done type="button">Done</button>
      </div>
    </div>
  `
  const input = app.querySelector('.task-input')
  input.focus()
  app.querySelector('.back-arrow-btn').addEventListener('click', renderDurationPicker)
  app.querySelector('[data-done]').addEventListener('click', () => {
    startSession(minutes, input.value.trim().slice(0, 30))
  })
}

function startSession(minutes, task) {
  state.timer = {
    task: task || '',
    elapsedMs: 0,
    segmentPlannedMs: minutes * 60 * 1000,
    segmentStartedAt: Date.now(),
    remainingMsSnapshot: null,
  }
  save()
  renderTimerLoop(true)
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
