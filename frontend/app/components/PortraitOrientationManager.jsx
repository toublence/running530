'use client'

import { useEffect, useMemo, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ScreenOrientation } from '@capacitor/screen-orientation'

const resolveNativePlatform = () => {
  try {
    const Cap = window?.Capacitor
    if (!Cap) return 'web'
    const platform = typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : Cap.platform
    if (platform === 'ios' || platform === 'android') return platform
    return 'web'
  } catch {
    return 'web'
  }
}

const shouldForcePortrait = (pathname, exercise) => {
  if (!pathname) return false
  if (pathname === '/') return true
  if (pathname === '/boxing-menu' || pathname.startsWith('/boxing-menu/')) return true
  if (pathname === '/realtime-mediapipe' && !exercise) return true
  return false
}

export default function PortraitOrientationManager() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const exercise = searchParams?.get?.('exercise') || ''
  const needsPortrait = useMemo(() => shouldForcePortrait(pathname, exercise), [pathname, exercise])
  const lastAppliedRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (resolveNativePlatform() === 'web') return
    if (lastAppliedRef.current === needsPortrait) return

    lastAppliedRef.current = needsPortrait

    const applyOrientation = async () => {
      try {
        if (needsPortrait) {
          await ScreenOrientation.lock({ orientation: 'portrait' })
        } else {
          await ScreenOrientation.unlock()
        }
      } catch (error) {
        console.log('[OrientationManager]', needsPortrait ? 'lock' : 'unlock', 'error:', error)
        lastAppliedRef.current = null
      }
    }

    applyOrientation()
  }, [needsPortrait])

  return null
}
