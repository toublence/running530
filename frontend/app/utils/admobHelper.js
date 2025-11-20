import { attPromise } from '../components/TrackingTransparencyPrompt'

let adMobInitialized = false
let adMobInitPromise = null

const defaultPrivacyState = {
  platform: 'unknown',
  attStatus: 'pending',
  npa: false,
  personalized: true,
  attResult: null,
}

let adPrivacyState = { ...defaultPrivacyState }

const detectPlatform = () => {
  if (typeof window === 'undefined') return 'unknown'
  const Cap = window.Capacitor || null
  return Cap?.getPlatform?.() || Cap?.platform || 'web'
}

const computePrivacyState = (platform, attResult) => {
  const authorized = attResult?.authorized === true
  const status = attResult?.status || (authorized ? 'authorized' : 'denied')
  const npa = platform === 'ios' ? !authorized : false

  return {
    platform,
    attStatus: status,
    npa,
    personalized: !npa,
    attResult: attResult || null,
  }
}

const setPrivacyState = (platform, attResult) => {
  adPrivacyState = computePrivacyState(platform, attResult)
  return adPrivacyState
}

export const getAdPrivacyState = () => adPrivacyState

const getAdMobPlugin = () => {
  if (typeof window === 'undefined' || !window.Capacitor) {
    return null
  }
  const plugins = window.Capacitor.Plugins || {}
  return plugins.AdMob || plugins.CapacitorAdmobAds || null
}

/**
 * Initialize AdMob after ATT authorization (iOS only requirement)
 * This ensures compliance with Apple's App Tracking Transparency requirements
 *
 * @returns {Promise<boolean>} True if AdMob was initialized successfully
 */
export async function initializeAdMob() {
  // Return existing promise if already initializing
  if (adMobInitPromise) {
    return adMobInitPromise
  }

  // Return immediately if already initialized
  if (adMobInitialized) {
    return Promise.resolve(true)
  }

  adMobInitPromise = (async () => {
    try {
      // Wait for ATT prompt to complete (iOS) or resolve immediately (web/Android)
      console.log('[AdMob] Waiting for ATT authorization...')
      const attResult = await attPromise.catch((error) => {
        console.warn('[AdMob] ATT promise rejected, defaulting to non-personalized ads', error)
        return null
      })
      const platform = detectPlatform()
      const privacy = setPrivacyState(platform, attResult)
      console.log('[AdMob] ATT result:', {
        status: privacy.attStatus,
        platform: privacy.platform,
        npa: privacy.npa,
      })

      if (privacy.npa) {
        console.log('[AdMob] Non-personalized ads will be requested (ATT denied/restricted)')
      }

      // Check if we're in a Capacitor environment
      if (typeof window === 'undefined' || !window.Capacitor) {
        console.log('[AdMob] Not in Capacitor environment, skipping initialization')
        return false
      }

      const plugins = window.Capacitor?.Plugins || {}
      const plugin = plugins.AdMob || plugins.CapacitorAdmobAds || null
      console.log('[AdMob] Detected plugins:', Object.keys(plugins || {}))

      if (!plugin) {
        console.warn('[AdMob] Plugin not available (AdMob/CapacitorAdmobAds not found)')
        return false
      }

      // Initialize AdMob with production settings (if supported by the plugin)
      const initFn = plugin.initialize
      if (typeof initFn === 'function') {
        await initFn.call(plugin, {
          initializeForTesting: false, // PRODUCTION MODE
        })
      } else {
        console.log('[AdMob] Plugin has no initialize(); continuing without explicit init')
      }

      console.log('[AdMob] Initialized successfully')
      adMobInitialized = true
      return true
    } catch (error) {
      console.error('[AdMob] Initialization failed:', error)
      return false
    }
  })()

  return adMobInitPromise
}

/**
 * Show a banner ad
 * Automatically initializes AdMob if not already done
 */
export async function showBannerAd({ adId, position = 'BOTTOM_CENTER', adSize = 'BANNER', margin = 0 }) {
  try {
    const initialized = await initializeAdMob()
    if (!initialized) {
      console.warn('[AdMob] Cannot show banner - not initialized')
      return false
    }

    const plugin = getAdMobPlugin()

    if (!plugin) {
      console.warn('[AdMob] Banner plugin not available')
      return false
    }

    const showFn = plugin.showBanner || plugin.showBannerAd
    if (typeof showFn !== 'function') {
      console.warn('[AdMob] Banner show method missing on plugin')
      return false
    }

    const request = {
      adId,
      adSize,
      position,
      margin,
      isTesting: false, // PRODUCTION MODE
    }

    if (adPrivacyState.npa) {
      request.npa = true
    }

    await showFn.call(plugin, request)

    console.log('[AdMob] Banner ad shown')
    return true
  } catch (error) {
    console.error('[AdMob] Failed to show banner:', error)
    return false
  }
}

/**
 * Hide banner ad
 */
export async function hideBannerAd() {
  try {
    const plugin = getAdMobPlugin()

    if (!plugin) {
      return false
    }

    const hideFn = plugin.hideBanner || plugin.hideBannerAd || plugin.removeBanner
    if (typeof hideFn !== 'function') {
      return false
    }

    await hideFn.call(plugin)
    console.log('[AdMob] Banner ad hidden')
    return true
  } catch (error) {
    console.error('[AdMob] Failed to hide banner:', error)
    return false
  }
}

/**
 * Prepare an interstitial ad
 */
export async function prepareInterstitialAd(adId) {
  try {
    const initialized = await initializeAdMob()
    if (!initialized) {
      console.warn('[AdMob] Cannot prepare interstitial - not initialized')
      return false
    }

    const plugin = getAdMobPlugin()

    if (!plugin) {
      return false
    }

    const options = {
      adId,
      isTesting: false, // PRODUCTION MODE
    }

    if (adPrivacyState.npa) {
      options.npa = true
    }

    const prepareFn = plugin.prepareInterstitial || plugin.loadInterstitialAd
    if (typeof prepareFn !== 'function') {
      return false
    }

    await prepareFn.call(plugin, options)

    console.log('[AdMob] Interstitial ad prepared')
    return true
  } catch (error) {
    console.error('[AdMob] Failed to prepare interstitial:', error)
    return false
  }
}

/**
 * Show an interstitial ad
 */
export async function showInterstitialAd() {
  try {
    const plugin = getAdMobPlugin()

    if (!plugin) {
      return false
    }

    const showFn = plugin.showInterstitial || plugin.showInterstitialAd
    if (typeof showFn !== 'function') {
      return false
    }

    await showFn.call(plugin)
    console.log('[AdMob] Interstitial ad shown')
    return true
  } catch (error) {
    console.error('[AdMob] Failed to show interstitial:', error)
    return false
  }
}
