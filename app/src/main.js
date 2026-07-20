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
    .select('id, display_name, friend_code, pizzas')
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
  const defaults = { pizzas: 0, muted: false, volume: 0.5, timer: null, log: [], cloudSynced: false }
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

  if (playAlarm) renderIntro(renderHome, true)
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
    renderIntro(renderDurationPicker, false)
  })
  app.querySelector('[data-nav="pizzas"]').addEventListener('click', renderPizzas)
  app.querySelector('[data-nav="friends"]').addEventListener('click', renderFriends)
  app.querySelector('[data-nav="settings"]').addEventListener('click', renderSettings)
}

// ---------- Pizzas (session log) ----------
async function renderPizzas() {
  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="log-content">
        <button class="back-btn" type="button">&larr; Back</button>
        <div class="log-header">
          <img class="home-icon log-icon" src="${BASE}assets/penguin-icon.png" alt="" />
          <div class="home-score">
            <span class="home-score-value">${formatScore(displayPizzas())}</span>
            <span class="home-score-label">pizzas made</span>
          </div>
        </div>
        <div class="log-list"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
  `
  app.querySelector('.back-btn').addEventListener('click', renderHome)

  const log = await fetchLog(currentUser?.id)
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

// ---------- Settings ----------
function renderSettings() {
  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="home-content">
        <button class="back-btn" type="button">&larr; Back</button>
        <h1>Settings</h1>
        <div class="settings-row">
          <label for="volume-slider">Music volume</label>
          <div class="volume-control">
            <span>🔈</span>
            <input id="volume-slider" type="range" min="0" max="100" value="${Math.round(state.volume * 100)}" />
            <span>🔊</span>
          </div>
        </div>
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
  app.querySelector('.back-btn').addEventListener('click', renderHome)
  app.querySelector('#volume-slider').addEventListener('input', (e) => {
    state.volume = Number(e.target.value) / 100
    save()
  })
  app.querySelector('[data-action="sign-in"]')?.addEventListener('click', signInWithGoogle)
  app.querySelector('[data-action="sign-out"]')?.addEventListener('click', signOut)
}

// ---------- Friends ----------
async function renderFriends() {
  if (!currentUser) {
    app.innerHTML = `
      <div class="home">
        <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
        <div class="home-content">
          <button class="back-btn" type="button">&larr; Back</button>
          <h1>Friends</h1>
          <p class="home-tag">Sign in with Google to add friends and see their progress</p>
          <div class="home-btn-col">
            <button class="start-btn" data-action="sign-in" type="button">Sign in with Google</button>
          </div>
        </div>
      </div>
    `
    app.querySelector('.back-btn').addEventListener('click', renderHome)
    app.querySelector('[data-action="sign-in"]').addEventListener('click', signInWithGoogle)
    return
  }

  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="log-content">
        <button class="back-btn" type="button">&larr; Back</button>
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
  app.querySelector('.back-btn').addEventListener('click', renderHome)

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
    .select('friend_id, profiles:friend_id(id, display_name, pizzas)')

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
        <button class="friend-view-btn" data-friend-id="${f.id}" data-friend-name="${escapeHtml(f.display_name)}" type="button">View log</button>
        <button class="friend-remove-btn" data-friend-id="${f.id}" type="button">Remove</button>
      </div>
    </div>
  `).join('')

  listEl.querySelectorAll('.friend-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      renderFriendLog(btn.dataset.friendId, btn.dataset.friendName)
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

async function renderFriendLog(friendId, friendName) {
  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="log-content">
        <button class="back-btn" type="button">&larr; Back</button>
        <div class="log-header">
          <img class="home-icon log-icon" src="${BASE}assets/penguin-icon.png" alt="" />
          <div class="home-score">
            <span class="home-score-value">${escapeHtml(friendName)}</span>
            <span class="home-score-label">pizzas made</span>
          </div>
        </div>
        <div class="log-list"><p class="log-empty">Loading&hellip;</p></div>
      </div>
    </div>
  `
  app.querySelector('.back-btn').addEventListener('click', renderFriends)

  const log = await fetchLog(friendId)
  const listEl = app.querySelector('.log-list')
  if (!listEl) return
  const groups = groupLogByDate(log)
  listEl.innerHTML = groups.length ? groups.map(renderDateGroup).join('') : '<p class="log-empty">No sessions yet.</p>'
}

// ---------- Intro (used both to start a session and as the completion alarm) ----------
function renderIntro(onEnd, isAlarm) {
  app.innerHTML = `
    <div class="intro">
      <video class="intro-video" src="${BASE}assets/intro.mp4" playsinline autoplay></video>
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
      <h1>${isAlarm ? "Time's up!" : 'Chef Penguino'}</h1>
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
  })
}

function renderTimePickerUI({ title, onPick }) {
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
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
}

// ---------- Task prompt ----------
function renderTaskPrompt(minutes) {
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
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
