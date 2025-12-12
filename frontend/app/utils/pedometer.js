'use client'

/**
 * Lightweight wrapper around a Capacitor/Cordova pedometer plugin.
 * Handles both Capacitor event emitters and the cordova-plugin-pedometer callback API.
 */

let activeStopper = null

const resolvePlugin = () => {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor || {}
  const plugins = cap.Plugins || {}
  const w = window
  return (
    plugins.Pedometer
    || cap.Pedometer
    || plugins.Motion
    || cap.Motion
    || w.Pedometer
    || w.pedometer
    || w.plugins?.pedometer
    || w.cordova?.plugins?.pedometer
    || null
  )
}

const normalizeReading = (data) => {
  if (!data) return null
  const stepsRaw = data.steps ?? data.numberOfSteps ?? data.count ?? data.value
  const steps = Number(stepsRaw)
  if (!Number.isFinite(steps)) return null
  const tsRaw = data.timestamp ?? data.endDate ?? data.time ?? data.ts
  const timestamp = Number.isFinite(tsRaw) ? Number(tsRaw) : Date.now()
  return { steps: Math.max(0, steps), timestamp, raw: data }
}

const stopActive = async () => {
  const stopper = activeStopper
  activeStopper = null
  if (typeof stopper === 'function') {
    try { await stopper() } catch {}
  }
}

const callCordovaBoolean = (fn) => new Promise((resolve) => {
  try {
    fn(
      (res) => resolve(res === true || res === 1 || res === '1'),
      () => resolve(false),
    )
  } catch {
    resolve(false)
  }
})

export const pedometer = {
  async isAvailable() {
    const plugin = resolvePlugin()
    if (!plugin) return false
    // Capacitor-style promise
    if (typeof plugin.isAvailable === 'function') {
      try {
        const res = await plugin.isAvailable()
        if (res === true) return true
        if (res && typeof res === 'object') {
          return Boolean(res.available ?? res.isAvailable)
        }
        return Boolean(res)
      } catch {
        return false
      }
    }
    // Cordova pedometer plugin
    if (typeof plugin.isStepCountingAvailable === 'function') {
      return callCordovaBoolean(plugin.isStepCountingAvailable)
    }
    // If the plugin exists but has no availability hook, assume present.
    return true
  },

  async requestPermission() {
    const plugin = resolvePlugin()
    if (!plugin) return 'denied'

    // Capacitor plugin
    if (typeof plugin.requestPermission === 'function') {
      try {
        const res = await plugin.requestPermission()
        if (typeof res === 'string') return res
        if (res === true) return 'granted'
        if (res && typeof res === 'object') {
          if (res.status) return res.status
          if (res.value === true || res.granted === true || res.authorized === true) return 'granted'
        }
      } catch {}
    }

    // CMPedometer bridge style
    if (typeof plugin.authorizationStatus === 'function') {
      try {
        const status = await plugin.authorizationStatus()
        if (status === 'authorized' || status === 'authorizedAlways' || status === 'granted') {
          return 'granted'
        }
      } catch {}
    }

    // Cordova pedometer has no explicit permission API; permission handled separately.
    return 'granted'
  },

  async startUpdates(callback) {
    const plugin = resolvePlugin()
    if (!plugin) throw new Error('Pedometer plugin is unavailable')

    await stopActive()

    const emit = (payload) => {
      const reading = normalizeReading(payload)
      if (!reading) return
      try {
        callback?.(reading)
      } catch (err) {
        console.warn('[pedometer] callback error', err)
      }
    }

    // Capacitor event emitter style
    if (typeof plugin.addListener === 'function' && typeof plugin.startUpdates === 'function') {
      const listener = await plugin.addListener('stepUpdate', emit)
      await plugin.startUpdates().catch(() => {})
      activeStopper = async () => {
        try { await plugin.stopUpdates?.() } catch {}
        try { await listener?.remove?.() } catch {}
      }
      return true
    }

    // Capacitor promise style without event name
    if (typeof plugin.startUpdates === 'function') {
      await plugin.startUpdates(emit)
      activeStopper = async () => {
        try { await plugin.stopUpdates?.() } catch {}
      }
      return true
    }

    // Cordova pedometer (callback-based)
    if (typeof plugin.startPedometerUpdates === 'function') {
      try {
        plugin.startPedometerUpdates(
          (data) => emit(data),
          (err) => console.warn('[pedometer] startPedometerUpdates error', err),
        )
        activeStopper = async () => {
          try { plugin.stopPedometerUpdates?.(() => {}, () => {}) } catch {}
        }
        return true
      } catch (err) {
        console.warn('[pedometer] failed to start cordova pedometer', err)
        throw err
      }
    }

    throw new Error('No pedometer start method available')
  },

  async stopUpdates() {
    await stopActive()
  },
}

export default pedometer
