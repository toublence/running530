'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import Image from 'next/image'
import Header from '../components/Header'
import IOSBackButtonLocal from '../components/IOSBackButtonLocal'
import RunningSession from './RunningSession'
import useSafeAreaTop from '../hooks/useSafeAreaTop'
import { ScreenOrientation } from '@capacitor/screen-orientation'
import { MODE_LABELS } from './locale'

const MODE_ITEMS = [
  {
    key: 'run',
    icon: '/icons/running/running.png',
  },
  {
    key: 'walk',
    icon: '/icons/running/walking.png',
  },
]

function ModeIllustration({ icon, label }) {
  if (!icon) return null
  return (
    <Image
      src={icon}
      alt={label}
      width={200}
      height={200}
      className="h-full w-full object-contain"
    />
  )
}

export default function RunningPage() {
  const router = useRouter()
  const search = useSearchParams()
  const selected = search.get('mode') || ''
  const mode = useMemo(
    () => MODE_ITEMS.find((item) => item.key === selected)?.key || '',
    [selected]
  )
  const modeCards = MODE_ITEMS.map((item) => ({
    ...item,
    label: MODE_LABELS[item.key]?.en || item.key,
  }))

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

  const handleSelect = (key) => {
    router.push(`/running/?mode=${encodeURIComponent(key)}`)
  }

  useEffect(() => {
    if (mode) return undefined
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
  }, [mode])

  const safeAreaTop = useSafeAreaTop()
  const safeAreaInsetTop = Math.max(0, safeAreaTop || 0)

  const nativeExtraTop = mode ? 8 : 24
  const nativeTopPadding = safeAreaInsetTop + nativeExtraTop

  const mainPaddingClass = mode
    ? isNativeApp
      ? ''
      : 'pt-8 sm:pt-10'
    : isNativeApp
      ? ''
      : 'pt-16 sm:pt-20'

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
        {mode ? (
          <div className="mx-auto max-w-5xl">
            <RunningSession mode={mode} />
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-12">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 }}
              className="flex flex-col items-center gap-4 text-center"
            >
              <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-5 py-2 text-[0.70rem] uppercase tracking-[0.28em] text-white/75 backdrop-blur-md">
              <Sparkles className="h-3.5 w-3.5" />
              Running 530
            </div>
            <div className="flex gap-3">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-300/80" />
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300/80" />
                <span className="h-1.5 w-1.5 rounded-full bg-sky-300/80" />
              </div>
            </motion.div>

            <div className="grid w-full grid-cols-2 gap-6">
              {modeCards.map((item, idx) => (
                <motion.button
                  key={item.key}
                  onClick={() => handleSelect(item.key)}
                  whileHover={{ y: -6, scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 20, delay: idx * 0.02 }}
                  className="group relative flex h-48 items-center justify-center overflow-hidden rounded-[28px] p-1"
                >
                  <div className="relative z-10 flex h-full w-full items-center justify-center">
                    <ModeIllustration icon={item.icon} label={item.label} />
                  </div>
                </motion.button>
              ))}
            </div>
          </div>
        )}
      </main>

      <IOSBackButtonLocal show={!mode} />

      {/* Language selector - only show on menu */}
      {!mode && (
        <div className="relative z-10 mt-8 mb-20 flex justify-center">
          <div ref={langMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-full bg-black/40 px-4 py-2 text-xs font-semibold text-slate-100 backdrop-blur ring-1 ring-white/10"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-sky-300"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span>{lang === 'ko' ? 'Koren' : 'English'}</span>
            </button>

            {langOpen && (
              <div className="absolute bottom-full mb-2 left-0 right-0 rounded-xl bg-black/80 text-xs text-slate-100 shadow-lg ring-1 ring-white/10">
                {[
                  { code: 'en', label: 'English' },
                  { code: 'ko', label: 'Koren' },
                ].map((opt) => (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => handleLanguageChange(opt.code)}
                    className={`w-full px-4 py-2 text-left transition-colors ${
                      lang === opt.code ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
