import './style.css'

const app = document.querySelector('#app')

const STORAGE_KEY = 'chef-penguino-save'
const INTRO_DURATION = 5.2 // seconds of the intro clip to play before cutting to the game

const state = load()

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { pizzas: 0, muted: false }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function formatNumber(n) {
  return Math.floor(n).toLocaleString('en-US')
}

renderIntro()

function renderIntro() {
  app.innerHTML = `
    <div class="intro">
      <video class="intro-video" src="/assets/intro.mp4" playsinline autoplay></video>
      <button class="intro-skip" type="button">Skip</button>
    </div>
  `

  const video = app.querySelector('.intro-video')
  const skipBtn = app.querySelector('.intro-skip')

  const goToGame = () => {
    video.pause()
    renderGame()
  }

  video.addEventListener('timeupdate', () => {
    if (video.currentTime >= INTRO_DURATION) goToGame()
  })
  video.addEventListener('ended', goToGame)
  skipBtn.addEventListener('click', goToGame)

  // Autoplay with sound can be blocked on mobile browsers; fall back to a tap-to-start screen.
  video.play().catch(() => renderIntroStart())
}

function renderIntroStart() {
  app.innerHTML = `
    <div class="intro-start">
      <img src="/assets/penguin-icon.png" alt="Chef Penguino" />
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
      <button class="tap-layer" type="button" aria-label="Tap to make pizza">
        <img class="kitchen-bg" src="/assets/kitchen-bg.jpg" alt="" />
      </button>
      <div class="hud">
        <div class="score">
          <span id="score-value">${formatNumber(state.pizzas)}</span>
          <span class="label">pizzas</span>
        </div>
        <button class="mute-btn" type="button" aria-label="Toggle music"></button>
      </div>
      <div class="tap-hint">Tap Chef Penguino to make pizza!</div>
    </div>
  `

  const tapLayer = app.querySelector('.tap-layer')
  const scoreEl = app.querySelector('#score-value')
  const muteBtn = app.querySelector('.mute-btn')
  const hint = app.querySelector('.tap-hint')

  const music = new Audio('/assets/bg-music.mp3')
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

  let hintShown = true
  let tapTimeout

  tapLayer.addEventListener('pointerdown', (e) => {
    state.pizzas += 1
    scoreEl.textContent = formatNumber(state.pizzas)
    save()

    if (hintShown) {
      hintShown = false
      hint.style.opacity = '0'
    }

    tapLayer.classList.add('tapped')
    clearTimeout(tapTimeout)
    tapTimeout = setTimeout(() => tapLayer.classList.remove('tapped'), 120)

    spawnPop(e.clientX, e.clientY)
  })

  function spawnPop(x, y) {
    const jitterX = x + (Math.random() * 30 - 15)
    const jitterY = y + (Math.random() * 20 - 10)

    const pizza = document.createElement('img')
    pizza.src = '/assets/pizza-pop.png'
    pizza.className = 'pizza-pop'
    pizza.style.left = `${jitterX}px`
    pizza.style.top = `${jitterY}px`
    tapLayer.after(pizza)
    pizza.addEventListener('animationend', () => pizza.remove())

    const plus = document.createElement('div')
    plus.className = 'pop-plus'
    plus.textContent = '+1'
    plus.style.left = `${jitterX + 34}px`
    plus.style.top = `${jitterY - 10}px`
    tapLayer.after(plus)
    plus.addEventListener('animationend', () => plus.remove())
  }
}
