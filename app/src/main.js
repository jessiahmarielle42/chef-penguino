import './style.css'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL

const STORAGE_KEY = 'chef-penguino-save'

const DURATIONS = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
]

const state = load()

function load() {
  const defaults = { pizzas: 0, muted: false, timer: null }
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

function formatScore(n) {
  return String(round2(n))
}

function addSessionPizzas(minutes) {
  state.pizzas = round2(state.pizzas + minutes / 60)
  save()
}

// ---------- boot ----------
if (state.timer && state.timer.endAt) {
  const remainingMs = state.timer.endAt - Date.now()
  if (remainingMs > 0) {
    renderTimerLoop(state.timer.durationMin, remainingMs)
  } else {
    // The session finished while the app was closed - award it and show the alarm.
    addSessionPizzas(state.timer.durationMin)
    state.timer = null
    save()
    renderIntro(renderHome, true)
  }
} else {
  renderHome()
}

// ---------- Home ----------
function renderHome() {
  app.innerHTML = `
    <div class="home">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="home-content">
        <div class="home-score">
          <span class="home-score-value">${formatScore(state.pizzas)}</span>
          <span class="home-score-label">pizzas earned</span>
        </div>
        <h1>Chef Penguino</h1>
        <p class="home-tag">Focus timer</p>
        <button class="start-btn" type="button">Start</button>
      </div>
    </div>
  `
  app.querySelector('.start-btn').addEventListener('click', () => {
    renderIntro(renderDurationPicker, false)
  })
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
  app.innerHTML = `
    <div class="picker">
      <img class="home-bg" src="${BASE}assets/home-bg.jpg" alt="" />
      <div class="picker-content">
        <h2>How long do you want to work?</h2>
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
      startSession(Number(btn.dataset.minutes))
    })
  })

  app.querySelector('.custom-go').addEventListener('click', () => {
    const minutes = Math.floor(Number(customInput.value))
    if (minutes > 0) startSession(minutes)
  })
}

function startSession(minutes) {
  const endAt = Date.now() + minutes * 60 * 1000
  state.timer = { endAt, durationMin: minutes }
  save()
  renderTimerLoop(minutes, minutes * 60 * 1000)
}

// ---------- Timer + looping gameplay video ----------
function renderTimerLoop(minutes, remainingMs) {
  app.innerHTML = `
    <div class="kitchen">
      <video class="kitchen-loop" src="${BASE}assets/gameplay-loop.mp4" playsinline autoplay loop muted></video>
      <div class="timer-hud"><span class="timer-value">--:--</span></div>
      <button class="mute-btn" type="button" aria-label="Toggle music"></button>
    </div>
  `

  const loopVideo = app.querySelector('.kitchen-loop')
  const muteBtn = app.querySelector('.mute-btn')
  const timerValue = app.querySelector('.timer-value')

  loopVideo.muted = true
  loopVideo.play().catch(() => {})

  const music = new Audio(`${BASE}assets/bg-music.mp3`)
  music.loop = true
  music.volume = 0.5
  const updateMuteIcon = () => { muteBtn.textContent = state.muted ? '🔇' : '🔊' }
  updateMuteIcon()
  if (!state.muted) music.play().catch(() => {})

  muteBtn.addEventListener('click', () => {
    state.muted = !state.muted
    updateMuteIcon()
    if (state.muted) music.pause()
    else music.play().catch(() => {})
    save()
  })

  const endAt = Date.now() + remainingMs

  function formatTime(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000))
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  let intervalId
  function tick() {
    const remaining = endAt - Date.now()
    timerValue.textContent = formatTime(remaining)
    if (remaining <= 0) {
      clearInterval(intervalId)
      music.pause()
      addSessionPizzas(minutes)
      state.timer = null
      save()
      renderIntro(renderHome, true)
    }
  }
  intervalId = setInterval(tick, 250)
  tick()
}
