"use client"

import { useMemo } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

export default function SafeAreaBottomInset(){
  const pathname = usePathname()
  const search = useSearchParams()
  const exercise = search?.get?.('exercise')

  const isNativeApp = useMemo(() => {
    try {
      if (typeof window === 'undefined') return false
      const Cap = window?.Capacitor
      if (!Cap) return false
      const platform = typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : (Cap.platform || 'web')
      return platform !== 'web'
    } catch {
      return false
    }
  }, [])

  const shouldReserve = useMemo(() => {
    if (!pathname) return false
    if (!isNativeApp) return false

    const inRealtime = pathname === '/realtime-mediapipe' || pathname.startsWith('/realtime-mediapipe/')
    const needsCamera = inRealtime ? !!exercise : (
      pathname === '/boxing' || pathname.startsWith('/boxing/') ||
      pathname === '/mittrealtime' || pathname.startsWith('/mittrealtime/') ||
      pathname === '/newmittrealtime' || pathname.startsWith('/newmittrealtime/')
    )

    if (needsCamera) return false

    const isHome = pathname === '/'
    const isBoxingMenu = pathname === '/boxing-menu' || pathname.startsWith('/boxing-menu/')
    const isRealtimeMenu = pathname === '/realtime-mediapipe'

    // Avoid adding extra bottom space on full-screen pages to prevent scrollbars
    if (isHome || isBoxingMenu) return false

    return isRealtimeMenu
  }, [pathname, exercise, isNativeApp])

  if (!shouldReserve) return null

  return (
    <div aria-hidden className="shrink-0" style={{ height: 'calc(env(safe-area-inset-bottom) + 24px)' }} />
  )
}

