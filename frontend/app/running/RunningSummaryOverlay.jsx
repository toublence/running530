'use client'

import { useState } from 'react'
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

  const [helpKey, setHelpKey] = useState(null)

  const completedLabel = language === 'ko' ? '러닝 완료!' : 'Run Complete!'
  const hasRoute = Array.isArray(routePoints) && routePoints.length > 1
  const summaryStats = { ...(stats || {}) }
  const DEFAULT_WEIGHT_KG = 65
  const caloriesLabel = language === 'ko' ? '칼로리' : 'Calories'
  const elevationLabel = language === 'ko' ? '고도 상승' : 'Elevation Gain'
  const intensityLabel = language === 'ko' ? '강도' : 'Intensity'
  const goalProgressLabel = language === 'ko' ? '목표 달성률' : 'Goal Progress'
  const helpTexts = {
    ko: {
      totalTime: '운동한 총 시간입니다.',
      totalDistance: 'GPS로 기록된 전체 이동 거리입니다.',
      avgPace: '전체 구간 평균 페이스입니다.',
      current: '현재 시점 페이스입니다.',
      calories: '속도와 시간으로 추정한 칼로리 소모량입니다.',
      elevation: '오르막으로 얻은 고도 누적값입니다.',
      laps: '완료한 랩(구간) 수입니다.',
      goalProgress: '설정한 목표 대비 진행률입니다.',
      intensity: '속도 기반의 운동 강도입니다.',
    },
    en: {
      totalTime: 'Total elapsed workout time.',
      totalDistance: 'GPS-measured total distance.',
      avgPace: 'Average pace across the whole session.',
      current: 'Current pace at this moment.',
      calories: 'Estimated calories burned from speed and time.',
      elevation: 'Total elevation gain from uphill segments.',
      laps: 'Number of completed laps/segments.',
      goalProgress: 'Progress toward your selected goal.',
      intensity: 'Effort level inferred from speed.',
    },
  }

  const estimateCalories = (distanceM, durationMs) => {
    if (!Number.isFinite(distanceM) || !Number.isFinite(durationMs) || durationMs <= 0) return 0
    const speedKmh = (distanceM / 1000) / (durationMs / 3600000)
    if (!Number.isFinite(speedKmh) || speedKmh <= 0) return 0
    let met = 2.5
    if (speedKmh < 3) met = 2.0
    else if (speedKmh < 4.5) met = 2.8
    else if (speedKmh < 5.5) met = 3.5
    else met = 4.3
    const minutes = durationMs / 60000
    return met * 3.5 * DEFAULT_WEIGHT_KG / 200 * minutes
  }

  if (!summaryStats.totalDistance && Number.isFinite(meta?.distanceM)) {
    summaryStats.totalDistance = {
      value: formatDistanceLabel(meta.distanceM, 2),
      label: language === 'ko' ? '거리' : 'Distance',
    }
  }

  if (!summaryStats.calories) {
    const kcal = Number.isFinite(meta?.calories) ? meta.calories : estimateCalories(meta?.distanceM, meta?.durationMs)
    summaryStats.calories = {
      value: `${Math.max(0, kcal || 0).toFixed(0)} kcal`,
      label: caloriesLabel,
    }
  }

  if (!summaryStats.elevation && Number.isFinite(meta?.elevationGainM)) {
    summaryStats.elevation = {
      value: `${Math.max(0, meta.elevationGainM).toFixed(0)} m`,
      label: elevationLabel,
    }
  }

  if (!summaryStats.intensity && meta?.intensityLevel) {
    summaryStats.intensity = {
      value: meta.intensityLevel,
      label: intensityLabel,
    }
  }

  if (!summaryStats.goalProgress && Number.isFinite(meta?.goalProgress)) {
    summaryStats.goalProgress = {
      value: `${Math.max(0, meta.goalProgress).toFixed(0)}%`,
      label: goalProgressLabel,
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-950">
      <div
        className="flex h-full flex-col px-3"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        }}
      >
        <div className="mx-auto flex w-full max-w-xl h-full flex-col">
          {/* Content area - Scrollable */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 mb-3 scrollbar-hide">
            {/* Route Preview */}
            <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-cyan-500/10 shadow-lg">
              {hasRoute ? (
                <RunningRoutePreview points={routePoints} />
              ) : (
                <div className="flex h-28 items-center justify-center px-3 py-4 text-center text-[0.65rem] text-white/60">
                  {language === 'ko'
                    ? '경로를 표시할 만큼 GPS 데이터가 충분하지 않습니다.'
                    : 'Not enough GPS points were recorded to draw the route.'}
                </div>
              )}
            </div>

            {/* Stats Grid with enhanced design */}
            <div className="grid grid-cols-2 gap-1.5">
              {summaryStats && Object.entries(summaryStats).map(([key, value]) => {
                const isDistance = key.toLowerCase().includes('distance')
                const isTime = key.toLowerCase().includes('time')
                const isPace = key.toLowerCase().includes('pace')

                let gradientClass = 'from-emerald-500/20 to-blue-500/10 border-emerald-400/30'

                if (isTime) {
                  gradientClass = 'from-cyan-500/20 to-blue-500/10 border-cyan-400/30'
                } else if (isPace) {
                  gradientClass = 'from-blue-500/20 to-emerald-500/10 border-blue-400/30'
                }

                return (
                  <div
                    key={key}
                    className={`rounded-xl border bg-gradient-to-br ${gradientClass} px-2 py-1.5 text-center backdrop-blur-sm`}
                  >
                    <div className="flex items-center justify-center gap-1 mb-0.5">
                      <p className="text-[0.55rem] uppercase tracking-wider text-white/70 font-bold">
                        {value.label}
                      </p>
                      {helpTexts[language]?.[key] && (
                        <button
                          type="button"
                          onClick={() => setHelpKey((prev) => (prev === key ? null : key))}
                          className="h-3.5 w-3.5 rounded-full border border-white/30 text-[0.5rem] font-black text-white/80 leading-none flex items-center justify-center bg-white/10"
                        >
                          ?
                        </button>
                      )}
                    </div>
                    <p className="text-base font-black text-white">{value.value}</p>
                    {helpKey === key && helpTexts[language]?.[key] && (
                      <div className="mt-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[0.55rem] text-white/80">
                        {helpTexts[language][key]}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

	            {/* Weekly / Monthly running distance goals context (run mode only) */}
	            {meta?.mode === 'run' && (Number.isFinite(meta.runWeeklyTotalDistanceM) || Number.isFinite(meta.runMonthlyTotalDistanceM)) && (
	              <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/5 px-2 py-1.5 text-sm text-white/90">
	                <p className="text-[0.55rem] uppercase tracking-wider text-emerald-200 font-bold mb-1">
	                  {language === 'ko' ? '주간/월간 런닝 목표' : 'Weekly / Monthly running goals'}
	                </p>
	                <div className="grid grid-cols-2 gap-1.5">
	                  {Number.isFinite(meta.runWeeklyTotalDistanceM) && Number.isFinite(meta.runWeeklyTargetKm) && (
	                    <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1">
	                      <p className="text-[0.65rem] uppercase tracking-[0.18em] text-emerald-100 font-semibold">
	                        {language === 'ko' ? '이번 주' : 'This week'}
	                      </p>
	                      <p className="mt-1 text-sm font-bold">
	                        {`${(meta.runWeeklyTotalDistanceM / 1000).toFixed(1)} / ${meta.runWeeklyTargetKm.toFixed(0)} km`}
	                      </p>
	                      {Number.isFinite(meta.runWeeklyGoalProgress) && (
	                        <p className="text-[0.7rem] text-emerald-100/80">
	                          {`${Math.max(0, Math.round(meta.runWeeklyGoalProgress))}%`}
	                        </p>
	                      )}
	                    </div>
	                  )}
	                  {Number.isFinite(meta.runMonthlyTotalDistanceM) && Number.isFinite(meta.runMonthlyTargetKm) && (
	                    <div className="rounded-lg border border-sky-400/30 bg-sky-500/10 px-2 py-1">
	                      <p className="text-[0.65rem] uppercase tracking-[0.18em] text-sky-100 font-semibold">
	                        {language === 'ko' ? '이번 달' : 'This month'}
	                      </p>
	                      <p className="mt-1 text-sm font-bold">
	                        {`${(meta.runMonthlyTotalDistanceM / 1000).toFixed(1)} / ${meta.runMonthlyTargetKm.toFixed(0)} km`}
	                      </p>
	                      {Number.isFinite(meta.runMonthlyGoalProgress) && (
	                        <p className="text-[0.7rem] text-sky-100/80">
	                          {`${Math.max(0, Math.round(meta.runMonthlyGoalProgress))}%`}
	                        </p>
	                      )}
	                    </div>
	                  )}
	                </div>
	              </div>
	            )}

            {/* Meta details */}
            {meta && (
              <MetaDetails meta={meta} language={language} modeTitle={modeTitle} />
            )}

            {/* Extra Content */}
            {extraContent && (
              <div className="rounded-xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 px-2 py-1.5 text-sm backdrop-blur-sm">
                {extraContent}
              </div>
            )}
          </div>

          {/* Confirmation Button - Fixed at bottom, never scrolls */}
          {onClose && (
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-blue-500 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/30 transition-all duration-200 active:scale-[0.98] flex-shrink-0"
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
    <div className="rounded-xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 px-2 py-1.5 text-sm backdrop-blur-sm space-y-1.5">
      <p className="text-[0.55rem] uppercase tracking-wider text-white/60 font-bold">
        {language === 'ko' ? '세부 정보' : 'Details'}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-white/10 bg-black/20 px-2 py-1"
          >
            <p className="text-[0.5rem] uppercase tracking-wider text-white/60 font-bold">{item.label}</p>
            <p className="text-xs font-semibold text-white">{item.value}</p>
          </div>
        ))}
      </div>

      {ghostResult && (
        <div className="rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-2 py-1">
          <p className="text-[0.5rem] uppercase tracking-wider text-white/70 font-bold">
            {language === 'ko' ? '고스트 모드' : 'Ghost mode'}
          </p>
          {ghostTargetLabel ? (
            <p className="text-xs font-semibold text-white/90">
              {language === 'ko' ? '도전 대상: ' : 'Target: '}{ghostTargetLabel}
            </p>
          ) : null}
          <p className={`text-xs font-bold ${ghostResult.success ? 'text-emerald-200' : 'text-amber-200'}`}>
            {ghostOutcomeLabel}{ghostDiffLabel ? ` · ${ghostDiffLabel}` : ''}
          </p>
        </div>
      )}
    </div>
  )
}
