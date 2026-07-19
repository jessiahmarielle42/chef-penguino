import './style.css'

const app = document.querySelector('#app')
const BASE = import.meta.env.BASE_URL

const STORAGE_KEY = 'chef-penguino-save'

const state = load()

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { muted: false }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

renderIntro()

function renderIntro() {
  app.innerHTML = `
    <div class="intro">
      <video class="intro-video" src="${BASE}assets/intro.mp4" playsinline autoplay></video>
      <button class="intro-skip" type="button">Skip</button>
    </div>
  `

  const video = app.querySelector('.intro-video')
  const skipBtn = app.querySelector('.intro-skip')

  let transitioned = false
  const goToGame = () => {
    if (transitioned) return
    transitioned = true
    video.pause()
    renderGame()
  }

  video.addEventListener('ended', goToGame)
  skipBtn.addEventListener('click', goToGame)

  // Autoplay with sound can be blocked on mobile browsers; fall back to a tap-to-start screen.
  video.play().catch(() => renderIntroStart())
}

function renderIntroStart() {
  app.innerHTML = `
    <div class="intro-start">
      <img src="${BASE}assets/penguin-icon.png" alt="Chef Penguino" />
      <h1>Chef Penguino</h1>
      <button type="button">Tap to Start</button>
    </div>
  `
  app.querySelector('button').addEventListener('click', () => {
    renderIntro()
  })
}

function renderGame() {
  app.innerHTML = `
    <div class="kitchen">
      <video class="kitchen-loop" src="${BASE}assets/gameplay-loop.mp4" playsinline autoplay loop muted></video>
      <button class="mute-btn" type="button" aria-label="Toggle music"></button>
    </div>
  `

  const loopVideo = app.querySelector('.kitchen-loop')
  const muteBtn = app.querySelector('.mute-btn')

  // The video's own audio track stays off; background music plays instead.
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
}
