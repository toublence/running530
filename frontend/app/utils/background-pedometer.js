'use client'

/**
 * Background Pedometer Plugin
 * Supports step counting even when app is closed/terminated
 * - iOS: Uses CMPedometer with historical data query
 * - Android: Uses Foreground Service with TYPE_STEP_COUNTER
 */

let activeStopper = null

const resolvePlugin = () => {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor || {}
  const plugins = cap.Plugins || {}
  return plugins.BackgroundPedometer || cap.BackgroundPedometer || null
}

const normalizeReading = (data) => {
  if (!data) return null
  const stepsRaw = data.steps ?? data.numberOfSteps ?? data.count ?? data.value
  const steps = Number(stepsRaw)
  if (!Number.isFinite(steps)) return null
  const tsRaw = data.timestamp ?? data.endDate ?? data.time ?? data.ts
  const timestamp = Number.isFinite(tsRaw) ? Number(tsRaw) : Date.now()
  return {
    steps: Math.max(0, steps),
    timestamp,
    distance: data.distance ?? 0,
    historicalSteps: data.historicalSteps ?? 0,
    liveSteps: data.liveSteps ?? steps,
    raw: data,
  }
}

const stopActive = async () => {
  const stopper = activeStopper
  activeStopper = null
  if (typeof stopper === 'function') {
    try {
      await stopper()
    } catch {}
  }
}

export const backgroundPedometer = {
  async isAvailable() {
    const plugin = resolvePlugin()
    if (!plugin) return false

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
  },

  async requestPermission() {
    const plugin = resolvePlugin()
    if (!plugin) return 'denied'

    try {
      const res = await plugin.requestPermission()
      if (typeof res === 'string') return res
      if (res === true) return 'granted'
      if (res && typeof res === 'object') {
        if (res.status) return res.status
        if (res.value === true || res.granted === true || res.authorized === true) {
          return 'granted'
        }
      }
      return 'granted'
    } catch {
      return 'denied'
    }
  },

  async startUpdates(callback) {
    const plugin = resolvePlugin()
    if (!plugin) throw new Error('BackgroundPedometer plugin is unavailable')

    await stopActive()

    const emit = (payload) => {
      const reading = normalizeReading(payload)
      if (!reading) return
      try {
        callback?.(reading)
      } catch (err) {
        console.warn('[backgroundPedometer] callback error', err)
      }
    }

    try {
      // Capacitor event emitter style
      if (typeof plugin.addListener === 'function' && typeof plugin.startUpdates === 'function') {
        const listener = await plugin.addListener('stepUpdate', emit)
        const startResult = await plugin.startUpdates()

        console.log('[backgroundPedometer] Started with historical steps:', startResult?.historicalSteps ?? 0)

        activeStopper = async () => {
          try {
            await plugin.stopUpdates?.()
          } catch {}
          try {
            await listener?.remove?.()
          } catch {}
        }
        return true
      }

      // Promise style
      if (typeof plugin.startUpdates === 'function') {
        await plugin.startUpdates(emit)
        activeStopper = async () => {
          try {
            await plugin.stopUpdates?.()
          } catch {}
        }
        return true
      }

      throw new Error('No pedometer start method available')
    } catch (err) {
      console.error('[backgroundPedometer] Failed to start:', err)
      throw err
    }
  },

  async stopUpdates() {
    await stopActive()
  },

  // JavaScript 리스너만 해제하고 네이티브 세션은 유지
  // 다른 메뉴로 이동할 때 사용 (워킹 모드)
  detachListener() {
    const stopper = activeStopper
    activeStopper = null
    if (typeof stopper === 'function') {
      // stopper를 호출하지 않음 - 네이티브 stopUpdates가 호출되지 않음
      // 다만 listener.remove()만 호출해야 하는데, stopper가 두 가지를 모두 하므로
      // 그냥 아무것도 하지 않음 - 다음 startUpdates에서 새 리스너가 등록됨
    }
  },

  async queryHistoricalData(startTime, endTime) {
    const plugin = resolvePlugin()
    if (!plugin) return null

    try {
      const result = await plugin.queryHistoricalData({
        startTime: startTime || Date.now() - 7 * 24 * 60 * 60 * 1000, // 기본 7일
        endTime: endTime || Date.now(),
      })

      return {
        steps: result?.steps ?? 0,
        distance: result?.distance ?? 0,
        startTime: result?.startTime,
        endTime: result?.endTime,
      }
    } catch (err) {
      console.warn('[backgroundPedometer] queryHistoricalData failed:', err)
      return null
    }
  },

  async getServiceStatus() {
    const plugin = resolvePlugin()
    if (!plugin) return { isRunning: false, currentSteps: 0, sessionStartTime: 0 }

    try {
      const result = await plugin.getServiceStatus()
	      const rawCurrent = Number(result?.currentSteps)
	      const rawHistorical = Number(result?.historicalSteps)
	      const rawLive = Number(result?.liveSteps)
	      const hasHistOrLive = Number.isFinite(rawHistorical) || Number.isFinite(rawLive)
	      const combinedFromHistLive = hasHistOrLive
	        ? Math.max(0, (Number.isFinite(rawHistorical) ? rawHistorical : 0) + (Number.isFinite(rawLive) ? rawLive : 0))
	        : null
	      const safeCurrent = Number.isFinite(rawCurrent) ? Math.max(0, rawCurrent) : null
	      const currentSteps = combinedFromHistLive != null ? combinedFromHistLive : (safeCurrent != null ? safeCurrent : 0)
	
	      return {
	        isRunning: result?.isRunning ?? false,
	        currentSteps,
	        sessionStartTime: result?.sessionStartTime ?? 0,
	      }
    } catch (err) {
      console.warn('[backgroundPedometer] getServiceStatus failed:', err)
      return { isRunning: false, currentSteps: 0, sessionStartTime: 0 }
    }
  },
}

export default backgroundPedometer
