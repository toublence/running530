'use client'

import { Geolocation } from '@capacitor/geolocation'

const hasNavigator = () => typeof navigator !== 'undefined'
const hasWindow = () => typeof window !== 'undefined'

const isNativeCapacitor = () => {
  if (!hasWindow()) return false
  try {
    const Cap = window.Capacitor
    if (!Cap) return false
    if (typeof Cap.isNativePlatform === 'function') {
      return Cap.isNativePlatform()
    }
    const platform = Cap.getPlatform?.() || Cap.platform
    return platform === 'ios' || platform === 'android'
  } catch {
    return false
  }
}

const normalizeLocation = (position) => {
  if (!position) return null
  const coords = position.coords || position
  const latitude = Number(coords?.latitude ?? coords?.lat)
  const longitude = Number(coords?.longitude ?? coords?.lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(coords?.accuracy) ? coords.accuracy : null,
    speed: Number.isFinite(coords?.speed) ? coords.speed : null,
    heading: Number.isFinite(coords?.heading) ? coords.heading : null,
    altitude: Number.isFinite(coords?.altitude) ? coords.altitude : null,
    timestamp: typeof position.timestamp === 'number' ? position.timestamp : Date.now(),
    raw: position,
  }
}

const requestWebPermission = async () => {
  if (!hasNavigator() || !navigator.permissions?.query) {
    return 'prompt'
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' })
    return status.state || 'prompt'
  } catch {
    return 'prompt'
  }
}

export const ensureLocationPermission = async () => {
  try {
    const existing = await Geolocation.checkPermissions()
    if (existing?.location === 'granted' || existing?.location === 'limited') {
      return existing.location
    }
    const requested = await Geolocation.requestPermissions()
    return requested?.location || 'prompt'
  } catch {
    return requestWebPermission()
  }
}

export const getCurrentLocation = async (options = {}) => {
  const defaultOpts = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000,
  }
  const merged = { ...defaultOpts, ...options }
  try {
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: merged.enableHighAccuracy,
      timeout: merged.timeout,
    })
    const normalized = normalizeLocation(position)
    if (normalized) return normalized
  } catch (err) {
    console.warn('[geolocation] native getCurrentPosition failed', err)
  }
  if (!hasNavigator() || !navigator.geolocation) {
    throw new Error('Geolocation is not supported in this environment.')
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const normalized = normalizeLocation(pos)
        if (normalized) {
          resolve(normalized)
        } else {
          reject(new Error('Unable to read geolocation result'))
        }
      },
      (error) => reject(error),
      merged,
    )
  })
}

const startWebWatch = (options, onPosition, onError) => {
  if (!hasNavigator() || !navigator.geolocation) {
    onError?.(new Error('Geolocation API not available'))
    return null
  }
  try {
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const normalized = normalizeLocation(pos)
        if (normalized) onPosition?.(normalized)
      },
      (err) => {
        console.warn('[geolocation] web watch error', err)
        onError?.(err)
      },
      options,
    )
    return () => {
      try {
        navigator.geolocation.clearWatch(id)
      } catch {}
    }
  } catch (err) {
    console.warn('[geolocation] failed to start web watch', err)
    onError?.(err)
    return null
  }
}

export const watchLocation = (options = {}, onPosition, onError) => {
  const handler = typeof onPosition === 'function' ? onPosition : () => {}
  const errorHandler = typeof onError === 'function' ? onError : () => {}
  const defaultOpts = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 1000,
  }
  const merged = { ...defaultOpts, ...options }

  if (isNativeCapacitor()) {
    try {
      const id = Geolocation.watchPosition(
        {
          enableHighAccuracy: merged.enableHighAccuracy,
          timeout: merged.timeout,
          maximumAge: merged.maximumAge,
        },
        (position, error) => {
          if (error) {
            console.warn('[geolocation] native watch error', error)
            errorHandler(error)
            return
          }
          const normalized = normalizeLocation(position)
          if (normalized) handler(normalized)
        },
      )
      return () => {
        try {
          Geolocation.clearWatch({ id })
        } catch {}
      }
    } catch (err) {
      console.warn('[geolocation] native watch failed, falling back to web', err)
    }
  }

  return startWebWatch(
    {
      enableHighAccuracy: merged.enableHighAccuracy,
      timeout: merged.timeout,
      maximumAge: merged.maximumAge,
    },
    handler,
    errorHandler,
  )
}
