'use client'

let bridgeRefCount = 0
let removeNativeListener = null
let lastForcedVisibility = null

const safeDispatch = (target, eventName) => {
  try {
    if (!target || typeof target.dispatchEvent !== 'function') return
    target.dispatchEvent(new Event(eventName))
  } catch (err) {
    console.warn('[native-visibility] Failed to dispatch', eventName, err)
  }
}

const applyVisibilityOverride = (state) => {
  if (typeof document === 'undefined') return
  try {
    Object.defineProperty(document, 'visibilityState', {
      value: state,
      configurable: true,
      enumerable: false,
      writable: true,
    })
  } catch (err) {
    console.warn('[native-visibility] visibilityState override failed', err)
  }
  try {
    Object.defineProperty(document, 'hidden', {
      value: state !== 'visible',
      configurable: true,
      enumerable: false,
      writable: true,
    })
  } catch (err) {
    console.warn('[native-visibility] hidden override failed', err)
  }
  try {
    Object.defineProperty(document, 'webkitHidden', {
      value: state !== 'visible',
      configurable: true,
      enumerable: false,
      writable: true,
    })
  } catch {}
}

const clearVisibilityOverride = () => {
  if (typeof document === 'undefined') return
  try { delete document.visibilityState } catch {}
  try { delete document.hidden } catch {}
  try { delete document.webkitHidden } catch {}
}

const emitVisibilitySignals = (state) => {
  if (typeof document === 'undefined') return
  const isVisible = state === 'visible'
  safeDispatch(document, 'visibilitychange')
  safeDispatch(window, isVisible ? 'focus' : 'blur')
  safeDispatch(window, isVisible ? 'pageshow' : 'pagehide')
  safeDispatch(window, isVisible ? 'resume' : 'pause')
  safeDispatch(document, isVisible ? 'resume' : 'pause')
}

const startNativeBridge = (tag) => {
  if (typeof window === 'undefined') return null
  const Cap = window?.Capacitor
  if (!Cap) return null
  const App = Cap?.Plugins?.App || Cap?.App
  if (!App || typeof App.addListener !== 'function') return null

  const log = (...args) => {
    try {
      console.log(`[native-visibility:${tag}]`, ...args)
    } catch {}
  }

  const handleState = (state) => {
    const next = state?.isActive ? 'visible' : 'hidden'
    if (next === lastForcedVisibility) return
    lastForcedVisibility = next
    log('App state changed:', state)
    applyVisibilityOverride(next)
    emitVisibilitySignals(next)
  }

  try {
    const listener = App.addListener('appStateChange', handleState)
    if (listener && typeof listener.then === 'function') {
      let resolved = null
      listener
        .then((sub) => {
          resolved = sub
        })
        .catch((err) => console.warn('[native-visibility] listener promise rejected', err))
      return () => {
        lastForcedVisibility = null
        if (resolved && typeof resolved.remove === 'function') {
          try { resolved.remove() } catch (err) { console.warn('[native-visibility] remove failed', err) }
        }
      }
    }
    return () => {
      lastForcedVisibility = null
      try {
        listener?.remove?.()
      } catch (err) {
        console.warn('[native-visibility] remove failed', err)
      }
    }
  } catch (err) {
    console.warn('[native-visibility] Failed to attach listener', err)
    return null
  }
}

export const acquireNativeVisibilityBridge = (tag = 'app') => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }
  bridgeRefCount += 1
  if (bridgeRefCount === 1) {
    removeNativeListener = startNativeBridge(tag)
  }
  return () => {
    bridgeRefCount = Math.max(0, bridgeRefCount - 1)
    if (bridgeRefCount === 0) {
      if (typeof removeNativeListener === 'function') {
        removeNativeListener()
        removeNativeListener = null
      }
      clearVisibilityOverride()
      lastForcedVisibility = null
    }
  }
}
