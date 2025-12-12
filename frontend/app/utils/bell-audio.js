// Bell/Audio utilities for boxing timers
// - Prefer real samples under /public/sounds
// - Fallback to WebAudio synthesis if samples are missing

let audioCtx = null
const bellBuffers = { gong: null, ding: null, swell: null, pop: null, round_begin: null, round_end: null, thirty_pre: null, three_sec_signal: null, loaded: false, loading: false }
const punchBuffers = new Map() // code -> AudioBuffer
const callBuffers = new Map() // normalizedKey -> AudioBuffer (combo call voice)
const callLoading = new Map()

const punchLoading = new Map()

// Global flag to track if audio is interrupted by system (phone call, etc.)
// This will be set by external audio players (BGM, MittVoice) when they detect interruption
let audioInterrupted = false

// Export functions to allow external audio players to signal interruption state
export function setAudioInterrupted(interrupted) {
  audioInterrupted = !!interrupted
  try { console.log('[Bell] Audio interruption state:', audioInterrupted) } catch {}
}

export function isAudioInterrupted() {
  return audioInterrupted
}

// Check if audio can play - don't play during phone calls or system interruptions
function canPlayAudio() {
  // If external audio players (BGM/MittVoice) detected interruption, respect it
  if (audioInterrupted) return false
  return true
}

// Normalize phrase to filesystem key: lower, trim, spaces->underscores
const normalizeCallKey = (s) => (String(s||'').trim().toLowerCase().replace(/\s+/g, '_'))
const SOUND_URLS = {
  // Use existing bell files - Round_Beginning for gong, 3S_Signal for ding, 30Pre_Bell for swell
  gong: ['/audio/boxing/bell/Round_Beginning.mp3', '/audio/boxing/bell/Round_End.mp3'],
  ding: ['/audio/boxing/bell/3S_Signal.mp3', '/audio/boxing/bell/Round_End.mp3'],
  swell: ['/audio/boxing/bell/30Pre_Bell.mp3', '/audio/boxing/bell/3S_Signal.mp3'],
  pop: ['/audio/boxing/bell/3S_Signal.mp3'],  // Use 3S_Signal as fallback for pop sound
  // Boxing round cues
  round_begin: ['/audio/boxing/bell/Round_Beginning.mp3', '/audio/boxing/Round_Beginning.mp3', '/Round_Beginning.mp3'],
  round_end: ['/audio/boxing/bell/Round_End.mp3', '/audio/boxing/Round_End.mp3', '/Round_End.mp3'],
  thirty_pre: ['/audio/boxing/bell/30Pre_Bell.mp3', '/audio/boxing/30Pre_Bell.mp3', '/30Pre_Bell.mp3'],
  three_sec_signal: ['/audio/boxing/bell/3S_Signal.mp3', '/audio/boxing/3S_Signal.mp3', '/3S_Signal.mp3'],
}

export function ensureAudioCtx(){
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    try {
      const AC = window.AudioContext || window['webkitAudioContext']
      if (AC) audioCtx = new AC()
    } catch {}
  }
  return audioCtx
}


// Proactively resume/unlock audio on user gesture and preload bell buffers
export async function unlockAudio(){
  const ctx = ensureAudioCtx()
  if (!ctx) return
  try { if (ctx.state === 'suspended') { await ctx.resume() } } catch {}
  try { await loadBellBuffers(ctx) } catch {}
}

// Preload punch samples to minimize first-hit latency
export async function preloadPunchSamples(codes){
  const ctx = ensureAudioCtx(); if (!ctx) return
  try { if (ctx.state === 'suspended') { await ctx.resume() } } catch {}
  const list = Array.isArray(codes) && codes.length ? codes : ['L','R','LH','RH','LU','RU','LB','RB','LDJ','RDJ']
  const toLoad = list.map(k => String(k||'').trim().toUpperCase()).filter(k => k && !punchBuffers.get(k))
  // Avoid duplicate fetches
  const unique = Array.from(new Set(toLoad)).filter(k => !punchLoading.get(k))
  await Promise.all(unique.map(async (key) => {
    punchLoading.set(key, true)
    try {
      const urls = [
        '/audio/boxing/punch/' + encodeURI(key) + '.mp3',
        '/punch/' + encodeURI(key) + '.mp3'
      ]
      for (const url of urls){
        try {
          const res = await fetch(url); if (!res.ok) continue
          const ab = await res.arrayBuffer(); const buf = await ctx.decodeAudioData(ab)
          if (buf) { punchBuffers.set(key, buf); break }
        } catch {}
      }
    } finally {
      punchLoading.delete(key)
    }
  }))
}

async function loadBellBuffers(ctx){
  if (!ctx || bellBuffers.loading || bellBuffers.loaded) return
  bellBuffers.loading = true
  try {
    const entries = Object.entries(SOUND_URLS)
    const results = await Promise.all(entries.map(async ([key, paths]) => {
      try {
        const arr = Array.isArray(paths) ? paths : [paths]
        let buf = null
        for (const url of arr) {
          try {
            const res = await fetch(url)
            if (!res.ok) continue
            const ab = await res.arrayBuffer()
            buf = await ctx.decodeAudioData(ab)
            if (buf) break
          } catch {}
        }
        return [key, buf]
      } catch {
        return [key, null]
      }
    }))
    results.forEach(([k, buf]) => { bellBuffers[k] = buf })
    bellBuffers.loaded = true
  } catch {
    // ignore
  } finally {
    bellBuffers.loading = false
  }
}


// Schedule a bell sound at an absolute wall-clock time (ms since epoch)
// Returns a cancel() function to mute/stop before it fires.
export function scheduleBellAt(absMs, type='ding', { volume=0.9 } = {}){
  const ctx = ensureAudioCtx(); if (!ctx) return () => {}
  try { loadBellBuffers(ctx) } catch {}
  const nowMs = Date.now()
  if (!Number.isFinite(absMs)) return () => {}
  if (absMs <= nowMs) { try { playBell(type) } catch {}; return () => {} }
  const delaySec = Math.max(0, (absMs - nowMs) / 1000)
  const when = ctx.currentTime + delaySec
  // pick buffer if loaded
  const buf = bellBuffers[type]
  if (!buf) {
    // Fallback: schedule a tiny WebAudio beep as last resort
    try {
      const osc = ctx.createOscillator(); osc.type = 'sine'
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, when)
      g.gain.exponentialRampToValueAtTime(Math.max(0, Math.min(1, volume)), when + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.3)
      osc.frequency.setValueAtTime(800, when)
      osc.connect(g).connect(ctx.destination)
      osc.start(when); osc.stop(when + 0.32)
      return () => { try { g.gain.setValueAtTime(0, ctx.currentTime) } catch {} }
    } catch { return () => {} }
  }
  try {
    const src = ctx.createBufferSource(); src.buffer = buf
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), when)
    src.connect(g).connect(ctx.destination)
    src.start(when)
    let cancelled = false
    return () => {
      if (cancelled) return; cancelled = true
      try { g.gain.setValueAtTime(0.0, ctx.currentTime) } catch {}
      try { src.stop(ctx.currentTime) } catch {}
      try { src.disconnect() } catch {}
    }
  } catch { return () => {} }
}

export function playBell(type='ding'){
  // CRITICAL: Don't play sounds during phone call or system audio interruption
  if (!canPlayAudio()) {
    try { console.log('[Bell] Skipping playBell - audio interrupted:', type) } catch {}
    return
  }
  const ctx = ensureAudioCtx(); if (!ctx) return
  try { loadBellBuffers(ctx) } catch {}
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.setValueAtTime(0.8, now)

  // helper to play decoded buffer
  const playBuf = (buf, gain=0.9, detune=0) => {
    if (!buf) return false
    const src = ctx.createBufferSource(); src.buffer = buf
    if (src.detune && typeof detune === 'number') { try { src.detune.value = detune } catch {} }
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, now)
    src.connect(g).connect(master).connect(ctx.destination)
    src.start(now)
    return true
  }

  // helper: HTMLAudio fallback when buffer not yet decoded
  const playUrlFallback = (paths, vol=0.9) => {
    try {
      const arr = Array.isArray(paths) ? paths : [paths]
      let idx = 0
      const a = new Audio()
      a.preload = 'auto'
      a.crossOrigin = 'anonymous'
      a.volume = Math.max(0, Math.min(1, vol))
      const tryNext = () => {
        if (idx >= arr.length) return
        a.onerror = () => { idx++; tryNext() }
        a.src = arr[idx++]
        a.currentTime = 0
        a.play().catch(()=>{})
      }
      tryNext()
      return true
    } catch { return false }
  }

  // New round cues (custom mp3) — try buffer first, then URL fallback
  if (type === 'round_begin')     { if (playBuf(bellBuffers.round_begin,     0.95) || playUrlFallback(SOUND_URLS.round_begin, 0.95)) return }
  if (type === 'round_end')       { if (playBuf(bellBuffers.round_end,       0.95) || playUrlFallback(SOUND_URLS.round_end, 0.95)) return }
  if (type === 'thirty_pre')      { if (playBuf(bellBuffers.thirty_pre,      0.80) || playUrlFallback(SOUND_URLS.thirty_pre, 0.80)) return }
  if (type === 'three_sec_signal'){ if (playBuf(bellBuffers.three_sec_signal,0.90) || playUrlFallback(SOUND_URLS.three_sec_signal,0.90)) return }

  if (type === 'gong') {
    const buf = bellBuffers.gong
    if (playBuf(buf, 0.9)) return
    // Fallback synthesis: heavy ring bell
    const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate)
    const data = noiseBuf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.02))
      data[i] = (Math.random() * 2 - 1) * env
    }
    const noise = ctx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = false

    const o1 = ctx.createOscillator(); o1.type = 'sine'
    const o2 = ctx.createOscillator(); o2.type = 'triangle'
    o1.frequency.setValueAtTime(650, now)
    o1.frequency.exponentialRampToValueAtTime(180, now + 1.2)
    o2.frequency.setValueAtTime(975, now)
    o2.frequency.exponentialRampToValueAtTime(270, now + 1.2)

    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'
    bp.frequency.setValueAtTime(700, now)
    bp.Q.setValueAtTime(8, now)

    const delay = ctx.createDelay(); delay.delayTime.setValueAtTime(0.14, now)
    const fb = ctx.createGain(); fb.gain.setValueAtTime(0.35, now)
    delay.connect(fb).connect(delay)

    const toneGain = ctx.createGain()
    toneGain.gain.setValueAtTime(0.0001, now)
    toneGain.gain.exponentialRampToValueAtTime(0.9, now + 0.02)
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.35)

    const hitGain = ctx.createGain()
    hitGain.gain.setValueAtTime(0.0001, now)
    hitGain.gain.exponentialRampToValueAtTime(0.7, now + 0.008)
    hitGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)

    o1.connect(bp); o2.connect(bp)
    bp.connect(delay)
    bp.connect(toneGain)
    noise.connect(hitGain)

    const mix = ctx.createGain()
    delay.connect(mix)
    toneGain.connect(mix)
    hitGain.connect(mix)
    mix.connect(master).connect(ctx.destination)

    o1.start(now); o2.start(now)
    o1.stop(now + 1.4); o2.stop(now + 1.4)
    noise.start(now); noise.stop(now + 0.12)
    return
  }

  if (type === 'swell') {
    const buf = bellBuffers.swell
    if (playBuf(buf, 0.9)) return

    // Fallback synthesis: rising tone '띠이잉'
    const osc = ctx.createOscillator(); osc.type = 'sine'
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'
    bp.frequency.setValueAtTime(1000, now)
    bp.Q.setValueAtTime(6, now)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.6, now + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5)
    osc.frequency.setValueAtTime(700, now)
    osc.frequency.exponentialRampToValueAtTime(1400, now + 0.4)
    osc.connect(bp).connect(g).connect(master).connect(ctx.destination)
    osc.start(now); osc.stop(now + 0.55)
    return
  }

  // default: 'ding'
  const buf = bellBuffers.ding
  if (playBuf(buf, 0.85)) return

  // Fallback synthesis: short, low-ish tick '띵'
  const osc = ctx.createOscillator(); osc.type = 'square'
  const g = ctx.createGain()
  osc.frequency.setValueAtTime(1000, now)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.5, now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)
  osc.connect(g).connect(master).connect(ctx.destination)


  osc.start(now); osc.stop(now + 0.24)
}

// Return approximate duration (ms) for a bell type if buffer loaded; otherwise sensible defaults
export function getBellDurationMs(type='ding'){
  try {
    const buf = bellBuffers?.[type]
    if (buf && typeof buf.duration === 'number' && isFinite(buf.duration)) {
      return Math.round(buf.duration * 1000)
    }
  } catch {}
  const defaults = { round_end: 1000, round_begin: 900, three_sec_signal: 900, thirty_pre: 800, gong: 1400, swell: 550, ding: 240 }
  return defaults[type] || 240
}

// Play bell strictly via WebAudio (no HTMLAudio fallback) to avoid mixing artifacts
let __bellLockUntil = 0
export function playBellExclusive(type='ding', { volume=0.9, lockMs=1200 } = {}){
  // CRITICAL: Don't play sounds during phone call or system audio interruption
  if (!canPlayAudio()) {
    try { console.log('[Bell] Skipping playBellExclusive - audio interrupted:', type) } catch {}
    return false
  }
  const nowWall = Date.now()
  if (nowWall < __bellLockUntil) return false // prevent overlapping/duplicate bells
  __bellLockUntil = nowWall + Math.max(200, lockMs)

  const ctx = ensureAudioCtx(); if (!ctx) return false
  try { if (ctx?.state === 'suspended') { ctx.resume?.() } } catch {}
  try { loadBellBuffers(ctx) } catch {}
  const now = ctx.currentTime
  const buf = bellBuffers?.[type]
  if (buf) {
    try {
      const src = ctx.createBufferSource(); src.buffer = buf
      const g = ctx.createGain(); g.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now)
      src.connect(g).connect(ctx.destination)
      src.start(now)
      return true
    } catch { return false }
  }
  // Fallback: synth tone similar to playBell default branch but shorter/clean
  try {
    const osc = ctx.createOscillator(); osc.type = 'sine'
    const g = ctx.createGain()
    osc.frequency.setValueAtTime(1000, now)
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(Math.max(0, Math.min(1, volume)), now + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.24)
    osc.connect(g).connect(ctx.destination)
    osc.start(now); osc.stop(now + 0.26)
    return true
  } catch { return false }
}



// Punch mitt samples player: plays /audio/boxing/punch/<CODE>.mp3 with fallback

// Low-latency punch sample via WebAudio (buffers cached)
export async function playPunchSample(code, { volume=0.9 } = {}){
  // CRITICAL: Don't play sounds during phone call or system audio interruption
  if (!canPlayAudio()) {
    try { console.log('[Punch] Skipping playPunchSample - audio interrupted:', code) } catch {}
    return
  }
  const ctx = ensureAudioCtx(); if (!ctx) return
  try { if (ctx.state === 'suspended') { await ctx.resume() } } catch {}
  const key = String(code||'').trim().toUpperCase(); if (!key) return

  const now = ctx.currentTime
  const tryPlay = (buf)=>{
    if (!buf) return
    const src = ctx.createBufferSource(); src.buffer = buf
    const g = ctx.createGain(); g.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now)
    src.connect(g).connect(ctx.destination)
    src.start(now)
  }

  // If buffer cached, play immediately
  const cached = punchBuffers.get(key)
  if (cached) { tryPlay(cached); return }

  // Not cached yet: play an immediate short pop for instant feedback and start async preload
  // Avoid duplicate fetches
  if (!punchLoading.get(key)) {
    try { playHitPop() } catch {}
    punchLoading.set(key, true)
    try {
      const urls = [
        '/audio/boxing/punch/' + encodeURI(key) + '.mp3',
        '/punch/' + encodeURI(key) + '.mp3'
      ]
      for (const url of urls){
        try {
          const res = await fetch(url); if (!res.ok) continue
          const ab = await res.arrayBuffer(); const buf = await ctx.decodeAudioData(ab)
          if (buf) { punchBuffers.set(key, buf); break }
        } catch {}
      }
    } finally {
      punchLoading.delete(key)
    }
  } else {
    // Already loading: still provide immediate feedback
    try { playHitPop() } catch {}
  }
}

// ===== Call Samples (Standalone, outside of playBell) =====
export async function preloadCallSamples(keys){
  // DISABLED: No call samples during mitt track
  console.log('Call samples disabled - mitt track only')
  return
  const unique = Array.from(new Set(list)).filter(k => k && !callBuffers.get(k) && !callLoading.get(k))
  await Promise.all(unique.map(async (key) => {
    const norm = normalizeCallKey(key)
    callLoading.set(norm, true)
    try {
      const urls = [
        '/audio/boxing/calls/' + encodeURI(key) + '.mp3',
        '/calls/' + encodeURI(key) + '.mp3'
      ]
      for (const url of urls){
        try {
          const res = await fetch(url); if (!res.ok) continue
          const ab = await res.arrayBuffer(); const buf = await ctx.decodeAudioData(ab)
          if (buf) { callBuffers.set(norm, buf); break }
        } catch {}
      }
    } finally {
      callLoading.delete(norm)
    }
  }))
}

export function playCallSample(key, { volume=0.92 } = {}){
  // DISABLED: No call samples during mitt track
  return false
}

// Ensure-load-and-play variant for when a sample wasn't preloaded
export async function playCallSampleAsync(key, { volume=0.92 } = {}){
  // DISABLED: No call samples during mitt track
  return false
  const norm = normalizeCallKey(key)
  const playBuf = (buf)=>{
    try {
      const now = ctx.currentTime
      const src = ctx.createBufferSource(); src.buffer = buf
      const g = ctx.createGain(); g.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now)
      src.connect(g).connect(ctx.destination)
      src.start(now)
      return true
    } catch { return false }
  }
  let buf = callBuffers.get(norm)
  if (buf) return playBuf(buf)
  if (!callLoading.get(norm)){
    callLoading.set(norm, true)
    try {
      let urls = [
        '/audio/boxing/calls/' + encodeURI(norm) + '.mp3',
        '/audio/boxing/calls/' + encodeURI(key) + '.mp3',
        '/calls/' + encodeURI(norm) + '.mp3'
      ]
      // Fallbacks: unify generic hook/body/upper if specific L/R missing
      if (norm==='left_hook' || norm==='right_hook') {
        urls = [
          '/audio/boxing/calls/' + encodeURI(norm) + '.mp3',
          '/audio/boxing/calls/hook.mp3',
          '/calls/' + encodeURI(norm) + '.mp3'
        ]
      }
      if (norm==='left_upper' || norm==='right_upper') {
        urls = [
          '/audio/boxing/calls/' + encodeURI(norm) + '.mp3',
          '/audio/boxing/calls/upper.mp3',
          '/calls/' + encodeURI(norm) + '.mp3'
        ]
      }
      for (const url of urls){
        try {
          const res = await fetch(url); if (!res.ok) continue
          const ab = await res.arrayBuffer(); const b = await ctx.decodeAudioData(ab)
          if (b) { callBuffers.set(norm, b); buf = b; break }
        } catch {}
      }
    } finally {
      callLoading.delete(norm)
    }

  } else {
    // wait briefly for ongoing load
    const t0 = Date.now()
    while (!callBuffers.get(norm) && (Date.now()-t0)<600) { await new Promise(r=>setTimeout(r,30)) }
    buf = callBuffers.get(norm)
  }
  return buf ? playBuf(buf) : false
}



// Short punch hit sound: '팝/탁'
export function playHitPop(){
  // CRITICAL: Don't play sounds during phone call or system audio interruption
  if (!canPlayAudio()) {
    try { console.log('[HitPop] Skipping playHitPop - audio interrupted') } catch {}
    return
  }
  const ctx = ensureAudioCtx(); if (!ctx) return
  // Attempt to resume audio context on user gesture sensitive paths
  try { if (ctx?.state === 'suspended') { ctx.resume?.() } } catch {}
  try { loadBellBuffers(ctx) } catch {}
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.setValueAtTime(0.95, now)

  // Prefer sample
  const buf = bellBuffers.pop
  if (buf) { const src = ctx.createBufferSource(); src.buffer = buf; src.connect(master).connect(ctx.destination); src.start(now); return }

  // Fallback synthesis: short noise burst with snap
  const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.07), ctx.sampleRate)
  const data = noiseBuf.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    const t = i / ctx.sampleRate
    const env = Math.exp(-t / 0.020)
    data[i] = (Math.random() * 2 - 1) * env
  }
  const noise = ctx.createBufferSource(); noise.buffer = noiseBuf; noise.loop = false

  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'
  hp.frequency.setValueAtTime(850, now)
  hp.Q.setValueAtTime(0.8, now)

  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'
  bp.frequency.setValueAtTime(1700, now)
  bp.Q.setValueAtTime(1.1, now)

  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.9, now + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.11)

  noise.connect(hp).connect(bp).connect(g).connect(master).connect(ctx.destination)
  noise.start(now); noise.stop(now + 0.11)
}



// Get duration (ms) of a preloaded call sample; null if not loaded
export function getCallSampleDuration(key){
  try {
    const buf = callBuffers.get(normalizeCallKey(key))
    return buf && typeof buf.duration === 'number' ? Math.round(buf.duration * 1000) : null
  } catch { return null }
}
