'use client'

import { formatDistanceLabel } from '../utils/distance'

export default function RunningSummaryOverlay({
  isVisible,
  modeTitle,
  language = 'en',
  stats,
  meta,
  routePoints,
  extraContent = null,
  onClose,
}) {
  if (!isVisible || !stats) return null

  const completedLabel = language === 'ko' ? '러닝 완료!' : 'Run Complete!'
  const hasRoute = Array.isArray(routePoints) && routePoints.length > 1
  const summaryStats = { ...(stats || {}) }

  if (!summaryStats.totalDistance && Number.isFinite(meta?.distanceM)) {
    summaryStats.totalDistance = {
      value: formatDistanceLabel(meta.distanceM, 2),
      label: language === 'ko' ? '거리' : 'Distance',
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-950">
      <div
        className="flex h-full flex-col px-4"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
        }}
      >
        <div className="mx-auto flex w-full max-w-xl h-full flex-col">
          {/* Content area - Scrollable */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 mb-4 scrollbar-hide">
            {/* Route Preview */}
            <div className="relative overflow-hidden rounded-3xl border-2 border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-cyan-500/10 shadow-xl shadow-emerald-500/20">
              {hasRoute ? (
                <RunningRoutePreview points={routePoints} />
              ) : (
                <div className="flex h-40 items-center justify-center px-4 py-6 text-center text-xs text-white/60">
                  {language === 'ko'
                    ? '경로를 표시할 만큼 GPS 데이터가 충분하지 않습니다.'
                    : 'Not enough GPS points were recorded to draw the route.'}
                </div>
              )}
            </div>

            {/* Stats Grid with enhanced design */}
            <div className="grid grid-cols-2 gap-3">
              {summaryStats && Object.entries(summaryStats).map(([key, value]) => {
                // Determine gradient based on stat type
                const isDistance = key.toLowerCase().includes('distance')
                const isTime = key.toLowerCase().includes('time')
                const isPace = key.toLowerCase().includes('pace')

                let gradientClass = 'from-emerald-500/20 to-blue-500/10 border-emerald-400/30'
                let glowClass = 'group-hover:shadow-emerald-500/30'

                if (isTime) {
                  gradientClass = 'from-cyan-500/20 to-blue-500/10 border-cyan-400/30'
                  glowClass = 'group-hover:shadow-cyan-500/30'
                } else if (isPace) {
                  gradientClass = 'from-blue-500/20 to-emerald-500/10 border-blue-400/30'
                  glowClass = 'group-hover:shadow-blue-500/30'
                }

                return (
                  <div
                    key={key}
                    className={`group rounded-2xl border-2 bg-gradient-to-br ${gradientClass} p-4 text-center shadow-lg backdrop-blur-sm transition-all duration-200 hover:scale-105 ${glowClass}`}
                  >
                    <p className="text-[0.65rem] uppercase tracking-[0.25em] text-white/70 font-bold mb-2">
                      {value.label}
                    </p>
                    <p className="text-2xl font-black text-white">{value.value}</p>
                  </div>
                )
              })}
            </div>

            {/* Meta details */}
            {meta && (
              <MetaDetails meta={meta} language={language} modeTitle={modeTitle} />
            )}

            {/* Extra Content */}
            {extraContent && (
              <div className="rounded-2xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 p-4 text-sm backdrop-blur-sm">
                {extraContent}
              </div>
            )}
          </div>

          {/* Confirmation Button - Fixed at bottom, never scrolls */}
          {onClose && (
            <button
              onClick={onClose}
              className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-blue-500 py-4 text-base font-bold text-white shadow-lg shadow-emerald-500/30 transition-all duration-200 hover:scale-[1.02] hover:shadow-xl hover:shadow-emerald-500/40 active:scale-[0.98] flex-shrink-0"
            >
              {language === 'ko' ? '확인' : 'OK'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function RunningRoutePreview({ points }) {
  if (!Array.isArray(points) || points.length < 2) {
    return null
  }

  const latitudes = points
    .map((p) => (typeof p.latitude === 'number' ? p.latitude : p.lat))
    .filter((v) => Number.isFinite(v))
  const longitudes = points
    .map((p) => (typeof p.longitude === 'number' ? p.longitude : p.lng))
    .filter((v) => Number.isFinite(v))

  if (!latitudes.length || !longitudes.length) return null

  const minLat = Math.min(...latitudes)
  const maxLat = Math.max(...latitudes)
  const minLng = Math.min(...longitudes)
  const maxLng = Math.max(...longitudes)

  const spanLat = maxLat - minLat || 1
  const spanLng = maxLng - minLng || 1

  const padding = 12
  const width = 300 - padding * 2
  const height = 180 - padding * 2

  const normalizedPoints = points
    .map((p) => {
      const lat = typeof p.latitude === 'number' ? p.latitude : p.lat
      const lng = typeof p.longitude === 'number' ? p.longitude : p.lng
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      const x = padding + ((lng - minLng) / spanLng) * width
      const y = padding + ((maxLat - lat) / spanLat) * height
      return { x, y }
    })
    .filter(Boolean)

  if (normalizedPoints.length < 2) return null

  const pathD = normalizedPoints.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
  const start = normalizedPoints[0]
  const end = normalizedPoints[normalizedPoints.length - 1]

  return (
    <svg viewBox="0 0 300 180" className="h-40 w-full">
      <defs>
        <linearGradient id="routeBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>
        <linearGradient id="routeLine" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="300" height="180" fill="url(#routeBg)" />
      <g strokeWidth="0.5" stroke="rgba(148,163,184,0.25)">
        <line x1="0" y1="60" x2="300" y2="60" />
        <line x1="0" y1="120" x2="300" y2="120" />
        <line x1="75" y1="0" x2="75" y2="180" />
        <line x1="150" y1="0" x2="150" y2="180" />
        <line x1="225" y1="0" x2="225" y2="180" />
      </g>
      <polyline
        points={pathD}
        fill="none"
        stroke="url(#routeLine)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={start.x} cy={start.y} r="5" fill="#22c55e" stroke="#bbf7d0" strokeWidth="2" />
      <circle cx={end.x} cy={end.y} r="5" fill="#38bdf8" stroke="#e0f2fe" strokeWidth="2" />
    </svg>
  )
}

function MetaDetails({ meta, language, modeTitle }) {
  const formatClock = (ms) => {
    if (!Number.isFinite(ms)) return '--:--'
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const hh = hours ? `${String(hours).padStart(2, '0')}:` : ''
    return `${hh}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  const formatDistance = (m) => {
    if (!Number.isFinite(m)) return '-- km'
    return `${(m / 1000).toFixed(2)} km`
  }

  const formatPace = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '--:-- /km'
    const totalSeconds = Math.round(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')} /km`
  }

  const goalLabel = (() => {
    if (!meta.goal) return language === 'ko' ? '설정 안 함' : 'No goal'
    if (meta.goal.type === 'distance') {
      return language === 'ko'
        ? `${(meta.goal.value / 1000).toFixed(1)}km`
        : `${(meta.goal.value / 1000).toFixed(1)} km`
    }
    return language === 'ko'
      ? `${formatClock(meta.goal.value)}`
      : `${formatClock(meta.goal.value)}`
  })()

  const timeCueLabel = meta.timeCueMs
    ? `${Math.round(meta.timeCueMs / 60000)}${language === 'ko' ? '분' : 'm'}`
    : language === 'ko'
      ? '끄기'
      : 'Off'
  const paceGuideLabel = meta.targetPaceMs ? formatPace(meta.targetPaceMs) : (language === 'ko' ? '끄기' : 'Off')
  const startedAtLabel = meta.startedAt ? new Date(meta.startedAt).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US') : '--'
  const lapVoiceLabel = meta.voiceEnabled
    ? `${language === 'ko' ? 'TTS 켜짐 · 랩' : 'TTS on · lap'} ${formatDistance(meta.lapDistanceM || 0)}`
    : language === 'ko' ? 'TTS 꺼짐' : 'TTS off'
  const ghostResult = meta.ghostResult
  const ghostTarget = meta.ghostTarget
  const ghostTargetLabel = ghostTarget?.distanceM
    ? `${formatDistance(ghostTarget.distanceM)}${ghostTarget.durationMs ? ` · ${formatClock(ghostTarget.durationMs, { showHours: ghostTarget.durationMs >= 3600000 })}` : ''}`
    : ''
  const ghostDiffLabel = ghostResult && Number.isFinite(ghostResult.diffSeconds)
    ? `${ghostResult.diffSeconds > 0 ? '+' : ''}${formatClock(Math.abs(ghostResult.diffSeconds) * 1000)}`
    : ''
  const ghostOutcomeLabel = ghostResult
    ? ghostResult.success
      ? (language === 'ko' ? '도전 성공' : 'Ghost success')
      : (language === 'ko' ? '도전 실패' : 'Ghost miss')
    : ''

  const items = [
    { label: language === 'ko' ? '시작 시간' : 'Started', value: startedAtLabel },
    { label: language === 'ko' ? '목표' : 'Goal', value: goalLabel },
    { label: language === 'ko' ? '랩 거리' : 'Lap distance', value: formatDistance(meta.lapDistanceM || 0) },
    { label: language === 'ko' ? '시간 음성' : 'Time voice', value: timeCueLabel },
    { label: language === 'ko' ? '페이스 가이드' : 'Pace guide', value: paceGuideLabel },
  ]

  return (
    <div className="rounded-2xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 p-4 text-sm backdrop-blur-sm space-y-3">
      <p className="text-xs uppercase tracking-[0.3em] text-white/60 font-bold">
        {language === 'ko' ? '세부 정보' : 'Details'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-white/10 bg-black/20 p-3"
          >
            <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">{item.label}</p>
            <p className="text-sm font-semibold text-white">{item.value}</p>
          </div>
        ))}
      </div>

      {ghostResult && (
        <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3">
          <p className="text-[0.65rem] uppercase tracking-wider text-white/70 mb-1 font-bold">
            {language === 'ko' ? '고스트 모드' : 'Ghost mode'}
          </p>
          {ghostTargetLabel ? (
            <p className="text-sm font-semibold text-white/90">
              {language === 'ko' ? '도전 대상: ' : 'Target: '}{ghostTargetLabel}
            </p>
          ) : null}
          <p className={`text-sm font-bold ${ghostResult.success ? 'text-emerald-200' : 'text-amber-200'}`}>
            {ghostOutcomeLabel}{ghostDiffLabel ? ` · ${ghostDiffLabel}` : ''}
          </p>
        </div>
      )}
    </div>
  )
}
