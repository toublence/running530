'use client'

import { useEffect, useRef } from 'react'

const defaultAttState = {
  authorized: false,
  platform: 'unknown',
  status: 'pending',
  shouldUseNpa: false,
  attAvailable: null,
  updatedAt: null,
}

let attPromiseResolver = null
let latestAttResult = { ...defaultAttState }

const resolveAttState = (partial = {}) => {
  const platform = partial.platform || latestAttResult.platform || 'unknown'
  const authorized = partial.authorized === true
  const status = partial.status || (authorized ? 'authorized' : 'denied')
  const shouldUseNpa = platform === 'ios' && !authorized

  latestAttResult = {
    ...latestAttResult,
    ...partial,
    authorized,
    platform,
    status,
    shouldUseNpa,
    updatedAt: Date.now(),
  }

  if (attPromiseResolver) {
    const resolve = attPromiseResolver
    attPromiseResolver = null
    resolve(latestAttResult)
  }

  return latestAttResult
}

// Global promise that resolves when ATT request is complete
export const attPromise = new Promise((resolve) => {
  attPromiseResolver = resolve
})

export const getLatestAttResult = () => latestAttResult

export default function TrackingTransparencyPrompt() {
  const requestedRef = useRef(false)

  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true

    let cancelled = false

    const requestTrackingPermission = async () => {
      if (typeof window === 'undefined') {
        resolveAttState({ authorized: false, platform: 'unknown', status: 'no-window' })
        return
      }

      const Cap = window.Capacitor || null
      const platform = Cap?.getPlatform?.() || Cap?.platform || 'web'

      // For web and Android, allow AdMob immediately
      if (platform !== 'ios') {
        resolveAttState({ authorized: true, platform, status: 'authorized' })
        return
      }

      try {
        // Prefer runtime plugin from Capacitor (avoids bundling dependency in web build)
        const ATT = Cap?.Plugins?.AppTrackingTransparency

        // Support multiple plugin method names across community plugins
        const getStatusFn = ATT && (ATT.getTrackingAuthorizationStatus || ATT.getStatus)
        const requestFn = ATT && (ATT.requestTrackingAuthorization || ATT.requestPermission)

        if (!ATT || typeof getStatusFn !== 'function' || typeof requestFn !== 'function') {
          console.warn('[ATT] Plugin not available or incompatible on iOS — disallow tracking')
          resolveAttState({ authorized: false, platform: 'ios', attAvailable: !!ATT, status: 'unavailable' })
          return
        }

        const result = await getStatusFn.call(ATT)
        if (cancelled) return

        const status = typeof result === 'string' ? result : result?.status

        if (status === 'notDetermined') {
          // Request permission and wait for user response
          const requestResult = await requestFn.call(ATT)
          if (cancelled) return

          const finalStatus = typeof requestResult === 'string' ? requestResult : requestResult?.status
          const authorized = finalStatus === 'authorized'

          console.log('[ATT] User response:', finalStatus, 'Authorized:', authorized)
          resolveAttState({ authorized, platform: 'ios', status: finalStatus })
        } else {
          // Already determined (authorized, denied, or restricted)
          const authorized = status === 'authorized'
          console.log('[ATT] Already determined:', status, 'Authorized:', authorized)
          resolveAttState({ authorized, platform: 'ios', status })
        }
      } catch (err) {
        console.warn('[ATT] Tracking authorization request failed:', err)
        // On error, allow ads to continue (graceful degradation)
        resolveAttState({ authorized: false, platform: 'ios', error: err.message, status: 'error' })
      }
    }

    requestTrackingPermission()

    return () => {
      cancelled = true
    }
  }, [])

  return null
}
