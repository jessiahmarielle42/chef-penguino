import './style.css'
import { supabase } from './supabaseClient.js'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL
const APP_VERSION = 'v2.0.1'

const STORAGE_KEY = 'chef-penguino-save'

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
  await supabase.auth.signOut()
  currentUser = null
  currentProfile = null
  renderHome()
}

async function refreshProfile() {
  if (!currentUser) { currentProfile = null; return }
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, friend_code, pizzas, avatar_url, owned_emotes')
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
    pizzas: 0, muted: false, volume: 0.5, darkenLevel: 1, autoDarken: true,
    timer: null, log: [], cloudSynced: false, lastSeenPizzaCount: null,
    pendingSessions: [], ownedEmotes: [], equippedEmote: 'waving', lastSeenCoins: null,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch {}
  return defaults
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

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

// Without a touch listener, iOS Safari won't apply :active CSS states on
// quick taps, so buttons feel unresponsive - this is a no-op handler that
// exists purely to turn that behavior on.
document.addEventListener('touchstart', () => {}, { passive: true })

function round2(n) { return parseFloat(n.toFixed(2)) }
function round1(n) { return parseFloat(n.toFixed(1)) }
function formatScore(n) { return String(round2(n)) }
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

function addSessionPizzas(minutes) {
  state.pizzas = round2(state.pizzas + minutes / 60)
  save()
}

function logSession({ completedAt, minutes, pizzas, task }) {
  state.log.unshift({ completedAt, minutes, pizzas, task })
  save()
}

async function finalizeSession(playAlarm) {
  const t = state.timer
  const minutes = t.elapsedMs / 60000
  const pizzasEarned = round2(minutes / 60)
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
      })
    } else if (event === 'SIGNED_OUT') {
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
}

boot()

// =================================================================
//  Coin + emote economy (all derived from lifetime pizzas)
// =================================================================
const EMOTES = [
  { id: 'waving', name: 'Waving', desc: 'Your chef waves hello', clip: 'pizzas-waving.mp4', free: true },
  { id: 'sniffing', name: 'Sniffing', desc: 'Leans in for a big whiff', clip: 'pizzas-sniffing.mp4' },
  { id: 'eating', name: 'Eating', desc: 'Sneaks a slice for himself', clip: 'pizzas-eating.mp4' },
]
const EMOTE_BY_ID = Object.fromEntries(EMOTES.map(e => [e.id, e]))

function ownedEmotes() {
  return (currentProfile ? currentProfile.owned_emotes : state.ownedEmotes) || []
}
function isOwned(id) { return id === 'waving' || ownedEmotes().includes(id) }
function coinsEarned() { return Math.floor(Math.floor(displayPizzas()) / 12) }
function coinBalance() { return Math.max(0, coinsEarned() - ownedEmotes().length) }
function stashCount() { return Math.floor(displayPizzas()) % 12 }
function equippedEmote() {
  const e = state.equippedEmote || 'waving'
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

function equipEmote(id) {
  if (!isOwned(id)) return
  state.equippedEmote = id
  save()
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

function statusBarHtml() {
  return `
    <div class="statusbar">
      <div class="who">
        <img class="who-avatar" src="${myAvatar()}" alt="" role="button" tabindex="0" data-action="profile" />
        <div>
          <div class="greet">${isSignedIn() ? 'Welcome back,' : 'Hello,'}</div>
          <div class="nm">${escapeHtml(myName())}</div>
        </div>
      </div>
      <div class="stats">
        <span class="chip"><span class="ic">🍕</span><span>${formatScore(displayPizzas())}</span></span>
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

function mountScreen(active, contentHtml, after) {
  app.innerHTML = `
    <div class="app">
      ${statusBarHtml()}
      <div class="scroll view active">${contentHtml}</div>
      ${tabBarHtml(active)}
    </div>
  `
  wireStatusBar()
  wireTabBar()
  if (after) after()
}

function wireStatusBar() {
  app.querySelector('[data-action="profile"]')?.addEventListener('click', openProfilePopup)
  app.querySelector('[data-action="coin-info"]')?.addEventListener('click', openCoinInfo)
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
  app.querySelector('[data-action="cook"]')?.addEventListener('click', startCookingFlow)
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
    <div class="hero-card" id="hero-card">
      <img class="hero-still" src="${heroSrc}" alt="" />
      <div class="glow"></div>
      <button class="hero-tap" type="button" data-action="emote">👋 Tap to emote</button>
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="lab">🍕 Lifetime pizzas</div>
        <div class="big">${formatScore(lifetime)}</div>
        <div class="sub">All-time made</div>
      </div>
      <div class="tile coin-tile">
        <div class="lab">Pizzas in stash</div>
        <div class="big">${stash}<span style="font-size:16px;color:var(--muted)">/12</span></div>
        <div class="sub">${toNext} more → 1 coin</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
    </div>

    <button class="cta" type="button" data-action="cook">🔥 Start Cooking</button>

    <div class="quicklinks">
      <div class="qlink" data-go="shop"><span class="qic">🛍️</span> Emotes Shop</div>
      <div class="qlink" data-go="friends"><span class="qic">🐧</span> Friends</div>
    </div>

    <div class="section-h"><h2>Recent sessions</h2></div>
    <div class="log-list" id="home-log"><p class="log-empty">Loading&hellip;</p></div>
  `

  mountScreen('home', content, () => {
    app.querySelector('[data-action="cook"]').addEventListener('click', startCookingFlow)
    app.querySelector('[data-go="shop"]').addEventListener('click', renderShop)
    app.querySelector('[data-go="friends"]').addEventListener('click', renderFriends)

    // Tap the shopfront to play the equipped emote, then revert to the still.
    const attachEmoteTap = (btnHost) => {
      btnHost.addEventListener('click', () => {
        const img = app.querySelector('#hero-card .hero-still')
        if (img && img.tagName === 'IMG') {
          playEmoteInto(img, equippedEmote(), heroSrc)
        }
      })
    }
    attachEmoteTap(app.querySelector('.hero-tap'))

    loadHomeLog()
    maybeShowCoinMilestone()
  })
}

async function loadHomeLog() {
  const log = await fetchLog(currentUser?.id)
  const listEl = app.querySelector('#home-log')
  if (!listEl) return
  const recent = log.slice(0, 6)
  const groups = groupLogByDate(recent)
  listEl.innerHTML = groups.length
    ? groups.map(renderDateGroup).join('')
    : '<p class="log-empty">No sessions yet. Start cooking!</p>'
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
function renderShop() {
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

  const thumb = `${BASE}assets/display-case/12.jpg`
  const cards = EMOTES.map(e => {
    const owned = isOwned(e.id)
    const equipped = equippedEmote() === e.id
    let badge
    if (e.free) badge = '<span class="badge">Free</span>'
    else if (owned) badge = '<span class="badge">Owned</span>'
    else badge = '<span class="badge">Locked</span>'
    const lock = (!owned) ? '<div class="lock">🔒</div>' : ''

    let action
    if (equipped) action = `<button class="btn btn-equipped" type="button" data-equip="${e.id}">✓ Equipped</button>`
    else if (owned) action = `<button class="btn btn-equip" type="button" data-equip="${e.id}">Equip</button>`
    else action = `<button class="btn btn-buy" type="button" data-buy="${e.id}">${coinImg()}1</button>`

    return `
      <div class="anim-card">
        <div class="anim-top" data-emote="${e.id}">
          <img class="anim-still" src="${thumb}" alt="${escapeHtml(e.name)}" />
          ${badge}${lock}
        </div>
        <div class="anim-body">
          <div class="anim-info"><div class="nm">${escapeHtml(e.name)}</div><div class="ds">${escapeHtml(e.desc)}</div></div>
          <div class="act">
            <button class="btn btn-preview" type="button" data-preview="${e.id}">▶ Preview</button>
            ${action}
          </div>
        </div>
      </div>
    `
  }).join('')

  const content = `
    <div class="shop-banner">
      ${coinImg('lg')}
      <div class="txt">
        <div class="t">Emotes Shop <span class="info-badge" role="button" tabindex="0" data-action="coin-info">i</span></div>
        <div class="s">Unlock new moves for your chef.</div>
      </div>
    </div>
    ${cards}
    <p class="code-note" style="text-align:center">More emotes coming — earn a coin every 12 pizzas.</p>
  `

  mountScreen('shop', content, () => {
    app.querySelector('[data-action="coin-info"]')?.addEventListener('click', openCoinInfo)

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
      btn.addEventListener('click', () => { equipEmote(btn.dataset.equip); renderShop() })
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
//  Profile popup (tap the status-bar avatar)
// =================================================================
function openProfilePopup() {
  const signed = isSignedIn()
  const editOrGuest = signed
    ? `<button class="btn-edit-profile" type="button" data-action="edit-profile">${PENCIL_SVG}<span style="margin-left:8px">Edit Profile</span></button>`
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
    <div class="section-h" style="margin-top:6px"><h2>Leaderboard</h2><span class="meta">Lifetime pizzas</span></div>
    <div id="friends-list"><p class="log-empty">Loading&hellip;</p></div>
    <div class="section-h"><h2>Add a friend</h2></div>
    <div class="addfriend"><input id="friend-code-input" placeholder="Friend's code" maxlength="6" /><button type="button" data-action="add">Add</button></div>
    <p class="friends-error" id="friends-error" hidden></p>
    <p class="code-note">Your code: <b id="friend-code-val">${currentProfile?.friend_code || '…'}</b> <button class="copy-btn" type="button" data-action="copy" aria-label="Copy friend code">${COPY_SVG}</button> — share it to compare pizzas.</p>
    <div class="friend-swipe-hint">
      <span class="info-badge" aria-hidden="true">i</span>
      <p>To remove friends, swipe left on their name above.</p>
    </div>
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

  const { data: friendRows } = await supabase
    .from('friends')
    .select('friend_id, profiles:friend_id(id, display_name, pizzas, avatar_url)')

  const friends = (friendRows || []).map(r => r.profiles).filter(Boolean).sort((a, b) => b.pizzas - a.pizzas)
  if (!friends.length) {
    listEl.innerHTML = '<p class="log-empty">No friends yet. Share your code below!</p>'
    return
  }

  const medals = ['🥇', '🥈', '🥉']
  listEl.innerHTML = friends.map((f, i) => `
    <div class="frow-wrap">
      <button class="frow-delete" type="button" data-remove="${f.id}">🗑<span>Delete</span></button>
      <div class="frow">
        <div class="${i < 3 ? 'medal' : 'rank'}">${i < 3 ? medals[i] : (i + 1)}</div>
        <img src="${f.avatar_url || `${BASE}assets/penguin-icon.png`}" alt="" />
        <div><div class="fn">${escapeHtml(f.display_name)}</div><div class="fp">Code ${escapeHtml(f.friend_code || '')}</div></div>
        <div class="score">🍕 ${formatScore(f.pizzas)}</div>
      </div>
    </div>
  `).join('')

  const nameById = Object.fromEntries(friends.map(f => [f.id, f.display_name]))
  listEl.querySelectorAll('.frow-wrap').forEach(wrap => wireSwipeRow(wrap, nameById))
}

const SWIPE_OPEN_X = -84
function closeAllSwipes(except) {
  app.querySelectorAll('.frow-wrap').forEach(w => {
    if (w === except) return
    w.querySelector('.frow').style.transform = ''
    w.classList.remove('open')
  })
}

function wireSwipeRow(wrap, nameById) {
  const row = wrap.querySelector('.frow')
  const delBtn = wrap.querySelector('.frow-delete')
  const friendId = delBtn.dataset.remove
  let startX = 0, startY = 0, currentX = 0, dragging = false, axis = null, suppressClick = false

  row.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startY = e.clientY
    currentX = wrap.classList.contains('open') ? SWIPE_OPEN_X : 0
    dragging = true; axis = null
    wrap.classList.add('dragging')
    try { row.setPointerCapture(e.pointerId) } catch {}
  })
  row.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - startX, dy = e.clientY - startY
    if (axis === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    if (axis !== 'x') return
    row.style.transform = `translateX(${Math.min(0, Math.max(SWIPE_OPEN_X, currentX + dx))}px)`
  })
  const end = (e) => {
    if (!dragging) return
    dragging = false
    wrap.classList.remove('dragging')
    if (axis !== 'x') { axis = null; return }
    const finalX = Math.min(0, Math.max(SWIPE_OPEN_X, currentX + (e.clientX - startX)))
    const open = finalX < SWIPE_OPEN_X / 2
    const wasOpen = wrap.classList.contains('open')
    closeAllSwipes(wrap)
    row.style.transform = open ? `translateX(${SWIPE_OPEN_X}px)` : ''
    wrap.classList.toggle('open', open)
    if (open && !wasOpen) suppressClick = true
    axis = null
  }
  row.addEventListener('pointerup', end)
  row.addEventListener('pointercancel', end)
  row.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); return }
    if (wrap.classList.contains('open')) { e.stopPropagation(); closeAllSwipes() }
  }, true)

  delBtn.addEventListener('click', () => confirmRemoveFriend(friendId, nameById[friendId] || 'this friend', wrap))
}

function confirmRemoveFriend(friendId, name, wrap) {
  const o = overlay(`
    <h3>Do you want to remove ${escapeHtml(name)} as friend?</h3>
    <p>You can add them back anytime with their friend code.</p>
    <div class="home-btn-col">
      <button type="button" class="btn-danger" data-action="yes">Yes, remove</button>
      <button type="button" class="btn-secondary" data-action="no">Cancel</button>
    </div>
  `)
  o.querySelector('[data-action="no"]').addEventListener('click', () => { o.remove(); closeAllSwipes() })
  o.querySelector('[data-action="yes"]').addEventListener('click', async () => {
    o.remove()
    await supabase.rpc('remove_friend', { target_id: friendId })
    wrap?.remove()
    toast(`Removed ${name}`)
  })
}

async function fetchLog(userId) {
  if (!userId) return state.log
  const { data } = await supabase
    .from('sessions')
    .select('completed_at, minutes, pizzas, task')
    .eq('user_id', userId)
    .order('completed_at', { ascending: false })
  if (!data) return []
  return data.map(r => ({
    completedAt: new Date(r.completed_at).getTime(),
    minutes: r.minutes,
    pizzas: r.pizzas,
    task: r.task,
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

function renderDateGroup(group) {
  return `
    <div class="log-date-group">
      <div class="log-date-heading">${group.label}</div>
      ${group.entries.map(renderLogRow).join('')}
    </div>
  `
}

function renderLogRow(entry) {
  const time = new Date(entry.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const task = escapeHtml(entry.task) || 'Focus session'
  return `
    <div class="log-row">
      <div class="log-row-main">
        <span class="log-row-task">${task}</span>
        <span class="log-row-time">${time}</span>
      </div>
      <div class="log-row-meta">
        <span>${formatDuration(entry.minutes)}</span>
        <span class="log-row-pizzas">🍕 ${formatScore(entry.pizzas)}</span>
      </div>
    </div>
  `
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
            <div class="gs">Chef Penguino</div>
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
          <div><div class="gt">Background music</div></div>
          <div class="right"><div class="switch ${state.muted ? 'off' : ''}" data-action="toggle-music"></div></div>
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
          <div class="right"><div class="switch ${state.autoDarken ? '' : 'off'}" data-action="toggle-darken"></div></div>
        </div>
      </div>
    </div>
    ${accountGroup}
    <div class="group">
      <p class="glab">About</p>
      <div class="glist">
        <div class="grow"><div><div class="gt">Version</div><div class="gs">${APP_VERSION}</div></div></div>
      </div>
    </div>
    <div style="height:8px"></div>
  `

  mountScreen('settings', content, () => {
    app.querySelector('#volume-slider').addEventListener('input', (e) => {
      state.volume = Number(e.target.value) / 100; save(); syncMusic()
    })
    app.querySelector('[data-action="toggle-music"]').addEventListener('click', (e) => {
      state.muted = !state.muted; save(); syncMusic(); e.currentTarget.classList.toggle('off', state.muted)
    })
    app.querySelector('[data-action="toggle-darken"]').addEventListener('click', (e) => {
      state.autoDarken = !state.autoDarken; save(); e.currentTarget.classList.toggle('off', !state.autoDarken)
    })
    app.querySelector('[data-action="google"]')?.addEventListener('click', signInWithGoogle)
    app.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut)
    app.querySelector('[data-action="rename"]')?.addEventListener('click', openRenamePopup)

    app.querySelector('[data-action="change-photo"]')?.addEventListener('click', () => app.querySelector('#avatar-input').click())
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
