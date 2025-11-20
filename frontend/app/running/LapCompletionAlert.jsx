'use client'

import { useEffect, useState } from 'react'
import { formatClock, formatPaceLabel } from '../utils/distance'

export default function LapCompletionAlert({
  isVisible,
  lapNumber,
  lapDurationMs,
  lapPaceMs,
  avgPaceMs = null,
  language = 'en',
  onDismiss,
  autoDismissMs = 3000,
}) {
  const [isAnimating, setIsAnimating] = useState(false)

  useEffect(() => {
    if (isVisible) {
      setIsAnimating(true)

      // Auto-dismiss after specified time
      if (autoDismissMs > 0) {
        const timer = setTimeout(() => {
          handleDismiss()
        }, autoDismissMs)

        return () => clearTimeout(timer)
      }
    } else {
      setIsAnimating(false)
    }
  }, [isVisible, autoDismissMs])

  const handleDismiss = () => {
    setIsAnimating(false)
    setTimeout(() => {
      onDismiss?.()
    }, 200)
  }

  if (!isVisible) return null

  const title = language === 'ko' ? `${lapNumber}km 완료!` : `${lapNumber}km Complete!`
  const timeLabel = language === 'ko' ? '시간' : 'Time'
  const paceLabel = language === 'ko' ? '페이스' : 'Pace'
  const avgLabel = language === 'ko' ? '평균 페이스' : 'Avg Pace'
  const continueLabel = language === 'ko' ? '계속하기' : 'Continue'

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
        isAnimating ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleDismiss}
    >
      <div
        className={`relative rounded-3xl border-2 border-emerald-400/80 bg-gradient-to-br from-emerald-500/30 via-blue-500/20 to-cyan-500/30 p-8 shadow-2xl shadow-emerald-500/50 max-w-sm w-full transition-all duration-300 ${
          isAnimating ? 'scale-100 translate-y-0' : 'scale-90 translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow effect */}
        <div className="absolute -inset-1 bg-gradient-to-r from-emerald-400/30 via-blue-500/30 to-cyan-500/30 blur-2xl -z-10 animate-pulse"></div>

        {/* Celebration icon */}
        <div className="text-center mb-6">
          <div className="text-6xl animate-bounce inline-block">🎉</div>
        </div>

        {/* Lap info */}
        <div className="text-center text-white space-y-4">
          <h3 className="text-3xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white via-emerald-200 to-cyan-200">
            {title}
          </h3>

          <div className="grid grid-cols-2 gap-3">
            {/* Time */}
            <div className="rounded-xl bg-black/30 p-4 backdrop-blur-sm border border-white/10">
              <p className="text-xs text-white/60 uppercase tracking-wider mb-2 font-bold">{timeLabel}</p>
              <p className="text-2xl font-black text-emerald-300 tabular-nums">{formatClock(lapDurationMs)}</p>
            </div>

            {/* Lap Pace */}
            <div className="rounded-xl bg-black/30 p-4 backdrop-blur-sm border border-white/10">
              <p className="text-xs text-white/60 uppercase tracking-wider mb-2 font-bold">{paceLabel}</p>
              <p className="text-2xl font-black text-cyan-300 tabular-nums">{formatPaceLabel(lapPaceMs)}</p>
            </div>
          </div>

          {/* Average Pace (if provided) */}
          {avgPaceMs && (
            <div className="rounded-xl bg-gradient-to-r from-white/5 to-white/10 p-3 backdrop-blur-sm border border-white/15">
              <p className="text-xs text-white/60 uppercase tracking-wider mb-1 font-bold">{avgLabel}</p>
              <p className="text-xl font-black text-emerald-200 tabular-nums">{formatPaceLabel(avgPaceMs)}</p>
            </div>
          )}
        </div>

        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          className="mt-6 w-full rounded-2xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 px-6 py-4 font-black text-black text-lg shadow-xl transition-all duration-200 active:scale-95 hover:shadow-2xl hover:shadow-emerald-500/50"
        >
          {continueLabel}
        </button>

        {/* Auto-dismiss progress indicator */}
        {autoDismissMs > 0 && (
          <div className="mt-3 h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-all"
              style={{
                width: '100%',
                animation: `shrink ${autoDismissMs}ms linear`,
              }}
            ></div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes shrink {
          from {
            width: 100%;
          }
          to {
            width: 0%;
          }
        }
      `}</style>
    </div>
  )
}
