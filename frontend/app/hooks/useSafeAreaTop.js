'use client'

import { useEffect, useState } from 'react'

const clampInset = (val) => {
  const parsed = typeof val === 'number' ? val : parseFloat(val)
  if (!Number.isFinite(parsed)) return 0
  return parsed > 0 ? parsed : 0
}

const measureCssSafeArea = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0
  let probe
  try {
    probe = document.createElement('div')
    probe.style.position = 'absolute'
    probe.style.top = '0'
    probe.style.height = 'env(safe-area-inset-top, 0px)'
    probe.style.pointerEvents = 'none'
    probe.style.opacity = '0'
    probe.style.zIndex = '-1'
    document.body.appendChild(probe)
    const computed = window.getComputedStyle(probe).height
    return clampInset(parseFloat(computed) || 0)
  } catch {
    return 0
  } finally {
    if (probe && probe.parentNode) {
      probe.parentNode.removeChild(probe)
    }
  }
}

const readViewportOffset = () => {
  if (typeof window === 'undefined') return 0
  try {
    const viewport = window.visualViewport
    if (viewport && typeof viewport.offsetTop === 'number') {
      return clampInset(viewport.offsetTop)
    }
  } catch {}
  return 0
}

const getInitialInset = () => {
  if (typeof window === 'undefined') return 0
  const cssInset = measureCssSafeArea()
  const viewportInset = readViewportOffset()
  return Math.max(cssInset, viewportInset)
}

export default function useSafeAreaTop() {
  const [safeAreaTop, setSafeAreaTop] = useState(() => getInitialInset())

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let cancelled = false
    let raf = 0

    const commit = (value) => {
      if (cancelled) return
      const next = clampInset(value)
      setSafeAreaTop((prev) => (Math.abs(prev - next) > 0.5 ? next : prev))
    }

    const updateFromPlugin = async () => {
      try {
        const SafeArea = window?.Capacitor?.Plugins?.SafeArea
        if (SafeArea?.getSafeAreaInsets) {
          const result = await SafeArea.getSafeAreaInsets()
          const inset = clampInset(result?.insets?.top)
          if (inset > 0) {
            commit(inset)
            return true
          }
        }
      } catch {}
      return false
    }

    const updateFromFallback = () => {
      const cssInset = measureCssSafeArea()
      const viewportInset = readViewportOffset()
      commit(Math.max(cssInset, viewportInset))
    }

    const refresh = async () => {
      if (cancelled) return
      const usedPlugin = await updateFromPlugin()
      if (!usedPlugin) {
        updateFromFallback()
      }
    }

    const scheduleRefresh = () => {
      if (cancelled) return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        refresh()
      })
    }

    scheduleRefresh()

    window.addEventListener('resize', scheduleRefresh)
    window.addEventListener('orientationchange', scheduleRefresh)
    window.visualViewport?.addEventListener?.('resize', scheduleRefresh)

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', scheduleRefresh)
      window.removeEventListener('orientationchange', scheduleRefresh)
      window.visualViewport?.removeEventListener?.('resize', scheduleRefresh)
    }
  }, [])

  return safeAreaTop
}
