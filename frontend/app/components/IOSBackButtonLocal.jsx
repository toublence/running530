'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

/**
 * Local iOS back button for exercise components
 * Shows only on setup UI (when sessionActive is false)
 */
export default function IOSBackButtonLocal({ show = true }) {
  const router = useRouter()
  const [isIOS, setIsIOS] = useState(false)

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
  if (!isIOS || !show) {
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
