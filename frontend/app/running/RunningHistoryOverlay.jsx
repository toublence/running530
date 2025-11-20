'use client'

import { useState, useEffect } from 'react'
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

export default function RunningHistoryOverlay({
  isVisible,
  language = 'en',
  entries,
  onClose,
  onDeleteEntry,
  mode,
  onChallengeEntry,
  initialSortBy = 'recent',
}) {
  const [expandedId, setExpandedId] = useState(null)
  const [filterPeriod, setFilterPeriod] = useState('week') // 'week' | 'month' | 'all'
  const [sortBy, setSortBy] = useState(initialSortBy) // 'recent' | 'record'

  // Update sortBy when initialSortBy changes
  useEffect(() => {
    setSortBy(initialSortBy)
  }, [initialSortBy])

  if (!isVisible) return null

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
          {/* Header - Fixed */}
          <div className="mb-6 text-center flex-shrink-0">
            <h3 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 via-blue-300 to-cyan-300 mb-1">
              {headerTitle}
            </h3>
            <p className="text-sm text-white/60">
              {language === 'ko' ? '러닝 기록을 확인하세요' : 'Review your running history'}
            </p>
          </div>

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
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {text.summary.distance}
                                </p>
                                <p className="text-sm font-black text-white">{distanceLabel}</p>
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {text.summary.totalTime}
                                </p>
                                <p className="text-sm font-black text-white">{durationLabel}</p>
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {text.summary.avgPace}
                                </p>
                                <p className="text-sm font-black text-white">{paceLabel}</p>
                              </div>
                              <div className="rounded-xl bg-gradient-to-br from-white/10 to-white/5 p-3 text-center border border-white/10">
                                <p className="text-[0.65rem] uppercase tracking-wider text-white/60 mb-1 font-bold">
                                  {text.summary.laps}
                                </p>
                                <p className="text-sm font-black text-white">{laps.length}</p>
                              </div>
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
