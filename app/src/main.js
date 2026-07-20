import './style.css'
import { supabase } from './supabaseClient.js'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL

const STORAGE_KEY = 'chef-penguino-save'

let currentUser = null
let currentProfile = null

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
    .select('id, display_name, friend_code, pizzas, avatar_url')
    .eq('id', currentUser.id)
    .single()
  currentProfile = data || null
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
  await refreshProfile()
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
  const defaults = { pizzas: 0, muted: false, volume: 0.5, timer: null, log: [], cloudSynced: false, lastSeenPizzaCount: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch {}
  return defaults
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function round2(n) {
  return parseFloat(n.toFixed(2))
}

function round1(n) {
  return parseFloat(n.toFixed(1))
}

function formatScore(n) {
  return String(round2(n))
}

function formatScore1(n) {
  return String(round1(n))
}

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

function addSessionPizzas(minutes) {
  state.pizzas = round2(state.pizzas + minutes / 60)
  save()
}

function logSession({ completedAt, minutes, pizzas, task }) {
  state.log.unshift({ completedAt, minutes, pizzas, task })
  save()
}

function finalizeSession(playAlarm) {
  const t = state.timer
  const minutes = t.elapsedMs / 60000
  const pizzasEarned = round2(minutes / 60)
  const completedAt = Date.now()
  addSessionPizzas(minutes)
  logSession({ completedAt, minutes, pizzas: pizzasEarned, task: t.task })
  state.timer = null
  save()

  if (currentUser) {
    supabase.from('sessions').insert({
      user_id: currentUser.id,
      completed_at: new Date(completedAt).toISOString(),
      minutes,
      pizzas: pizzasEarned,
      task: t.task || '',
    }).then(() => refreshProfile())
  }

  if (playAlarm) renderIntro(() => renderPizzas(), true)
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

// ---------- Home ----------
function renderHome() {
  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="home-content">
        <img class="home-icon" src="${BASE}assets/penguin-icon.png" alt="Chef Penguino" />
        <div class="home-score">
          <span class="home-score-value">${formatScore(displayPizzas())}</span>
          <span class="home-score-label">pizzas made</span>
        </div>
        <h1>Chef Penguino</h1>
        <p class="home-tag">Focus timer</p>
        <div class="home-btn-col">
          <button class="start-btn" data-nav="start" type="button">Start</button>
          <button class="start-btn" data-nav="pizzas" type="button">Pizzas</button>
          <button class="start-btn" data-nav="friends" type="button">Friends</button>
          <button class="start-btn" data-nav="settings" type="button">Settings</button>
        </div>
      </div>
    </div>
  `
  app.querySelector('[data-nav="start"]').addEventListener('click', () => {
    if (currentUser) {
      renderIntro(renderDurationPicker, false)
    } else {
      showNotSignedInWarning()
    }
  })
  app.querySelector('[data-nav="pizzas"]').addEventListener('click', () => {
    renderPizzas(undefined, true)
  })
  app.querySelector('[data-nav="friends"]').addEventListener('click', renderFriends)
  app.querySelector('[data-nav="settings"]').addEventListener('click', renderSettings)
}

function showNotSignedInWarning() {
  const container = app.querySelector('.home')
  const overlay = document.createElement('div')
  overlay.className = 'pause-overlay solid-bg'
  overlay.innerHTML = `
    <div class="pause-content">
      <h2>Not signed in</h2>
      <p class="confirm-sub">Your progress may not be saved since you're not signed in.</p>
      <div class="home-btn-col">
        <button class="start-btn" data-action="sign-in" type="button">Sign in with Google</button>
        <button class="start-btn" data-action="risk-it" type="button">I'll risk it</button>
      </div>
    </div>
  `
  container.appendChild(overlay)
  overlay.querySelector('[data-action="sign-in"]').addEventListener('click', signInWithGoogle)
  overlay.querySelector('[data-action="risk-it"]').addEventListener('click', () => {
    overlay.remove()
    renderIntro(renderDurationPicker, false)
  })
}

function pizzaImagePath(count) {
  const clamped = Math.max(0, Math.min(12, count))
  return `${BASE}assets/display-case/${clamped}.jpg`
}

// ---------- Pizzas (shop front + log, one scrollable page) ----------
// Pass a friend object ({id, display_name, pizzas, avatar_url}) to view
// someone else's page; omit it to view your own. Pass playIntro=true to
// play the waving clip first (only used from the Home button) - the log
// and everything else render immediately either way, so it's scrollable
// and visible even while the intro clip is still playing.
async function renderPizzas(friend, playIntro) {
  const isSelf = !friend
  const titleText = isSelf
    ? (currentProfile?.display_name ? `${currentProfile.display_name}'s Pizzas` : 'Your Pizzas')
    : `${friend.display_name}'s Pizzas`
  const pizzas = isSelf ? displayPizzas() : friend.pizzas
  const avatarSrc = (isSelf ? currentProfile?.avatar_url : friend.avatar_url) || `${BASE}assets/penguin-icon.png`
  const backAction = isSelf ? renderHome : renderFriends

  const currentCount = Math.floor(pizzas)
  let previousCount = currentCount
  let showMilestone = false

  if (isSelf) {
    if (state.lastSeenPizzaCount === null) {
      state.lastSeenPizzaCount = currentCount
      save()
    } else if (currentCount > state.lastSeenPizzaCount) {
      previousCount = state.lastSeenPizzaCount
      showMilestone = true
    }
  }

  const mediaHtml = playIntro
    ? `<video class="shop-image" id="shop-media" src="${BASE}assets/pizzas-intro.mp4" playsinline autoplay></video>`
    : `<img class="shop-image" id="shop-media" src="${pizzaImagePath(previousCount)}" alt="" />`

  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="shop-content">
        <div class="shop-header-row">
          <button class="back-arrow-btn" type="button" aria-label="Back">&larr;</button>
          <div class="shop-pizza-pill">${escapeHtml(titleText)}</div>
        </div>
        ${mediaHtml}
        <div class="log-header">
          <img class="home-icon log-icon avatar-circle" src="${avatarSrc}" alt="" />
          <div class="home-score">
            <span class="home-score-value">${formatScore(pizzas)}</span>
            <span class="home-score-label">pizzas made</span>
          </div>
        </div>
        <div class="log-list"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
  `
  app.querySelector('.back-arrow-btn').addEventListener('click', backAction)

  function showMilestoneIfNeeded() {
    if (!showMilestone) return
    const container = app.querySelector('.home')
    const overlay = document.createElement('div')
    overlay.className = 'pause-overlay'
    overlay.innerHTML = `
      <div class="pause-content">
        <h2>New Pizza Baked!</h2>
        <img class="home-icon" src="${BASE}assets/penguin-icon.png" alt="" />
        <button class="start-btn" data-action="yay" type="button">Yay!</button>
      </div>
    `
    container.appendChild(overlay)
    overlay.querySelector('[data-action="yay"]').addEventListener('click', () => {
      state.lastSeenPizzaCount = currentCount
      save()
      const shopImg = app.querySelector('#shop-media')
      if (shopImg) shopImg.src = pizzaImagePath(currentCount)
      overlay.remove()
    })
  }

  if (playIntro) {
    const video = app.querySelector('#shop-media')
    let swapped = false
    const swapToImage = () => {
      if (swapped) return
      swapped = true
      const img = document.createElement('img')
      img.className = 'shop-image'
      img.id = 'shop-media'
      img.alt = ''
      img.src = pizzaImagePath(previousCount)
      video.replaceWith(img)
      showMilestoneIfNeeded()
    }
    video.addEventListener('ended', swapToImage)
    // Decorative only - if autoplay is blocked, just skip straight to the still image.
    video.play().catch(swapToImage)
  } else {
    showMilestoneIfNeeded()
  }

  const log = await fetchLog(isSelf ? currentUser?.id : friend.id)
  const listEl = app.querySelector('.log-list')
  if (!listEl) return
  const groups = groupLogByDate(log)
  listEl.innerHTML = groups.length ? groups.map(renderDateGroup).join('') : '<p class="log-empty">No sessions yet. Start cooking!</p>'
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

// ---------- Avatar upload + crop ----------
async function uploadAvatarBlob(blob) {
  const errorEl = app.querySelector('#avatar-error')
  const path = `${currentUser.id}/avatar.jpg`
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
  if (uploadError) {
    if (errorEl) {
      errorEl.textContent = uploadError.message
      errorEl.hidden = false
    }
    return
  }
  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const url = `${data.publicUrl}?t=${Date.now()}`
  await supabase.from('profiles').update({ avatar_url: url }).eq('id', currentUser.id)
  currentProfile.avatar_url = url
  const preview = app.querySelector('#avatar-preview')
  if (preview) preview.src = url
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

  const overlay = app.querySelector('.crop-overlay')
  const stageWrap = overlay.querySelector('.crop-stage-wrap')
  const stage = overlay.querySelector('#crop-stage')
  const img = overlay.querySelector('#crop-img')
  const circleGuide = overlay.querySelector('.crop-circle-guide')

  // Read the actual rendered sizes so this works with the responsive CSS sizing.
  const STAGE = stageWrap.getBoundingClientRect().width
  const CIRCLE = circleGuide.getBoundingClientRect().width

  let naturalW = 0, naturalH = 0, baseScale = 1, scale = 1, tx = 0, ty = 0
  const MAX_ZOOM_FACTOR = 3

  function clampScale() {
    scale = Math.min(Math.max(scale, baseScale), baseScale * MAX_ZOOM_FACTOR)
  }

  function clampPos() {
    const w = naturalW * scale
    const h = naturalH * scale
    const minTx = Math.min(0, STAGE - w)
    const minTy = Math.min(0, STAGE - h)
    tx = Math.min(0, Math.max(minTx, tx))
    ty = Math.min(0, Math.max(minTy, ty))
  }

  function apply() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  function zoomAt(stageX, stageY, newScale) {
    const imgX = (stageX - tx) / scale
    const imgY = (stageY - ty) / scale
    scale = newScale
    clampScale()
    tx = stageX - imgX * scale
    ty = stageY - imgY * scale
    clampPos()
    apply()
  }

  img.onload = () => {
    naturalW = img.naturalWidth
    naturalH = img.naturalHeight
    baseScale = Math.max(STAGE / naturalW, STAGE / naturalH)
    scale = baseScale
    tx = (STAGE - naturalW * scale) / 2
    ty = (STAGE - naturalH * scale) / 2
    clampPos()
    apply()
  }

  // --- Gestures: one finger/pointer drags, two fingers pinch-zoom, mouse wheel zooms ---
  const pointers = new Map()
  let panStart = null
  let pinchStart = null

  function stagePoint(e) {
    const rect = stage.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  stage.addEventListener('pointerdown', (e) => {
    try { stage.setPointerCapture(e.pointerId) } catch {}
    pointers.set(e.pointerId, stagePoint(e))
    if (pointers.size === 1) {
      const p = [...pointers.values()][0]
      panStart = { x: p.x, y: p.y, tx, ty }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchStart = { dist: distance(a, b), scale, mid: midpoint(a, b), tx, ty }
    }
  })

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, stagePoint(e))

    if (pointers.size === 1 && panStart) {
      const p = [...pointers.values()][0]
      tx = panStart.tx + (p.x - panStart.x)
      ty = panStart.ty + (p.y - panStart.y)
      clampPos()
      apply()
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()]
      const newDist = distance(a, b)
      const ratio = newDist / (pinchStart.dist || 1)
      zoomAt(pinchStart.mid.x, pinchStart.mid.y, pinchStart.scale * ratio)
    }
  })

  function releasePointer(e) {
    pointers.delete(e.pointerId)
    if (pointers.size === 1) {
      const p = [...pointers.values()][0]
      panStart = { x: p.x, y: p.y, tx, ty }
      pinchStart = null
    } else if (pointers.size === 0) {
      panStart = null
      pinchStart = null
    }
  }
  stage.addEventListener('pointerup', releasePointer)
  stage.addEventListener('pointercancel', releasePointer)

  stage.addEventListener('wheel', (e) => {
    e.preventDefault()
    const p = stagePoint(e)
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
    zoomAt(p.x, p.y, scale * factor)
  }, { passive: false })

  function cleanup() {
    URL.revokeObjectURL(objectUrl)
    overlay.remove()
  }

  overlay.querySelector('#crop-cancel').addEventListener('click', cleanup)
  overlay.querySelector('#crop-confirm').addEventListener('click', () => {
    const OUTPUT = 512
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')

    const margin = (STAGE - CIRCLE) / 2
    const srcX = (margin - tx) / scale
    const srcY = (margin - ty) / scale
    const srcSize = CIRCLE / scale

    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT, OUTPUT)
    canvas.toBlob((blob) => {
      cleanup()
      if (blob) onCropped(blob)
    }, 'image/jpeg', 0.9)
  })
}

// ---------- Settings ----------
function renderSettings() {
  const avatarSrc = currentProfile?.avatar_url || `${BASE}assets/penguin-icon.png`

  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="home-content">
        <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
        <h1>Settings</h1>
        <div class="settings-row">
          <label for="volume-slider">Music volume</label>
          <div class="volume-control">
            <span>🔈</span>
            <input id="volume-slider" type="range" min="0" max="100" value="${Math.round(state.volume * 100)}" />
            <span>🔊</span>
          </div>
        </div>
        ${currentUser ? `
        <div class="settings-row">
          <label>Profile picture</label>
          <img class="home-icon avatar-circle" id="avatar-preview" src="${avatarSrc}" alt="" />
          <input type="file" accept="image/*" id="avatar-input" hidden />
          <button class="start-btn" data-action="change-photo" type="button">Change Photo</button>
          <p class="friends-error" id="avatar-error" hidden></p>
        </div>
        <div class="settings-row">
          <label for="name-input">Display name</label>
          <input type="text" id="name-input" maxlength="15" class="task-input" value="${escapeHtml(currentProfile?.display_name || '')}" />
          <button class="start-btn" data-action="save-name" type="button">Save Name</button>
          <p class="friends-error" id="name-error" hidden></p>
        </div>
        ` : ''}
        <div class="settings-row">
          <label>Account</label>
          ${currentUser
            ? `<p class="home-tag">Signed in as ${escapeHtml(currentProfile?.display_name || currentUser.email || '')}</p>
               <button class="start-btn" data-action="sign-out" type="button">Sign Out</button>`
            : `<p class="home-tag">Sign in to sync your progress and add friends</p>
               <button class="start-btn" data-action="sign-in" type="button">Sign in with Google</button>`
          }
        </div>
      </div>
    </div>
  `
  app.querySelector('.back-arrow-btn').addEventListener('click', renderHome)
  app.querySelector('#volume-slider').addEventListener('input', (e) => {
    state.volume = Number(e.target.value) / 100
    save()
  })
  app.querySelector('[data-action="sign-in"]')?.addEventListener('click', signInWithGoogle)
  app.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut)

  app.querySelector('[data-action="change-photo"]')?.addEventListener('click', () => {
    app.querySelector('#avatar-input').click()
  })
  app.querySelector('#avatar-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    openAvatarCropper(file, (blob) => uploadAvatarBlob(blob))
  })

  app.querySelector('[data-action="save-name"]')?.addEventListener('click', async () => {
    const input = app.querySelector('#name-input')
    const errorEl = app.querySelector('#name-error')
    errorEl.hidden = true
    const newName = input.value.trim().slice(0, 15)
    if (!newName) return
    const { error } = await supabase.from('profiles').update({ display_name: newName }).eq('id', currentUser.id)
    if (error) {
      errorEl.textContent = error.message
      errorEl.hidden = false
      return
    }
    currentProfile.display_name = newName
    renderSettings()
  })
}

// ---------- Friends ----------
async function renderFriends() {
  if (!currentUser) {
    app.innerHTML = `
      <div class="home">
        <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
        <div class="home-content">
          <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
          <h1>Friends</h1>
          <p class="home-tag">Sign in with Google to add friends and see their progress</p>
          <div class="home-btn-col">
            <button class="start-btn" data-action="sign-in" type="button">Sign in with Google</button>
          </div>
        </div>
      </div>
    `
    app.querySelector('.back-arrow-btn').addEventListener('click', renderHome)
    app.querySelector('[data-action="sign-in"]').addEventListener('click', signInWithGoogle)
    return
  }

  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="log-content">
        <button class="back-arrow-btn back-arrow-fixed" type="button" aria-label="Back">&larr;</button>
        <div class="log-header">
          <h1>Friends</h1>
          <p class="home-tag">Your code: <strong>${currentProfile?.friend_code || '...'}</strong></p>
          <div class="custom-row">
            <input type="text" maxlength="6" placeholder="Friend's code" class="custom-input" id="friend-code-input" />
            <button class="custom-go" type="button" id="add-friend-btn">Add</button>
          </div>
          <p class="friends-error" id="friends-error" hidden></p>
        </div>
        <div class="log-list" id="friends-list"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
  `
  app.querySelector('.back-arrow-btn').addEventListener('click', renderHome)

  const errorEl = app.querySelector('#friends-error')
  app.querySelector('#add-friend-btn').addEventListener('click', async () => {
    const input = app.querySelector('#friend-code-input')
    const code = input.value.trim()
    if (!code) return
    errorEl.hidden = true
    const { error } = await supabase.rpc('add_friend_by_code', { code })
    if (error) {
      errorEl.textContent = error.message
      errorEl.hidden = false
      return
    }
    input.value = ''
    loadFriendsList()
  })

  loadFriendsList()
}

async function loadFriendsList() {
  const listEl = app.querySelector('#friends-list')
  if (!listEl) return

  const { data: friendRows } = await supabase
    .from('friends')
    .select('friend_id, profiles:friend_id(id, display_name, pizzas, avatar_url)')

  if (!friendRows || friendRows.length === 0) {
    listEl.innerHTML = '<p class="log-empty">No friends yet. Share your code above!</p>'
    return
  }

  const friends = friendRows.map(r => r.profiles).filter(Boolean).sort((a, b) => b.pizzas - a.pizzas)
  listEl.innerHTML = friends.map(f => `
    <div class="log-row friend-row" data-friend-id="${f.id}">
      <div class="log-row-main">
        <span class="log-row-task">${escapeHtml(f.display_name)}</span>
        <span class="log-row-pizzas">🍕 ${formatScore(f.pizzas)}</span>
      </div>
      <div class="log-row-meta">
        <button class="friend-view-btn" data-friend-id="${f.id}" type="button">View log</button>
        <button class="friend-remove-btn" data-friend-id="${f.id}" type="button">Remove</button>
      </div>
    </div>
  `).join('')

  listEl.querySelectorAll('.friend-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const friend = friends.find(f => f.id === btn.dataset.friendId)
      if (friend) renderPizzas(friend)
    })
  })

  listEl.querySelectorAll('.friend-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showRemoveFriendConfirm(btn.dataset.friendId)
    })
  })
}

function showRemoveFriendConfirm(friendId) {
  const container = app.querySelector('.home')
  const overlay = document.createElement('div')
  overlay.className = 'pause-overlay'
  overlay.innerHTML = `
    <div class="pause-content">
      <h2>Remove friend?</h2>
      <div class="home-btn-col">
        <button class="start-btn" data-action="confirm-remove" type="button">Yes, Remove</button>
        <button class="start-btn" data-action="cancel" type="button">Cancel</button>
      </div>
    </div>
  `
  container.appendChild(overlay)
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => overlay.remove())
  overlay.querySelector('[data-action="confirm-remove"]').addEventListener('click', async () => {
    await supabase.rpc('remove_friend', { target_id: friendId })
    overlay.remove()
    loadFriendsList()
  })
}

// ---------- Intro (used both to start a session and as the completion alarm) ----------
function renderIntro(onEnd, isAlarm, videoSrc = 'intro.mp4') {
  app.innerHTML = `
    <div class="intro">
      <video class="intro-video" src="${BASE}assets/${videoSrc}" playsinline autoplay></video>
      <button class="intro-skip" type="button">Skip</button>
    </div>
  `

  const video = app.querySelector('.intro-video')
  const skipBtn = app.querySelector('.intro-skip')

  let transitioned = false
  const goNext = () => {
    if (transitioned) return
    transitioned = true
    video.pause()
    onEnd()
  }

  video.addEventListener('ended', goNext)
  skipBtn.addEventListener('click', goNext)

  // A session-completion alarm usually fires with no fresh user gesture, so
  // autoplay-with-sound is often blocked - fall back to a tap prompt.
  video.play().catch(() => renderTapToContinue(goNext, isAlarm))
}

function renderTapToContinue(onContinue, isAlarm) {
  app.innerHTML = `
    <div class="intro-start">
      <img src="${BASE}assets/penguin-icon.png" alt="Chef Penguino" />
      <h1>${isAlarm ? `Hooray! ${formatScore(displayPizzas())} Pizzas made` : 'Chef Penguino'}</h1>
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
      if (btn.dataset.custom) {
        customRow.hidden = false
        customInput.focus()
        return
      }
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

// ---------- Timer + looping gameplay video ----------
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

  const music = new Audio(`${BASE}assets/bg-music.mp3`)
  music.loop = true
  music.volume = state.volume
  const updateMuteIcon = () => { muteBtn.textContent = state.muted ? '🔇' : '🔊' }
  updateMuteIcon()

  let isPausedNow = startedPaused
  let intervalId

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted
    updateMuteIcon()
    if (state.muted) music.pause()
    else if (!isPausedNow) music.play().catch(() => {})
    save()
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
      state.timer.elapsedMs += state.timer.segmentPlannedMs
      finalizeSession(true)
    }
  }

  function startTicking() {
    loopVideo.play().catch(() => {})
    kitchenEl.classList.remove('paused')
    if (!state.muted) music.play().catch(() => {})
    clearInterval(intervalId)
    intervalId = setInterval(tick, 250)
    tick()
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
    loopVideo.pause()
    music.pause()
    kitchenEl.classList.add('paused')
    timerBtn.textContent = formatTime(remaining)
    showPausedOverlay()
  }

  timerBtn.addEventListener('click', pauseNow)

  function showPausedOverlay() {
    const overlay = document.createElement('div')
    overlay.className = 'pause-overlay'
    overlay.innerHTML = `
      <div class="pause-content">
        <h2>Timer Paused</h2>
        <div class="home-btn-col">
          <button class="start-btn" data-action="resume" type="button">Resume</button>
          <button class="start-btn" data-action="edit" type="button">Edit Time</button>
          <button class="start-btn" data-action="end" type="button">End Early</button>
        </div>
      </div>
    `
    kitchenEl.appendChild(overlay)

    overlay.querySelector('[data-action="resume"]').addEventListener('click', () => {
      overlay.remove()
      isPausedNow = false
      state.timer.segmentStartedAt = Date.now()
      state.timer.segmentPlannedMs = state.timer.remainingMsSnapshot
      state.timer.remainingMsSnapshot = null
      save()
      startTicking()
    })

    overlay.querySelector('[data-action="edit"]').addEventListener('click', () => {
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

    overlay.querySelector('[data-action="end"]').addEventListener('click', () => {
      showEndEarlyConfirm(overlay)
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
      finalizeSession(false)
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
