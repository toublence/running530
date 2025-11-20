'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

export default function IOSBackButton() {
  const router = useRouter()
  const pathname = usePathname()
  const [isIOS, setIsIOS] = useState(false)
  const [shouldShow, setShouldShow] = useState(false)

  // Detect iOS platform
  useEffect(() => {
    const detectIOS = () => {
      try {
        const Cap = window.Capacitor
        const platform = Cap?.getPlatform?.() || Cap?.platform
        return platform === 'ios'
      } catch {
        return false
      }
    }

    setIsIOS(detectIOS())
  }, [])

  // Determine if back button should be shown based on current route
  useEffect(() => {
    // Normalize path to avoid trailing-slash mismatches
    const path = (pathname && pathname !== '/' && pathname.endsWith('/')) ? pathname.slice(0, -1) : pathname

    // Don't show on home page
    if (path === '/') {
      setShouldShow(false)
      return
    }

    // Show on menu pages (boxing-menu)
    if (path === '/boxing-menu') {
      setShouldShow(true)
      return
    }

    // If on realtime-mediapipe, hide global button (local button handles it)
    if (path === '/realtime-mediapipe') {
      setShouldShow(false)
      return
    }

    // Show on DailyCombo (no Stop button, just displays combo)
    if (path === '/dailycombo') {
      setShouldShow(true)
      return
    }

    // Hide on exercise/activity pages - they have their own local back buttons
    const hideOnPages = [
      '/boxingtimer',
      '/shadow',
      '/mittrealtime',
      '/newmittrealtime',
      '/running',
    ]

    // Hide on specific activity pages (they manage their own back buttons)
    if (hideOnPages.some(page => path?.startsWith(page))) {
      setShouldShow(false)
      return
    }

    // Show on all other pages (but not shown above anyway due to menu-only logic)
    setShouldShow(true)
  }, [pathname])

  // Listen for URL changes to keep realtime-mediapipe hidden consistently
  useEffect(() => {
    const handleUrlChange = () => {
      if (typeof window === 'undefined') return
      const path = (pathname && pathname !== '/' && pathname.endsWith('/')) ? pathname.slice(0, -1) : pathname
      if (path === '/realtime-mediapipe') {
        setShouldShow(false)
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', handleUrlChange)
      window.addEventListener('pushstate', handleUrlChange)

      // Also listen for hash changes and manual navigation
      const originalPushState = window.history.pushState
      const originalReplaceState = window.history.replaceState

      window.history.pushState = function(...args) {
        originalPushState.apply(this, args)
        handleUrlChange()
      }

      window.history.replaceState = function(...args) {
        originalReplaceState.apply(this, args)
        handleUrlChange()
      }

      return () => {
        window.removeEventListener('popstate', handleUrlChange)
        window.removeEventListener('pushstate', handleUrlChange)
        window.history.pushState = originalPushState
        window.history.replaceState = originalReplaceState
      }
    }
  }, [pathname])

  // Handle back button click
  const handleBack = () => {
    try {
      // Try to go back in history
      if (window.history.length > 1) {
        router.back()
      } else {
        // If no history, go to home
        router.push('/')
      }
    } catch (error) {
      console.error('Navigation error:', error)
      router.push('/')
    }
  }

  // Don't render if not iOS or shouldn't show
  if (!isIOS || !shouldShow) {
    return null
  }

  return (
    <AnimatePresence>
      <motion.button
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 20 }}
        transition={{ duration: 0.2 }}
        onClick={handleBack}
        className="fixed bottom-6 right-6 z-50 flex h-10 w-10 items-center justify-center bg-black/40 backdrop-blur-sm hover:bg-black/50 active:scale-95 transition-all rounded-lg"
        aria-label="Go back"
      >
        <ChevronLeft className="h-8 w-8 text-white/70 drop-shadow-md" strokeWidth={3} />
      </motion.button>
    </AnimatePresence>
  )
}
