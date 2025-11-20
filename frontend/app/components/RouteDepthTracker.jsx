"use client"

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

export default function RouteDepthTracker(){
  const pathname = usePathname()
  const prevRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof window.__routeDepth !== 'number') window.__routeDepth = 0

    // Attach popstate once on first mount
    const onPop = () => {
      try { window.__routeDepth = Math.max(0, (window.__routeDepth || 0) - 1) } catch {}
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (prevRef.current == null) { prevRef.current = pathname; return }
    if (pathname !== prevRef.current) {
      try { window.__routeDepth = (window.__routeDepth || 0) + 1 } catch {}
      prevRef.current = pathname
    }
  }, [pathname])

  return null
}

