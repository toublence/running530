"use client"

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'

export default function BackButtonGuard() {
  const pathname = usePathname()
  const router = useRouter()
  const pathRef = useRef(pathname)
  const listenerRef = useRef(null)

  useEffect(() => {
    pathRef.current = pathname
  }, [pathname])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const Cap = window?.Capacitor
    const platform = Cap && (typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : (Cap.platform || 'web'))
    if (!Cap || platform === 'web') return

    const App = Cap?.Plugins?.App || Cap?.App
    if (!App || typeof App.addListener !== 'function') return

    if (listenerRef.current) return

    const isHome = (p) => !p || p === '/'

    const remove = (sub) => {
      if (!sub) return
      try {
        if (typeof sub.then === 'function') {
          sub.then((resolved) => resolved?.remove?.()).catch(() => {})
        } else {
          sub.remove?.()
        }
      } catch {}
    }

    const handler = (event) => {
      try {
        const isLocked = (typeof window !== 'undefined') && !!window.__MOTIONFIT_SCREEN_LOCK_ACTIVE__
        if (isLocked) {
          event?.preventDefault?.()
          return
        }

        const currentPath = pathRef.current
        const canGoBack = typeof event?.canGoBack === 'boolean' ? event.canGoBack : undefined

        if (!isHome(currentPath) && canGoBack !== false) {
          event?.preventDefault?.()
          router.back()
          return
        }

        event?.preventDefault?.()
        if (App.minimizeApp) {
          App.minimizeApp()
        } else if (App.exitApp) {
          App.exitApp()
        }
      } catch (err) {
        try { console.warn('[BackButtonGuard] back handler failed', err) } catch {}
      }
    }

    const subscription = App.addListener('backButton', handler)
    listenerRef.current = subscription

    return () => {
      remove(listenerRef.current)
      listenerRef.current = null
    }
  }, [router])

  return null
}
