'use client'

// Helper to request activity / motion permissions on Android and iOS.
// Best-effort fallback: if a platform is unsupported we return true to avoid blocking the app.

const resolvePlatform = () => {
  if (typeof window === 'undefined') return 'web'
  const Cap = window.Capacitor
  return Cap?.getPlatform?.() || Cap?.platform || 'web'
}

const resolvePedometerBridge = () => {
  if (typeof window === 'undefined') return null
  const Cap = window.Capacitor
  let ped = Cap?.Plugins?.Pedometer || Cap?.Plugins?.Motion || Cap?.Motion
  if (!ped) {
    const w = window
    ped = w.pedometer || w.plugins?.pedometer || w.cordova?.plugins?.pedometer || null
  }
  return ped
}

export const ensureActivityRecognitionPermission = async () => {
  if (resolvePlatform() !== 'android') return true
  const cordovaPerms = typeof window !== 'undefined' ? window.cordova?.plugins?.permissions : null
  if (!cordovaPerms) {
    console.warn('[permissions] cordova-plugin-android-permissions not available; skipping prompt')
    return true
  }
  const PERM = cordovaPerms.ACTIVITY_RECOGNITION || 'android.permission.ACTIVITY_RECOGNITION'
  const checkAsync = () => new Promise((resolve) => {
    try {
      cordovaPerms.checkPermission(PERM, (status) => resolve(status?.hasPermission === true), () => resolve(false))
    } catch (err) {
      console.warn('[permissions] checkPermission failed', err)
      resolve(false)
    }
  })
  const requestAsync = () => new Promise((resolve) => {
    try {
      cordovaPerms.requestPermission(PERM, (status) => resolve(status?.hasPermission === true), () => resolve(false))
    } catch (err) {
      console.warn('[permissions] requestPermission failed', err)
      resolve(false)
    }
  })

  const already = await checkAsync()
  if (already) return true
  return requestAsync()
}

export const ensurePedometerPermission = async () => {
  const platform = resolvePlatform()
  if (platform !== 'ios') return true

  const pedometer = resolvePedometerBridge()
  if (!pedometer) {
    console.warn('[permissions] pedometer plugin not available on iOS; skipping Motion & Fitness prompt')
    return true
  }

  try {
    if (typeof pedometer.authorizationStatus === 'function') {
      const status = await pedometer.authorizationStatus()
      if (status === 'authorized' || status === 'allowed' || status === 'granted' || status === 'authorizedAlways') return true
    }

    if (typeof pedometer.requestPermission === 'function') {
      const res = await pedometer.requestPermission()
      if (res === true || res === 'granted' || res?.value === true || res?.status === 'granted') return true
      if (res?.authorized === true || res?.granted === true) return true
    }

    // Cordova pedometer plugin (cordova-plugin-pedometer) style API
    if (typeof pedometer.startPedometerUpdates === 'function') {
      return await new Promise((resolve) => {
        let resolved = false
        const safeResolve = (value) => {
          if (resolved) return
          resolved = true
          resolve(value)
        }

        try {
          pedometer.startPedometerUpdates(
            () => {
              try {
                pedometer.stopPedometerUpdates?.(() => {}, () => {})
              } catch (stopErr) {
                console.warn('[permissions] stopPedometerUpdates failed', stopErr)
              }
              safeResolve(true)
            },
            (err) => {
              console.warn('[permissions] startPedometerUpdates error', err)
              safeResolve(true) // best-effort: don't block the session
            },
          )
        } catch (err) {
          console.warn('[permissions] startPedometerUpdates threw', err)
          safeResolve(true)
        }
      })
    }

    // Generic CMPedometer-style bridge
    if (typeof pedometer.startUpdates === 'function') {
      await pedometer.startUpdates()
      return true
    }

    return true
  } catch (err) {
    console.warn('[permissions] pedometer request failed, continuing best-effort', err)
    return true
  }
}

export const maybeRequestIgnoreBatteryOptimizations = async () => {
  if (resolvePlatform() !== 'android') return
  const storageKey = 'battery_opt_out_prompted'
  const alreadyPrompted = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) === 'true' : false
  if (alreadyPrompted) return

  try {
    const mod = await import('@capacitor/app-launcher')
    const AppLauncher = mod?.AppLauncher || mod?.default?.AppLauncher || mod?.default
    const appMod = await import('@capacitor/app')
    const App = appMod?.App || appMod?.default?.App || appMod?.default
    const appInfo = App?.getInfo ? await App.getInfo().catch(() => null) : null
    const packageName = appInfo?.id || ''

    const intentRequest = packageName
      ? `intent:#Intent;action=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;data=package:${packageName};end`
      : 'intent:#Intent;action=android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;end'
    const intentSettings = 'intent:#Intent;action=android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS;end'

    const tryOpen = async (url) => {
      const can = await AppLauncher.canOpenUrl({ url }).catch(() => ({ value: false }))
      if (can?.value) {
        await AppLauncher.openUrl({ url })
        return true
      }
      return false
    }

    const opened = (await tryOpen(intentRequest)) || (await tryOpen(intentSettings)) || (await tryOpen('app-settings:'))
    if (opened && typeof localStorage !== 'undefined') localStorage.setItem(storageKey, 'true')
  } catch (err) {
    console.warn('[permissions] battery optimization prompt failed', err)
  }
}
