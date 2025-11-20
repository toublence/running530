"use client"

import { useEffect } from "react"
import { usePathname, useSearchParams } from "next/navigation"

// Pages that actually require camera (prefix match)
const CAMERA_PREFIXES = [
  "/realtime-mediapipe",
  "/boxing",
  "/mittrealtime",
  "/newmittrealtime",
]

function needsCamera(pathname, exercise) {
  if (!pathname) return false
  // Realtime page needs camera only when a mode is selected via ?exercise=...
  if (pathname === "/realtime-mediapipe" || pathname.startsWith("/realtime-mediapipe/")) {
    return !!exercise
  }
  // Boxing always needs camera when within its route; MittRealtime route needs camera always
  return (
    pathname === "/boxing" || pathname.startsWith("/boxing/") ||
    pathname === "/mittrealtime" || pathname.startsWith("/mittrealtime/") ||
    pathname === "/newmittrealtime" || pathname.startsWith("/newmittrealtime/")
  )
}

export default function CameraCleanup() {
  const pathname = usePathname()
  const search = useSearchParams()
  const exercise = search?.get?.('exercise')

  const stopAll = () => {
    try {
      const w = window
      // Stop globally tracked streams
      const set = w.__activeCameraStreams
      if (set && set.size) {
        for (const s of Array.from(set)) {
          try { s.getTracks?.().forEach(t => t.stop()) } catch {}
          try { set.delete(s) } catch {}
        }
      }
      // Stop streams bound to <video>
      const videos = Array.from(document.querySelectorAll('video'))
      for (const v of videos) {
        const stream = v && v.srcObject
        if (stream && typeof stream.getTracks === 'function') {
          try { stream.getTracks().forEach(t => t.stop()) } catch {}
        }
        try { v.pause && v.pause() } catch {}
        try { v.srcObject = null } catch {}
      }
    } catch {}
  }

  // 1) Patch getUserMedia once to register streams globally
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window
    if (!navigator?.mediaDevices?.getUserMedia) return
    if (w.__augPatchedGetUserMedia) return

    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    w.__activeCameraStreams = w.__activeCameraStreams || new Set()

    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await origGetUserMedia(...args)
      try {
        w.__activeCameraStreams.add(stream)
        const onEnded = () => {
          try {
            const allEnded = stream.getTracks().every(t => t.readyState === 'ended')
            if (allEnded) w.__activeCameraStreams.delete(stream)
          } catch {}
        }
        stream.getTracks().forEach(t => {
          try { t.addEventListener && t.addEventListener('ended', onEnded) } catch {}
        })
      } catch {}
      return stream
    }
    w.__augPatchedGetUserMedia = true
  }, [])

  // 2) On route change: if current page does NOT need camera, stop all known streams and any attached <video>
  useEffect(() => {
    if (typeof window === 'undefined') return

    if (!needsCamera(pathname, exercise)) {
      stopAll()
      // call a bit later as well to catch late-attach streams
      setTimeout(stopAll, 200)
      setTimeout(stopAll, 800)
    }
  }, [pathname, exercise])

  // 3) Also stop when tab is hidden or page is being unloaded
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onVis = () => { if (document.visibilityState !== 'visible' && !needsCamera(pathname, exercise)) stopAll() }
    const onHide = () => { if (!needsCamera(pathname, exercise)) stopAll() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onHide)
    }
  }, [pathname, exercise])

  // 4) Watch for new <video> nodes and stop if not allowed
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (needsCamera(pathname, exercise)) return
    const mo = new MutationObserver(() => { stopAll() })
    mo.observe(document.documentElement, { subtree: true, childList: true })
    return () => mo.disconnect()
  }, [pathname, exercise])

  return null
}

