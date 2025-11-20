'use client'

import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'


export default function Header() {
  const router = useRouter()
  const isNativeApp = (() => {
    try {
      if (typeof window === 'undefined') return false
      const Cap = window?.Capacitor
      if (!Cap) return false
      const platform = typeof Cap.getPlatform === 'function' ? Cap.getPlatform() : (Cap.platform || 'web')
      return platform !== 'web'
    } catch { return false }
  })()
  if (isNativeApp) return null


  const handleLogoClick = () => {
    router.push('/')
  }

  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-6 border-b border-white/20 backdrop-blur-sm bg-white/80"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <button
          onClick={handleLogoClick}
          className="flex items-center space-x-3 hover:opacity-80 transition-opacity"
        >
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            Running 530
          </h1>
        </button>
      </div>
    </motion.header>
  )
}
