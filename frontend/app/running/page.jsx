'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import Header from '../components/Header'
import RunningSession from './RunningSession'
import useSafeAreaTop from '../hooks/useSafeAreaTop'
import { ScreenOrientation } from '@capacitor/screen-orientation'

export default function RunningPage() {
  const mode = 'run' // Fixed to running mode only

  const [lang, setLang] = useState('en')
  const [langOpen, setLangOpen] = useState(false)
  const langMenuRef = useRef(null)

  // Load language from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = localStorage.getItem('locale')
    if (saved === 'en' || saved === 'ko') {
      setLang(saved)
    } else {
      localStorage.setItem('locale', 'en')
      setLang('en')
    }
  }, [])

  // Close language dropdown when clicking outside
  useEffect(() => {
    if (!langOpen) return
    if (typeof document === 'undefined') return

    const handleClickOutside = (event) => {
      if (!langMenuRef.current) return
      if (!langMenuRef.current.contains(event.target)) {
        setLangOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [langOpen])

  const handleLanguageChange = (code) => {
    setLang(code)
    if (typeof window !== 'undefined') {
      localStorage.setItem('locale', code)
    }
    setLangOpen(false)
  }

  const isNativeApp = (() => {
    try {
      if (typeof window === 'undefined') return false
      const Cap = window?.Capacitor
      if (!Cap) return false
      const platform =
        typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : Cap.platform || 'web'
      return platform !== 'web'
    } catch {
      return false
    }
  })()

  useEffect(() => {
    const lockOrientation = async () => {
      try {
        await ScreenOrientation.lock({ orientation: 'portrait' })
      } catch (error) {
        console.log('[ScreenOrientation] lock portrait error:', error)
      }
    }
    lockOrientation()
    return () => {
      ScreenOrientation.unlock().catch(() => {})
    }
  }, [])

  const safeAreaTop = useSafeAreaTop()
  const safeAreaInsetTop = Math.max(0, safeAreaTop || 0)

  const nativeExtraTop = 8
  const nativeTopPadding = safeAreaInsetTop + nativeExtraTop

  const mainPaddingClass = isNativeApp ? '' : 'pt-8 sm:pt-10'
  const mainStyle = isNativeApp ? { paddingTop: nativeTopPadding } : undefined

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.18),_transparent_60%)]" />
        <div className="absolute -left-24 top-24 h-72 w-72 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute -right-32 bottom-10 h-80 w-80 rounded-full bg-blue-400/20 blur-[140px]" />
      </div>
      <Header />
      <main
        className={`relative z-10 flex-1 px-6 pb-16 ${mainPaddingClass}`}
        style={mainStyle}
      >
        <div className="mx-auto max-w-5xl">
          <RunningSession mode={mode} />
        </div>
      </main>
    </div>
  )
}
