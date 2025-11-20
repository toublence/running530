/**
 * Wake Lock API utility for preventing screen sleep during workouts
 * Keeps the screen on while the camera is active
 */

let wakeLock = null
let wakeLockSupported = false

// Check if Wake Lock API is supported
if (typeof window !== 'undefined' && 'wakeLock' in navigator) {
  wakeLockSupported = true
}

/**
 * Request a wake lock to prevent screen from sleeping
 * @returns {Promise<boolean>} true if wake lock was acquired, false otherwise
 */
export async function requestWakeLock() {
  if (!wakeLockSupported) {
    console.log('[WakeLock] Wake Lock API not supported')
    return false
  }

  try {
    // Release existing wake lock first
    if (wakeLock !== null) {
      try {
        await wakeLock.release()
      } catch (e) {
        console.warn('[WakeLock] Error releasing existing wake lock:', e)
      }
    }

    wakeLock = await navigator.wakeLock.request('screen')

    wakeLock.addEventListener('release', () => {
      console.log('[WakeLock] Wake Lock released')
    })

    console.log('[WakeLock] Wake Lock acquired successfully')
    return true
  } catch (err) {
    console.error('[WakeLock] Failed to acquire wake lock:', err)
    wakeLock = null
    return false
  }
}

/**
 * Release the current wake lock
 * @returns {Promise<void>}
 */
export async function releaseWakeLock() {
  if (wakeLock !== null) {
    try {
      await wakeLock.release()
      wakeLock = null
      console.log('[WakeLock] Wake Lock released manually')
    } catch (err) {
      console.error('[WakeLock] Error releasing wake lock:', err)
    }
  }
}

/**
 * Check if wake lock is currently active
 * @returns {boolean}
 */
export function isWakeLockActive() {
  return wakeLock !== null && wakeLock.released === false
}

/**
 * Setup automatic wake lock re-acquisition on visibility change
 * This ensures the wake lock is re-acquired when the user returns to the app
 */
export function setupAutoWakeLock() {
  if (!wakeLockSupported) return () => {}

  const handleVisibilityChange = async () => {
    if (document.visibilityState === 'visible' && wakeLock === null) {
      console.log('[WakeLock] Page became visible, re-acquiring wake lock')
      await requestWakeLock()
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)

  // Return cleanup function
  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}
