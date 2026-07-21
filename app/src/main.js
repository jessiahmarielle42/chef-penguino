import './style.css'
import { supabase } from './supabaseClient.js'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL
const APP_VERSION = 'v2.6.4'

const STORAGE_KEY = 'chef-penguino-save'

// Client-side hiding of the Admin Dashboard entry point only - real
// enforcement lives in Supabase RLS (see migration_admin.sql), which checks
// auth.email() server-side and can't be spoofed from here.
const ADMIN_EMAIL = 'keefefons@gmail.com'
function isAdmin() { return currentUser?.email === ADMIN_EMAIL }

let currentUser = null
let currentProfile = null

// ---------- auth / profile / supabase plumbing (unchanged mechanics) ----------
async function signInWithGoogle() {
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + BASE },
  })
}

async function signOut() {
  unsubscribeFromSocial()
  await supabase.auth.signOut()
  currentUser = null
  currentProfile = null
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
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') { checkPendingNoots(); checkPendingCoinGifts() }
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
  const m = Math.round(minutes)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
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

function logSession({ completedAt, minutes, pizzas, task }) {
  state.log.unshift({ id: crypto.randomUUID(), completedAt, minutes, pizzas, task })
  save()
}

async function finalizeSession(playAlarm) {
  const t = state.timer
  const minutes = t.elapsedMs / 60000
  const pizzasEarned = minutes / 60 // full precision - see addSessionPizzas
  const completedAt = Date.now()
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
    await refreshProfile()
  }

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
      })
    } else if (event === 'SIGNED_OUT') {
      unsubscribeFromSocial()
      currentUser = null
      currentProfile = null
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
}

boot()

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
]
const EMOTE_BY_ID = Object.fromEntries(EMOTES.map(e => [e.id, e]))

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

function myName() {
  if (!currentUser) return 'Guest'
  return currentProfile?.display_name || currentUser.email?.split('@')[0] || 'Chef'
}
function myAvatar() {
  return currentProfile?.avatar_url || `${BASE}assets/penguin-icon.png`
}

function coinImg(extra = '') {
  return `<img class="coin ${extra}" src="${BASE}assets/coin.png" alt="coin" />`
}

const GOOGLE_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`

function googleBtn() {
  return `<button class="gbtn" type="button" data-action="google">${GOOGLE_SVG}<span>Sign in with Google</span></button>`
}

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
  const tab = (t) => `<button class="tab ${active === t.id ? 'active' : ''}" type="button" data-tab="${t.id}"><span class="ti">${t.icon}</span>${t.label}</button>`
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

    <div class="section-h" style="margin-top:2.75rem"><h2>Recent sessions</h2></div>
    <div class="friend-swipe-hint" style="margin-top:0.625rem;margin-bottom:1.375rem">
      <span class="info-badge" aria-hidden="true">i</span>
      <p>Swipe left on a session to edit</p>
    </div>
    <div class="log-list" id="home-log"><p class="log-empty">Loading&hellip;</p></div>
  `

  mountScreen('home', content, () => {
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
const SORT_LABELS = { owned: 'Owned', az: 'A-Z', newest: 'Newest' }

function sortedShopEmotes() {
  if (shopSort === 'az') {
    return [...EMOTES].sort((a, b) => a.name.localeCompare(b.name))
  }
  if (shopSort === 'owned') {
    // Only owned emotes, latest bought -> oldest. owned_emotes is stored in
    // purchase order (appended on buy), so reversing gives newest-first. The
    // free 'waving' isn't in that array but is always owned, so it goes last
    // as the oldest-owned default.
    const owned = [...ownedEmotes()].reverse().map(id => EMOTE_BY_ID[id]).filter(Boolean)
    if (isOwned('waving')) owned.push(EMOTE_BY_ID['waving'])
    return owned
  }
  // 'newest': EMOTES is ordered oldest-added -> newest, so reverse it.
  return [...EMOTES].reverse()
}

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

function renderShop(scrollTop) {
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
      app.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
    })
    return
  }

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
          <img class="anim-still" src="${thumb}" alt="${escapeHtml(e.name)}" />
          ${badge}${lock}
        </div>
        <div class="anim-body">
          <div class="anim-info"><div class="nm">${escapeHtml(e.name)}</div><div class="ds">${escapeHtml(e.desc)}</div></div>
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
    </div>
    ${cards}
    <p class="code-note" style="text-align:center">More emotes coming — earn a coin every 12 pizzas.</p>
  `

  mountScreen('shop', content, () => {
    if (scrollTop) app.querySelector('.scroll').scrollTop = scrollTop

    app.querySelector('[data-action="shop-coin-info"]')?.addEventListener('click', openCoinInfo)
    app.querySelector('[data-action="sort"]')?.addEventListener('click', openSortMenu)

    app.querySelectorAll('[data-preview]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.preview
        const top = btn.closest('.anim-card').querySelector('.anim-top')
        const img = top.querySelector('.anim-still')
        if (img && img.tagName === 'IMG') {
          top.classList.remove('previewing'); void top.offsetWidth; top.classList.add('previewing')
          playEmoteInto(img, id, thumb)
          toast(`▶ Previewing ${EMOTE_BY_ID[id].name}…`)
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
    <h3>Unlock ${escapeHtml(e.name)}?</h3>
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
  o.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
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
      app.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
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
    const name = f.isMe ? `${escapeHtml(f.display_name)} <span class="you-tag">(you)</span>` : escapeHtml(f.display_name)
    return `
      <div class="frow ${f.isMe ? 'me' : ''}" ${f.isMe ? 'role="button" tabindex="0"' : `data-friend="${f.id}" role="button" tabindex="0"`}>
        ${rank}
        <img src="${f.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
        <div><div class="fn">${name}</div><div class="fp">Code ${escapeHtml(f.friend_code || '')}</div></div>
        <div class="score">🍕 ${formatScore(f.pizzas)}</div>
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
    <img class="popup-profile-avatar" src="${friend.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
    <div class="popup-profile-name">${escapeHtml(friend.display_name)}</div>
    <div class="home-btn-col">
      <button type="button" class="btn-secondary" data-action="visit">🏠 Visit Pizzeria</button>
      <button type="button" class="btn-secondary" data-action="noot">🐧 Noot</button>
      <button type="button" data-action="gift">🎁 Gift Coins</button>
      <button type="button" class="btn-danger" data-action="remove">🗑 Remove</button>
    </div>
  `, { popupClass: 'popup-profile' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="visit"]').addEventListener('click', () => { o.remove(); renderFriendHome(friend) })
  o.querySelector('[data-action="gift"]').addEventListener('click', () => { o.remove(); playNootSound(); confirmGiftCoin(friend) })
  o.querySelector('[data-action="noot"]').addEventListener('click', () => {
    o.remove()
    playNootSound()
    if (alreadyNooted) { openNootCooldownInfo(friend.display_name); return }
    confirmNoot(friend)
  })
  o.querySelector('[data-action="remove"]').addEventListener('click', () => { o.remove(); confirmRemoveFriend(friend.id, friend.display_name) })
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
    <h3>Gift 1 Penguino Coin to ${escapeHtml(friend.display_name)}?</h3>
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
    toast(`Gifted 1 coin to ${friend.display_name}! 🎁`)
  })
}

function confirmNoot(friend) {
  const o = overlay(`
    <h3>Do you want to Noot ${escapeHtml(friend.display_name)}?</h3>
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
    toast(`Nooted ${friend.display_name}!`)
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
    <img class="popup-profile-avatar" src="${noot.sender?.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
    <h3>${escapeHtml(noot.sender?.display_name || 'A friend')} Nooted you!</h3>
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
    <img class="popup-profile-avatar" src="${gift.sender?.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
    <h3>${escapeHtml(gift.sender?.display_name || 'A friend')} gifted you a Penguino Coin! 🎁</h3>
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

function openNootCooldownInfo(name) {
  const o = overlay(`
    <span class="info-badge popup-info-badge" aria-hidden="true">i</span>
    <div class="popup-emoji-xl">🐧</div>
    <h3>Already Nooted</h3>
    <p>You can Noot ${escapeHtml(name)} again once they've acknowledged your last Noot.</p>
    <button type="button" data-action="ok">Got it</button>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="ok"]').addEventListener('click', () => o.remove())
}

function renderFriendHome(friend) {
  const stash = Math.floor(friend.pizzas) % 12
  const toNext = 12 - stash
  const pct = Math.round((stash / 12) * 100)
  const heroSrc = pizzaImagePath(stash)

  const content = `
    <div class="viewing-banner" id="viewing-banner" role="button" tabindex="0">Viewing: ${escapeHtml(friend.display_name)}'s Pizzeria</div>
    <div class="hero-card" id="hero-card" role="button" tabindex="0">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      <button class="hero-tap" type="button" data-action="emote">👋 Tap to emote</button>
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

    <div class="section-h"><h2>Recent sessions</h2></div>
    <div class="log-list" id="home-log"><p class="log-empty">Loading&hellip;</p></div>
  `

  mountScreen('friends', content, () => {
    loadHomeLog(friend.id)
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

function logRowMetric(entry) {
  const m = COIN_TASK_RE.exec(entry.task || '')
  if (m) return `${coinImg('log-coin')} ${m[1]}`
  // Older coin-adjustment rows carried the coin marker only in the icon, with
  // no stored amount - still show a coin, never a misleading "pizza 0".
  if (entry.icon === '🪙') return `${coinImg('log-coin')}`
  if (entry.task === 'Admin Edit') return `🍕 ${signedScore(entry.pizzas)}`
  return `🍕 ${formatScore(entry.pizzas)}`
}

function renderLogRow(entry, editable) {
  const time = new Date(entry.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  // Strip the "(+1 coin)" storage suffix from the title - the amount shows on the right.
  const task = escapeHtml((entry.task || '').replace(COIN_TASK_RE, '')) || 'Focus session'
  const icon = stableIconFor(entry)
  if (editable && entry.id) logEntriesById.set(entry.id, { entry, icon })

  const actions = editable && entry.id ? `
    <div class="log-row-actions2">
      <button class="log-action2 edit" type="button" data-action="edit-log" aria-label="Edit session">${PENCIL_SVG}<span>Edit</span></button>
      <button class="log-action2 delete" type="button" data-action="delete-log" aria-label="Delete session">${TRASH_SVG}<span>Delete</span></button>
    </div>
  ` : ''

  return `
    <div class="log-row-wrap" ${editable && entry.id ? `data-log-id="${entry.id}"` : ''}>
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
    renderHome()
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
    renderHome()
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
async function uploadAvatarBlob(blob) {
  const path = `${currentUser.id}/avatar.jpg`
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
  if (uploadError) { toast(uploadError.message); return }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const url = `${data.publicUrl}?t=${Date.now()}`
  await supabase.from('profiles').update({ avatar_url: url }).eq('id', currentUser.id)
  currentProfile.avatar_url = url
  renderSettings()
}

function openEditPicturePopup() {
  const o = overlay(`
    <button class="popup-close" type="button" data-action="close" aria-label="Close">✕</button>
    <h3>Edit Picture</h3>
    <div class="editpic-avatar-wrap">
      <img class="editpic-avatar" src="${myAvatar()}" alt="" />
      <button class="editpic-cam" type="button" data-action="camera" aria-label="Take or upload photo">${CAMERA_SVG}</button>
    </div>
    <label class="field-label">Or pick a preset</label>
    <div class="editpic-presets" id="editpic-presets"><p class="editpic-empty">Loading&hellip;</p></div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="close"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="camera"]').addEventListener('click', () => {
    o.remove()
    app.querySelector('#avatar-input')?.click()
  })
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
    <input type="file" accept="image/*" id="avatar-input" hidden />
  ` : ''

  const accountGroup = `
    <div class="group">
      <p class="glab">Account</p>
      <div class="glist">
        ${signed
          ? `<div class="grow"><div><div class="gt">Google</div><div class="gs">${escapeHtml(currentUser.email || '')}</div></div><div class="right"><span class="linkish signout" data-action="sign-out">Sign out</span></div></div>`
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
      <div class="glist">
        <div class="grow" role="button" tabindex="0" data-action="lore">
          <div><div class="gt">Lore</div><div class="gs">Click to learn about Chef Penguino lore</div></div>
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
    app.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
    app.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut)
    app.querySelector('[data-action="rename"]')?.addEventListener('click', openRenamePopup)

    app.querySelector('[data-action="change-photo"]')?.addEventListener('click', openEditPicturePopup)
    app.querySelector('#avatar-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''
      if (file) openAvatarCropper(file, (blob) => uploadAvatarBlob(blob))
    })

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

    <div class="group">
      <p class="glab">Preset Profile Pictures</p>
      <div class="adm-preset-grid" id="preset-grid"><p class="log-empty">Loading&hellip;</p></div>
      <button class="admin-upload-btn" type="button" data-action="toggle-preset-edit">Edit Pictures</button>
      <input type="file" accept="image/*" id="preset-input" hidden />
    </div>

    <div class="group">
      <p class="glab">Edit User Pizzas &amp; Coins</p>
      <div class="adm-search-card">
        <span class="adm-search-ic" aria-hidden="true">🔍</span>
        <input id="admin-search-input" type="text" placeholder="Name or friend code" />
        <button type="button" data-action="admin-search">Search</button>
      </div>
      <div id="admin-search-results" style="margin-top:0.875rem"></div>
    </div>
    <div style="height:8px"></div>
  `

  presetEditMode = false
  mountScreen('settings', content, () => {
    loadPresetAvatars()
    app.querySelector('#preset-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = ''
      if (file) openAvatarCropper(file, (blob) => uploadPresetAvatar(blob))
    })
    app.querySelector('[data-action="toggle-preset-edit"]').addEventListener('click', () => {
      presetEditMode = !presetEditMode
      renderPresetGrid()
    })
    app.querySelector('[data-action="admin-search"]').addEventListener('click', runAdminSearch)
    app.querySelector('#admin-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runAdminSearch()
    })
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

async function runAdminSearch() {
  const input = app.querySelector('#admin-search-input')
  const resultsEl = app.querySelector('#admin-search-results')
  const q = input.value.trim().replace(/[,()]/g, '')
  if (!q) { resultsEl.innerHTML = ''; return }
  resultsEl.innerHTML = '<p class="log-empty">Searching&hellip;</p>'
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code, pizzas, coin_adjustment, owned_emotes, avatar_url')
    .or(`display_name.ilike.%${q}%,friend_code.ilike.%${q}%`)
    .limit(10)
  if (error) { resultsEl.innerHTML = `<p class="log-empty">${escapeHtml(error.message)}</p>`; return }
  if (!data || !data.length) { resultsEl.innerHTML = '<p class="log-empty">No users found.</p>'; return }
  resultsEl.innerHTML = `<div class="glist">${data.map(p => `
    <div class="adm-userrow" data-admin-user="${p.id}" role="button" tabindex="0">
      <img src="${p.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
      <div class="adm-u-info"><div class="adm-u-name">${escapeHtml(p.display_name)}</div><div class="adm-u-code">Code ${escapeHtml(p.friend_code || '')}</div></div>
      <div class="adm-u-stats">
        <span class="adm-stat">🍕 ${formatScore(p.pizzas)}</span>
        <span class="adm-stat"><i class="adm-coin-dot"></i> ${adminCoinBalance(p)}</span>
        <span class="chevron" aria-hidden="true">›</span>
      </div>
    </div>
  `).join('')}</div>`
  const byId = Object.fromEntries(data.map(p => [p.id, p]))
  resultsEl.querySelectorAll('[data-admin-user]').forEach(row => {
    row.addEventListener('click', () => openAdminAdjustPopup(byId[row.dataset.adminUser]))
  })
}

function openAdminAdjustPopup(profile) {
  const curPizzas = Number(profile.pizzas) || 0
  const curCoins = adminCoinBalance(profile)
  const o = overlay(`
    <h3>Edit ${escapeHtml(profile.display_name)}</h3>
    <label class="field-label" for="admin-pizzas">Pizzas</label>
    <input id="admin-pizzas" class="rename-input" type="number" step="0.01" value="${curPizzas}" />
    <label class="field-label" for="admin-coins">Coins</label>
    <input id="admin-coins" class="rename-input" type="number" step="1" value="${curCoins}" />
    <div class="home-btn-col" style="margin-top:0.25rem">
      <button type="button" data-action="apply">Save changes</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `, { popupClass: 'popup-wide' })
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="apply"]').addEventListener('click', async () => {
    const newPizzas = Number(o.querySelector('#admin-pizzas').value)
    const newCoins = Number(o.querySelector('#admin-coins').value)
    if (Number.isNaN(newPizzas) || Number.isNaN(newCoins)) { toast('Enter valid numbers'); return }
    const pizzaDelta = Math.round((newPizzas - curPizzas) * 100) / 100
    const coinDelta = Math.round(newCoins - curCoins)
    if (!pizzaDelta && !coinDelta) { o.remove(); return }
    const ok = await applyAdminEdit(profile, pizzaDelta, coinDelta)
    o.remove()
    if (ok) { toast('Applied'); runAdminSearch() }
  })
}

async function applyAdminEdit(profile, pizzaDelta, coinDelta) {
  if (pizzaDelta) {
    const ok = await insertSessionRow({ user_id: profile.id, completed_at: new Date().toISOString(), minutes: 0, pizzas: pizzaDelta, task: 'Admin Edit', icon: '🛠️' })
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

function openRenamePopup() {
  const o = overlay(`
    <h3>Edit name</h3>
    <input id="rename-input" class="rename-input" type="text" maxlength="15" value="${escapeHtml(currentProfile?.display_name || '')}" placeholder="Display name" />
    <div class="home-btn-col">
      <button type="button" data-action="save">Save</button>
      <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
    </div>
  `)
  const input = o.querySelector('#rename-input')
  setTimeout(() => input.focus(), 50)
  o.querySelector('[data-action="cancel"]').addEventListener('click', () => o.remove())
  o.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newName = input.value.trim().slice(0, 15)
    if (!newName) return
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
      <button type="button" data-action="sign-in">Sign in with Google</button>
      <button type="button" class="btn-secondary" data-action="risk">I'll risk it</button>
    </div>
  `)
  o.querySelector('[data-action="sign-in"]').addEventListener('click', signInWithGoogle)
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
          <input type="number" min="1" max="360" inputmode="numeric" placeholder="Minutes" class="custom-input" />
          <button class="custom-go" type="button">Go</button>
        </div>
      </div>
    </div>
  `
  const customRow = app.querySelector('.custom-row')
  const customInput = app.querySelector('.custom-input')
  app.querySelectorAll('.picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.custom) { customRow.hidden = false; customInput.focus(); return }
      onPick(Number(btn.dataset.minutes))
    })
  })
  app.querySelector('.custom-go').addEventListener('click', () => {
    const minutes = Math.floor(Number(customInput.value))
    if (minutes > 0) onPick(minutes)
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
