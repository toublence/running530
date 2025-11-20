'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import RunningSummaryOverlay from './RunningSummaryOverlay'
import RunningHistoryOverlay from './RunningHistoryOverlay'
import LapCompletionAlert from './LapCompletionAlert'
import useNativeAppVisibility from '../hooks/useNativeAppVisibility'
import useSafeAreaTop from '../hooks/useSafeAreaTop'
import IOSBackButtonLocal from '../components/IOSBackButtonLocal'
import { ensureLocationPermission, watchLocation } from '../utils/geolocation'
import {
  haversineDistanceMeters,
  formatClock,
  formatDistanceLabel,
  formatPaceLabel,
  formatSpokenDuration,
  formatSpokenPace,
  formatSpokenDistance,
  formatSpokenSpeed,
} from '../utils/distance'
import { unlockTTS, speakOnce, stopAllTTS, forceUnduck } from '../utils/tts'
import { requestWakeLock, releaseWakeLock, isWakeLockActive } from '../utils/wake-lock'
import { showBannerAd, hideBannerAd } from '../utils/admobHelper'
import { ScreenOrientation } from '@capacitor/screen-orientation'
import {
  SESSION_TEXT,
} from './locale'

const MODE_META = {
  run: {
    title: 'Running',
    titleKo: '러닝',
    gradient: 'from-emerald-400/30 via-blue-500/20 to-cyan-500/30',
    accentColor: 'emerald',
    defaultTimeCueMs: 5 * 60 * 1000,
    defaultTargetPaceMs: 6.5 * 60 * 1000, // 6'30"
  },
  walk: {
    title: 'Walking',
    titleKo: '도보',
    gradient: 'from-amber-400/30 via-orange-500/20 to-rose-500/30',
    accentColor: 'amber',
    defaultTimeCueMs: 10 * 60 * 1000,
    defaultTargetPaceMs: 10 * 60 * 1000, // 10'00"
  },
}

const HISTORY_KEY = 'running_history_v1'
const LAP_DISTANCE_STORAGE_KEY = 'running_lap_distance_m'
const TIME_CUE_STORAGE_KEY = 'running_time_cue_ms'
const PACE_TARGET_STORAGE_KEY = 'running_target_pace_ms'
const GOAL_STORAGE_KEY = 'running_goal_v1'
const MIN_DISTANCE_DELTA = 1
const CURRENT_PACE_WINDOW_MS = 20000
const CURRENT_PACE_MIN_DISTANCE_M = 3
const MAX_ACCEPTABLE_ACCURACY_M = 25
const MAX_HISTORY_ITEMS = 20
const MIN_AVG_PACE_DISTANCE_M = 100
const MIN_SPEED_THRESHOLD_MPS = 0.14 // ~0.5 km/h, below this is considered stopped
const SPEED_SMOOTHING_FACTOR = 0.3 // EMA smoothing factor: 0.0 (no change) to 1.0 (instant)
const MIN_PACE_COACH_DELTA_MS = 15000 // 15s difference before coaching nags
const PACE_COACH_COOLDOWN_MS = 90000
const GHOST_DISTANCE_TOLERANCE_M = 500 // ±0.5km tolerance when finding a target run
const MIN_GHOST_SPLITS = 1

const BANNER_AD_UNITS = {
  // Google test banner IDs; replace with production units when ready
  android: 'ca-app-pub-3940256099942544/6300978111',
  ios: 'ca-app-pub-3940256099942544/2934735716',
}

const BANNER_HEIGHT_PX = 60
// Extra gap between the bottom of the banner and the Running card
const IOS_BANNER_EXTRA_GAP_PX = 0
const ANDROID_BANNER_EXTRA_GAP_PX = 8
const getBannerPlaceholderHeight = (platform) => {
  if (platform === 'ios') return BANNER_HEIGHT_PX + IOS_BANNER_EXTRA_GAP_PX
  if (platform === 'android') return BANNER_HEIGHT_PX + ANDROID_BANNER_EXTRA_GAP_PX
  return BANNER_HEIGHT_PX
}

const computeBannerTopMargin = (platform, safeAreaTop) => {
  const measuredInset = Math.max(0, safeAreaTop || 0)
  if (platform === 'ios') {
    if (measuredInset > 0.5) {
      // Safe area known: align banner directly under the status bar
      return 0
    }
    // Fallback when the safe area inset is not yet known
    return -64
  }
  const extraSpacing = 12
  return Math.round(measuredInset + extraSpacing)
}

const resolveCapacitorPlatform = () => {
  if (typeof window === 'undefined') return 'web'
  const Cap = window.Capacitor || null
  const platform = Cap?.getPlatform?.() || Cap?.platform
  if (platform === 'ios' || platform === 'android') return platform
  return 'web'
}


const buildLapSpeech = (index, lapDuration, lapPace, avgPace, language) => {
  const lapDurationText = formatSpokenDuration(lapDuration, language)
  const lapPaceText = formatSpokenPace(lapPace, language)
  const avgText = avgPace ? formatSpokenPace(avgPace, language) : null
  if (language === 'ko') {
    return avgText
      ? `${index}번째 구간 기록, ${lapDurationText}, 평균 페이스 ${lapPaceText}, 전체 평균 ${avgText}.`
      : `${index}번째 구간 기록, ${lapDurationText}, 평균 페이스 ${lapPaceText}.`
  }
  const lapSegment = `${lapPaceText} pace`
  const avgSegment = avgText ? `${avgText} pace` : null
  return avgSegment
    ? `Lap ${index} complete in ${lapDurationText}. Lap pace ${lapSegment}, overall average ${avgSegment}.`
    : `Lap ${index} complete in ${lapDurationText}. Lap pace ${lapSegment}.`
}

const formatSpeedLabel = (paceMs) => {
  if (!paceMs || paceMs <= 0) return '--.- km/h'
  const kmh = 3600000 / paceMs
  if (!Number.isFinite(kmh)) return '--.- km/h'
  return `${kmh.toFixed(1)} km/h`
}

const buildTimeCueSpeech = (payload) => {
  const {
    elapsedMs,
    distanceM,
    avgPaceMs,
    currentPaceMs,
    language,
    lastSnapshot,
  } = payload

  const elapsedText = formatSpokenDuration(elapsedMs, language)
  const distanceText = formatSpokenDistance(distanceM, language, 2)
  const avgPaceText = avgPaceMs ? formatSpokenPace(avgPaceMs, language) : null
  const currentPaceText = currentPaceMs ? formatSpokenPace(currentPaceMs, language) : null
  const avgSpeed = avgPaceMs ? 3600000 / avgPaceMs : null
  const avgSpeedText = avgSpeed ? formatSpokenSpeed(avgSpeed, language) : null

  let trendText = ''
  let speedTrendText = ''
  if (lastSnapshot && avgPaceMs && Number.isFinite(lastSnapshot.avgPaceMs)) {
    const paceDeltaMs = avgPaceMs - lastSnapshot.avgPaceMs
    const paceDeltaSec = Math.round(Math.abs(paceDeltaMs) / 1000)
    if (paceDeltaSec >= 5) {
      if (language === 'ko') {
        trendText = paceDeltaMs < 0
          ? `이전보다 ${paceDeltaSec}초 빨라졌어요.`
          : `이전보다 ${paceDeltaSec}초 느려졌어요.`
      } else {
        trendText = paceDeltaMs < 0
          ? `${paceDeltaSec} seconds faster than before.`
          : `${paceDeltaSec} seconds slower than before.`
      }
    }
  }

  if (lastSnapshot && avgSpeed != null && Number.isFinite(lastSnapshot.avgSpeed)) {
    const speedDelta = avgSpeed - lastSnapshot.avgSpeed
    const speedDeltaAbs = Math.abs(speedDelta)
    if (speedDeltaAbs >= 0.2) {
      if (language === 'ko') {
        speedTrendText = speedDelta > 0
          ? `${speedDeltaAbs.toFixed(1)}킬로미터 속도가 빨라졌어요.`
          : `${speedDeltaAbs.toFixed(1)}킬로미터 속도가 느려졌어요.`
      } else {
        speedTrendText = speedDelta > 0
          ? `${speedDeltaAbs.toFixed(1)} kilometers per hour faster.`
          : `${speedDeltaAbs.toFixed(1)} kilometers per hour slower.`
      }
    }
  }

  const parts = []
  if (language === 'ko') {
    parts.push(`${elapsedText} 경과, 거리 ${distanceText}.`)
    if (currentPaceText) parts.push(`현재 페이스 ${currentPaceText}.`)
    if (avgPaceText) parts.push(`평균 페이스 ${avgPaceText}.`)
    if (avgSpeedText) parts.push(`평균 속도 ${avgSpeedText}.`)
    if (trendText) parts.push(trendText)
    if (speedTrendText) parts.push(speedTrendText)
  } else {
    parts.push(`${elapsedText} elapsed. Distance ${distanceText}.`)
    if (currentPaceText) parts.push(`Current pace ${currentPaceText}.`)
    if (avgPaceText) parts.push(`Average pace ${avgPaceText}.`)
    if (avgSpeedText) parts.push(`Average speed ${avgSpeedText}.`)
    if (trendText) parts.push(trendText)
    if (speedTrendText) parts.push(speedTrendText)
  }

  return parts.join(' ')
}

const buildPaceCoachSpeech = (direction, deltaSeconds, language, modeLabel) => {
  if (language === 'ko') {
    if (direction === 'slow') {
      return `목표 페이스보다 ${deltaSeconds}초 느립니다. 조금 더 빠르게 ${modeLabel === '도보' ? '걸어보세요.' : '뛰어보세요.'}`
    }
    return `목표 페이스보다 ${deltaSeconds}초 빠릅니다. 속도를 조금만 줄여보세요.`
  }

  if (direction === 'slow') {
    return `You're ${deltaSeconds} seconds slower than target pace. Pick it up a bit.`
  }
  return `You're ${deltaSeconds} seconds faster than target pace. Ease off slightly.`
}

const buildGoalSpeech = (goal, elapsedMs, distanceM, avgPaceMs, language) => {
  if (!goal) return ''
  const distanceText = formatSpokenDistance(distanceM, language, 2)
  const durationText = formatSpokenDuration(elapsedMs, language)
  const avgText = avgPaceMs ? formatSpokenPace(avgPaceMs, language) : null

  if (language === 'ko') {
    if (goal.type === 'distance') {
      return `목표 ${formatSpokenDistance(goal.value, 'ko', 1)} 달성! 총 시간 ${durationText}${avgText ? `, 평균 페이스 ${avgText}` : ''} 입니다.`
    }
    return `목표 ${formatSpokenDuration(goal.value, 'ko')} 달성! 거리 ${distanceText}${avgText ? `, 평균 페이스 ${avgText}` : ''} 입니다.`
  }

  if (goal.type === 'distance') {
    return `Distance goal of ${formatSpokenDistance(goal.value, 'en', 1)} reached! Total time ${durationText}${avgText ? `, average pace ${avgText}` : ''}.`
  }
  return `Time goal reached! ${durationText} elapsed. Distance ${distanceText}${avgText ? `, average pace ${avgText}` : ''}.`
}

const formatGoalLabel = (goal, language) => {
  if (!goal) return ''
  if (goal.type === 'distance') {
    return language === 'ko'
      ? `${(goal.value / 1000).toFixed(1)}km 목표`
      : `${(goal.value / 1000).toFixed(1)}km goal`
  }
  const label = formatClock(goal.value, { showHours: goal.value >= 3600000 })
  return language === 'ko' ? `${label} 목표` : `${label} goal`
}

const buildGhostDeltaSpeech = (kmIndex, diffSeconds, language) => {
  if (!Number.isFinite(diffSeconds)) return ''
  const kmLabel = language === 'ko' ? `${kmIndex}킬로미터` : `Kilometer ${kmIndex}`
  const prefix = language === 'ko' ? `${kmLabel} 통과.` : `${kmLabel} mark.`
  const absText = formatSpokenDuration(Math.abs(diffSeconds) * 1000, language)
  if (Math.abs(diffSeconds) < 3) {
    return `${prefix} ${language === 'ko' ? '도전 기록과 거의 비슷해요.' : 'Pace is almost identical to your target run.'}`
  }
  if (diffSeconds < 0) {
    return `${prefix} ${language === 'ko' ? `도전 기록보다 ${absText} 빠릅니다.` : `${absText} faster than your ghost.`}`
  }
  return `${prefix} ${language === 'ko' ? `도전 기록보다 ${absText} 느립니다.` : `${absText} slower than your ghost.`}`
}


export default function RunningSession({ mode }) {
  useNativeAppVisibility('running')
  const resolvedMode = MODE_META[mode] ? mode : 'run'
  const meta = MODE_META[resolvedMode]

  const [sessionActive, setSessionActive] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [distanceM, setDistanceM] = useState(0)
  const [currentPaceMs, setCurrentPaceMs] = useState(null)
  const [avgPaceMs, setAvgPaceMs] = useState(null)
  const [laps, setLaps] = useState([])
  const [routePoints, setRoutePoints] = useState([])
  const [history, setHistory] = useState([])
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState(null)
  const [locationPermission, setLocationPermission] = useState('prompt')
  const [latestAccuracy, setLatestAccuracy] = useState(null)
  const [showStats, setShowStats] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyInitialSort, setHistoryInitialSort] = useState('recent')
  const [workoutStats, setWorkoutStats] = useState(null)
  const [summaryMeta, setSummaryMeta] = useState(null)
  const [starting, setStarting] = useState(false)
  const [lapAlert, setLapAlert] = useState(null)
  const [capPlatform, setCapPlatform] = useState(() => resolveCapacitorPlatform())
  const safeAreaTop = useSafeAreaTop()
  const [bannerStatus, setBannerStatus] = useState('hidden') // 'hidden' | 'loading' | 'visible' | 'error' | 'unavailable'
  const [language, setLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'en'
    const saved = localStorage.getItem('locale') || ''
    return saved === 'ko' ? 'ko' : 'en'
  })
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem('running_voice_enabled')
    return saved === null ? true : saved === 'true'
  })
  const [timeCueMs, setTimeCueMs] = useState(() => {
    if (typeof window === 'undefined') return meta.defaultTimeCueMs || 0
    try {
      const raw = localStorage.getItem(`${TIME_CUE_STORAGE_KEY}_${resolvedMode}`)
      if (raw !== null) return Number(raw) || 0
    } catch {}
    return meta.defaultTimeCueMs || 0
  })
  const [targetPaceMs, setTargetPaceMs] = useState(() => {
    if (typeof window === 'undefined') return meta.defaultTargetPaceMs || null
    try {
      const raw = localStorage.getItem(`${PACE_TARGET_STORAGE_KEY}_${resolvedMode}`)
      if (raw === 'off') return null
      if (raw) return Number(raw) || null
    } catch {}
    return meta.defaultTargetPaceMs || null
  })
  const [lapDistanceM, setLapDistanceM] = useState(() => {
    if (typeof window === 'undefined') return 1000
    try {
      const raw = localStorage.getItem(LAP_DISTANCE_STORAGE_KEY)
      const parsed = Number(raw || '1000')
      return parsed === 500 ? 500 : 1000
    } catch {
      return 1000
    }
  })
  const [lapDistanceDropdownOpen, setLapDistanceDropdownOpen] = useState(false)
  const [timeCueDropdownOpen, setTimeCueDropdownOpen] = useState(false)
  const [paceTargetDropdownOpen, setPaceTargetDropdownOpen] = useState(false)
  const [goalDistanceDropdownOpen, setGoalDistanceDropdownOpen] = useState(false)
  const [goalTimeDropdownOpen, setGoalTimeDropdownOpen] = useState(false)
  const [preventScreenLock, setPreventScreenLock] = useState(() => {
    if (typeof window === 'undefined') return true
    const saved = localStorage.getItem('running_prevent_screen_lock')
    return saved === null ? true : saved === 'true'
  })
  const [sessionKeepAwake, setSessionKeepAwake] = useState(false)
  const [goalPreset, setGoalPreset] = useState(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(`${GOAL_STORAGE_KEY}_${resolvedMode}`)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  })
  const [goalBanner, setGoalBanner] = useState(null)
  const [showGoalGuide, setShowGoalGuide] = useState(false)
  const [showSettingsGuide, setShowSettingsGuide] = useState(false)
  const [showGhostGuide, setShowGhostGuide] = useState(false)
  const [ghostEnabled, setGhostEnabled] = useState(false)
  const [ghostTarget, setGhostTarget] = useState(null)
  const [ghostMessage, setGhostMessage] = useState('')

  const text = SESSION_TEXT[language] || SESSION_TEXT.en
  const modeTitle = language === 'ko' ? meta.titleKo : meta.title

  const watchStopRef = useRef(null)
  const lastPointRef = useRef(null)
  const routePointsRef = useRef([])
  const sessionStartRef = useRef(null)
  const pauseStartRef = useRef(0)
  const pausedAccumulatedRef = useRef(0)
  const totalDistanceRef = useRef(0)
  const lapTargetRef = useRef(lapDistanceM || 1000)
  const lapStartTimeRef = useRef(null)
  const lapStartDistanceRef = useRef(0)
  const lapPauseStartRef = useRef(0)
  const lapPausedAccumulatedRef = useRef(0)
  const lapsRef = useRef([])
  const samplesRef = useRef([])
  const voiceEnabledRef = useRef(voiceEnabled)
  const nextTimeCueRef = useRef(null)
  const paceCoachRef = useRef({ ts: 0, direction: null })
  const goalRef = useRef(null)
  const goalReachedRef = useRef(false)
  const lastTimeCueRef = useRef(null)
  const bannerAnchorRef = useRef(null)
  const smoothedSpeedRef = useRef(null) // Smoothed speed in m/s for better current pace
  const androidBackCleanupRef = useRef(null)
  const lockHistoryPushedRef = useRef(false)
  const suppressPopstateRef = useRef(false)
  const ghostSessionRef = useRef({ enabled: false, targetRun: null, lapsTimeline: [], nextKmIndex: 1 })

  const blockLockedInteraction = useCallback((e) => {
    try { e?.preventDefault?.() } catch {}
    try { e?.stopPropagation?.() } catch {}
  }, [])

  const handleSelectGoalPreset = useCallback((preset) => {
    if (!preset || preset.value === 0) {
      setGoalPreset(null)
      return
    }
    setGoalPreset((prev) => {
      if (prev?.type === preset.type && prev?.value === preset.value) {
        return null
      }
      return preset
    })
  }, [])

  const resolveRecordDistance = useCallback((record) => {
    if (!record) return null
    if (record.goal?.type === 'distance' && Number.isFinite(record.goal.value)) {
      return record.goal.value
    }
    if (Number.isFinite(record.distanceM)) return record.distanceM
    return null
  }, [])

  const buildGhostTimeline = useCallback((record) => {
    if (!record || !Array.isArray(record.laps)) return []
    let cumulativeDistance = 0
    let cumulativeElapsed = 0
    return record.laps.map((lap) => {
      const dist = Number(lap.distanceM) || 0
      const duration = Number(lap.durationMs) || 0
      const elapsed = Number.isFinite(lap.elapsedMs) ? lap.elapsedMs : cumulativeElapsed + duration
      cumulativeElapsed = elapsed
      cumulativeDistance += dist
      return {
        index: lap.index,
        distanceM: dist,
        durationMs: duration,
        paceMs: lap.paceMs,
        elapsedMs: elapsed,
        cumulativeDistanceM: cumulativeDistance,
      }
    }).filter((lap) => lap.distanceM > 0 && Number.isFinite(lap.elapsedMs))
  }, [])

  const resetGhostSession = useCallback(() => {
    ghostSessionRef.current = { enabled: false, targetRun: null, lapsTimeline: [], nextKmIndex: 1 }
  }, [])

  const findBestGhostRun = useCallback((distanceHintM) => {
    const list = Array.isArray(history) ? history : []
    const mapped = list
      .filter((item) => !item.mode || item.mode === resolvedMode)
      .map((item) => ({ record: item, timeline: buildGhostTimeline(item) }))
      .filter(({ timeline }) => timeline.length >= MIN_GHOST_SPLITS)
    const filtered = Number.isFinite(distanceHintM)
      ? mapped.filter(({ record }) => {
          const recordDistance = resolveRecordDistance(record)
          return Number.isFinite(recordDistance) && Math.abs(recordDistance - distanceHintM) <= GHOST_DISTANCE_TOLERANCE_M
        })
      : mapped
    const pool = filtered.length ? filtered : mapped
    if (!pool.length) return null
    return pool.reduce((best, current) => {
      if (!best) return current
      const bestDur = Number(best.record.durationMs) || Infinity
      const curDur = Number(current.record.durationMs) || Infinity
      return curDur < bestDur ? current : best
    }, null)
  }, [buildGhostTimeline, history, resolveRecordDistance, resolvedMode])

  const getGhostElapsedAtDistance = useCallback((distanceM) => {
    const timeline = ghostSessionRef.current?.lapsTimeline || []
    if (!timeline.length || !Number.isFinite(distanceM)) return null
    let prev = null
    for (let i = 0; i < timeline.length; i += 1) {
      const point = timeline[i]
      if (point.cumulativeDistanceM >= distanceM) {
        const elapsed = Number(point.elapsedMs)
        if (prev && point.cumulativeDistanceM > prev.cumulativeDistanceM) {
          const ratio = (distanceM - prev.cumulativeDistanceM) / (point.cumulativeDistanceM - prev.cumulativeDistanceM)
          const prevElapsed = Number(prev.elapsedMs)
          if (Number.isFinite(prevElapsed) && Number.isFinite(elapsed)) {
            return prevElapsed + ratio * (elapsed - prevElapsed)
          }
        }
        return Number.isFinite(elapsed) ? elapsed : null
      }
      prev = point
    }
    return null
  }, [])

  const clearError = () => {
    setError('')
    setErrorCode(null)
  }

  const pushError = (code, fallback) => {
    if (code) {
      const translated = SESSION_TEXT[language]?.errors?.[code]
      if (translated) {
        setError(translated)
        setErrorCode(code)
        return
      }
    }
    if (fallback) {
      setError(fallback)
    } else {
      setError('')
    }
    setErrorCode(null)
  }

  const applyGhostTargetSettings = useCallback((targetRecord) => {
    if (!targetRecord) return
    if (Number.isFinite(targetRecord.lapDistanceM)) {
      setLapDistanceM(targetRecord.lapDistanceM === 500 ? 500 : 1000)
    }
    if (Number.isFinite(targetRecord.timeCueMs)) {
      setTimeCueMs(targetRecord.timeCueMs)
    }
    if (targetRecord.targetPaceMs !== undefined) {
      const value = targetRecord.targetPaceMs
      setTargetPaceMs(value === null || value === 'off' ? null : Number(value) || null)
    }
    if (typeof targetRecord.voiceEnabled === 'boolean') {
      setVoiceEnabled(Boolean(targetRecord.voiceEnabled))
    }
    if (targetRecord.goal) {
      setGoalPreset(targetRecord.goal)
    } else {
      const ghostDistance = resolveRecordDistance(targetRecord)
      if (ghostDistance) {
        setGoalPreset({ type: 'distance', value: ghostDistance })
      }
    }
  }, [resolveRecordDistance])

  const handleToggleGhost = useCallback(() => {
    if (ghostEnabled) {
      setGhostEnabled(false)
      setGhostTarget(null)
      setGhostMessage('')
      resetGhostSession()
      return
    }
    // Open history in record sort mode
    setHistoryInitialSort('record')
    setShowHistory(true)
  }, [ghostEnabled, resetGhostSession])

  const handleChallengeRecord = useCallback((record) => {
    if (!record) return
    const timeline = record.ghostTimeline || buildGhostTimeline(record)
    const targetRecord = { ...record, ghostTimeline: timeline }
    setGhostEnabled(true)
    setGhostTarget(targetRecord)
    setGhostMessage(text.ghost?.targetReady || '')
    applyGhostTargetSettings(targetRecord)
    resetGhostSession()
    setShowHistory(false)
  }, [applyGhostTargetSettings, buildGhostTimeline, language, resetGhostSession, text.ghost])

  const prepareGhostSession = useCallback(() => {
    if (!ghostEnabled) {
      resetGhostSession()
      return null
    }
    const distanceHint = goalPreset?.type === 'distance' ? goalPreset.value : null
    const explicitTarget = ghostTarget
      ? { record: ghostTarget, timeline: ghostTarget.ghostTimeline || buildGhostTimeline(ghostTarget) }
      : null
    const candidate = explicitTarget || findBestGhostRun(distanceHint)
    if (!candidate || !candidate.record) {
      const msg = text.ghost?.notFound || ''
      setGhostMessage(msg)
      setGhostEnabled(false)
      setGhostTarget(null)
      resetGhostSession()
      if (voiceEnabledRef.current && msg) {
        const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
        speakOnce(msg, language === 'ko' ? 1.05 : 1.02, { lang: speechLocale, delayMs: 0 }).catch(() => {})
      }
      return null
    }
    const timeline = candidate.timeline && candidate.timeline.length
      ? candidate.timeline
      : buildGhostTimeline(candidate.record)
    const targetRecord = { ...candidate.record, ghostTimeline: timeline }
    ghostSessionRef.current = {
      enabled: true,
      targetRun: targetRecord,
      lapsTimeline: timeline,
      nextKmIndex: 1,
    }
    applyGhostTargetSettings(targetRecord)
    setGhostMessage(text.ghost?.targetReady || '')
    return targetRecord
  }, [applyGhostTargetSettings, buildGhostTimeline, findBestGhostRun, ghostEnabled, goalPreset, ghostTarget, language, resetGhostSession, text.ghost])

  const stopTracking = useCallback(() => {
    if (watchStopRef.current) {
      try {
        watchStopRef.current()
      } catch {}
      watchStopRef.current = null
    }
  }, [])

  const persistHistory = useCallback((record) => {
    setHistory((prev) => {
      const next = [record, ...prev].slice(0, MAX_HISTORY_ITEMS)
      try {
        if (typeof window !== 'undefined') {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
        }
      } catch {}
      return next
    })
  }, [])

  const handleDeleteHistoryEntry = useCallback((id) => {
    setHistory((prev) => {
      const next = prev.filter((item) => item.id !== id)
      try {
        if (typeof window !== 'undefined') {
          if (next.length) {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
          } else {
            localStorage.removeItem(HISTORY_KEY)
          }
        }
      } catch {}
      return next
    })
  }, [])

  useEffect(() => {
    setCapPlatform(resolveCapacitorPlatform())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (sessionActive) return
    try {
      const timeRaw = localStorage.getItem(`${TIME_CUE_STORAGE_KEY}_${resolvedMode}`)
      const fallbackTime = meta.defaultTimeCueMs || 0
      setTimeCueMs(timeRaw !== null ? Number(timeRaw) || 0 : fallbackTime)

      const paceRaw = localStorage.getItem(`${PACE_TARGET_STORAGE_KEY}_${resolvedMode}`)
      if (paceRaw === 'off') {
        setTargetPaceMs(null)
      } else if (paceRaw) {
        setTargetPaceMs(Number(paceRaw) || null)
      } else {
        setTargetPaceMs(meta.defaultTargetPaceMs || null)
      }

      const goalRaw = localStorage.getItem(`${GOAL_STORAGE_KEY}_${resolvedMode}`)
      setGoalPreset(goalRaw ? JSON.parse(goalRaw) : null)
    } catch (err) {
      console.warn('[running] failed to reload mode settings', err)
    }
  }, [resolvedMode, sessionActive, meta.defaultTimeCueMs, meta.defaultTargetPaceMs])

  useEffect(() => {
    // Reset ghost state when switching modes
    setGhostEnabled(false)
    setGhostTarget(null)
    setGhostMessage('')
    resetGhostSession()
  }, [resolvedMode, resetGhostSession])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setHistory(parsed)
        }
      }
    } catch (err) {
      console.warn('[running] failed to load history', err)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleStorageChange = (e) => {
      if (e.key === 'locale' && (e.newValue === 'en' || e.newValue === 'ko')) {
        setLanguage(e.newValue)
      }
    }
    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const checkLocale = () => {
      const saved = localStorage.getItem('locale') || ''
      const newLang = saved === 'ko' ? 'ko' : 'en'
      if (newLang !== language) {
        setLanguage(newLang)
      }
    }
    const interval = setInterval(checkLocale, 500)
    return () => clearInterval(interval)
  }, [language])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopAllTTS().catch(() => {})
        forceUnduck().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('running_voice_enabled', String(voiceEnabled))
    }
    voiceEnabledRef.current = voiceEnabled
  }, [voiceEnabled])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(`${TIME_CUE_STORAGE_KEY}_${resolvedMode}`, String(timeCueMs || 0))
    }
    if (!sessionActive) {
      nextTimeCueRef.current = timeCueMs || null
    }
  }, [timeCueMs, resolvedMode, sessionActive])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const key = `${PACE_TARGET_STORAGE_KEY}_${resolvedMode}`
      if (targetPaceMs) {
        localStorage.setItem(key, String(targetPaceMs))
      } else {
        localStorage.setItem(key, 'off')
      }
    }
  }, [targetPaceMs, resolvedMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = `${GOAL_STORAGE_KEY}_${resolvedMode}`
    try {
      if (!goalPreset) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(goalPreset))
      }
    } catch {}
  }, [goalPreset, resolvedMode])

  useEffect(() => {
    if (!sessionActive) {
      goalRef.current = goalPreset
      goalReachedRef.current = false
    }
  }, [goalPreset, sessionActive])

  useEffect(() => {
    if (!sessionActive) {
      setGoalBanner(null)
    }
  }, [sessionActive])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('running_prevent_screen_lock', String(preventScreenLock))
    }
  }, [preventScreenLock])

  // Auto-activate screen lock when session starts
  useEffect(() => {
    if (!sessionActive) {
      setSessionKeepAwake(false)
      return
    }
    setSessionKeepAwake(preventScreenLock)
  }, [sessionActive, preventScreenLock])

  // Global flag for screen lock status
  useEffect(() => {
    if (typeof window === 'undefined') return
    const locked = sessionActive && sessionKeepAwake
    if (locked) {
      window.__MOTIONFIT_SCREEN_LOCK_ACTIVE__ = true
    } else if (window.__MOTIONFIT_SCREEN_LOCK_ACTIVE__) {
      window.__MOTIONFIT_SCREEN_LOCK_ACTIVE__ = false
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.__MOTIONFIT_SCREEN_LOCK_ACTIVE__ = false
      }
    }
  }, [sessionActive, sessionKeepAwake])

  // Web History API - Block browser back button
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!sessionKeepAwake) return

    const blockPopstate = (event) => {
      if (!sessionKeepAwake || suppressPopstateRef.current) return
      try { event?.preventDefault?.() } catch {}
      try { event?.stopPropagation?.() } catch {}
      try { window.history.go(1) } catch {}
    }

    try {
      window.history.pushState({ __runningLock: Date.now() }, document.title, window.location.href)
      lockHistoryPushedRef.current = true
    } catch {}

    window.addEventListener('popstate', blockPopstate)

    return () => {
      window.removeEventListener('popstate', blockPopstate)
      if (lockHistoryPushedRef.current) {
        suppressPopstateRef.current = true
        try { window.history.back() } catch {}
        setTimeout(() => { suppressPopstateRef.current = false }, 200)
        lockHistoryPushedRef.current = false
      }
    }
  }, [sessionKeepAwake])

  // Hardware back button - Block Android back button during session lock
  useEffect(() => {
    const cleanupExisting = () => {
      if (androidBackCleanupRef.current) {
        try { androidBackCleanupRef.current() } catch {}
        androidBackCleanupRef.current = null
      }
    }
    cleanupExisting()
    if (!sessionKeepAwake) return

    const cleanupFns = []

    // Cordova backbutton
    if (typeof document !== 'undefined') {
      const blockHardwareBack = (e) => {
        try { e?.preventDefault?.() } catch {}
        try { e?.stopPropagation?.() } catch {}
        return false
      }
      document.addEventListener('backbutton', blockHardwareBack, true)
      cleanupFns.push(() => document.removeEventListener('backbutton', blockHardwareBack, true))
    }

    // Window backbutton
    if (typeof window !== 'undefined') {
      const blockHardwareBackWindow = (e) => {
        try { e?.preventDefault?.() } catch {}
        try { e?.stopPropagation?.() } catch {}
        return false
      }
      window.addEventListener('backbutton', blockHardwareBackWindow, true)
      cleanupFns.push(() => window.removeEventListener('backbutton', blockHardwareBackWindow, true))

      const blockHardwareBackPress = (e) => {
        try { e?.preventDefault?.() } catch {}
        try { e?.stopPropagation?.() } catch {}
        return false
      }
      window.addEventListener('hardwarebackpress', blockHardwareBackPress, true)
      cleanupFns.push(() => window.removeEventListener('hardwarebackpress', blockHardwareBackPress, true))
    }

    // Capacitor App
    const cap = typeof window !== 'undefined' ? window.Capacitor?.App : null
    if (cap?.addListener) {
      try {
        cap.addListener('backButton', (event) => {
          try { event?.preventDefault?.() } catch {}
          try { event?.stopImmediatePropagation?.() } catch {}
          return false
        }).then((listener) => {
          cleanupFns.push(() => listener?.remove?.())
        }).catch(() => {})
      } catch {}
    }

    androidBackCleanupRef.current = () => {
      cleanupFns.forEach(fn => { try { fn() } catch {} })
    }

    return () => cleanupExisting()
  }, [sessionKeepAwake])

  // Hardware back button - Handle overlay back navigation (stats/history)
  useEffect(() => {
    if (sessionActive) return // Only handle when session is not active

    const cleanupFns = []

    // Capacitor App - highest priority
    const cap = typeof window !== 'undefined' ? window.Capacitor?.App : null
    if (cap?.addListener) {
      try {
        const handleCapacitorBack = cap.addListener('backButton', (event) => {
          console.log('[Running] Capacitor back button:', { showStats, showHistory })

          if (showStats || showHistory) {
            // Close the overlay instead of going back
            if (showStats) {
              console.log('[Running] Closing stats overlay')
              setShowStats(false)
            }
            if (showHistory) {
              console.log('[Running] Closing history overlay')
              setShowHistory(false)
            }
          } else {
            // Neither overlay is open - allow default back to running menu
            console.log('[Running] Allowing default back navigation')
          }
        })

        if (handleCapacitorBack && typeof handleCapacitorBack === 'object' && handleCapacitorBack.then) {
          handleCapacitorBack.then((listener) => {
            cleanupFns.push(() => {
              try { listener?.remove?.() } catch {}
            })
          }).catch(() => {})
        }
      } catch (err) {
        console.warn('[Running] Capacitor back button setup failed:', err)
      }
    }

    // Cordova backbutton (fallback)
    if (typeof document !== 'undefined') {
      const handleCordovaBack = (e) => {
        if (showStats || showHistory) {
          try { e?.preventDefault?.() } catch {}
          try { e?.stopPropagation?.() } catch {}
          if (showStats) setShowStats(false)
          if (showHistory) setShowHistory(false)
          return false
        }
      }
      document.addEventListener('backbutton', handleCordovaBack, true)
      cleanupFns.push(() => document.removeEventListener('backbutton', handleCordovaBack, true))
    }

    // Window backbutton (fallback)
    if (typeof window !== 'undefined') {
      const handleWindowBack = (e) => {
        if (showStats || showHistory) {
          try { e?.preventDefault?.() } catch {}
          try { e?.stopPropagation?.() } catch {}
          if (showStats) setShowStats(false)
          if (showHistory) setShowHistory(false)
          return false
        }
      }
      window.addEventListener('backbutton', handleWindowBack, true)
      cleanupFns.push(() => window.removeEventListener('backbutton', handleWindowBack, true))

      window.addEventListener('hardwarebackpress', handleWindowBack, true)
      cleanupFns.push(() => window.removeEventListener('hardwarebackpress', handleWindowBack, true))
    }

    return () => {
      cleanupFns.forEach(fn => { try { fn() } catch {} })
    }
  }, [sessionActive, showStats, showHistory])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(LAP_DISTANCE_STORAGE_KEY, String(lapDistanceM))
    }
  }, [lapDistanceM])

  useEffect(() => {
    if (errorCode) {
      const translated = SESSION_TEXT[language]?.errors?.[errorCode]
      if (translated) {
        setError(translated)
      }
    }
  }, [language, errorCode])

  useEffect(() => {
    if (!sessionActive) return undefined
    const lock = async () => {
      try {
        await ScreenOrientation.lock({ orientation: 'portrait' })
      } catch (err) {
        console.log('[running] orientation lock failed', err)
      }
    }
    lock()
    return () => {
      ScreenOrientation.unlock().catch(() => {})
    }
  }, [sessionActive])

  useEffect(() => {
    if (!sessionActive) {
      releaseWakeLock().catch(() => {})
      return
    }
    if (isPaused || !sessionKeepAwake) {
      releaseWakeLock().catch(() => {})
      return
    }
    requestWakeLock().catch(() => {})
    const ensureWakeLock = () => {
      if (document.visibilityState === 'visible' && !isWakeLockActive()) {
        requestWakeLock().catch(() => {})
      }
    }
    const onVisibility = () => ensureWakeLock()
    const interval = setInterval(ensureWakeLock, 20000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      releaseWakeLock().catch(() => {})
    }
  }, [sessionActive, isPaused, sessionKeepAwake])

  useEffect(() => {
    if (!sessionActive) {
      hideBannerAd().catch(() => {})
      setBannerStatus('hidden')
      return
    }
    const adId = capPlatform === 'ios' ? BANNER_AD_UNITS.ios : BANNER_AD_UNITS.android
    if (!adId) {
      setBannerStatus('unavailable')
      return
    }

    let cancelled = false
    setBannerStatus('loading')
    ;(async () => {
      try {
        if (cancelled) return
        const margin = computeBannerTopMargin(capPlatform, safeAreaTop)
        const ok = await showBannerAd({ adId, position: 'TOP_CENTER', adSize: 'BANNER', margin })
        if (!cancelled) {
          setBannerStatus(ok ? 'visible' : 'unavailable')
        }
      } catch (err) {
        if (!cancelled) {
          console.log('[running] banner ad error', err?.message || err)
          setBannerStatus('error')
        }
      }
    })()
    return () => {
      cancelled = true
      hideBannerAd().catch(() => {})
    }
  }, [sessionActive, capPlatform, safeAreaTop])

  useEffect(() => {
    return () => {
      stopTracking()
      releaseWakeLock().catch(() => {})
      hideBannerAd().catch(() => {})
    }
  }, [stopTracking])

  useEffect(() => {
    if (!sessionActive || isPaused) return undefined
    let raf = 0
    const tick = () => {
      if (sessionStartRef.current) {
        const now = Date.now()
        const elapsed = now - sessionStartRef.current - pausedAccumulatedRef.current
        setElapsedMs(elapsed)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [sessionActive, isPaused])

  useEffect(() => {
    if (!sessionActive || isPaused) return
    if (!voiceEnabledRef.current) return
    if (!timeCueMs || timeCueMs <= 0) return
    if (!nextTimeCueRef.current) {
      nextTimeCueRef.current = timeCueMs
    }
    const target = nextTimeCueRef.current
    if (!target) return
    if (elapsedMs >= target) {
      const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
      const announceElapsed = target
      const script = buildTimeCueSpeech({
        elapsedMs: announceElapsed,
        distanceM,
        avgPaceMs,
        currentPaceMs,
        language,
        lastSnapshot: lastTimeCueRef.current,
      })
      speakOnce(script, language === 'ko' ? 1.06 : 1.03, { lang: speechLocale, delayMs: 0 }).catch(() => {})
      lastTimeCueRef.current = {
        elapsedMs: announceElapsed,
        distanceM,
        avgPaceMs,
        currentPaceMs,
        avgSpeed: avgPaceMs ? 3600000 / avgPaceMs : null,
      }
      let nextTarget = target + timeCueMs
      while (elapsedMs >= nextTarget) {
        nextTarget += timeCueMs
      }
      nextTimeCueRef.current = nextTarget
    }
  }, [elapsedMs, sessionActive, isPaused, timeCueMs, distanceM, avgPaceMs, language])

  useEffect(() => {
    if (!sessionActive || isPaused) return
    if (!voiceEnabledRef.current) return
    if (!targetPaceMs || targetPaceMs <= 0) return
    if (!currentPaceMs || currentPaceMs <= 0) return
    const delta = currentPaceMs - targetPaceMs
    const direction = delta > MIN_PACE_COACH_DELTA_MS
      ? 'slow'
      : delta < -MIN_PACE_COACH_DELTA_MS
        ? 'fast'
        : 'ok'
    if (direction === 'ok') {
      paceCoachRef.current = { ts: paceCoachRef.current?.ts || 0, direction: null }
      return
    }
    const now = Date.now()
    const last = paceCoachRef.current || { ts: 0, direction: null }
    const changedDirection = last.direction !== direction
    if (!changedDirection && now - (last.ts || 0) < PACE_COACH_COOLDOWN_MS) return
    const deltaSeconds = Math.max(1, Math.round(Math.abs(delta) / 1000))
    const script = buildPaceCoachSpeech(
      direction,
      deltaSeconds,
      language,
      language === 'ko' ? meta.titleKo : meta.title,
    )
    const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
    speakOnce(script, language === 'ko' ? 1.05 : 1.02, { lang: speechLocale, delayMs: 0 }).catch(() => {})
    paceCoachRef.current = { ts: now, direction }
  }, [currentPaceMs, targetPaceMs, sessionActive, isPaused, language, meta.title, meta.titleKo])

  useEffect(() => {
    if (!sessionActive || isPaused) return
    const goal = goalRef.current
    if (!goal || goalReachedRef.current) return
    const hit = goal.type === 'distance'
      ? distanceM >= goal.value
      : elapsedMs >= goal.value
    if (!hit) return
    goalReachedRef.current = true
    const avgForGoal = distanceM >= MIN_AVG_PACE_DISTANCE_M
      ? elapsedMs / (distanceM / 1000)
      : null
    if (voiceEnabledRef.current) {
      const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
      const script = buildGoalSpeech(goal, elapsedMs, distanceM, avgForGoal, language)
      speakOnce(script, language === 'ko' ? 1.05 : 1.02, { lang: speechLocale, delayMs: 0 }).catch(() => {})
    }
    const goalText = SESSION_TEXT[language]?.goal || SESSION_TEXT.en.goal
    setGoalBanner({
      title: goalText.reached,
      detail: goal.type === 'distance'
        ? `${formatDistanceLabel(goal.value, 1)}`
        : formatClock(goal.value, { showHours: goal.value >= 3600000 }),
    })
  }, [distanceM, elapsedMs, sessionActive, isPaused, language])

  useEffect(() => {
    if (!goalBanner) return undefined
    const timer = setTimeout(() => setGoalBanner(null), 5000)
    return () => clearTimeout(timer)
  }, [goalBanner])

  const handleLocation = useCallback((position) => {
    if (!sessionActive || isPaused) return
    const nowTs = Number(position.timestamp) || Date.now()
    const accuracy = Number.isFinite(position.accuracy) ? position.accuracy : null
    const gpsSpeedRaw = position.coords?.speed ?? position.speed
    const gpsSpeed = Number.isFinite(gpsSpeedRaw) ? gpsSpeedRaw : null
    setLatestAccuracy(Number.isFinite(position.accuracy) ? Math.round(position.accuracy) : null)

    if (accuracy !== null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
      // Accuracy explicitly reported as too low -> ignore
      return
    }

    // If accuracy is missing, only trust samples when GPS speed says we're moving
    if (accuracy === null && (gpsSpeed === null || gpsSpeed < MIN_SPEED_THRESHOLD_MPS)) {
      return
    }

    const currentPoint = {
      latitude: position.latitude,
      longitude: position.longitude,
      timestamp: nowTs,
    }
    routePointsRef.current.push(currentPoint)

    if (!lastPointRef.current) {
      lastPointRef.current = currentPoint
      samplesRef.current.push({ timestamp: nowTs, distance: totalDistanceRef.current })
      return
    }

    const delta = haversineDistanceMeters(lastPointRef.current, currentPoint)
    const minDelta = Math.max(MIN_DISTANCE_DELTA, accuracy !== null ? accuracy : MIN_DISTANCE_DELTA)
    // Skip if reported speed is essentially stopped or movement is within accuracy noise
    if ((gpsSpeed !== null && gpsSpeed < MIN_SPEED_THRESHOLD_MPS) || delta < minDelta) {
      lastPointRef.current = currentPoint
      return
    }

    totalDistanceRef.current += delta
    lastPointRef.current = currentPoint
    setDistanceM(totalDistanceRef.current)

    const elapsed = Math.max(0, nowTs - (sessionStartRef.current || nowTs) - pausedAccumulatedRef.current)
    setElapsedMs(elapsed)

    samplesRef.current.push({ timestamp: nowTs, distance: totalDistanceRef.current })
    if (samplesRef.current.length > 180) samplesRef.current.shift()

    // Improved average pace calculation: wait for 100m to reduce GPS noise impact
    const avgPace = totalDistanceRef.current >= MIN_AVG_PACE_DISTANCE_M
      ? elapsed / (totalDistanceRef.current / 1000)
      : null
    setAvgPaceMs(avgPace)

    // Improved current pace using GPS speed when available
    if (gpsSpeed != null && gpsSpeed >= 0) {
      // Use GPS speed (m/s) with EMA smoothing for stability
      const currentSpeed = gpsSpeed

      // Apply exponential smoothing to reduce jitter
      if (smoothedSpeedRef.current === null) {
        smoothedSpeedRef.current = currentSpeed
      } else {
        smoothedSpeedRef.current = smoothedSpeedRef.current * (1 - SPEED_SMOOTHING_FACTOR) + currentSpeed * SPEED_SMOOTHING_FACTOR
      }

      // Convert smoothed speed to pace
      if (smoothedSpeedRef.current < MIN_SPEED_THRESHOLD_MPS) {
        // Below minimum threshold = stopped
        setCurrentPaceMs(null)
      } else {
        // Convert m/s to ms/km: (1000m / speed_m_per_s) * 1000ms
        const paceMs = 1000000 / smoothedSpeedRef.current
        setCurrentPaceMs(paceMs)
      }
    } else {
      // Fallback to distance-based calculation if GPS speed unavailable
      const samples = samplesRef.current
      const latestSample = samples[samples.length - 1]
      let anchor = samples[0]
      for (let i = samples.length - 2; i >= 0; i -= 1) {
        const candidate = samples[i]
        if (latestSample.timestamp - candidate.timestamp >= CURRENT_PACE_WINDOW_MS) {
          anchor = candidate
          break
        }
      }
      const distDelta = latestSample.distance - anchor.distance
      const timeDelta = latestSample.timestamp - anchor.timestamp
      const paceMinDelta = Math.max(CURRENT_PACE_MIN_DISTANCE_M, accuracy !== null ? accuracy : 0)
      if (distDelta >= paceMinDelta && timeDelta > 0) {
        setCurrentPaceMs(timeDelta / (distDelta / 1000))
      } else if (timeDelta >= CURRENT_PACE_WINDOW_MS) {
        setCurrentPaceMs(null)
        smoothedSpeedRef.current = null // Reset smoothing
      }
    }

    // Ghost comparison at each kilometer mark
    if (ghostSessionRef.current?.enabled) {
      let nextKm = ghostSessionRef.current.nextKmIndex || 1
      const lastGhostLap = ghostSessionRef.current.lapsTimeline?.[ghostSessionRef.current.lapsTimeline.length - 1]
      const ghostMaxKm = lastGhostLap ? Math.ceil((Number(lastGhostLap.cumulativeDistanceM) || 0) / 1000) : Infinity
      while (totalDistanceRef.current >= nextKm * 1000 && nextKm <= ghostMaxKm + 1) {
        const ghostElapsed = getGhostElapsedAtDistance(nextKm * 1000)
        if (ghostElapsed != null && voiceEnabledRef.current) {
          const diffSeconds = Math.round((elapsed - ghostElapsed) / 1000)
          const script = buildGhostDeltaSpeech(nextKm, diffSeconds, language)
          if (script) {
            const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
            speakOnce(script, language === 'ko' ? 1.05 : 1.02, { lang: speechLocale, delayMs: 0 }).catch(() => {})
          }
        }
        ghostSessionRef.current.nextKmIndex = nextKm + 1
        nextKm += 1
      }
    }

    if (totalDistanceRef.current >= lapTargetRef.current) {
      const lapIndex = lapsRef.current.length + 1
      const lapDuration = lapStartTimeRef.current
        ? nowTs - lapStartTimeRef.current - lapPausedAccumulatedRef.current
        : elapsed
      const lapDistance = Math.max(1, totalDistanceRef.current - lapStartDistanceRef.current)
      const lapPace = lapDuration / (lapDistance / 1000)
      const lap = {
        index: lapIndex,
        durationMs: lapDuration,
        paceMs: lapPace,
        distanceM: lapDistance,
        timestamp: nowTs,
        elapsedMs: elapsed,
      }
      lapsRef.current = [...lapsRef.current, lap]
      setLaps(lapsRef.current)
      lapStartTimeRef.current = nowTs
      lapStartDistanceRef.current = totalDistanceRef.current
      lapTargetRef.current += lapDistanceM
      lapPausedAccumulatedRef.current = 0
      lapPauseStartRef.current = 0

      // Show lap completion alert
      setLapAlert({
        lapNumber: lapIndex,
        lapDurationMs: lapDuration,
        lapPaceMs: lapPace,
        avgPaceMs: avgPace,
      })

      if (voiceEnabledRef.current) {
        const speechLocale = language === 'ko' ? 'ko-KR' : 'en-US'
        const script = buildLapSpeech(lapIndex, lapDuration, lapPace, avgPace, language)
        speakOnce(script, language === 'ko' ? 1.08 : 1.04, { lang: speechLocale, delayMs: 0 }).catch(() => {})
      }
    }
  }, [sessionActive, isPaused, language, lapDistanceM, getGhostElapsedAtDistance])

  useEffect(() => {
    if (!sessionActive || isPaused) {
      stopTracking()
      return undefined
    }
    const stop = watchLocation(
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 },
      handleLocation,
      (err) => {
        console.warn('[running] location error', err)
        // Transient watch errors (e.g. backgrounding / temporary unavailability)
        // are common on mobile. We log them for debugging but avoid showing a
        // persistent error banner above the content.
      },
    )
    watchStopRef.current = stop
    return () => {
      try { stop?.() } catch {}
      if (watchStopRef.current === stop) {
        watchStopRef.current = null
      }
    }
  }, [sessionActive, isPaused, handleLocation, stopTracking])

  const handleStartSession = async () => {
    if (starting || sessionActive) return
    clearError()
    setStarting(true)
    try {
      const permission = await ensureLocationPermission()
      setLocationPermission(permission)
      if (permission !== 'granted' && permission !== 'limited') {
        pushError('permission')
        return
      }
      if (voiceEnabled) {
        try {
          await unlockTTS(language === 'ko' ? 'ko-KR' : 'en-US')
        } catch (err) {
          console.warn('[running] TTS unlock failed', err)
        }
      }
      prepareGhostSession()
      totalDistanceRef.current = 0
      sessionStartRef.current = Date.now()
      lapStartTimeRef.current = sessionStartRef.current
      lapStartDistanceRef.current = 0
      lapPausedAccumulatedRef.current = 0
      lapPauseStartRef.current = 0
      pausedAccumulatedRef.current = 0
      lapTargetRef.current = lapDistanceM
      lastPointRef.current = null
      routePointsRef.current = []
      samplesRef.current = []
      lapsRef.current = []
      smoothedSpeedRef.current = null
      goalRef.current = goalPreset
      goalReachedRef.current = false
      lastTimeCueRef.current = null
      nextTimeCueRef.current = timeCueMs || null
      paceCoachRef.current = { ts: 0, direction: null }
      setGoalBanner(null)
      setLaps([])
      setRoutePoints([])
      setDistanceM(0)
      setElapsedMs(0)
      setCurrentPaceMs(null)
      setAvgPaceMs(null)
      setLatestAccuracy(null)
      setShowStats(false)
      setWorkoutStats(null)
      setSessionActive(true)
      setIsPaused(false)
    } catch (err) {
      pushError('generic', err?.message)
    } finally {
      setStarting(false)
    }
  }

  const handlePause = () => {
    if (!sessionActive || isPaused) return
    pauseStartRef.current = Date.now()
    lapPauseStartRef.current = pauseStartRef.current
    setIsPaused(true)
  }

  const handleResume = () => {
    if (!sessionActive || !isPaused) return
    pausedAccumulatedRef.current += Date.now() - (pauseStartRef.current || Date.now())
    if (lapPauseStartRef.current) {
      lapPausedAccumulatedRef.current += Date.now() - lapPauseStartRef.current
    }
    lapPauseStartRef.current = 0
    pauseStartRef.current = 0
    setIsPaused(false)
    lastPointRef.current = null
    smoothedSpeedRef.current = null // Reset speed smoothing after pause
    paceCoachRef.current = { ts: 0, direction: null }
  }

  const finalizeSession = useCallback(() => {
    stopTracking()
    const endTs = Date.now()
    const sessionPauseCarry = pauseStartRef.current ? endTs - pauseStartRef.current : 0
    const duration = sessionStartRef.current
      ? endTs - sessionStartRef.current - pausedAccumulatedRef.current - sessionPauseCarry
      : 0
    const distance = totalDistanceRef.current
    const avgPace = distance >= MIN_AVG_PACE_DISTANCE_M ? duration / (distance / 1000) : null
    const lapSnapshot = lapsRef.current.map((lap) => ({ ...lap }))
    const routeSnapshot = routePointsRef.current.map((pt) => ({ ...pt }))
    let ghostResult = null
    if (ghostSessionRef.current?.enabled && ghostSessionRef.current.targetRun) {
      const target = ghostSessionRef.current.targetRun
      const targetDuration = Number(target.durationMs ?? target.duration)
      const targetDistance = resolveRecordDistance(target)
      const targetGoal = target.goal
      let goalCompleted = true
      if (targetGoal?.type === 'distance' && Number.isFinite(targetGoal.value)) {
        goalCompleted = distance >= targetGoal.value - 10
      } else if (targetGoal?.type === 'time' && Number.isFinite(targetGoal.value)) {
        goalCompleted = duration >= targetGoal.value
      } else if (Number.isFinite(targetDistance)) {
        goalCompleted = distance >= targetDistance - 10 // fallback distance check
      }
      if (Number.isFinite(targetDuration)) {
        const diffSeconds = Math.round((duration - targetDuration) / 1000)
        ghostResult = {
          targetRunId: target.id || target.startedAt || target.timestamp || null,
          targetDistanceM: targetDistance,
          targetDurationMs: targetDuration,
          success: goalCompleted && diffSeconds < 0,
          distanceCompleted: goalCompleted,
          diffSeconds,
        }
      }
    }

    // Auto-save session to history immediately
    persistHistory({
      id: `${Date.now()}`,
      mode: resolvedMode,
      startedAt: sessionStartRef.current,
      durationMs: duration,
      distanceM: distance,
      avgPaceMs: avgPace,
      laps: lapSnapshot,
      route: routeSnapshot,
      lapDistanceM,
      timeCueMs,
      targetPaceMs,
      goal: goalRef.current || null,
      voiceEnabled: voiceEnabledRef.current,
      ghostResult,
    })

    const summaryText = SESSION_TEXT[language]?.summary || SESSION_TEXT.en.summary
    setWorkoutStats({
      totalTime: { value: formatClock(duration, { showHours: duration >= 3600000 }), label: summaryText.totalTime },
      totalDistance: { value: formatDistanceLabel(distance, 2), label: summaryText.distance },
      avgPace: { value: avgPace ? formatPaceLabel(avgPace) : '--:-- /km', label: summaryText.avgPace },
      laps: { value: `${lapSnapshot.length}`, label: summaryText.laps },
    })
    setSummaryMeta({
      startedAt: sessionStartRef.current,
      mode: resolvedMode,
      goal: goalRef.current || null,
      lapDistanceM,
      timeCueMs,
      targetPaceMs,
      voiceEnabled: voiceEnabledRef.current,
      distanceM: distance,
      durationMs: duration,
      avgPaceMs: avgPace,
      lapCount: lapSnapshot.length,
      ghostResult,
      ghostTarget: ghostSessionRef.current?.enabled ? {
        id: ghostSessionRef.current.targetRun?.id || null,
        distanceM: resolveRecordDistance(ghostSessionRef.current.targetRun),
        durationMs: ghostSessionRef.current.targetRun?.durationMs
          ?? ghostSessionRef.current.targetRun?.duration
          ?? null,
      } : null,
    })
    setRoutePoints(routeSnapshot)
    setShowStats(true)
    resetGhostSession()
    setGhostEnabled(false)
    setGhostTarget(null)
    setGhostMessage('')
  }, [language, lapDistanceM, persistHistory, resolvedMode, resetGhostSession, resolveRecordDistance, stopTracking, timeCueMs, targetPaceMs])

  const handleEndSession = () => {
    if (!sessionActive) return
    setSessionActive(false)
    setIsPaused(false)
    finalizeSession()
  }


  const nextLapMeters = Math.max(0, lapTargetRef.current - totalDistanceRef.current)
  const startButtonLabel = language === 'ko'
    ? `${modeTitle}${text.setup.startSuffix}`
    : `${text.setup.startPrefix} ${modeTitle}`.trim()
  const timeCueLabel = timeCueMs
    ? `${Math.round(timeCueMs / 60000)}${language === 'ko' ? '분' : 'm'}`
    : language === 'ko'
      ? '끄기'
      : 'Off'
  const paceGuideLabel = targetPaceMs ? formatPaceLabel(targetPaceMs) : language === 'ko' ? '끄기' : 'Off'
  const goalLabel = goalPreset ? formatGoalLabel(goalPreset, language) : ''
  const ghostTargetRecord = ghostTarget || ghostSessionRef.current?.targetRun || null
  const ghostDistance = ghostTargetRecord
    ? resolveRecordDistance(ghostTargetRecord) || ghostTargetRecord.distanceM || ghostTargetRecord.distance
    : null
  const ghostDuration = Number(ghostTargetRecord?.durationMs || ghostTargetRecord?.duration || null)
  const ghostAvgPaceFromTarget = ghostTargetRecord
    ? ghostTargetRecord.avgPaceMs || (
      Number(ghostDuration) && Number(ghostDistance)
        ? ghostDuration / ((ghostDistance || 1) / 1000)
        : null
    )
    : null
  const ghostTargetText = ghostTargetRecord && Number.isFinite(ghostDistance)
    ? `${formatDistanceLabel(Number(ghostDistance), 2)}${Number.isFinite(ghostDuration) ? ` / ${formatClock(ghostDuration, { showHours: ghostDuration >= 3600000 })}` : ''}${ghostAvgPaceFromTarget ? ` / ${formatPaceLabel(ghostAvgPaceFromTarget)}` : ''}`
    : ''
  const ghostButtonLabel = ghostEnabled
    ? (text.ghost?.disableButton || 'Cancel challenge')
    : (text.ghost?.enableButton || 'Start challenge')
  const lapSummaryContent = laps.length ? (
    <div className="space-y-2 text-white">
      <p className="text-xs uppercase tracking-[0.35em] text-white/60">{text.summary.lapList}</p>
      <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
        {laps.map((lap) => (
          <div
            key={lap.index}
            className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80"
          >
            <span className="font-semibold text-white">
              {language === 'ko' ? `${lap.index}구간` : `Lap ${lap.index}`} · {formatDistanceLabel(lap.distanceM, 2)}
            </span>
            <span>{formatClock(lap.durationMs)}</span>
            <span className="text-emerald-200">{formatPaceLabel(lap.paceMs)}</span>
          </div>
        ))}
      </div>
    </div>
  ) : null

  const runningSectionMarginClass = sessionActive
    ? capPlatform === 'ios'
      ? 'mt-0'
      : capPlatform === 'android'
        ? 'mt-2'
        : 'mt-20'
    : 'mt-6'
  const stackSpacingClass = capPlatform === 'ios' ? 'space-y-1' : 'space-y-2'
  const hasBannerSpace =
    (capPlatform === 'ios' || capPlatform === 'android') &&
    sessionActive &&
    (bannerStatus === 'visible' || bannerStatus === 'loading')
  const goalDistancePresets = [
    { value: 0, label: language === 'ko' ? '설정 안 함' : 'No goal' },
    { value: 1000, label: language === 'ko' ? '1km' : '1 km' },
    { value: 3000, label: language === 'ko' ? '3km' : '3 km' },
    { value: 5000, label: language === 'ko' ? '5km' : '5 km' },
    { value: 8000, label: language === 'ko' ? '8km' : '8 km' },
    { value: 10000, label: language === 'ko' ? '10km' : '10 km' },
    { value: 15000, label: language === 'ko' ? '15km' : '15 km' },
    { value: 20000, label: language === 'ko' ? '20km' : '20 km' },
  ]
  const goalTimePresets = [
    { value: 0, label: language === 'ko' ? '설정 안 함' : 'No goal' },
    { value: 30 * 60 * 1000, label: language === 'ko' ? '30분' : '30 min' },
    { value: 40 * 60 * 1000, label: language === 'ko' ? '40분' : '40 min' },
    { value: 50 * 60 * 1000, label: language === 'ko' ? '50분' : '50 min' },
    { value: 60 * 60 * 1000, label: language === 'ko' ? '60분' : '60 min' },
    { value: 90 * 60 * 1000, label: language === 'ko' ? '1시간 30분' : '1 hr 30 min' },
  ]
  const timeCueOptions = [
    { value: 0, label: language === 'ko' ? '끄기' : 'Off' },
    { value: 5 * 60 * 1000, label: language === 'ko' ? '5분마다' : 'Every 5 min' },
    { value: 10 * 60 * 1000, label: language === 'ko' ? '10분마다' : 'Every 10 min' },
  ]
  const paceGuideOptions = (resolvedMode === 'walk'
    ? [
        { value: null, label: language === 'ko' ? '끄기' : 'Off' },
        { value: 9 * 60 * 1000, label: formatPaceLabel(9 * 60 * 1000) },
        { value: 10 * 60 * 1000, label: formatPaceLabel(10 * 60 * 1000) },
        { value: 11 * 60 * 1000, label: formatPaceLabel(11 * 60 * 1000) },
      ]
    : [
        { value: null, label: language === 'ko' ? '끄기' : 'Off' },
        { value: 5.5 * 60 * 1000, label: formatPaceLabel(5.5 * 60 * 1000) },
        { value: 6 * 60 * 1000, label: formatPaceLabel(6 * 60 * 1000) },
        { value: 6.5 * 60 * 1000, label: formatPaceLabel(6.5 * 60 * 1000) },
        { value: 7 * 60 * 1000, label: formatPaceLabel(7 * 60 * 1000) },
      ])

  const modeHistory = Array.isArray(history)
    ? history.filter((item) => !item.mode || item.mode === resolvedMode)
    : []

  return (
    <div className={stackSpacingClass}>
      {error && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          {error}
        </div>
      )}
      <div
        aria-hidden="true"
        ref={bannerAnchorRef}
        className="w-full"
        style={{ height: hasBannerSpace ? getBannerPlaceholderHeight(capPlatform) : 0 }}
      />

      {sessionActive ? (
        <>
          {goalBanner && (
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-emerald-50 shadow-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em]">{goalBanner.title}</p>
                  <p className="text-sm font-semibold">{goalBanner.detail}</p>
                </div>
              </div>
            </div>
          )}

          {/* Screen Lock Overlay - Blocks all touches except lock button */}
          {sessionKeepAwake && (
            <div
              className="fixed inset-0 bg-transparent pointer-events-auto"
              style={{ touchAction: 'none', zIndex: 60 }}
              onPointerDown={blockLockedInteraction}
              onPointerMove={blockLockedInteraction}
              onPointerUp={blockLockedInteraction}
              onTouchStart={blockLockedInteraction}
              onTouchEnd={blockLockedInteraction}
              onClick={blockLockedInteraction}
            >
              <span className="sr-only">
                {language === 'ko' ? '잠금 모드가 활성화되었습니다. 잠금 아이콘을 눌러 해제하세요.' : 'Screen lock active. Tap the lock icon to unlock.'}
              </span>
            </div>
          )}

          {/* Main Timer Display - 중앙 대형 타이머 */}
          <section className={`${runningSectionMarginClass} rounded-3xl border-2 border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-blue-500/5 to-cyan-500/10 p-5 text-white shadow-2xl backdrop-blur-xl transition-all duration-300`}>
            <div className="absolute -inset-1 bg-gradient-to-r from-emerald-400/20 via-blue-500/20 to-cyan-500/20 blur-xl -z-10"></div>

            {/* GPS Accuracy Badge */}
            <div className="flex justify-between items-center mb-4">
              <div className="relative">
                <h3 className="text-base font-black tracking-tight text-white/90">{modeTitle}</h3>
              </div>
              {latestAccuracy ? (
                <div className="flex items-center gap-1.5 rounded-full bg-black/30 px-3 py-1 backdrop-blur-sm">
                  <span className="text-xs font-medium text-white/80">{`GPS ±${latestAccuracy}m`}</span>
                </div>
              ) : null}
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1 text-[0.7rem] font-semibold text-white/80">
                {text.setup.timeCue}: {timeCueLabel}
              </span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-[0.7rem] font-semibold text-white/80">
                {text.setup.paceGuide}: {paceGuideLabel}
              </span>
              {ghostEnabled && (
                <span className="rounded-full bg-cyan-500/20 px-3 py-1 text-[0.7rem] font-semibold text-cyan-50 border border-cyan-400/30">
                  {text.ghost?.title || 'Ghost'}: {ghostTargetText || (text.ghost?.subtitle || '')}
                </span>
              )}
              {goalPreset && (
                <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-[0.7rem] font-semibold text-emerald-50">
                  {text.goal.title}: {goalLabel}
                </span>
              )}
            </div>

            {/* Main Timer */}
            <div className="text-center mb-3">
              <div className="text-6xl font-black tracking-tighter text-white tabular-nums">
                {formatClock(elapsedMs, { showHours: elapsedMs >= 3600000, showCentiseconds: true })}
              </div>
              {/* Current Speed Display - 타이머 바로 아래 */}
              <div className="mt-2">
                <p className="text-[0.65rem] uppercase tracking-[0.2em] text-cyan-300/70 font-bold mb-1">
                  {text.stats.currentSpeed}
                </p>
                <div className="flex items-baseline justify-center gap-2">
                  <span className={`text-3xl font-black text-cyan-100 tabular-nums transition-all duration-300 ${!isPaused ? 'animate-pulse' : ''}`}>
                    {formatSpeedLabel(currentPaceMs).split(' ')[0]}
                  </span>
                  <span className="text-base font-bold text-cyan-300/80">km/h</span>
                </div>
              </div>
            </div>

            {/* 2x2 Stats Grid */}
            <div className="grid grid-cols-2 gap-3">
              <StatTile label={text.stats.distance} value={formatDistanceLabel(distanceM, 2)} accent={meta.accentColor} />
              <StatTile label={text.stats.average} value={avgPaceMs ? formatPaceLabel(avgPaceMs) : '--:-- /km'} accent={meta.accentColor} />
              <StatTile label={text.stats.current} value={currentPaceMs ? formatPaceLabel(currentPaceMs) : '--:-- /km'} accent={meta.accentColor} />
              <StatTile label={text.stats.avgSpeed} value={formatSpeedLabel(avgPaceMs)} accent={meta.accentColor} />
            </div>
          </section>

          {/* Lap Progress and Control Buttons - with custom spacing */}
          <div className="space-y-4">
            {/* Lap Progress */}
            <div className="rounded-2xl border border-white/15 bg-gradient-to-br from-white/5 to-black/20 p-3 backdrop-blur-sm">
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="font-semibold text-white/90">{text.laps.next}</span>
                <span className="font-bold text-emerald-300">{formatDistanceLabel(nextLapMeters, 2)}</span>
              </div>
              <div className="relative h-2.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 transition-all duration-300 relative"
                  style={{ width: `${Math.min(100, Math.max(0, ((lapDistanceM - nextLapMeters) / lapDistanceM) * 100))}%` }}
                >
                  <div className="absolute inset-0 bg-white/30 animate-shimmer"></div>
                </div>
              </div>
            </div>

            {/* Control Buttons */}
            <div className="flex items-center justify-center gap-5">
            {isPaused ? (
              <button
                onClick={handleResume}
                className="group relative flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 border-emerald-400/90 bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 text-emerald-100 shadow-2xl shadow-emerald-500/30 transition-all duration-200 active:scale-95"
              >
                <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-lg group-hover:bg-emerald-400/40 transition-all"></div>
                <div className="relative flex flex-col items-center justify-center gap-0.5">
                  <span className="text-3xl">▶</span>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-emerald-100">{text.controls.resume}</span>
                </div>
              </button>
            ) : (
              <button
                onClick={handlePause}
                className="group relative flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 border-white/50 bg-gradient-to-br from-white/10 to-black/30 text-white shadow-2xl shadow-black/40 transition-all duration-200 active:scale-95"
              >
                <div className="absolute inset-0 rounded-full bg-white/10 blur-lg group-hover:bg-white/20 transition-all"></div>
                <div className="relative flex flex-col items-center justify-center gap-0.5">
                  <span className="text-3xl">⏸</span>
                  <span className="text-[0.55rem] font-bold uppercase tracking-wider text-white">{text.controls.pause}</span>
                </div>
              </button>
            )}

            <button
              onClick={handleEndSession}
              className="group relative flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 border-rose-400/90 bg-gradient-to-br from-rose-500/30 to-rose-600/20 text-rose-100 shadow-2xl shadow-rose-500/30 transition-all duration-200 active:scale-95"
            >
              <div className="absolute inset-0 rounded-full bg-rose-400/20 blur-lg group-hover:bg-rose-400/40 transition-all"></div>
              <div className="relative flex flex-col items-center justify-center gap-0.5">
                <span className="text-3xl">■</span>
                <span className="text-[0.55rem] font-bold uppercase tracking-wider text-rose-100">{text.controls.end}</span>
              </div>
            </button>

            {/* Screen Lock Toggle Button */}
            <button
              type="button"
              onClick={() => setSessionKeepAwake(prev => !prev)}
              className="group relative flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 border-white/40 bg-gradient-to-br from-white/20 to-black/30 text-white shadow-xl backdrop-blur-sm transition-all duration-200 active:scale-95 hover:border-white/60"
              style={{ zIndex: 70 }}
            >
              <div className="absolute inset-0 rounded-full bg-white/10 blur-lg group-hover:bg-white/20 transition-all"></div>
              <div className="relative flex flex-col items-center justify-center gap-0.5">
                {sessionKeepAwake ? (
                  // Locked icon
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8.25 10V7.5a3.75 3.75 0 117.5 0V10" />
                    <rect x="6" y="10" width="12" height="10" rx="2" />
                    <circle cx="12" cy="15" r="1.5" fill="currentColor" />
                  </svg>
                ) : (
                  // Unlocked icon
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 10V6.5a3 3 0 016 0" />
                    <path d="M9 6.5L6 4.5" strokeWidth="1.5" />
                    <path d="M7 4L5.5 3" strokeWidth="1.5" />
                    <rect x="6" y="10" width="12" height="10" rx="2" />
                    <circle cx="12" cy="15" r="1.5" fill="currentColor" />
                  </svg>
                )}
                <span className="text-[0.55rem] font-bold uppercase tracking-wider text-white">
                  {sessionKeepAwake ? (language === 'ko' ? '잠금' : 'Lock') : (language === 'ko' ? '해제' : 'Unlock')}
                </span>
              </div>
            </button>
            </div>
          </div>

        </>
      ) : (
          <div className="rounded-3xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 text-white backdrop-blur-xl flex flex-col shadow-xl overflow-hidden">
            <div className="flex flex-col h-full overflow-y-auto overscroll-contain p-6 space-y-4">
              {/* Header */}
              <div className="text-center flex-shrink-0">
                <h1 className="text-3xl font-black bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 via-blue-300 to-cyan-300">
                  {modeTitle}
                </h1>
              </div>

              {/* Goal Selection */}
              <div className="flex-shrink-0">
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-xs font-bold text-white/70 uppercase tracking-wider">
                    {text.goal.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowGoalGuide(true)}
                    aria-label={language === 'ko' ? '목표 안내' : 'Goal help'}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-white/30 bg-white/10 text-[0.7rem] text-white/80 hover:border-white/60 hover:text-white transition-colors"
                  >
                    ?
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <CustomDropdown
                    value={goalPreset?.type === 'distance' ? goalPreset.value : 0}
                    options={goalDistancePresets}
                    onChange={(val) => handleSelectGoalPreset(val ? { type: 'distance', value: val } : null)}
                    label={text.goal.distance}
                    open={goalDistanceDropdownOpen}
                    setOpen={(next) => {
                      if (next) {
                        setGoalTimeDropdownOpen(false)
                      }
                      setGoalDistanceDropdownOpen(next)
                    }}
                  />
                  <CustomDropdown
                    value={goalPreset?.type === 'time' ? goalPreset.value : 0}
                    options={goalTimePresets}
                    onChange={(val) => handleSelectGoalPreset(val ? { type: 'time', value: val } : null)}
                    label={text.goal.time}
                    open={goalTimeDropdownOpen}
                    setOpen={(next) => {
                      if (next) {
                        setGoalDistanceDropdownOpen(false)
                      }
                      setGoalTimeDropdownOpen(next)
                    }}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                  <span className="text-xs text-white/70">
                    {goalPreset ? goalLabel : text.goal.none}
                  </span>
                  <button
                    type="button"
                    onClick={() => setGoalPreset(null)}
                    className="text-xs font-bold text-emerald-300 hover:text-emerald-200 transition-colors"
                  >
                    {text.goal.clear}
                  </button>
                </div>
              </div>

              {/* Ghost Mode */}
              <div className="flex-shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold text-white/70 uppercase tracking-wider">
                    {text.ghost?.title || 'Ghost Mode'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowGhostGuide((prev) => !prev)}
                    aria-label={language === 'ko' ? '고스트 모드 안내' : 'Ghost mode help'}
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-white/30 bg-white/10 text-[0.65rem] text-white/80 hover:border-white/60 hover:text-white transition-colors"
                  >
                    ?
                  </button>
                </div>
                {showGhostGuide && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70">
                    {text.ghost?.subtitle || 'Challenge your past best run with the same settings.'}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-white/5 px-4 py-3">
                  <p className="text-sm font-semibold text-white truncate">
                    {ghostTargetText || ghostMessage || text.ghost?.subtitle}
                  </p>
                  <button
                    type="button"
                    onClick={handleToggleGhost}
                    className={`flex-shrink-0 rounded-full px-3 py-2 text-[0.75rem] font-bold transition-all duration-200 active:scale-95 ${
                      ghostEnabled
                        ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-400/40'
                        : 'bg-white/10 text-white/80 border border-white/20 hover:border-white/40'
                    }`}
                  >
                    {ghostButtonLabel}
                  </button>
                </div>
              </div>

              {/* Settings Row */}
              <div className="flex-shrink-0">
                <div className="mb-3 flex items-center gap-2">
                  <p className="text-xs font-bold text-white/70 uppercase tracking-wider">
                    {language === 'ko' ? '설정' : 'Settings'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowSettingsGuide(true)}
                    aria-label={language === 'ko' ? '설정 안내' : 'Settings help'}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-white/30 bg-white/10 text-[0.7rem] text-white/80 hover:border-white/60 hover:text-white transition-colors"
                  >
                    ?
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <CustomDropdown
                    value={lapDistanceM}
                    options={[
                      { value: 500, label: '500m' },
                      { value: 1000, label: '1km' }
                    ]}
                    onChange={setLapDistanceM}
                    label={text.setup.lapDistanceLabel}
                    open={lapDistanceDropdownOpen}
                    setOpen={(next) => {
                      if (next) {
                        setTimeCueDropdownOpen(false)
                        setPaceTargetDropdownOpen(false)
                      }
                      setLapDistanceDropdownOpen(next)
                    }}
                  />

                  <CustomDropdown
                    value={timeCueMs}
                    options={timeCueOptions}
                    onChange={setTimeCueMs}
                    label={text.setup.timeCue}
                    open={timeCueDropdownOpen}
                    setOpen={(next) => {
                      if (next) {
                        setLapDistanceDropdownOpen(false)
                        setPaceTargetDropdownOpen(false)
                      }
                      setTimeCueDropdownOpen(next)
                    }}
                  />

                  <CustomDropdown
                    value={targetPaceMs}
                    options={paceGuideOptions}
                    onChange={setTargetPaceMs}
                    label={text.setup.paceGuide}
                    open={paceTargetDropdownOpen}
                    setOpen={(next) => {
                      if (next) {
                        setLapDistanceDropdownOpen(false)
                        setTimeCueDropdownOpen(false)
                      }
                      setPaceTargetDropdownOpen(next)
                    }}
                  />

                  <button
                    type="button"
                    onClick={() => setVoiceEnabled((prev) => !prev)}
                    className={`flex w-full items-center justify-center rounded-2xl border-2 px-2 py-3 text-[0.75rem] font-bold shadow-lg transition-all duration-200 active:scale-95 ${
                      voiceEnabled
                        ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 text-emerald-100 hover:shadow-emerald-500/30'
                        : 'border-white/30 bg-gradient-to-br from-black/40 to-black/20 text-white/70 hover:border-white/50'
                    }`}
                  >
                    {voiceEnabled ? text.setup.voiceOn : text.setup.voiceOff}
                  </button>
                </div>
              </div>

              {/* Recent Records Preview - Only show if there are records */}
              {modeHistory.length > 0 && (
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-bold text-white/70 uppercase tracking-wider">
                      {language === 'ko' ? '최근 기록' : 'Recent Records'}
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowHistory(true)}
                      className="text-xs font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      {language === 'ko' ? '전체보기 ›' : 'View All ›'}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {modeHistory.slice(0, 2).map((entry, idx) => {
                      // Use startedAt or timestamp, whichever is available
                      const timestamp = entry.startedAt || entry.timestamp
                      const entryDate = timestamp ? new Date(timestamp) : null

                      let dateStr = language === 'ko' ? '날짜 없음' : 'No date'
                      if (entryDate && !isNaN(entryDate.getTime())) {
                        if (language === 'ko') {
                          dateStr = `${entryDate.getMonth() + 1}월 ${entryDate.getDate()}일`
                        } else {
                          dateStr = entryDate.toLocaleDateString('en', { month: 'short', day: 'numeric' })
                        }
                      }

                      return (
                        <div
                          key={idx}
                          className="rounded-xl border border-white/10 bg-gradient-to-r from-white/5 to-white/10 p-3 backdrop-blur-sm hover:border-white/20 transition-all duration-200"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-bold text-white/90">
                                {formatDistanceLabel(entry.distanceM)}
                              </p>
                              <p className="text-xs text-white/50">{dateStr}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs font-bold text-emerald-300">
                                {formatClock(entry.durationMs)}
                              </p>
                              <p className="text-xs text-white/50">
                                {formatPaceLabel(entry.avgPaceMs)}
                              </p>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Start Button */}
              <button
                onClick={handleStartSession}
                disabled={starting}
                className="group relative w-full flex-shrink-0 rounded-3xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 px-6 py-5 text-xl font-black text-black shadow-2xl transition-all duration-200 active:scale-95 disabled:opacity-60 hover:shadow-emerald-500/50 overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-white/20 via-transparent to-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <span className="relative">{starting ? text.setup.preparing : startButtonLabel}</span>
              </button>
            </div>
          </div>
      )}

      <RunningHistoryOverlay
        isVisible={showHistory}
      language={language}
      entries={modeHistory}
      mode={resolvedMode}
      onClose={() => {
        setShowHistory(false)
        setHistoryInitialSort('recent')
      }}
      onDeleteEntry={handleDeleteHistoryEntry}
      onChallengeEntry={handleChallengeRecord}
      initialSortBy={historyInitialSort}
    />

      <RunningSummaryOverlay
        isVisible={showStats}
        modeTitle={modeTitle}
        language={language}
        stats={workoutStats}
        meta={summaryMeta}
        routePoints={routePoints}
        extraContent={lapSummaryContent}
        onClose={() => setShowStats(false)}
      />

      <LapCompletionAlert
        isVisible={!!lapAlert}
        lapNumber={lapAlert?.lapNumber}
        lapDurationMs={lapAlert?.lapDurationMs}
        lapPaceMs={lapAlert?.lapPaceMs}
        avgPaceMs={lapAlert?.avgPaceMs}
        language={language}
        onDismiss={() => setLapAlert(null)}
        autoDismissMs={3000}
      />

      <IOSBackButtonLocal
        show={!sessionActive && !showStats && !showHistory}
        onBack={undefined}
      />

      {showGoalGuide && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center px-4">
          <div className="relative w-full max-w-md rounded-3xl border border-white/15 bg-slate-900/90 p-6 text-white shadow-2xl">
            <div className="mb-4">
              <h3 className="text-xl font-black">
                {language === 'ko' ? '목표 설정 가이드' : 'Goal Setup Guide'}
              </h3>
              <p className="text-xs text-white/60">
                {language === 'ko' ? '거리를 목표로 달리거나 시간 목표를 잡을 수 있어요.' : 'Pick distance or time goals before you start.'}
              </p>
            </div>
            <div className="space-y-3 text-sm text-white/80">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '거리 목표' : 'Distance goal'}
                </p>
                <p>
                  {language === 'ko'
                    ? '3km, 5km, 10km 등을 선택하면 해당 거리에 도달했을 때 자동으로 알림을 줍니다.'
                    : 'Choose 3km, 5km, 10km, etc. We announce when you reach it.'}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '시간 목표' : 'Time goal'}
                </p>
                <p>
                  {language === 'ko'
                    ? '30분, 40분 등 시간을 고르면 설정 시간이 지나면 알림을 들을 수 있어요.'
                    : 'Pick 30 or 40 minutes to get notified when time is up.'}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '목표 해제' : 'Clear goal'}
                </p>
                <p>
                  {language === 'ko'
                    ? '목표가 필요 없으면 목표 해제를 누르거나 드롭다운에서 “설정 안 함”을 선택하세요.'
                    : 'If you don’t need a goal, tap clear or choose “No goal” in the dropdown.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowGoalGuide(false)}
              className="mt-4 w-full rounded-2xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 py-3 font-bold text-black shadow-lg active:scale-95"
            >
              {language === 'ko' ? '확인' : 'Got it'}
            </button>
          </div>
        </div>
      )}

      {showSettingsGuide && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center px-4">
          <div className="relative w-full max-w-md rounded-3xl border border-white/15 bg-slate-900/90 p-6 text-white shadow-2xl">
            <div className="mb-4">
              <h3 className="text-xl font-black">
                {language === 'ko' ? '설정 가이드' : 'Settings Guide'}
              </h3>
              <p className="text-xs text-white/60">
                {language === 'ko' ? '음성 안내와 코칭을 원하는 방식으로 조정하세요.' : 'Tune voice cues and coaching to your style.'}
              </p>
            </div>
            <div className="space-y-3 text-sm text-white/80">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '랩 거리' : 'Lap distance'}
                </p>
                <p>
                  {language === 'ko'
                    ? '500m 또는 1km마다 자동 랩 음성을 듣습니다.'
                    : 'Hear automatic lap voice cues every 500m or 1km.'}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '시간 음성' : 'Time voice'}
                </p>
                <p>
                  {language === 'ko'
                    ? '5/10분 등 간격으로 경과 시간, 거리, 평균 페이스를 알려줍니다.'
                    : 'Get elapsed time, distance, and avg pace every 5/10 minutes, etc.'}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '페이스 가이드' : 'Pace guide'}
                </p>
                <p>
                  {language === 'ko'
                    ? '목표 페이스보다 빠르거나 느리면 즉시 코칭을 받아요.'
                    : 'Coaching prompts when you’re faster or slower than target pace.'}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <p className="font-semibold mb-1">
                  {language === 'ko' ? '음성' : 'Voice'}
                </p>
                <p>
                  {language === 'ko'
                    ? '이어폰으로 듣는다면 음성을 켜두세요. 필요 없으면 끌 수 있습니다.'
                    : 'Keep voice on for headphone cues; turn off if you prefer silence.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowSettingsGuide(false)}
              className="mt-4 w-full rounded-2xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 py-3 font-bold text-black shadow-lg active:scale-95"
            >
              {language === 'ko' ? '확인' : 'Got it'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CustomDropdown({ value, options, onChange, label, open, setOpen }) {
  const selectedOption = options.find(opt => opt.value === value)

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-2xl border border-white/30 bg-white/10 px-3 py-3 text-xs font-semibold text-white shadow-lg hover:border-white/50 transition-all duration-200 backdrop-blur-sm flex items-center justify-between"
      >
        <span>{selectedOption?.label || label}</span>
        <span className={`text-white/80 text-sm transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {open && (
        <>
          {/* Backdrop to close dropdown */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />

          {/* Dropdown menu */}
          <div className="absolute top-full left-0 right-0 mt-1 rounded-2xl border border-white/30 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-20 overflow-hidden">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`w-full px-3 py-3 text-xs font-semibold text-left transition-all duration-150 ${
                  value === option.value
                    ? 'bg-emerald-500/30 text-emerald-100'
                    : 'text-white/90 hover:bg-white/10'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function StatTile({ label, value, accent = 'emerald' }) {
  const accentColors = {
    emerald: 'from-emerald-400/10 to-blue-500/10 border-emerald-400/20',
    amber: 'from-amber-400/10 to-orange-500/10 border-amber-400/20',
  }

  // Split value and unit (e.g., "2.5 km" -> ["2.5", "km"])
  const parts = value.split(' ')
  const numericValue = parts[0]
  const unit = parts.length > 1 ? parts.slice(1).join(' ') : ''

  return (
    <div className={`group flex h-full flex-col items-center justify-center rounded-2xl border bg-gradient-to-br ${accentColors[accent]} p-4 text-center text-white shadow-lg backdrop-blur-sm transition-all duration-300 hover:scale-105 hover:shadow-xl`}>
      <p className="text-2xl font-black leading-tight group-hover:scale-110 transition-transform duration-200">{numericValue}</p>
      {unit && (
        <p className="text-[0.65rem] font-bold text-white/70 mt-0.5">{unit}</p>
      )}
      <p className="mt-2 text-[0.6rem] uppercase tracking-[0.25em] text-white/70 font-bold leading-tight">{label}</p>
    </div>
  )
}
