'use client'

import { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronUp, Minus } from 'lucide-react'
import { formatClock, formatDistanceLabel, formatPaceLabel } from '../utils/distance'
import { MODE_LABELS, SESSION_TEXT } from './locale'

const formatHistoryDate = (ts, language) => {
  if (!ts) return ''
  try {
    const formatter = new Intl.DateTimeFormat(language === 'ko' ? 'ko-KR' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    return formatter.format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
}

const formatGoalLabel = (goal, language) => {
  if (!goal) return ''
  if (goal.type === 'distance') {
    const dist = formatDistanceLabel(goal.value, 1)
    return language === 'ko' ? `${dist} 목표` : `${dist} goal`
  }
  const label = formatClock(goal.value, { showHours: goal.value >= 3600000 })
  return language === 'ko' ? `${label} 목표` : `${label} goal`
}

const formatSteps = (steps, language, withUnit = true) => {
  if (!Number.isFinite(steps)) return language === 'ko' ? '데이터 없음' : 'N/A'
  const value = Math.max(0, Math.round(steps)).toLocaleString()
  if (!withUnit) return value
  return language === 'ko' ? `${value} 걸음` : `${value} steps`
}

const formatCadence = (cadence, language) => {
  if (!Number.isFinite(cadence)) return language === 'ko' ? '데이터 없음' : 'N/A'
  return `${Math.round(cadence)} spm`
}

const formatStride = (stride, language) => {
  if (!Number.isFinite(stride)) return language === 'ko' ? '데이터 없음' : 'N/A'
  return `${stride.toFixed(2)} m`
}

const formatCalories = (kcal, language) => {
  if (!Number.isFinite(kcal)) return language === 'ko' ? '데이터 없음' : 'N/A'
  return `${Math.max(0, kcal).toFixed(0)} kcal`
}

const formatElevation = (gain, language) => {
  if (!Number.isFinite(gain)) return language === 'ko' ? '데이터 없음' : 'N/A'
  return `${Math.max(0, gain).toFixed(0)} m`
}

const formatGoalProgress = (progress, language) => {
  if (!Number.isFinite(progress)) return language === 'ko' ? '데이터 없음' : 'N/A'
  return `${Math.max(0, progress).toFixed(0)}%`
}

const RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT = 20
const RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT = 80
const RUN_GOALS_STORAGE_KEY = 'running_run_goals_v1'

const estimateCalories = (distanceM, durationMs, weightKg = 65) => {
  if (!Number.isFinite(distanceM) || !Number.isFinite(durationMs) || durationMs <= 0) return null
  const speedKmh = (distanceM / 1000) / (durationMs / 3600000)
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return null
  let met = 2.5
  if (speedKmh < 3) met = 2.0
  else if (speedKmh < 4.5) met = 2.8
  else if (speedKmh < 5.5) met = 3.5
  else met = 4.3
  const minutes = durationMs / 60000
  return met * 3.5 * weightKg / 200 * minutes
}

export default function RunningHistoryOverlay({
  isVisible,
  language = 'en',
  entries,
  onClose,
  onDeleteEntry,
  mode,
  onChallengeEntry,
  initialSortBy = 'recent',
  initialExpandedId = null,
}) {
  const [expandedId, setExpandedId] = useState(initialExpandedId || null)
  const [filterPeriod, setFilterPeriod] = useState('week') // 'week' | 'month' | 'all'
  const [sortBy, setSortBy] = useState(initialSortBy) // 'recent' | 'record'
  const [helpKey, setHelpKey] = useState(null)
	  const [runGoalConfig, setRunGoalConfig] = useState(null)

  // Update sortBy when initialSortBy changes
  useEffect(() => {
    setSortBy(initialSortBy)
  }, [initialSortBy])

  // Open a specific entry when provided
  useEffect(() => {
    if (initialExpandedId) {
      setExpandedId(initialExpandedId)
    }
  }, [initialExpandedId])

  // Reset when overlay closes
  useEffect(() => {
    if (!isVisible) {
      setExpandedId(null)
    }
  }, [isVisible])

	  // Load running weekly/monthly distance goals from localStorage (shared with RunningSession)
	  useEffect(() => {
	    if (typeof window === 'undefined') return
	    try {
	      const stored = window.localStorage.getItem(RUN_GOALS_STORAGE_KEY)
	      if (stored) {
	        const parsed = JSON.parse(stored)
	        setRunGoalConfig(parsed)
	      } else {
	        setRunGoalConfig({
	          weeklyDistanceKm: { active: true, target: RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT },
	          monthlyDistanceKm: { active: true, target: RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT },
	        })
	      }
	    } catch {
	      setRunGoalConfig({
	        weeklyDistanceKm: { active: true, target: RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT },
	        monthlyDistanceKm: { active: true, target: RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT },
	      })
	    }
	  }, [])

  const helpTexts = {
    ko: {
      distance: 'GPS로 기록된 전체 이동 거리입니다.',
      totalTime: '운동한 총 시간입니다.',
      avgPace: '전체 구간 평균 페이스입니다.',
      laps: '완료한 랩(구간) 수입니다.',
      steps: '세션 동안 기록된 총 걸음 수입니다.',
      calories: '속도와 시간으로 추정한 칼로리 소모량입니다.',
      cadence: '분당 걸음 수(spm)입니다.',
      stride: '걸음당 이동한 평균 거리입니다.',
      elevation: '오르막으로 얻은 고도 누적값입니다.',
      intensity: '속도 기반의 운동 강도입니다.',
      goalProgress: '설정한 목표 대비 진행률입니다.',
    },
    en: {
      distance: 'Total GPS-measured distance.',
      totalTime: 'Total elapsed workout time.',
      avgPace: 'Average pace across the session.',
      laps: 'Number of completed laps/segments.',
      steps: 'Total steps counted in this session.',
      calories: 'Estimated calories burned from speed and time.',
      cadence: 'Steps per minute (spm).',
      stride: 'Average distance per step.',
      elevation: 'Total elevation gain from uphill segments.',
      intensity: 'Effort level inferred from speed.',
      goalProgress: 'Progress toward your selected goal.',
    },
  }

  const renderLabel = (key, label) => (
    <div className="flex items-center justify-center gap-1">
      <span>{label}</span>
      {helpTexts[language]?.[key] && (
        <button
          type="button"
          onClick={() => setHelpKey((prev) => (prev === key ? null : key))}
          className="h-5 w-5 rounded-full border border-white/30 text-[0.65rem] font-black text-white/80 leading-none flex items-center justify-center bg-white/10"
        >
          ?
        </button>
      )}
    </div>
  )

  const handleSortChange = (newSort) => {
    setSortBy(newSort)
    setExpandedId(null) // Close expanded item when sort changes
  }

  const handleFilterChange = (newFilter) => {
    setFilterPeriod(newFilter)
    setExpandedId(null) // Close expanded item when filter changes
  }

  const text = SESSION_TEXT[language] || SESSION_TEXT.en
  const list = Array.isArray(entries) ? entries : []
  const modeLabel = mode && MODE_LABELS[mode]?.[language]
  const headerTitle = modeLabel
    ? language === 'ko'
      ? `${modeLabel} 히스토리`
      : `${modeLabel} History`
    : language === 'ko'
      ? '런닝 / 워킹 히스토리'
      : 'Running / Walking History'

  const handleToggle = (id) => {
    setExpandedId((current) => (current === id ? null : id))
  }

  const handleDelete = (id) => {
    if (onDeleteEntry) {
      onDeleteEntry(id)
    }
  }

  // Filter entries based on selected period
  const now = Date.now()
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
  const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000

  const filteredList = list.filter((entry) => {
    if (filterPeriod === 'all') return true
    const entryTime = entry.startedAt || entry.timestamp || 0
    if (filterPeriod === 'week') return entryTime >= oneWeekAgo
    if (filterPeriod === 'month') return entryTime >= oneMonthAgo
    return true
  })

  // Sort entries
  const sortedList = [...filteredList].sort((a, b) => {
    if (sortBy === 'record') {
      // Sort by average pace (faster is better, so ascending order)
      const paceA = Number(a.avgPaceMs) || Infinity
      const paceB = Number(b.avgPaceMs) || Infinity
      return paceA - paceB
    }
    // Default: sort by recent (descending timestamp)
    const timeA = a.startedAt || a.timestamp || 0
    const timeB = b.startedAt || b.timestamp || 0
    return timeB - timeA
  })

  // Group entries by date
  const groupedEntries = sortedList.reduce((groups, entry) => {
    const entryDate = new Date(entry.startedAt || entry.timestamp)
    const dateKey = entryDate.toLocaleDateString(language === 'ko' ? 'ko-KR' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    if (!groups[dateKey]) {
      groups[dateKey] = []
    }
    groups[dateKey].push(entry)
    return groups
  }, {})

  const distanceSeries = useMemo(() => {
    const series = sortedList
      .map((entry) => {
        const distanceKm = Number(entry?.distanceM) / 1000
        const ts = entry.startedAt || entry.timestamp || 0
        return {
          km: Number.isFinite(distanceKm) ? distanceKm : null,
          ts,
          dateLabel: formatHistoryDate(ts, language),
        }
      })
      .filter((item) => Number.isFinite(item.km) && item.km >= 0)
      .slice(0, 7)
      .reverse()
    return series
  }, [sortedList, language])

	  // Weekly / Monthly running distance summary for goals (run mode only)
	  const runDistanceGoalSummary = useMemo(() => {
	    if (mode !== 'run') return null
	    if (!Array.isArray(entries) || !entries.length) return null
	    const weeklyCfg = runGoalConfig?.weeklyDistanceKm
	    const monthlyCfg = runGoalConfig?.monthlyDistanceKm
	    const weeklyTargetKm = weeklyCfg?.target || RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT
	    const monthlyTargetKm = monthlyCfg?.target || RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT
	    const today = new Date()
	    const weekStart = new Date(today)
	    weekStart.setDate(today.getDate() - 6)
	    let weekTotalM = 0
	    let monthTotalM = 0
	    for (const entry of entries) {
	      if (!entry || entry.mode !== 'run') continue
	      const distM = Number(entry.distanceM)
	      if (!Number.isFinite(distM) || distM <= 0) continue
	      const ts = entry.startedAt || entry.timestamp
	      if (!ts) continue
	      const d = new Date(ts)
	      if (Number.isNaN(d.getTime()) || d > today) continue
	      if (d >= weekStart) weekTotalM += distM
	      if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) monthTotalM += distM
	    }
	    const weeklyTargetM = weeklyTargetKm > 0 ? weeklyTargetKm * 1000 : 0
	    const monthlyTargetM = monthlyTargetKm > 0 ? monthlyTargetKm * 1000 : 0
	    const toPct = (val, target) => {
	      if (!target) return null
	      const pct = (val / target) * 100
	      if (!Number.isFinite(pct)) return null
	      return Math.min(pct, 300)
	    }
	    return {
	      weekTotalM,
	      monthTotalM,
	      weekTargetKm: weeklyTargetKm,
	      monthTargetKm: monthlyTargetKm,
	      weekPct: toPct(weekTotalM, weeklyTargetM),
	      monthPct: toPct(monthTotalM, monthlyTargetM),
	    }
	  }, [mode, entries, runGoalConfig])

  const distanceSummary = useMemo(() => {
    if (!distanceSeries.length) return null
    const kms = distanceSeries.map((s) => s.km)
    const max = Math.max(...kms)
    const avg = kms.reduce((acc, v) => acc + v, 0) / kms.length
    const latest = kms[kms.length - 1]
    const prev = kms.length > 1 ? kms[kms.length - 2] : null
    const delta = prev != null ? latest - prev : null
    return { max, avg, latest, delta }
  }, [distanceSeries])

  const distanceBars = useMemo(() => {
    if (!distanceSeries.length) return { bars: [], yTicks: [] }
    const maxBars = 7
    const series = distanceSeries.slice(-maxBars)
    const maxKm = Math.max(...series.map((s) => s.km))
    const topTick = Math.max(0.5, Math.ceil((maxKm || 0.5) * 10) / 10)
    const ticks = [topTick, topTick * 0.66, topTick * 0.33]

    const leftMargin = 8
    const rightMargin = 8
    const bottomMargin = 18
    const topMargin = 8
    const graphWidth = 100 - leftMargin - rightMargin
    const graphHeight = 100 - topMargin - bottomMargin
    const baseY = 100 - bottomMargin
    const step = graphWidth / Math.max(series.length, 1)
    const barWidth = step * 0.075

    const formatAxisDate = (ts) => {
      if (!ts) return ''
      const d = new Date(ts)
      if (Number.isNaN(d.getTime())) return ''
      const month = d.getMonth() + 1
      const day = d.getDate()
      return language === 'ko' ? `${month}.${day}.` : `${month}/${day}`
    }

    const rainbow = [
      '#ef4444',
      '#f97316',
      '#eab308',
      '#22c55e',
      '#0ea5e9',
      '#6366f1',
      '#a855f7',
    ]

    const bars = series.map((item, idx) => {
      const barHeight = topTick > 0 ? (Math.min(item.km, topTick) / topTick) * graphHeight : 0
      const centerX = leftMargin + step * (idx + 0.5)
      const x = centerX - barWidth / 2
      const y = baseY - barHeight
      const axisLabel = formatAxisDate(item.ts)
      const fillColor = rainbow[idx % rainbow.length]

      return {
        x: +x.toFixed(2),
        y: +y.toFixed(2),
        width: +barWidth.toFixed(2),
        height: +barHeight.toFixed(2),
        km: item.km,
        axisLabel,
        fillColor,
      }
    })

    const yTicks = ticks.map((tick) => ({
      label: tick >= 10 ? tick.toFixed(0) : tick.toFixed(1),
      y: +(baseY - (tick / topTick) * graphHeight).toFixed(2),
    }))

    return { bars, yTicks }
  }, [distanceSeries, language])

  if (!isVisible) return null

  return (
    <div className="fixed inset-0 z-40 bg-slate-950">
	    <div
	        className="flex h-full flex-col px-4 overflow-y-auto"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)',
        }}
	        >
	        <div className="mx-auto flex w-full max-w-xl flex-col">
          {/* Header - Fixed */}
          <div className="mb-6 text-center flex-shrink-0">
            <h3 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 via-blue-300 to-cyan-300 mb-1">
              {headerTitle}
            </h3>
            <p className="text-sm text-white/60">
              {language === 'ko' ? '러닝 기록을 확인하세요' : 'Review your running history'}
            </p>
          </div>

		          {mode === 'run' && runDistanceGoalSummary && (
		            <div className="mb-4 flex-shrink-0 rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 via-sky-500/5 to-cyan-500/10 p-3">
		              <div className="flex items-center justify-between gap-3">
		                <div>
		                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-emerald-100">
		                    {language === 'ko' ? '\uc8fc\uac04/\uc6d4\uac04 \ub7f0\ub2dd \ubaa9\ud45c' : 'Weekly / Monthly running goals'}
		                  </p>
		                  <p className="text-[0.7rem] text-white/70">
		                    {language === 'ko'
		                      ? '\ud788\uc2a4\ud1a0\ub9ac\uc5d0 \uc800\uc7a5\ub41c \ub7f0\ub2dd \ub0b4\uc5ed\uc758 \ud569\uacc4\uc785\ub2c8\ub2e4.'
		                      : 'Totals across your saved running sessions.'}
		                  </p>
		                </div>
		                <div className="grid grid-cols-2 gap-2 text-xs text-white/90">
		                  <div className="rounded-xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2">
		                    <p className="text-[0.6rem] uppercase tracking-[0.18em] text-emerald-100 font-semibold">
		                      {language === 'ko' ? '\uc774\ubc88 \uc8fc' : 'This week'}
		                    </p>
		                    <p className="mt-0.5 text-sm font-bold">
		                      {`${(runDistanceGoalSummary.weekTotalM / 1000).toFixed(1)} / ${runDistanceGoalSummary.weekTargetKm.toFixed(0)} km`}
		                    </p>
		                    {Number.isFinite(runDistanceGoalSummary.weekPct) && (
		                      <p className="text-[0.65rem] text-emerald-100/80">
		                        {`${Math.max(0, Math.round(runDistanceGoalSummary.weekPct))}%`}
		                      </p>
		                    )}
		                  </div>
		                  <div className="rounded-xl border border-sky-400/40 bg-sky-500/10 px-3 py-2">
		                    <p className="text-[0.6rem] uppercase tracking-[0.18em] text-sky-100 font-semibold">
		                      {language === 'ko' ? '\uc774\ubc88 \ub2ec' : 'This month'}
		                    </p>
		                    <p className="mt-0.5 text-sm font-bold">
		                      {`${(runDistanceGoalSummary.monthTotalM / 1000).toFixed(1)} / ${runDistanceGoalSummary.monthTargetKm.toFixed(0)} km`}
		                    </p>
		                    {Number.isFinite(runDistanceGoalSummary.monthPct) && (
		                      <p className="text-[0.65rem] text-sky-100/80">
		                        {`${Math.max(0, Math.round(runDistanceGoalSummary.monthPct))}%`}
		                      </p>
		                    )}
		                  </div>
		                </div>
		              </div>
		            </div>
		          )}
		          {/* Filter Buttons - Fixed */}
          <div className="mb-3 flex gap-2 flex-shrink-0">
            {[
              { key: 'week', labelEn: 'Week', labelKo: '주간' },
              { key: 'month', labelEn: 'Month', labelKo: '월간' },
              { key: 'all', labelEn: 'All', labelKo: '전체' },
            ].map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => handleFilterChange(filter.key)}
                className={`flex-1 rounded-2xl border-2 px-4 py-2.5 text-sm font-bold transition-all duration-200 active:scale-95 ${
                  filterPeriod === filter.key
                    ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 text-emerald-100 shadow-lg shadow-emerald-500/30'
                    : 'border-white/30 bg-gradient-to-br from-white/5 to-black/10 text-white/70 hover:border-white/50'
                }`}
              >
                {language === 'ko' ? filter.labelKo : filter.labelEn}
              </button>
            ))}
          </div>

          {/* Sort Buttons - Fixed */}
          <div className="mb-4 flex justify-center gap-2 flex-shrink-0">
            {[
              { key: 'recent', labelEn: 'Recent', labelKo: '최신순' },
              { key: 'record', labelEn: 'Best Pace', labelKo: '기록순' },
            ].map((sort) => (
              <button
                key={sort.key}
                type="button"
                onClick={() => handleSortChange(sort.key)}
                className={`rounded-2xl border-2 px-4 py-2 text-xs font-bold transition-all duration-200 active:scale-95 ${
                  sortBy === sort.key
                    ? 'border-cyan-400/70 bg-gradient-to-br from-cyan-500/30 to-cyan-600/20 text-cyan-100 shadow-lg shadow-cyan-500/30'
                    : 'border-white/30 bg-gradient-to-br from-white/5 to-black/10 text-white/70 hover:border-white/50'
                }`}
              >
                {language === 'ko' ? sort.labelKo : sort.labelEn}
              </button>
            ))}
          </div>

          {distanceBars?.bars?.length > 0 && (
            <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-cyan-500/10 p-3 shadow-lg backdrop-blur-sm">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-100">
                    {language === 'ko' ? '거리 추이' : 'Distance Trend'}
                  </p>
                  <p className="text-[0.7rem] text-white/60">
                    {language === 'ko'
                      ? `최근 ${distanceSeries.length}회 기록`
                      : `Last ${distanceSeries.length} sessions`}
                  </p>
                </div>
                {distanceSummary && (
                  <div className="text-right">
                    <p className="text-lg font-black text-white">
                      {distanceSummary.latest.toFixed(2)} km
                    </p>
                    <p className="text-[0.65rem] text-white/70">
                      {language === 'ko'
                        ? `최고 ${distanceSummary.max.toFixed(2)}km · 평균 ${distanceSummary.avg.toFixed(2)}km`
                        : `Best ${distanceSummary.max.toFixed(2)} km · Avg ${distanceSummary.avg.toFixed(2)} km`}
                    </p>
                    {distanceSummary.delta != null && (
                      <p className={`text-[0.65rem] font-bold ${distanceSummary.delta > 0 ? 'text-emerald-200' : distanceSummary.delta < 0 ? 'text-amber-200' : 'text-white/70'}`}>
                        {language === 'ko'
                          ? `직전 대비 ${distanceSummary.delta >= 0 ? '+' : ''}${distanceSummary.delta.toFixed(2)}km`
                          : `vs last ${distanceSummary.delta >= 0 ? '+' : ''}${distanceSummary.delta.toFixed(2)} km`}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="relative h-36">
                <svg
                  className="absolute inset-0 w-full h-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {distanceBars.yTicks.map((tick, idx) => (
                    <g key={`ytick-${idx}`}>
                      <line
                        x1="8"
                        x2="100"
                        y1={tick.y}
                        y2={tick.y}
                        stroke="rgba(255,255,255,0.15)"
                        strokeWidth="0.3"
                      />
                      <text
                        x="4"
                        y={tick.y + 1.8}
                        textAnchor="start"
                        fontSize="6"
                        fill="#9ca3af"
                        fontWeight="600"
                      >
                        {tick.label} km
                      </text>
                    </g>
                  ))}
                  {distanceBars.bars.map((bar, idx) => (
                    <g key={`dist-bar-${idx}-${bar.x}`}>
                      <rect
                        x={bar.x}
                        y={bar.y}
                        width={bar.width}
                        height={bar.height}
                        rx="3"
                        fill={bar.fillColor}
                        opacity="0.95"
                      />
                      <text
                        x={bar.x + bar.width / 2}
                        y={Math.max(bar.y - 3, 8)}
                        textAnchor="middle"
                        fontSize="7"
                        fill="#ecfeff"
                        fontWeight="600"
                      >
                        {bar.km.toFixed(1)}
                      </text>
                      <text
                        x={bar.x + bar.width / 2}
                        y={95}
                        textAnchor="middle"
                        fontSize="5"
                        fill="#e5e7eb"
                      >
                        {bar.axisLabel || ''}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
            </div>
          )}

          {/* History List - Scrollable area with flex-1 and min-h-0 to enable scroll */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 mb-4 scrollbar-hide">
            {sortedList.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/5 to-white/10 p-8 text-center backdrop-blur-sm">
                <p className="text-sm text-white/60">{text.history.empty}</p>
              </div>
            ) : (
              Object.entries(groupedEntries).map(([dateKey, dateEntries]) => (
                <div key={dateKey} className="space-y-2">
                  {/* Date Header */}
                  <p className="text-xs font-bold text-white/50 uppercase tracking-wider px-2">
                    {dateKey}
                  </p>

                  {/* Entries for this date */}
                  {dateEntries.map((entry) => {
                    const expanded = expandedId === entry.id
                    const modeLabel = MODE_LABELS[entry.mode]?.[language] || MODE_LABELS[entry.mode]?.en || entry.mode
                    const timeLabel = new Date(entry.startedAt || entry.timestamp).toLocaleTimeString(
                      language === 'ko' ? 'ko-KR' : 'en-US',
                      { hour: '2-digit', minute: '2-digit' }
                    )
                    const distanceLabel = formatDistanceLabel(entry.distanceM, 2)
                    const durationLabel = formatClock(entry.durationMs, {
                      showHours: entry.durationMs >= 3600000,
                    })
                    const paceLabel = entry.avgPaceMs ? formatPaceLabel(entry.avgPaceMs) : '--:-- /km'
                    const laps = Array.isArray(entry.laps) ? entry.laps : []
                    const goalLabel = entry.goal ? formatGoalLabel(entry.goal, language) : ''
                    const lapDistanceLabel = entry.lapDistanceM ? formatDistanceLabel(entry.lapDistanceM, 2) : (language === 'ko' ? '데이터 없음' : 'N/A')
                    const timeCueLabel = entry.timeCueMs
                      ? `${Math.round(entry.timeCueMs / 60000)}${language === 'ko' ? '분' : 'm'}`
                      : language === 'ko'
                        ? '끄기'
                        : 'Off'
                    const paceGuideLabel = entry.targetPaceMs ? formatPaceLabel(entry.targetPaceMs) : (language === 'ko' ? '끄기' : 'Off')
                    const startedAtLabel = entry.startedAt
                      ? new Date(entry.startedAt).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US')
                      : ''
                    const lapVoiceLabel = entry.voiceEnabled
                      ? `${language === 'ko' ? 'TTS 켜짐 · 랩' : 'TTS on · lap'} ${lapDistanceLabel}`
                      : language === 'ko' ? 'TTS 꺼짐' : 'TTS off'
                    const ghostResult = entry.ghostResult
                    const ghostDiffLabel = ghostResult && Number.isFinite(ghostResult.diffSeconds)
                      ? `${ghostResult.diffSeconds > 0 ? '+' : ''}${formatClock(Math.abs(ghostResult.diffSeconds) * 1000)}`
                      : ''
                    const ghostOutcomeLabel = ghostResult
                      ? ghostResult.success
                        ? (text.ghost?.historySuccess || 'Ghost success')
                        : (text.ghost?.historyFail || 'Ghost miss')
                      : ''
                    const ghostTargetLabel = ghostResult?.targetDistanceM
                      ? `${formatDistanceLabel(ghostResult.targetDistanceM, 2)}${ghostResult.targetDurationMs ? ` · ${formatClock(ghostResult.targetDurationMs, { showHours: ghostResult.targetDurationMs >= 3600000 })}` : ''}`
                      : ''
                    const hasSteps = entry.mode === 'walk'
                    const stepsDisplay = hasSteps
                      ? (Number.isFinite(entry.steps) ? formatSteps(entry.steps, language, true) : (language === 'ko' ? '--' : '--'))
                      : ''
                    const stepsLabel = hasSteps
                      ? (Number.isFinite(entry.steps) ? formatSteps(entry.steps, language, false) : (language === 'ko' ? '--' : '--'))
                      : ''
                    const cadenceDisplay = Number.isFinite(entry.cadenceSpm) ? formatCadence(entry.cadenceSpm, language) : ''
                    const strideDisplay = Number.isFinite(entry.strideLengthM) ? formatStride(entry.strideLengthM, language) : ''
                    const estCalories = estimateCalories(entry.distanceM, entry.durationMs)
                    const caloriesDisplay = Number.isFinite(entry.calories)
                      ? formatCalories(entry.calories, language)
                      : formatCalories(estCalories || 0, language)
                    const elevationDisplay = Number.isFinite(entry.elevationGainM) ? formatElevation(entry.elevationGainM, language) : ''
                    const intensityDisplay = entry.intensityLevel || ''
                    const goalProgressDisplay = Number.isFinite(entry.goalProgress) ? formatGoalProgress(entry.goalProgress, language) : ''

                    return (
                      <div
                        key={entry.id}
                        className="overflow-hidden rounded-2xl border-2 border-emerald-400/20 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-cyan-500/10 shadow-lg backdrop-blur-sm"
                      >
                        <button
                          type="button"
                          onClick={() => handleToggle(entry.id)}
                          className="flex w-full items-center justify-between px-4 py-3.5 hover:bg-white/5 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <div className="text-left">
                              <p className="text-sm font-bold text-white/90">{distanceLabel}</p>
                              <p className="text-xs text-white/50">{timeLabel}</p>
                            </div>
                            {expanded && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDelete(entry.id)
                                }}
                                className="flex items-center gap-1 rounded-lg border border-rose-400/50 bg-gradient-to-br from-rose-500/20 to-rose-600/10 px-2 py-1 text-[0.65rem] font-bold text-rose-100 shadow-sm transition-all duration-200 hover:border-rose-400/80 hover:shadow-rose-500/30 active:scale-95"
                              >
                                <Minus className="h-3 w-3" />
                                <span>{language === 'ko' ? '삭제' : 'Del'}</span>
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            {expanded ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (onChallengeEntry) onChallengeEntry(entry)
                                }}
                                className="flex items-center gap-1 rounded-lg border border-cyan-400/50 bg-gradient-to-br from-cyan-500/20 to-cyan-600/10 px-2 py-1 text-[0.65rem] font-bold text-cyan-50 shadow-sm transition-all duration-200 hover:border-cyan-400/80 hover:shadow-cyan-500/30 active:scale-95"
                              >
                                <span>{text.ghost?.challengeButton || (language === 'ko' ? '도전' : 'Challenge')}</span>
                              </button>
                            ) : (
                              <div className="text-right">
                                <p className="text-sm font-bold text-emerald-300">{durationLabel}</p>
                                <p className="text-xs text-white/50">{paceLabel}</p>
                                {caloriesDisplay && (
                                  <p className="text-[0.65rem] text-white/60">
                                    {text.summary.calories || (language === 'ko' ? '칼로리' : 'Calories')}: {caloriesDisplay}
                                  </p>
                                )}
                                {hasSteps && (
                                  <p className="text-[0.65rem] text-white/60">
                                    {(text.summary?.steps) || (language === 'ko' ? '걸음수' : 'Steps')}: {stepsDisplay}
                                  </p>
                                )}
                                {ghostResult && (
                                  <p className={`text-[0.65rem] font-bold ${ghostResult.success ? 'text-emerald-200' : 'text-amber-200'}`}>
                                    {ghostOutcomeLabel}{ghostDiffLabel ? ` (${ghostDiffLabel})` : ''}
                                  </p>
                                )}
                              </div>
                            )}
                            {expanded ? (
                              <ChevronUp className="h-4 w-4 text-white/70" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-white/70" />
                            )}
                          </div>
                        </button>

                        {expanded && (
                          <div className="space-y-3 border-t border-white/15 bg-black/20 px-4 py-4 text-sm">
                            {/* Stats Grid */}
                            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                  {renderLabel('distance', text.summary.distance)}
                                </div>
                                <p className="text-sm font-black text-white">{distanceLabel}</p>
                                {helpKey === 'distance' && helpTexts[language]?.distance && (
                                  <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].distance}</p>
                                )}
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                  {renderLabel('totalTime', text.summary.totalTime)}
                                </div>
                                <p className="text-sm font-black text-white">{durationLabel}</p>
                                {helpKey === 'totalTime' && helpTexts[language]?.totalTime && (
                                  <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].totalTime}</p>
                                )}
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                  {renderLabel('avgPace', text.summary.avgPace)}
                                </div>
                                <p className="text-sm font-black text-white">{paceLabel}</p>
                                {helpKey === 'avgPace' && helpTexts[language]?.avgPace && (
                                  <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].avgPace}</p>
                                )}
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                  {renderLabel('laps', text.summary.laps)}
                                </div>
                                <p className="text-sm font-black text-white">{laps.length}</p>
                                {helpKey === 'laps' && helpTexts[language]?.laps && (
                                  <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].laps}</p>
                                )}
                              </div>
                              {hasSteps && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('steps', text.summary.steps || (language === 'ko' ? '걸음수' : 'Steps'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{stepsLabel}</p>
                                  {helpKey === 'steps' && helpTexts[language]?.steps && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].steps}</p>
                                  )}
                                </div>
                              )}
                              {caloriesDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('calories', text.summary.calories || (language === 'ko' ? '칼로리' : 'Calories'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{caloriesDisplay}</p>
                                  {helpKey === 'calories' && helpTexts[language]?.calories && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].calories}</p>
                                  )}
                                </div>
                              )}
                              {cadenceDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('cadence', text.summary.cadence || (language === 'ko' ? '케이던스' : 'Cadence'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{cadenceDisplay}</p>
                                  {helpKey === 'cadence' && helpTexts[language]?.cadence && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].cadence}</p>
                                  )}
                                </div>
                              )}
                              {strideDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('stride', text.summary.stride || (language === 'ko' ? '스트라이드' : 'Stride'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{strideDisplay}</p>
                                  {helpKey === 'stride' && helpTexts[language]?.stride && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].stride}</p>
                                  )}
                                </div>
                              )}
                              {elevationDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('elevation', text.summary.elevation || (language === 'ko' ? '고도 상승' : 'Elevation'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{elevationDisplay}</p>
                                  {helpKey === 'elevation' && helpTexts[language]?.elevation && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].elevation}</p>
                                  )}
                                </div>
                              )}
                              {intensityDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('intensity', text.summary.intensity || (language === 'ko' ? '강도' : 'Intensity'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{intensityDisplay}</p>
                                  {helpKey === 'intensity' && helpTexts[language]?.intensity && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].intensity}</p>
                                  )}
                                </div>
                              )}
                              {goalProgressDisplay && (
                                <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                  <div className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold flex items-center justify-center gap-1">
                                    {renderLabel('goalProgress', text.summary.goalProgress || (language === 'ko' ? '목표 달성률' : 'Goal Progress'))}
                                  </div>
                                  <p className="text-sm font-black text-white">{goalProgressDisplay}</p>
                                  {helpKey === 'goalProgress' && helpTexts[language]?.goalProgress && (
                                    <p className="mt-1 text-[0.65rem] text-white/70">{helpTexts[language].goalProgress}</p>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Extra details */}
                            <div className="grid grid-cols-2 gap-2">
                              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {language === 'ko' ? '시작 시간' : 'Started'}
                                </p>
                                <p className="text-sm font-semibold text-white/90">{startedAtLabel || '--'}</p>
                              </div>
                              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {language === 'ko' ? '랩 거리' : 'Lap Distance'}
                                </p>
                                <p className="text-sm font-semibold text-white/90">{lapDistanceLabel}</p>
                              </div>
                              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {language === 'ko' ? '시간 음성' : 'Time Voice'}
                                </p>
                                <p className="text-sm font-semibold text-white/90">{timeCueLabel}</p>
                              </div>
                              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {language === 'ko' ? '페이스 가이드' : 'Pace Guide'}
                                </p>
                                <p className="text-sm font-semibold text-white/90">{paceGuideLabel}</p>
                              </div>
                            </div>

                            {ghostResult && (
                              <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/70 mb-1 font-bold">
                                  {text.ghost?.title || 'Ghost mode'}
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

                            {goalLabel && (
                              <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/70 mb-1 font-bold">
                                  {language === 'ko' ? '목표' : 'Goal'}
                                </p>
                                <p className="text-sm font-semibold text-emerald-50">{goalLabel}</p>
                              </div>
                            )}

                            {/* Lap Details */}
                            {laps.length > 0 && (
                              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-2 font-bold">
                                  {text.summary.lapList}
                                </p>
                                <div className="max-h-32 space-y-1.5 overflow-y-auto pr-1 text-[0.7rem] text-white/70">
                                  {laps.map((lap) => (
                                    <div
                                      key={lap.index}
                                      className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-2 py-1.5"
                                    >
                                      <span className="font-bold text-white/80">
                                        {language === 'ko' ? `${lap.index}구간` : `Lap ${lap.index}`}
                                      </span>
                                      <span>{formatDistanceLabel(lap.distanceM, 2)}</span>
                                      <span>{formatClock(lap.durationMs)}</span>
                                      <span className="font-bold text-emerald-300">{formatPaceLabel(lap.paceMs)}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ))
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
