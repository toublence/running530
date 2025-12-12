'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RunningSummaryOverlay from './RunningSummaryOverlay'
import RunningHistoryOverlay from './RunningHistoryOverlay'
import LapCompletionAlert from './LapCompletionAlert'
import useNativeAppVisibility from '../hooks/useNativeAppVisibility'
import useSafeAreaTop from '../hooks/useSafeAreaTop'
import IOSBackButtonLocal from '../components/IOSBackButtonLocal'
import { ensureLocationPermission, watchLocation, getCurrentLocation } from '../utils/geolocation'
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
import { DistanceCalculator } from '../utils/DistanceCalculator'
import { unlockTTS, speakOnce, stopAllTTS, forceUnduck } from '../realtime-mediapipe/tts'
import { requestWakeLock, releaseWakeLock, isWakeLockActive } from '../utils/wake-lock'
import { showBannerAd, hideBannerAd, prepareInterstitialAd, showInterstitialAd } from '../utils/admobHelper'
import { ScreenOrientation } from '@capacitor/screen-orientation'
import {
  SESSION_TEXT,
} from './locale'
import { createMetricsAccumulator } from './metrics'
import { ensureActivityRecognitionPermission, ensurePedometerPermission, maybeRequestIgnoreBatteryOptimizations } from '../utils/activity-permissions'
import { backgroundPedometer } from '../utils/background-pedometer'
import { pedometer } from '../utils/pedometer'

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
    defaultTargetPaceMs: 5 * 60 * 1000, // 기본값 5'00"
  },
}

const HISTORY_KEY = 'running_history_v1'
const LAP_DISTANCE_STORAGE_KEY = 'running_lap_distance_m'
const TIME_CUE_STORAGE_KEY = 'running_time_cue_ms'
const PACE_TARGET_STORAGE_KEY = 'running_target_pace_ms'
const GOAL_STORAGE_KEY = 'running_goal_v1'
const HISTORY_AD_LAST_SHOWN_KEY = 'running_interstitial_last_shown_ts'
const HISTORY_AD_COOLDOWN_MS = 60 * 60 * 1000
const MIN_DISTANCE_DELTA = 3.0 // 최소 거리 필터 강화: GPS Drift 방지 (이전: 0.7m → 3.0m)
const CURRENT_PACE_WINDOW_MS = 20000
const CURRENT_PACE_MIN_DISTANCE_M = 3
const MAX_ACCEPTABLE_ACCURACY_M = 20 // GPS 정확도 임계값 강화 (이전: 25m → 20m)
const ACCURACY_STRICT_REJECT_M = 50
const UNKNOWN_ACCURACY_DELTA_CAP_M = 6
const LOCATION_STALE_THRESHOLD_MS = 2 * 60 * 1000
const RUN_MAX_SPEED_MPS = 11.1 // 런닝 최대 속도 현실화 (40km/h, 이전: 7.5m/s = 27km/h)
const WALK_MAX_SPEED_MPS = 4.17 // 워킹 최대 속도 현실화 (15km/h, 이전: 3.0m/s = 10.8km/h)
const MAX_STEPS_PER_SEC_WALK = 4.2
const MIN_MOVING_SPEED_FOR_STEPS_MPS = 0.3
const STEP_SENSOR_STALE_MS = 5000
const MAX_HISTORY_ITEMS = 20
const MIN_AVG_PACE_DISTANCE_M = 100
const IDLE_THRESHOLD_MS = 30000 // 30s of no movement -> pause high-accuracy watch
const IDLE_POLL_INTERVAL_MS = 8000 // During idle, low-duty polling interval
const IDLE_MOVE_THRESHOLD_M = 5 // Movement detection threshold during idle poll
const SPEED_SMOOTHING_FACTOR = 0.3 // EMA smoothing factor: 0.0 (no change) to 1.0 (instant)
const MIN_PACE_COACH_DELTA_MS = 15000 // 15s difference before coaching nags
const PACE_COACH_COOLDOWN_MS = 90000
const GHOST_DISTANCE_TOLERANCE_M = 500 // ±0.5km tolerance when finding a target run
const MIN_GHOST_SPLITS = 1
const WALK_STRIDE_M = 0.75 // Default walking stride length in meters
const STRIDE_FROM_HEIGHT_FACTOR = 0.415 // stride ≈ height * factor
// GPS fallback thresholds (walking only)
// - MIN_SEGMENT: 최소 이동 거리. 너무 작으면 GPS 드리프트(제자리에서 1~2m 흔들림)를 걸음으로 잘못 세게 됨.
// - MIN_SPEED: 최소 속도. 거의 멈춰 있거나 아주 느리게 움직이는 상황(예: 책상 위 폰 위치 튀는 현상)은 무시.
//   5m 이상 + 2km/h 이상일 때만 "실제 걸음"으로 인정하도록 기준을 올린다.
const WALK_GPS_FALLBACK_MIN_SEGMENT_M = 5
const WALK_GPS_FALLBACK_MIN_SPEED_MS = 2 / 3.6
const DEFAULT_WEIGHT_KG = 65 // Fallback weight for calorie estimation
const STEP_GOAL_DEFAULT = 10000 // Daily step goal for progress %
const ELEVATION_NOISE_M = 1 // Ignore tiny altitude fluctuations
const DEBUG_STEPS = false // 디버그 HUD 토글. false이면 HUD/로그 비활성화.
const LEGACY_WALK_PACE_DEFAULT_MS = 10 * 60 * 1000 // 기존 기본값 (마이그레이션 용)
const CARRYOVER_STORAGE_KEY = 'running_carryover_state_v1'
const STEP_TIMELINE_STORAGE_KEY = 'running_step_timeline_v1'

// Walking mode weekly/monthly step goals (gamification)
const WALK_WEEKLY_STEPS_GOAL_DEFAULT = 70000 // 기본 주간 걸음수 목표 (약 1만 보 * 7일)
const WALK_MONTHLY_STEPS_GOAL_DEFAULT = 300000 // 기본 월간 걸음수 목표 (약 1만 보 * 30일)
const WALK_GOALS_STORAGE_KEY = 'running_walk_goals_v1'
const WALK_BADGES_STORAGE_KEY = 'running_walk_badges_v1'
const WALK_BADGE_WEEK_GOAL_FIRST = 'walk_week_goal_1'

const makeDefaultWalkGoals = () => ({
  weeklySteps: { target: WALK_WEEKLY_STEPS_GOAL_DEFAULT, active: true },
  monthlySteps: { target: WALK_MONTHLY_STEPS_GOAL_DEFAULT, active: true },
})

// Running mode weekly/monthly distance goals (km 단위 기본값)
const RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT = 20 // 기본 주간 러닝 목표 거리 (20km)
const RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT = 80 // 기본 월간 러닝 목표 거리 (80km)
const RUN_GOALS_STORAGE_KEY = 'running_run_goals_v1'
const RUN_BADGES_STORAGE_KEY = 'running_run_badges_v1'
const RUN_BADGE_WEEK_DISTANCE_FIRST = 'run_week_distance_1'
const RUN_BADGE_MONTH_DISTANCE_FIRST = 'run_month_distance_1'

const makeDefaultRunGoals = () => ({
  weeklyDistanceKm: { target: RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT, active: true },
  monthlyDistanceKm: { target: RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT, active: true },
})

const getCapacitorMotion = () => {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor || {}
  return cap.Motion || cap.Plugins?.Motion || null
}

const requestDeviceMotionPermission = async () => {
  // iOS 13+ requires explicit permission for devicemotion
  if (typeof DeviceMotionEvent === 'undefined') return true
  const req = DeviceMotionEvent.requestPermission
  if (typeof req !== 'function') return true
  try {
    const res = await req()
    return res === 'granted'
  } catch {
    return false
  }
}

const BANNER_AD_UNITS = {
  android: 'ca-app-pub-6169297934919363/4340478603',
  ios: 'ca-app-pub-6169297934919363/2916993322',
}

const INTERSTITIAL_AD_UNITS = {
  android: 'ca-app-pub-6169297934919363/6708480786',
  ios: 'ca-app-pub-6169297934919363/3994687532',
}

const BANNER_HEIGHT_PX = 50
// Extra gap between the bottom of the banner and the Running card
const IOS_BANNER_EXTRA_GAP_PX = -10
const ANDROID_BANNER_EXTRA_GAP_PX = 8
const getBannerPlaceholderHeight = (platform) => {
  if (platform === 'ios') return BANNER_HEIGHT_PX + IOS_BANNER_EXTRA_GAP_PX
  if (platform === 'android') return BANNER_HEIGHT_PX + ANDROID_BANNER_EXTRA_GAP_PX
  return BANNER_HEIGHT_PX
}

const resolveCapacitorPlatform = () => {
  if (typeof window === 'undefined') return 'web'
  const Cap = window.Capacitor || null
  const platform = Cap?.getPlatform?.() || Cap?.platform
  if (platform === 'ios' || platform === 'android') return platform
  return 'web'
}

const estimateStepCount = (distanceM, mode) => {
  if (mode !== 'walk') return null
  const distance = Number(distanceM)
  if (!Number.isFinite(distance) || distance <= 0) return 0
  return Math.max(0, Math.round(distance / WALK_STRIDE_M))
}

// WALKING MODE stride helper
const resolveUserHeightMeters = () => {
  if (typeof window === 'undefined') return null
  const keys = ['user_height_cm', 'userHeightCm', 'user_height_m']
  for (let i = 0; i < keys.length; i += 1) {
    try {
      const raw = localStorage.getItem(keys[i])
      if (raw == null) continue
      const num = Number(raw)
      if (!Number.isFinite(num) || num <= 0) continue
      if (raw.includes('cm') || num > 3) {
        return num / 100
      }
      return num
    } catch {}
  }
  return null
}

const resolveStrideLengthMeters = () => {
  const heightM = resolveUserHeightMeters()
  if (Number.isFinite(heightM) && heightM > 0) {
    return heightM * STRIDE_FROM_HEIGHT_FACTOR
  }
  return WALK_STRIDE_M
}

const formatDateKey = (date) => {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const getTodayKey = () => {
  const now = new Date()
  return formatDateKey(now)
}

const getDateKeyFromValue = (value) => {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return formatDateKey(d)
}


const buildLapSpeech = (index, lapDuration, lapPace, avgPace, language) => {
  const lapDurationText = formatSpokenDuration(lapDuration, language)
  const lapPaceText = formatSpokenPace(lapPace, language)
  if (language === 'ko') {
    return `${index}번째 구간 기록, ${lapDurationText}, 평균 페이스 ${lapPaceText}.`
  }
  const lapSegment = `${lapPaceText} pace`
  return `Lap ${index} complete in ${lapDurationText}. Lap pace ${lapSegment}.`
}

const formatSpeedLabel = (paceMs) => {
  if (!paceMs || paceMs <= 0) return '--.- km/h'
  const kmh = 3600000 / paceMs
  if (!Number.isFinite(kmh)) return '--.- km/h'
  return `${kmh.toFixed(1)} km/h`
}

	// Compact formatter for large step counts so goal cards don't overflow
	// e.g. 70000 -> '7만' (ko) or '70k' (en), 300000 -> '30만' / '300k'
	const formatStepsCompact = (steps, language) => {
	  if (!Number.isFinite(steps)) return '0'
	  const n = Math.max(0, Math.floor(steps))
	  if (language === 'ko') {
	    if (n >= 10000) {
	      const man = Math.round(n / 10000) // 70000 -> 7
	      return `${man}만`
	    }
	    return n.toLocaleString()
	  }
	  // non-ko: use k-notation for 4+ digits
	  if (n >= 1000) {
	    const k = Math.round(n / 100) / 10 // 70000 -> 700.0 -> 700k
	    const label = k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)
	    return `${label}k`
	  }
	  return n.toLocaleString()
	}

	// Compact km label for running distance goals (e.g. 12.3km / 20km)
	const formatKmLabel = (kmValue, language) => {
	  if (!Number.isFinite(kmValue)) return language === 'ko' ? '0km' : '0 km'
	  const v = Math.max(0, kmValue)
	  const text = v >= 10 ? v.toFixed(0) : v.toFixed(1)
	  return language === 'ko' ? `${text}km` : `${text} km`
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

  let trendText = ''
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

  const parts = []
  if (language === 'ko') {
    parts.push(`${elapsedText} 경과, 거리 ${distanceText}.`)
    if (currentPaceText) parts.push(`현재 페이스 ${currentPaceText}.`)
    if (avgPaceText) parts.push(`평균 페이스 ${avgPaceText}.`)
    if (trendText) parts.push(trendText)
  } else {
    parts.push(`${elapsedText} elapsed. Distance ${distanceText}.`)
    if (currentPaceText) parts.push(`Current pace ${currentPaceText}.`)
    if (avgPaceText) parts.push(`Average pace ${avgPaceText}.`)
    if (trendText) parts.push(trendText)
  }

  return parts.join(' ')
}

const buildPaceCoachSpeech = (direction, deltaSeconds, language, modeLabel) => {
  const formatDelta = (secs) => {
    if (!Number.isFinite(secs) || secs <= 0) return language === 'ko' ? '0초' : '0 seconds'
    if (secs < 60) return language === 'ko' ? `${secs}초` : `${secs} seconds`
    const minutes = Math.floor(secs / 60)
    const seconds = secs % 60
    if (language === 'ko') {
      return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`
    }
    const minLabel = minutes === 1 ? '1 minute' : `${minutes} minutes`
    const secLabel = seconds === 1 ? '1 second' : `${seconds} seconds`
    return seconds === 0 ? minLabel : `${minLabel} ${secLabel}`
  }
  const deltaLabel = formatDelta(deltaSeconds)
  if (language === 'ko') {
    if (direction === 'slow') {
      return `목표 페이스보다 ${deltaLabel} 느립니다. 조금 더 빠르게 ${modeLabel === '도보' ? '걸어보세요.' : '뛰어보세요.'}`
    }
    return `목표 페이스보다 ${deltaLabel} 빠릅니다. 속도를 조금만 줄여보세요.`
  }

  if (direction === 'slow') {
    return `You're ${deltaLabel} slower than target pace. Pick it up a bit.`
  }
  return `You're ${deltaLabel} faster than target pace. Ease off slightly.`
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
  const [stepCount, setStepCount] = useState(null)
  const [baseSteps, setBaseSteps] = useState(null)
  const [sessionSteps, setSessionSteps] = useState(0)
  const [pedometerReady, setPedometerReady] = useState(false)
  const [pedometerError, setPedometerError] = useState(null)
  const [strideLengthM, setStrideLengthM] = useState(() => resolveStrideLengthMeters())
  const [displayStepCount, setDisplayStepCount] = useState(null)
  const [stepDebugInfo, setStepDebugInfo] = useState(null)
  const [stepDebugCollapsed, setStepDebugCollapsed] = useState(false)
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
  const [historyExpandedId, setHistoryExpandedId] = useState(null)
  const [workoutStats, setWorkoutStats] = useState(null)
  const [summaryMeta, setSummaryMeta] = useState(null)
  const [starting, setStarting] = useState(false)
  const [lapAlert, setLapAlert] = useState(null)
  const [capPlatform, setCapPlatform] = useState(() => resolveCapacitorPlatform())
  const [chartTab, setChartTab] = useState('day') // 'day' | 'week' | 'month'
  const [stepTimeline, setStepTimeline] = useState([])
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
  const [batterySaver, setBatterySaver] = useState(() => {
    if (typeof window === 'undefined') return false
    const saved = localStorage.getItem('running_battery_saver')
    return saved === 'true'
  })
	  const [sessionKeepAwake, setSessionKeepAwake] = useState(false)
	  const [walkGoalConfig, setWalkGoalConfig] = useState(() => {
	    if (typeof window === 'undefined') return makeDefaultWalkGoals()
	    try {
	      const raw = localStorage.getItem(WALK_GOALS_STORAGE_KEY)
	      if (!raw) return makeDefaultWalkGoals()
	      const parsed = JSON.parse(raw)
	      const base = makeDefaultWalkGoals()
	      if (parsed && typeof parsed === 'object') {
	        if (parsed.weeklySteps && Number.isFinite(parsed.weeklySteps.target)) {
	          base.weeklySteps.target = Math.max(0, Number(parsed.weeklySteps.target))
	          base.weeklySteps.active = parsed.weeklySteps.active !== false
	        }
	        if (parsed.monthlySteps && Number.isFinite(parsed.monthlySteps.target)) {
	          base.monthlySteps.target = Math.max(0, Number(parsed.monthlySteps.target))
	          base.monthlySteps.active = parsed.monthlySteps.active !== false
	        }
	      }
	      return base
	    } catch {
	      return makeDefaultWalkGoals()
	    }
	  })
	  const [walkBadges, setWalkBadges] = useState(() => {
	    if (typeof window === 'undefined') return {}
	    try {
	      const raw = localStorage.getItem(WALK_BADGES_STORAGE_KEY)
	      if (!raw) return {}
	      const parsed = JSON.parse(raw)
	      return parsed && typeof parsed === 'object' ? parsed : {}
	    } catch {
	      return {}
	    }
	  })
	  const [runGoalConfig, setRunGoalConfig] = useState(() => {
	    if (typeof window === 'undefined') return makeDefaultRunGoals()
	    try {
	      const raw = localStorage.getItem(RUN_GOALS_STORAGE_KEY)
	      if (!raw) return makeDefaultRunGoals()
	      const parsed = JSON.parse(raw)
	      const base = makeDefaultRunGoals()
	      if (parsed && typeof parsed === 'object') {
	        if (parsed.weeklyDistanceKm && Number.isFinite(parsed.weeklyDistanceKm.target)) {
	          base.weeklyDistanceKm.target = Math.max(0, Number(parsed.weeklyDistanceKm.target))
	          base.weeklyDistanceKm.active = parsed.weeklyDistanceKm.active !== false
	        }
	        if (parsed.monthlyDistanceKm && Number.isFinite(parsed.monthlyDistanceKm.target)) {
	          base.monthlyDistanceKm.target = Math.max(0, Number(parsed.monthlyDistanceKm.target))
	          base.monthlyDistanceKm.active = parsed.monthlyDistanceKm.active !== false
	        }
	      }
	      return base
	    } catch {
	      return makeDefaultRunGoals()
	    }
	  })
	  const [runBadges, setRunBadges] = useState(() => {
	    if (typeof window === 'undefined') return {}
	    try {
	      const raw = localStorage.getItem(RUN_BADGES_STORAGE_KEY)
	      if (!raw) return {}
	      const parsed = JSON.parse(raw)
	      return parsed && typeof parsed === 'object' ? parsed : {}
	    } catch {
	      return {}
	    }
	  })
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
		  const [badgeBanner, setBadgeBanner] = useState(null)
	  const [showGoalGuide, setShowGoalGuide] = useState(false)
  const [showSettingsGuide, setShowSettingsGuide] = useState(false)
  const [showGhostGuide, setShowGhostGuide] = useState(false)
  const [ghostEnabled, setGhostEnabled] = useState(false)
  const [ghostTarget, setGhostTarget] = useState(null)
  const [ghostMessage, setGhostMessage] = useState('')

  const text = SESSION_TEXT[language] || SESSION_TEXT.en
  const modeTitle = language === 'ko' ? meta.titleKo : meta.title
  const isWalkMode = resolvedMode === 'walk'
	  const anyDropdownOpen = lapDistanceDropdownOpen || timeCueDropdownOpen || paceTargetDropdownOpen || goalDistanceDropdownOpen || goalTimeDropdownOpen
	
	  const unlockWalkBadge = useCallback((badgeId) => {
	    if (!badgeId) return
	    setWalkBadges((prev) => {
	      const prevSafe = prev && typeof prev === 'object' ? prev : {}
	      if (prevSafe[badgeId]) return prevSafe
	      return {
	        ...prevSafe,
	        [badgeId]: {
	          unlockedAt: Date.now(),
	        },
	      }
	    })

	    let detail
	    if (badgeId === WALK_BADGE_WEEK_GOAL_FIRST) {
	      detail = language === 'ko'
	        ? '\uccab \uc8fc\uac04 \uac78\uc74c\uc218 \ubaa9\ud45c\ub97c \ub2ec\uc131\ud588\uc5b4\uc694!'
	        : 'You achieved your first weekly step goal!'
	    } else {
	      detail = language === 'ko'
	        ? '\uc6cc\ud0b9 \ubaa9\ud45c\ub97c \ub2ec\uc131\ud588\uc5b4\uc694.'
	        : 'You reached your walking goal.'
	    }

	    const title = language === 'ko' ? '\ubc30\uc9c0 \ud68d\ub4dd' : 'Badge unlocked'
	    setBadgeBanner({
	      title,
	      detail,
	    })
	  }, [language])

	  const unlockRunBadge = useCallback((badgeId) => {
	    if (!badgeId) return
	    setRunBadges((prev) => {
	      const prevSafe = prev && typeof prev === 'object' ? prev : {}
	      if (prevSafe[badgeId]) return prevSafe
	      return {
	        ...prevSafe,
	        [badgeId]: {
	          unlockedAt: Date.now(),
	        },
	      }
	    })

	    let detail
	    if (badgeId === RUN_BADGE_WEEK_DISTANCE_FIRST) {
	      detail = language === 'ko'
	        ? '\uccab \uc8fc\uac04 \ub7ec\ub2dd \uac70\ub9ac \ubaa9\ud45c\ub97c \ub2ec\uc131\ud588\uc5b4\uc694!'
	        : 'You hit your first weekly running distance goal!'
	    } else if (badgeId === RUN_BADGE_MONTH_DISTANCE_FIRST) {
	      detail = language === 'ko'
	        ? '\uccab \uc6d4\uac04 \ub7ec\ub2dd \uac70\ub9ac \ubaa9\ud45c\ub97c \ub2ec\uc131\ud588\uc5b4\uc694!'
	        : 'You hit your first monthly running distance goal!'
	    } else {
	      detail = language === 'ko'
	        ? '\ub7ec\ub2dd \ubaa9\ud45c\ub97c \ub2ec\uc131\ud588\uc5b4\uc694.'
	        : 'You reached your running goal.'
	    }

	    const title = language === 'ko' ? '\ubc30\uc9c0 \ud68d\ub4dd' : 'Badge unlocked'
	    setBadgeBanner({
	      title,
	      detail,
	    })
	  }, [language])

	  const watchStopRef = useRef(null)
  const lastPointRef = useRef(null)
  const routePointsRef = useRef([])
  const lastAltitudeRef = useRef(null)
  const elevationGainRef = useRef(0)
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
  const lastHistoryAdShownRef = useRef(0)
  const androidBackCleanupRef = useRef(null)
  const lockHistoryPushedRef = useRef(false)
  const suppressPopstateRef = useRef(false)
  const ghostSessionRef = useRef({ enabled: false, targetRun: null, lapsTimeline: [], nextKmIndex: 1 })
  const stepCountRef = useRef(null)
  const metricsRef = useRef(null)
  const pedometerStopRef = useRef(null)
  const pedometerPausedBaseRef = useRef(null)
  const pedometerActiveRef = useRef(false)
  const baseStepsRef = useRef(null)
  const distanceOffsetRef = useRef(0)
  const elapsedOffsetRef = useRef(0)
  const stepOffsetRef = useRef(0)
  const stepSensorSeenRef = useRef(false)
  const stepSessionTokenRef = useRef(null)
  const stepSensorBaseRef = useRef(null)
  const lastSensorStepValueRef = useRef(null)
  const lastStepUpdateTsRef = useRef(null)
  const lastSensorStepTsRef = useRef(null)
  const pausedIntervalsRef = useRef([])
  const lastActiveTsRef = useRef(0)
  const idleModeRef = useRef(false)
  const idlePollTimerRef = useRef(null)
  const lastActivityDistanceRef = useRef(0)
  const lastActivityStepsRef = useRef(0)
  const lastIdleProbeRef = useRef(null)
  const sessionRestoredRef = useRef(false) // 세션 복원 플래그
  const handleLocationRef = useRef(null)
  const enterIdleModeRef = useRef(null)
  const stepAnimTimerRef = useRef(null)
  const stepDisplayRef = useRef(null)
  const stepDebugLogTsRef = useRef(0)
  const prevDistanceRef = useRef(0)
  const motionStopRef = useRef(null)
  const stepTimelineRef = useRef([])
  const walkActiveElapsedRef = useRef(0)
  const walkLastTickRef = useRef(null)
  const walkLapStartElapsedRef = useRef(0)
  const sessionStartDateRef = useRef(null) // 세션 시작 날짜 추적용
  const distanceCalculatorRef = useRef(null) // DistanceCalculator 인스턴스
  const lastGpsStepCountRef = useRef(null) // GPS 기반 보폭 보정용 마지막 걸음수
  const pedometerReadingHandlerRef = useRef(null) // 페도미터 핸들러 ref (stale closure 방지)

  const stopStepAnim = useCallback(() => {
    if (stepAnimTimerRef.current) {
      clearInterval(stepAnimTimerRef.current)
      stepAnimTimerRef.current = null
    }
  }, [])

  const updateStepDebug = useCallback((partial) => {
    if (!DEBUG_STEPS) return
    setStepDebugInfo((prev) => ({
      ...(prev || {}),
      ...partial,
      updatedAt: Date.now(),
    }))
  }, [])

  const updateWalkingElapsed = useCallback((timestamp, moving, { force } = {}) => {
    if (!isWalkMode) return null
    const now = Number.isFinite(timestamp) ? timestamp : Date.now()
    const lastTick = walkLastTickRef.current
    const delta = lastTick ? Math.max(0, now - lastTick) : 0
    const clampedDelta = delta > 0 ? Math.min(delta, STEP_SENSOR_STALE_MS) : 0

    if (clampedDelta > 0 && (moving || force)) {
      walkActiveElapsedRef.current += clampedDelta
    }

    if (moving) {
      walkLastTickRef.current = now
    } else {
      walkLastTickRef.current = null
    }

    const elapsed = (elapsedOffsetRef.current || 0) + walkActiveElapsedRef.current
    setElapsedMs(elapsed)
    return elapsed
  }, [isWalkMode])

  const flushWalkingElapsed = useCallback((timestamp) => {
    if (!isWalkMode) return null
    const now = Number.isFinite(timestamp) ? timestamp : Date.now()
    const lastTick = walkLastTickRef.current
    updateWalkingElapsed(now, Boolean(lastTick), { force: true })
    walkLastTickRef.current = null
    const elapsed = (elapsedOffsetRef.current || 0) + walkActiveElapsedRef.current
    setElapsedMs(elapsed)
    return elapsed
  }, [isWalkMode, updateWalkingElapsed])

  const upsertCarryoverHistory = useCallback((entry, reason = 'carryover') => {
    if (!entry) return
    const dateKey = getDateKeyFromValue(entry.dateKey || entry.startedAt || entry.timestamp)
    if (!dateKey) return

    const normalized = {
      id: entry.id || `${dateKey}_${reason}_${Date.now()}`,
      mode: entry.mode || 'walk',
      startedAt: entry.startedAt || entry.timestamp || new Date(dateKey).getTime(),
      durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : Number(entry.duration) || 0,
      distanceM: Number.isFinite(entry.distanceM) ? entry.distanceM : Number(entry.distance) || 0,
      avgPaceMs: Number.isFinite(entry.avgPaceMs) ? entry.avgPaceMs : null,
      laps: Array.isArray(entry.laps) ? entry.laps : [],
      route: Array.isArray(entry.route) ? entry.route : [],
      steps: Number.isFinite(entry.steps) ? Math.max(0, entry.steps) : 0,
      autoSaved: entry.autoSaved !== undefined ? entry.autoSaved : true,
      migratedFromCarryover: Boolean(entry.migratedFromCarryover || reason === 'carryover'),
      migratedFromReset: Boolean(entry.migratedFromReset || reason === 'reset'),
    }

    // pace 보정
    if (!Number.isFinite(normalized.avgPaceMs) && normalized.distanceM > 0 && normalized.durationMs > 0) {
      normalized.avgPaceMs = normalized.durationMs / (normalized.distanceM / 1000)
    }

    setHistory((prev) => {
      const historyArr = Array.isArray(prev) ? [...prev] : []
      const existingIdx = historyArr.findIndex((item) => {
        if (item.mode && item.mode !== 'walk') return false
        const itemDateKey = getDateKeyFromValue(item.startedAt || item.timestamp)
        return itemDateKey === dateKey
      })

      if (existingIdx >= 0) {
        const existing = historyArr[existingIdx]
        const merged = {
          ...existing,
          ...normalized,
          id: existing.id || normalized.id,
          startedAt: existing.startedAt || normalized.startedAt,
          steps: Math.max(Number(existing.steps) || 0, normalized.steps || 0),
          distanceM: Math.max(Number(existing.distanceM) || 0, normalized.distanceM || 0),
          durationMs: Math.max(Number(existing.durationMs) || 0, normalized.durationMs || 0),
          autoSaved: existing.autoSaved && normalized.autoSaved,
          migratedFromCarryover: Boolean(existing.migratedFromCarryover || normalized.migratedFromCarryover),
          migratedFromReset: Boolean(existing.migratedFromReset || normalized.migratedFromReset),
        }
        const mergedDist = merged.distanceM
        const mergedDur = merged.durationMs
        const pace = mergedDist > 0 && mergedDur > 0
          ? mergedDur / (mergedDist / 1000)
          : (normalized.avgPaceMs ?? existing.avgPaceMs ?? null)
        merged.avgPaceMs = Number.isFinite(pace) ? pace : null
        historyArr[existingIdx] = merged
      } else {
        historyArr.unshift(normalized)
        if (historyArr.length > MAX_HISTORY_ITEMS) {
          historyArr.splice(MAX_HISTORY_ITEMS)
        }
      }

      try {
        if (typeof window !== 'undefined') {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(historyArr))
        }
      } catch {}

      return historyArr
    })
  }, [])

  const loadCarryoverState = useCallback(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(CARRYOVER_STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const todayKey = getTodayKey()
      if (parsed?.dateKey !== todayKey) {
        // 전날 데이터가 있으면 히스토리로 마이그레이션 (데이터 손실 방지)
        if (parsed?.steps > 0 || parsed?.distanceM > 0 || parsed?.elapsedMs > 0) {
          console.log('[walking] Migrating previous day carryover to history:', parsed)

          upsertCarryoverHistory({
            id: `${parsed.dateKey}_carryover_${Date.now()}`,
            mode: parsed.mode || 'walk',
            dateKey: parsed.dateKey,
            startedAt: new Date(parsed.dateKey).getTime(),
            durationMs: parsed.elapsedMs || 0,
            distanceM: parsed.distanceM || 0,
            avgPaceMs: parsed.distanceM > 0 ? (parsed.elapsedMs / (parsed.distanceM / 1000)) : 0,
            laps: parsed.laps || [],
            route: [],
            steps: parsed.steps || 0,
            autoSaved: true,
            migratedFromCarryover: true,
          }, 'carryover')
        }

        // carryover 삭제
        localStorage.removeItem(CARRYOVER_STORAGE_KEY)
        return null
      }
      return parsed
    } catch {
      return null
    }
  }, [upsertCarryoverHistory])

  const clearCarryoverState = useCallback(() => {
    if (typeof window === 'undefined') return
    try { localStorage.removeItem(CARRYOVER_STORAGE_KEY) } catch {}
  }, [])

  const checkAndResetForNewDay = useCallback((currentRawSteps = null, forceReset = false) => {
    if (!isWalkMode || !sessionActive) return { didReset: false, previousBaseSteps: null }

    const currentDateKey = getTodayKey()
    const sessionDateKey = sessionStartDateRef.current

    // 날짜가 변경되었는지 확인
    if (sessionDateKey && sessionDateKey !== currentDateKey) {
      // currentRawSteps가 없으면 (GPS 경로) 리셋하지 않고 날짜만 체크
      // pedometer 이벤트에서만 실제 리셋 수행
      if (!Number.isFinite(currentRawSteps) && !forceReset) {
        console.log('[walking] Date changed detected (GPS path). Waiting for pedometer event to reset.', {
          sessionDate: sessionDateKey,
          currentDate: currentDateKey
        })
        return { didReset: false, previousBaseSteps: null }
      }

      // 리셋 전에 이전 baseSteps 저장 (자정 이후 증분 계산용)
      const previousBaseSteps = baseStepsRef.current

      console.log('[walking] Date changed detected. Resetting all data.', {
        sessionDate: sessionDateKey,
        currentDate: currentDateKey,
        currentRawSteps,
        previousBaseSteps
      })

      // 모든 워킹 데이터 초기화
      // 걸음수 - baseSteps를 현재 raw 값으로 설정하여 자정 이후 걸음 누락 방지
      stepCountRef.current = 0
      stepDisplayRef.current = 0
      setStepCount(0)
      setDisplayStepCount(0)
      setSessionSteps(0)
      stepOffsetRef.current = 0

      // currentRawSteps가 제공되면 새로운 base로 설정
      if (Number.isFinite(currentRawSteps)) {
        baseStepsRef.current = currentRawSteps
        setBaseSteps(currentRawSteps)
        pedometerPausedBaseRef.current = null
      } else if (forceReset) {
        // forceReset (visibility change)인 경우 baseSteps를 null로 초기화
        // 다음 pedometer 이벤트에서 새로운 base로 설정됨
        baseStepsRef.current = null
        setBaseSteps(null)
        pedometerPausedBaseRef.current = null
      }
      // else: GPS 경로에서 호출 - baseSteps 유지 (다음 pedometer 이벤트에서 설정)

      // 거리
      totalDistanceRef.current = 0
      distanceOffsetRef.current = 0
      setDistanceM(0)
      lastActivityDistanceRef.current = 0

      // GPS 앵커 초기화 (중요: 전날 위치 기준 거리 계산 방지)
      lastPointRef.current = null
      routePointsRef.current = []
      samplesRef.current = [] // 페이스 계산용 샘플 초기화

      // 시간
      walkActiveElapsedRef.current = 0
      elapsedOffsetRef.current = 0
      setElapsedMs(0)
      walkLastTickRef.current = null
      sessionStartRef.current = Date.now()

      // Pause 관련 누적치 초기화
      pausedAccumulatedRef.current = 0
      pauseStartRef.current = 0
      pausedIntervalsRef.current.length = 0
      lapPausedAccumulatedRef.current = 0
      lapPauseStartRef.current = 0

      // 랩 데이터
      lapsRef.current = []
      setLaps([])
      walkLapStartElapsedRef.current = 0
      lapStartDistanceRef.current = 0
      lapStartTimeRef.current = Date.now()
      lapTargetRef.current = lapDistanceM

      // 페이스
      setAvgPaceMs(null)
      setCurrentPaceMs(null)

      // carryover 및 타임라인 초기화 전에 히스토리로 마이그레이션
      try {
        const carryoverRaw = localStorage.getItem(CARRYOVER_STORAGE_KEY)
        if (carryoverRaw) {
          const carryover = JSON.parse(carryoverRaw)

          // 전날 데이터가 있으면 히스토리로 저장 (데이터 손실 방지)
          if (carryover?.steps > 0 || carryover?.distanceM > 0 || carryover?.elapsedMs > 0) {
            console.log('[walking] Migrating carryover to history before reset:', carryover)

            upsertCarryoverHistory({
              id: `${carryover.dateKey}_reset_${Date.now()}`,
              mode: carryover.mode || 'walk',
              dateKey: carryover.dateKey,
              startedAt: new Date(carryover.dateKey).getTime(),
              durationMs: carryover.elapsedMs || 0,
              distanceM: carryover.distanceM || 0,
              avgPaceMs: carryover.distanceM > 0 ? (carryover.elapsedMs / (carryover.distanceM / 1000)) : 0,
              laps: carryover.laps || [],
              route: [],
              steps: carryover.steps || 0,
              autoSaved: true,
              migratedFromReset: true,
            }, 'reset')
          }
        }
      } catch (err) {
        console.error('[walking] Failed to migrate carryover before reset:', err)
      }

      clearCarryoverState()
      stepTimelineRef.current = []
      setStepTimeline([])
      try {
        localStorage.removeItem(STEP_TIMELINE_STORAGE_KEY)
      } catch {}

      // 메트릭 누산기 초기화 (칼로리, 강도 등)
      metricsRef.current = createMetricsAccumulator({
        mode: 'walking',
        userWeightKg: DEFAULT_WEIGHT_KG,
        userStepGoal: STEP_GOAL_DEFAULT,
        sessionStartTime: sessionStartRef.current,
        pausedIntervals: pausedIntervalsRef.current,
        stepCounterAtStart: null,
        enableAccelFallback: true,
        onDebug: DEBUG_STEPS ? (payload) => updateStepDebug(payload) : null,
      })

      // 새로운 날짜로 세션 시작 날짜 업데이트
      sessionStartDateRef.current = currentDateKey

      if (DEBUG_STEPS) {
        updateStepDebug({
          source: 'date-reset',
          sessionSteps: 0,
          displayStepCount: 0,
          distanceM: 0,
          message: `All data reset due to date change: ${sessionDateKey} -> ${currentDateKey}`,
        })
      }

      return { didReset: true, previousBaseSteps }
    }

    return { didReset: false, previousBaseSteps: null }
  }, [isWalkMode, sessionActive, clearCarryoverState, updateStepDebug, lapDistanceM, upsertCarryoverHistory])

  const saveCarryoverState = useCallback((payload) => {
    if (typeof window === 'undefined') return
    try {
      const data = { ...payload, dateKey: getTodayKey() }
      localStorage.setItem(CARRYOVER_STORAGE_KEY, JSON.stringify(data))
    } catch {}
  }, [])

  const persistCarryover = useCallback((snapshot) => {
    if (resolvedMode === 'run') return
    const distance = Math.max(0, Number(snapshot?.distanceM) || 0)
    const elapsed = Math.max(0, Number(snapshot?.elapsedMs) || 0)
    const stepsVal = Number.isFinite(snapshot?.steps) ? Math.max(0, snapshot.steps) : null
    const lapsData = Array.isArray(snapshot?.laps) ? snapshot.laps : []
    saveCarryoverState({
      mode: resolvedMode,
      distanceM: distance,
      elapsedMs: elapsed,
      steps: stepsVal,
      lapDistanceM,
      laps: lapsData,
    })
  }, [lapDistanceM, resolvedMode, saveCarryoverState])

  // 시간/주/월 그래프를 위해 스텝 타임라인 누적 (워킹 전용)
  const appendStepTimeline = useCallback((sample) => {
    if (!sample || !Number.isFinite(sample.steps) || !Number.isFinite(sample.ts)) return
    const tsNorm = sample.ts < 1e12 ? sample.ts * 1000 : sample.ts // 일부 센서가 sec 단위로 전달하는 경우 보정

    // 분 단위로 그룹화하여 샘플 압축 (같은 분에는 마지막 샘플만 유지)
    const current = [...stepTimelineRef.current]
    const d = new Date(tsNorm)
    const newKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`

    // 같은 분의 기존 샘플 찾기
    const existingIdx = current.findIndex(s => {
      const sd = new Date(s.ts)
      const sKey = `${sd.getFullYear()}-${sd.getMonth()}-${sd.getDate()}-${sd.getHours()}-${sd.getMinutes()}`
      return sKey === newKey
    })

    if (existingIdx >= 0) {
      // 같은 분의 샘플이 있으면 업데이트 (더 큰 걸음수로)
      if (sample.steps > current[existingIdx].steps) {
        current[existingIdx] = { ...sample, ts: tsNorm }
      }
    } else {
      // 새로운 분의 샘플 추가
      current.push({ ...sample, ts: tsNorm })
    }

    // 최대 1440개 (24시간 * 60분) 유지
    const next = current.slice(-1440)

    stepTimelineRef.current = next
    setStepTimeline(next)
    try {
      const payload = { dateKey: getTodayKey(), samples: next }
      localStorage.setItem(STEP_TIMELINE_STORAGE_KEY, JSON.stringify(payload))
    } catch {}
  }, [getTodayKey])

  const loadStepTimeline = useCallback(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = localStorage.getItem(STEP_TIMELINE_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.dateKey !== getTodayKey() || !Array.isArray(parsed.samples)) return []
      return parsed.samples
        .map((s) => {
          const tsRaw = Number(s?.ts)
          const ts = Number.isFinite(tsRaw) ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : null
          return Number.isFinite(s?.steps) && Number.isFinite(ts) ? { steps: s.steps, ts } : null
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }, [getTodayKey])

  // 그래프에 실시간 스텝 반영
  useEffect(() => {
    if (!isWalkMode) return
    if (!Number.isFinite(stepCount)) return
    const last = stepTimelineRef.current[stepTimelineRef.current.length - 1]
    if (last && last.steps === stepCount) return
    appendStepTimeline({ ts: Date.now(), steps: stepCount })
  }, [appendStepTimeline, isWalkMode, stepCount])

  // 세션 시작 전에도 당일 캐리오버 데이터를 미리 표시
  useEffect(() => {
    if (sessionActive || resolvedMode === 'run') return
    if (resolvedMode === 'run') {
      clearCarryoverState()
      return
    }
    const carry = loadCarryoverState()
    if (!carry || carry.mode !== resolvedMode) return
    const distance = Math.max(0, Number(carry.distanceM) || 0)
    const elapsed = Math.max(0, Number(carry.elapsedMs) || 0)
    const stepsVal = Number.isFinite(carry.steps) ? Math.max(0, carry.steps) : null
    setDistanceM(distance)
    setElapsedMs(elapsed)
    if (resolvedMode === 'walk') {
      setStepCount(stepsVal)
      setDisplayStepCount(stepsVal)
      setSessionSteps(stepsVal || 0)
    }
    if (Array.isArray(carry.laps)) {
      lapsRef.current = carry.laps
      setLaps(carry.laps)
    }
    if (Number.isFinite(carry.lapDistanceM)) {
      const parsed = carry.lapDistanceM === 500 ? 500 : 1000
      setLapDistanceM(parsed)
    }
  }, [loadCarryoverState, resolvedMode, sessionActive])

  // 스텝 타임라인 로드 (당일 유지)
  useEffect(() => {
    if (sessionActive) return
    const stored = loadStepTimeline()
    stepTimelineRef.current = stored
    setStepTimeline(stored)
  }, [loadStepTimeline, sessionActive])

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
      return Number(record.goal.value)
    }
    if (Number.isFinite(record.distanceM)) return Number(record.distanceM)
    if (Number.isFinite(record.distance)) return Number(record.distance)
    if (Number.isFinite(record.totalDistance)) return Number(record.totalDistance)
    return null
  }, [])

  const resolveRecordDuration = useCallback((record) => {
    if (!record) return null
    if (Number.isFinite(record.durationMs)) return Number(record.durationMs)
    if (Number.isFinite(record.duration)) return Number(record.duration)
    if (Number.isFinite(record.totalTime)) return Number(record.totalTime)
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
  const formatGhostLabel = useCallback((record) => {
    if (!record) return ''
    const distance = resolveRecordDistance(record)
    const duration = resolveRecordDuration(record)
    const avgPace = record.avgPaceMs
      ? record.avgPaceMs
      : (Number.isFinite(duration) && Number.isFinite(distance) && distance > 0
        ? duration / (distance / 1000)
        : null)
    const lapCount = Array.isArray(record.laps) ? record.laps.length : null
    const lapDistance = Number.isFinite(record.lapDistanceM) ? record.lapDistanceM : null
    const targetPace = Number.isFinite(record.targetPaceMs) ? record.targetPaceMs : null
    const isWalk = record.mode === 'walk'
    const steps = isWalk && Number.isFinite(record.steps) ? record.steps : null

    if (!Number.isFinite(distance)) return ''
    const parts = []
    parts.push(formatDistanceLabel(Number(distance), 2))
    if (Number.isFinite(duration)) parts.push(formatClock(duration, { showHours: duration >= 3600000 }))
    if (Number.isFinite(avgPace)) parts.push(formatPaceLabel(avgPace))
    if (Number.isFinite(lapDistance)) parts.push(`${formatDistanceLabel(lapDistance, 2)} lap`)
    if (Number.isFinite(lapCount)) parts.push(`${lapCount} laps`)
    if (Number.isFinite(targetPace)) parts.push(formatPaceLabel(targetPace))
    if (Number.isFinite(steps)) parts.push(`${steps.toLocaleString()} steps`)
    return parts.join(' / ')
  }, [resolveRecordDistance, resolveRecordDuration])

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
    // 고스트 도전 시 목표 자동 설정하지 않음 (거리/시간 그대로 유지)
  }, [resolveRecordDistance])

  const pickInterstitialAdId = useCallback(() => {
    return capPlatform === 'ios' ? INTERSTITIAL_AD_UNITS.ios : INTERSTITIAL_AD_UNITS.android
  }, [capPlatform])

  const markHistoryAdShown = useCallback((timestamp = Date.now()) => {
    const ts = Number(timestamp) || Date.now()
    lastHistoryAdShownRef.current = ts
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(HISTORY_AD_LAST_SHOWN_KEY, String(ts))
      } catch {}
    }
  }, [])

  const shouldThrottleHistoryAd = useCallback(() => {
    const lastShown = lastHistoryAdShownRef.current || 0
    if (!lastShown) return false
    return Date.now() - lastShown < HISTORY_AD_COOLDOWN_MS
  }, [])

  const showHistoryInterstitialAd = useCallback(async () => {
    if (shouldThrottleHistoryAd()) return false
    const adId = pickInterstitialAdId()
    if (!adId) return false
    try {
      const prepared = await prepareInterstitialAd(adId)
      if (!prepared) return false
      const shown = await showInterstitialAd()
      if (shown) {
        markHistoryAdShown()
      }
      return shown
    } catch (err) {
      console.warn('[running] interstitial history error', err)
      return false
    }
  }, [markHistoryAdShown, pickInterstitialAdId, shouldThrottleHistoryAd])

  const handleOpenHistory = useCallback(async ({ entryId = null, sort = null } = {}) => {
    if (sort) setHistoryInitialSort(sort)
    setHistoryExpandedId(entryId || null)
    try { await showHistoryInterstitialAd() } catch (err) { console.warn('[running] show history ad failed', err) }
    setShowHistory(true)
  }, [showHistoryInterstitialAd])

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
    handleOpenHistory({ sort: 'record' })
  }, [ghostEnabled, handleOpenHistory, resetGhostSession])

  const handleChallengeRecord = useCallback((record) => {
    if (!record) return
    const timeline = record.ghostTimeline || buildGhostTimeline(record)
    const targetRecord = { ...record, ghostTimeline: timeline }
    setGhostEnabled(true)
    setGhostTarget(targetRecord)
    setGhostMessage(formatGhostLabel(targetRecord) || text.ghost?.targetReady || '')
    applyGhostTargetSettings(targetRecord)
    resetGhostSession()
    setShowHistory(false)
  }, [applyGhostTargetSettings, buildGhostTimeline, formatGhostLabel, language, resetGhostSession, text.ghost])

  const prepareGhostSession = useCallback(() => {
    if (isWalkMode) {
      resetGhostSession()
      return null
    }
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
    setGhostMessage(formatGhostLabel(targetRecord) || text.ghost?.targetReady || '')
    return targetRecord
  }, [applyGhostTargetSettings, buildGhostTimeline, findBestGhostRun, formatGhostLabel, ghostEnabled, goalPreset, ghostTarget, isWalkMode, language, resetGhostSession, text.ghost])

  const stopTracking = useCallback(() => {
    if (watchStopRef.current) {
      try {
        watchStopRef.current()
      } catch {}
      watchStopRef.current = null
    }
    if (motionStopRef.current) {
      try {
        motionStopRef.current()
      } catch {}
      motionStopRef.current = null
    }
  }, [])

  // WALKING MODE distance aggregation (pedometer or GPS fallback)
  const applyWalkingDistanceSample = useCallback((distance, timestamp, options = {}) => {
    const nowTs = Number.isFinite(timestamp) ? timestamp : Date.now()
    const { isMoving } = options || {}
    const rawDistance = Number.isFinite(distance) ? Math.max(0, distance) : 0
    const distanceWithOffset = rawDistance + (distanceOffsetRef.current || 0)
    const prevActivityDistance = Number.isFinite(lastActivityDistanceRef.current)
      ? lastActivityDistanceRef.current
      : distanceWithOffset
    const moved = typeof isMoving === 'boolean'
      ? isMoving
      : (distanceWithOffset - prevActivityDistance) > 0
    totalDistanceRef.current = distanceWithOffset
    setDistanceM(distanceWithOffset)

    const elapsedWithOffset = updateWalkingElapsed(nowTs, moved)
      ?? ((elapsedOffsetRef.current || 0) + (sessionStartRef.current ? Math.max(0, nowTs - sessionStartRef.current - pausedAccumulatedRef.current) : 0))

    const avgPace = distanceWithOffset >= MIN_AVG_PACE_DISTANCE_M && elapsedWithOffset > 0
      ? elapsedWithOffset / (distanceWithOffset / 1000)
      : null
    setAvgPaceMs(Number.isFinite(avgPace) ? avgPace : null)

    samplesRef.current.push({ t: nowTs, d: distanceWithOffset })
    const windowStart = nowTs - CURRENT_PACE_WINDOW_MS
    while (samplesRef.current.length && samplesRef.current[0].t < windowStart) {
      samplesRef.current.shift()
    }
    setCurrentPaceMs(null)
    lastActivityDistanceRef.current = distanceWithOffset
    lastActiveTsRef.current = nowTs
    persistCarryover({
      distanceM: distanceWithOffset,
      elapsedMs: elapsedWithOffset,
      steps: Number.isFinite(stepCountRef.current) ? stepCountRef.current : null,
      laps: lapsRef.current,
    })
    return { safeDistance: distanceWithOffset, safeElapsed: elapsedWithOffset }
  }, [persistCarryover, updateWalkingElapsed])

  // stopNativeSession=true: 네이티브 세션도 종료 (정지 버튼)
  // stopNativeSession=false: JavaScript 상태만 정리 (언마운트, 세션 전환 등)
  const stopPedometer = useCallback((stopNativeSession = true) => {
    pedometerActiveRef.current = false
    pedometerPausedBaseRef.current = null
    baseStepsRef.current = null
    const stopper = pedometerStopRef.current
    pedometerStopRef.current = null
    if (stopper && stopNativeSession) {
      try { stopper() } catch {}
    }
  }, [])

  const handlePedometerReading = useCallback((reading) => {
    if (!sessionActive) return

    const rawSteps = Number(reading?.steps)
    if (!Number.isFinite(rawSteps)) return

    // 날짜가 변경되었는지 먼저 확인 - rawSteps를 전달하여 새로운 base로 설정
    const resetResult = checkAndResetForNewDay(rawSteps)
    const ts = Number.isFinite(reading?.timestamp) ? reading.timestamp : Date.now()

    // 날짜 리셋이 발생한 경우, 자정 이후 증분만 계산
    let midnightStepDelta = 0
    if (resetResult.didReset && Number.isFinite(resetResult.previousBaseSteps)) {
      // 자정 직전 baseSteps와 현재 rawSteps의 차이 = 자정 이후 걸음수
      midnightStepDelta = Math.max(0, rawSteps - resetResult.previousBaseSteps)
      console.log('[walking] Midnight step delta:', {
        rawSteps,
        previousBaseSteps: resetResult.previousBaseSteps,
        midnightStepDelta
      })
    }

    if (baseStepsRef.current === null || rawSteps < baseStepsRef.current) {
      baseStepsRef.current = rawSteps
      setBaseSteps(rawSteps)
    }

    if (isPaused) {
      pedometerPausedBaseRef.current = rawSteps
      return
    }

    if (pedometerPausedBaseRef.current !== null && rawSteps >= pedometerPausedBaseRef.current) {
      const pausedDelta = rawSteps - pedometerPausedBaseRef.current
      baseStepsRef.current = (baseStepsRef.current ?? rawSteps) + pausedDelta
      setBaseSteps(baseStepsRef.current)
      pedometerPausedBaseRef.current = null
    }

		const base = baseStepsRef.current ?? rawSteps
		const sessionStepsLocal = Math.max(0, rawSteps - base)

		// 자정 이후 증분이 있으면 추가 (midnightStepDelta는 이미 자정 이후 걸음수)
		let totalSteps = sessionStepsLocal + midnightStepDelta + (stepOffsetRef.current || 0)
		const prevSteps = Number.isFinite(stepCountRef.current) ? stepCountRef.current : 0

		// ⚠️ 안전장치: 어떤 이유로든 새로운 계산값이 이전 값보다 작아지면
		// (센서 리셋, 오프셋 계산 오차 등) UI 상 걸음 수가 뒤로 가는 일이 없도록 막는다.
		if (totalSteps < prevSteps) {
			if (DEBUG_STEPS) {
				updateStepDebug({
					rawStepCounter: rawSteps,
					prevSteps,
					computedSteps: totalSteps,
					clampedToPrev: true,
					source: 'pedometer-clamp',
					updatedAt: ts,
				})
			}
			totalSteps = prevSteps
		}

		const stepDelta = totalSteps - prevSteps

    // 걸음수가 증가했을 때: 증가분에 해당하는 시간을 직접 추가
    if (stepDelta > 0) {
      // 평균 보행 속도: 4.5 km/h = 1.25 m/s
      const avgWalkSpeedMps = 1.25
      // 걸음수 증가분만큼 걸은 거리
      const distanceForSteps = stepDelta * strideLengthM
      // 해당 거리를 걷는데 걸린 시간 (초)
      const timeForSteps = distanceForSteps / avgWalkSpeedMps
      // ms로 변환하여 활성 시간에 추가
      walkActiveElapsedRef.current += timeForSteps * 1000
      // 마지막 틱 업데이트
      walkLastTickRef.current = ts
    }

    setSessionSteps(totalSteps)
    stepCountRef.current = totalSteps
    setStepCount(totalSteps)
    appendStepTimeline({ ts, steps: totalSteps })

    // iOS CMPedometer distance 우선 사용 (더 정확함)
    const distanceFromSensor = Number.isFinite(reading?.distance) && reading.distance > 0
      ? reading.distance
      : null

    // Fallback: 안드로이드 또는 iOS distance 없을 때 걸음수 × 보폭
    const distanceRaw = distanceFromSensor ?? (sessionStepsLocal * strideLengthM)

    // isMoving은 이제 의미 없음 (시간은 이미 위에서 추가됨)
    applyWalkingDistanceSample(distanceRaw, ts, { isMoving: false })

    if (DEBUG_STEPS) {
      const distanceWithOffset = distanceRaw + (distanceOffsetRef.current || 0)
      updateStepDebug({
        rawStepCounter: rawSteps,
        sessionSteps: totalSteps,
        distanceM: distanceWithOffset,
        source: 'pedometer',
        updatedAt: ts,
      })
    }
  }, [applyWalkingDistanceSample, appendStepTimeline, checkAndResetForNewDay, isPaused, sessionActive, strideLengthM, updateStepDebug])

  // 핸들러 ref를 항상 최신 상태로 유지 (stale closure 방지)
  useEffect(() => {
    pedometerReadingHandlerRef.current = handlePedometerReading
  }, [handlePedometerReading])

  const startPedometerUpdates = useCallback(async () => {
    if (!sessionActive || resolvedMode !== 'walk') return false

    const startWithBackground = async () => {
      const available = await backgroundPedometer.isAvailable()
      if (!available) return false

      const permission = await backgroundPedometer.requestPermission()
      const permissionOk = (
        permission === 'granted'
        || permission === 'authorized'
        || permission === 'authorizedAlways'
        || permission === 'notDetermined'
        || permission === 'prompt'
      )
      if (!permissionOk) {
        setPedometerReady(false)
        setPedometerError('permission')
        pedometerActiveRef.current = false
        return false
      }

      await backgroundPedometer.startUpdates((reading) => {
        pedometerActiveRef.current = true
        // ref를 통해 항상 최신 핸들러 호출 (stale closure 방지)
        pedometerReadingHandlerRef.current?.(reading)
      })
      pedometerStopRef.current = () => {
        try { return backgroundPedometer.stopUpdates() } catch {}
        return null
      }
      return true
    }

    const startWithFallback = async () => {
      const available = await pedometer.isAvailable()
      if (!available) return false
      const permission = await pedometer.requestPermission()
      const permissionOk = permission !== 'denied'
      if (!permissionOk) {
        setPedometerReady(false)
        setPedometerError('permission')
        pedometerActiveRef.current = false
        return false
      }
      await pedometer.startUpdates((reading) => {
        pedometerActiveRef.current = true
        // ref를 통해 항상 최신 핸들러 호출 (stale closure 방지)
        pedometerReadingHandlerRef.current?.(reading)
      })
      pedometerStopRef.current = () => {
        try { return pedometer.stopUpdates() } catch {}
        return null
      }
      return true
    }

    try {
      let ok = await startWithBackground()
      if (!ok) {
        ok = await startWithFallback()
      }
      if (ok) {
        setPedometerReady(true)
        setPedometerError(null)
        return true
      }
      setPedometerReady(false)
      setPedometerError('unavailable')
      pedometerActiveRef.current = false
      return false
    } catch (err) {
      setPedometerReady(false)
      setPedometerError(err?.message || 'error')
      pedometerActiveRef.current = false
      return false
    }
  }, [resolvedMode, sessionActive])

  const persistHistory = useCallback((record) => {
    setHistory((prev) => {
      // 동일 ID의 기존 기록 찾기 (자동 저장 덮어쓰기)
      const existingIndex = prev.findIndex((item) => item.id === record.id)

      let next
      if (existingIndex >= 0) {
        // 기존 기록 업데이트 (위치 유지)
        next = [...prev]
        next[existingIndex] = record
        console.log('[persistHistory] Updated existing record:', record.id)
      } else {
        // 새 기록 추가
        next = [record, ...prev].slice(0, MAX_HISTORY_ITEMS)
        console.log('[persistHistory] Added new record:', record.id)
      }

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

  const stopIdlePoll = useCallback(() => {
    if (idlePollTimerRef.current) {
      clearInterval(idlePollTimerRef.current)
      idlePollTimerRef.current = null
    }
  }, [])

  const exitIdleMode = useCallback(() => {
    stopIdlePoll()
    idleModeRef.current = false
  }, [stopIdlePoll])

  const enterIdleMode = useCallback(() => {
    // Idle mode disabled to ensure continuous tracking/screen lock
  }, [])

  useEffect(() => {
    setCapPlatform(resolveCapacitorPlatform())
  }, [])

  useEffect(() => {
    setStrideLengthM(resolveStrideLengthMeters())
  }, [resolvedMode])

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

  // 워킹 모드는 만보기 전용: 음성/고스트/설정 비활성화
  useEffect(() => {
    if (!isWalkMode) return
    if (voiceEnabled) setVoiceEnabled(false)
    if (targetPaceMs !== null) setTargetPaceMs(null)
    if (timeCueMs !== 0) setTimeCueMs(0)
    if (ghostEnabled) setGhostEnabled(false)
    if (ghostTarget) setGhostTarget(null)
    if (ghostMessage) setGhostMessage('')
  }, [isWalkMode, voiceEnabled, targetPaceMs, timeCueMs, ghostEnabled, ghostTarget, ghostMessage])

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
    if (resolvedMode !== 'walk') {
      setStepCount(null)
      setDisplayStepCount(null)
      stepCountRef.current = null
      stepDisplayRef.current = null
      if (DEBUG_STEPS) {
        setStepDebugInfo(null)
      }
    }
  }, [resolvedMode])

  useEffect(() => {
    if (!sessionActive || resolvedMode !== 'walk') {
      // 세션이 비활성화되면 UI 상태만 리셋
      // stopPedometer()는 정지 버튼에서만 호출
      setPedometerReady(false)
      setPedometerError(null)
      setBaseSteps(null)
      setSessionSteps(0)
      baseStepsRef.current = null
      sessionRestoredRef.current = false
      return undefined
    }

    // 앱 실행 중일 때만 리스너 시작
    let cancelled = false
    ;(async () => {
      const ok = await startPedometerUpdates()
      if (!ok && !cancelled) {
        setSessionSteps(0)
      }
    })()
    return () => {
      cancelled = true
      // 워킹 모드에서는 cleanup 시 pedometer를 중지하지 않음
      // 네이티브 세션은 계속 유지됨
    }
  }, [resolvedMode, sessionActive, startPedometerUpdates])

  useEffect(() => () => stopStepAnim(), [stopStepAnim])

  // Animate UI step display so jumps from sensor batches look smoother
  useEffect(() => {
    if (!Number.isFinite(stepCount)) {
      stopStepAnim()
      setDisplayStepCount(stepCount)
      stepDisplayRef.current = stepCount
      updateStepDebug({ displayStepCount: stepCount, source: 'display-reset' })
      return
    }
    const current = Number.isFinite(stepDisplayRef.current) ? stepDisplayRef.current : 0
    const target = stepCount
    if (target <= current + 1) {
      stopStepAnim()
      setDisplayStepCount(target)
      stepDisplayRef.current = target
      updateStepDebug({ displayStepCount: target, source: 'display-direct' })
      return
    }
    stopStepAnim()
    const stepSize = Math.max(1, Math.floor((target - current) / 20))
    stepDisplayRef.current = current
    setDisplayStepCount(current)
    stepAnimTimerRef.current = setInterval(() => {
      const next = Math.min(target, (stepDisplayRef.current || 0) + stepSize)
      stepDisplayRef.current = next
      setDisplayStepCount(next)
      updateStepDebug({ displayStepCount: next, source: 'display-anim' })
      if (next >= target) {
        stopStepAnim()
      }
    }, 50)
    return stopStepAnim
  }, [stepCount, stopStepAnim, updateStepDebug])

  // 앱 시작 시 Android 백그라운드 서비스 상태 확인 및 복원
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (resolvedMode !== 'walk') return
    if (sessionRestoredRef.current) return // 이미 복원했으면 다시 실행하지 않음

    ;(async () => {
      try {
        const status = await backgroundPedometer.getServiceStatus()
        if (status?.isRunning && !sessionActive) {
          console.log('[RunningSession] Detected running background service, restoring session state')
          console.log('[RunningSession] Current steps from service:', status.currentSteps)

          // 날짜 체크: 세션 시작 날짜와 오늘 날짜 비교
          const sessionDate = Number.isFinite(status.sessionStartTime) && status.sessionStartTime > 0
            ? getDateKeyFromValue(status.sessionStartTime)
            : null
          const todayKey = getTodayKey()

          if (sessionDate && sessionDate !== todayKey) {
            console.log('[RunningSession] Session from different day, resetting', { sessionDate, todayKey })
            // 네이티브 세션 종료 및 데이터 리셋
            try {
              await backgroundPedometer.stopUpdates()
            } catch {}
            clearCarryoverState()
            sessionRestoredRef.current = true
            return // 복원하지 않고 새로 시작 화면 표시
          }

          sessionRestoredRef.current = true

          // 캐리오버 기준값 (당일) 로드
          const carry = loadCarryoverState()
          const carryValid = carry && carry.mode === 'walk'
          const carryDistance = carryValid ? Math.max(0, Number(carry.distanceM) || 0) : 0
          const carryElapsed = carryValid ? Math.max(0, Number(carry.elapsedMs) || 0) : 0
          const carrySteps = carryValid && Number.isFinite(carry.steps) ? Math.max(0, Number(carry.steps)) : 0

	          const restoredStepsRaw = Number(status.currentSteps)
	          const restoredCandidate = Number.isFinite(restoredStepsRaw) ? Math.max(0, restoredStepsRaw) : null
	          // 절대 캐리오버 값보다 작게 복원하지 않음 (UI가 165 → 40처럼 줄어드는 것 방지)
	          const restoredSteps = restoredCandidate != null
	            ? Math.max(carrySteps, restoredCandidate)
	            : carrySteps
	          const stepDelta = Math.max(0, restoredSteps - carrySteps)

          const stride = Number.isFinite(strideLengthM) && strideLengthM > 0 ? strideLengthM : WALK_STRIDE_M
          const restoredDistance = carryDistance + stepDelta * stride
          const avgWalkSpeedMps = 1.25
          const restoredElapsedActive = carryElapsed + ((stepDelta * stride) / avgWalkSpeedMps) * 1000

          // 스텝/거리/시간 오프셋 재정렬
          stepOffsetRef.current = restoredSteps
          stepCountRef.current = restoredSteps
          setStepCount(restoredSteps)
          setDisplayStepCount(restoredSteps)
          setSessionSteps(restoredSteps)

          distanceOffsetRef.current = restoredDistance
          totalDistanceRef.current = restoredDistance
          setDistanceM(restoredDistance)

          walkActiveElapsedRef.current = restoredElapsedActive
          elapsedOffsetRef.current = 0
          setElapsedMs(restoredElapsedActive)

          const avgPace = restoredDistance >= MIN_AVG_PACE_DISTANCE_M && restoredElapsedActive > 0
            ? restoredElapsedActive / (restoredDistance / 1000)
            : null
          setAvgPaceMs(Number.isFinite(avgPace) ? avgPace : null)

          // 랩 기준값도 현재 거리/시간에 맞춰 재설정
          lapStartDistanceRef.current = restoredDistance
          lapTargetRef.current = Math.floor(restoredDistance / lapDistanceM) * lapDistanceM + lapDistanceM
          walkLapStartElapsedRef.current = restoredElapsedActive
          if (carryValid && Array.isArray(carry.laps)) {
            lapsRef.current = carry.laps
            setLaps(carry.laps)
          }

          const restoredSessionStart = Number.isFinite(status.sessionStartTime) && status.sessionStartTime > 0
            ? status.sessionStartTime
            : Date.now()
          sessionStartRef.current = restoredSessionStart
          sessionStartDateRef.current = getDateKeyFromValue(restoredSessionStart) || getTodayKey()

          appendStepTimeline({ ts: Date.now(), steps: restoredSteps })

          // Pedometer 상태 복원
          setPedometerReady(true)
          pedometerActiveRef.current = true

          setSessionActive(true)
          // carryover에서 isPaused 상태 복원 (저장된 상태 유지)
          const restoredIsPaused = carryValid && carry.isPaused === true
          setIsPaused(restoredIsPaused)

          console.log('[RunningSession] Session restored - steps:', restoredSteps, 'distance:', restoredDistance, 'isPaused:', restoredIsPaused)
        }
      } catch (err) {
        console.warn('[RunningSession] Failed to check service status:', err)
      }
    })()
  }, [appendStepTimeline, clearCarryoverState, lapDistanceM, loadCarryoverState, resolvedMode, sessionActive, strideLengthM])

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

  // 날짜 변경 감지: 자정 이후 pedometer 이벤트가 없어도 강제 리셋
  useEffect(() => {
    if (!sessionActive || !isWalkMode) return undefined
    const interval = setInterval(() => {
      checkAndResetForNewDay(null, true)
    }, 30000)
    return () => clearInterval(interval)
  }, [sessionActive, isWalkMode, checkAndResetForNewDay])

  // 테스트용 시드 데이터 정리: seed_12/06, seed_12/07 제거
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (!raw) return
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      const cleaned = arr.filter((entry) => {
        const id = entry?.id || ''
        const isSeed = entry?.seed === true
        const isSeedId = typeof id === 'string' && id.startsWith('seed_')
        return !isSeed && !isSeedId
      })
      if (cleaned.length !== arr.length) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(cleaned))
        setHistory(cleaned)
        console.log('[running] Removed test seed history entries')
      }
    } catch (err) {
      console.warn('[running] Failed to remove seed entries', err)
    }
  }, [])

  // 정기 자동 저장 (1분마다) - 데이터 손실 방지
  useEffect(() => {
    if (!sessionActive || !sessionStartRef.current) return undefined

    const AUTO_SAVE_INTERVAL_MS = 60 * 1000 // 1분

    const intervalId = setInterval(() => {
      const currentTime = Date.now()
      const duration = currentTime - sessionStartRef.current
      const distance = totalDistanceRef.current
      const avgPaceSafe = distance > 0 ? (duration / (distance / 1000)) : 0

      // ref에서 최신 값 읽기 (의존성 배열에서 제외하여 타이머 리셋 방지)
      const currentSteps = stepCountRef.current
      const lapSnapshot = lapsRef.current.map((lap) => ({ ...lap }))
      const routeSnapshot = routePointsRef.current.map((pt) => ({ ...pt }))

      console.log('[walking] Auto-saving session data (periodic):', {
        steps: currentSteps,
        distance,
        duration,
      })

      // 칼로리 계산 (caloriesLive 로직 복사)
      const elapsedMinutes = duration > 0 ? duration / 60000 : 0
      const avgSpeedKmh = duration > 0 ? (distance / 1000) / (duration / 3600000) : null
      const met = (() => {
        if (!avgSpeedKmh) return null
        if (avgSpeedKmh < 3) return 2.0
        if (avgSpeedKmh < 4.5) return 2.8
        if (avgSpeedKmh < 5.5) return 3.5
        return 4.3
      })()
      const caloriesCalc = met && elapsedMinutes > 0
        ? met * 3.5 * DEFAULT_WEIGHT_KG / 200 * elapsedMinutes
        : null

      // 케이던스 계산 (cadenceSpmLive 로직 복사)
      const cadenceCalc = resolvedMode === 'walk' && elapsedMinutes > 0 && Number.isFinite(currentSteps)
        ? currentSteps / elapsedMinutes
        : null

      // 임시 저장 (세션 재개 시 덮어쓰기 가능)
      persistHistory({
        id: `${sessionStartRef.current}`, // 동일 ID로 저장하여 세션 종료 시 덮어쓰기
        mode: resolvedMode,
        startedAt: sessionStartRef.current,
        durationMs: duration,
        distanceM: distance,
        avgPaceMs: avgPaceSafe,
        laps: lapSnapshot,
        route: routeSnapshot,
        lapDistanceM,
        timeCueMs,
        targetPaceMs,
        goal: goalRef.current || null,
        voiceEnabled: voiceEnabledRef.current,
        steps: currentSteps,
        cadenceSpm: Number.isFinite(cadenceCalc) ? cadenceCalc : undefined,
        strideLengthM: Number.isFinite(strideLengthM) ? strideLengthM : undefined,
        calories: Number.isFinite(caloriesCalc) ? caloriesCalc : undefined,
        intensityLevel: (() => {
          if (!avgSpeedKmh) return null
          if (avgSpeedKmh < 3) return 'Slow'
          if (avgSpeedKmh < 5) return 'Moderate'
          if (avgSpeedKmh < 7) return 'Fast'
          return 'Very Fast'
        })(),
        goalProgress: resolvedMode === 'walk' && Number.isFinite(currentSteps) && STEP_GOAL_DEFAULT > 0
          ? (currentSteps / STEP_GOAL_DEFAULT) * 100
          : undefined,
        elevationGainM: Number.isFinite(elevationGainRef.current) ? elevationGainRef.current : undefined,
        autoSaved: true, // 자동 저장 플래그
      })
    }, AUTO_SAVE_INTERVAL_MS)

    return () => clearInterval(intervalId)
  }, [sessionActive, resolvedMode, lapDistanceM, timeCueMs, targetPaceMs, strideLengthM])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopAllTTS().catch(() => {})
        forceUnduck().catch(() => {})

        // 백그라운드 진입 시 현재 세션 자동 저장 (데이터 손실 방지)
        if (sessionActive && sessionStartRef.current) {
          const currentTime = Date.now()
          const duration = currentTime - sessionStartRef.current
          const distance = totalDistanceRef.current
          const avgPaceSafe = distance > 0 ? (duration / (distance / 1000)) : 0

          // ref에서 최신 값 읽기
          const currentSteps = stepCountRef.current
          const lapSnapshot = lapsRef.current.map((lap) => ({ ...lap }))
          const routeSnapshot = routePointsRef.current.map((pt) => ({ ...pt }))

          // 칼로리 계산
          const elapsedMinutes = duration > 0 ? duration / 60000 : 0
          const avgSpeedKmh = duration > 0 ? (distance / 1000) / (duration / 3600000) : null
          const met = (() => {
            if (!avgSpeedKmh) return null
            if (avgSpeedKmh < 3) return 2.0
            if (avgSpeedKmh < 4.5) return 2.8
            if (avgSpeedKmh < 5.5) return 3.5
            return 4.3
          })()
          const caloriesCalc = met && elapsedMinutes > 0
            ? met * 3.5 * DEFAULT_WEIGHT_KG / 200 * elapsedMinutes
            : null

          // 케이던스 계산
          const cadenceCalc = resolvedMode === 'walk' && elapsedMinutes > 0 && Number.isFinite(currentSteps)
            ? currentSteps / elapsedMinutes
            : null

          // 임시 저장 (세션 재개 시 덮어쓰기 가능)
          persistHistory({
            id: `${sessionStartRef.current}`, // 동일 ID로 저장하여 세션 종료 시 덮어쓰기
            mode: resolvedMode,
            startedAt: sessionStartRef.current,
            durationMs: duration,
            distanceM: distance,
            avgPaceMs: avgPaceSafe,
            laps: lapSnapshot,
            route: routeSnapshot,
            lapDistanceM,
            timeCueMs,
            targetPaceMs,
            goal: goalRef.current || null,
            voiceEnabled: voiceEnabledRef.current,
            steps: currentSteps,
            cadenceSpm: Number.isFinite(cadenceCalc) ? cadenceCalc : undefined,
            strideLengthM: Number.isFinite(strideLengthM) ? strideLengthM : undefined,
            calories: Number.isFinite(caloriesCalc) ? caloriesCalc : undefined,
            intensityLevel: (() => {
              if (!avgSpeedKmh) return null
              if (avgSpeedKmh < 3) return 'Slow'
              if (avgSpeedKmh < 5) return 'Moderate'
              if (avgSpeedKmh < 7) return 'Fast'
              return 'Very Fast'
            })(),
            goalProgress: resolvedMode === 'walk' && Number.isFinite(currentSteps) && STEP_GOAL_DEFAULT > 0
              ? (currentSteps / STEP_GOAL_DEFAULT) * 100
              : undefined,
            elevationGainM: Number.isFinite(elevationGainRef.current) ? elevationGainRef.current : undefined,
            autoSaved: true, // 자동 저장 플래그
          })
        }
      } else if (document.visibilityState === 'visible') {
        // 앱이 포그라운드로 돌아올 때 날짜 변경 확인 (forceReset=true)
        // pedometer가 없어도 리셋해야 함 (GPS만 사용하는 경우)
        checkAndResetForNewDay(null, true)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [checkAndResetForNewDay, sessionActive, resolvedMode, lapDistanceM, timeCueMs, targetPaceMs, strideLengthM])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('running_voice_enabled', String(voiceEnabled))
    }
    voiceEnabledRef.current = voiceEnabled
  }, [voiceEnabled])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(HISTORY_AD_LAST_SHOWN_KEY)
      const parsed = raw ? Number(raw) : 0
      if (Number.isFinite(parsed)) {
        lastHistoryAdShownRef.current = parsed
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (resolvedMode !== 'walk') return
    try {
      const key = `${PACE_TARGET_STORAGE_KEY}_${resolvedMode}`
      localStorage.setItem(key, 'off')
      setTargetPaceMs(null)
      setTimeCueMs(0)
    } catch {}
  }, [resolvedMode])

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
	    if (typeof window === 'undefined') return
	    try {
	      if (!walkGoalConfig) {
	        localStorage.removeItem(WALK_GOALS_STORAGE_KEY)
	      } else {
	        localStorage.setItem(WALK_GOALS_STORAGE_KEY, JSON.stringify(walkGoalConfig))
	      }
	    } catch {}
	  }, [walkGoalConfig])

	  useEffect(() => {
	    if (typeof window === 'undefined') return
	    try {
	      if (!walkBadges || Object.keys(walkBadges).length === 0) {
	        localStorage.removeItem(WALK_BADGES_STORAGE_KEY)
	      } else {
	        localStorage.setItem(WALK_BADGES_STORAGE_KEY, JSON.stringify(walkBadges))
	      }
	    } catch {}
	  }, [walkBadges])

	  useEffect(() => {
	    if (typeof window === 'undefined') return
	    try {
	      if (!runGoalConfig) {
	        localStorage.removeItem(RUN_GOALS_STORAGE_KEY)
	      } else {
	        localStorage.setItem(RUN_GOALS_STORAGE_KEY, JSON.stringify(runGoalConfig))
	      }
	    } catch {}
	  }, [runGoalConfig])

	  useEffect(() => {
	    if (typeof window === 'undefined') return
	    try {
	      if (!runBadges || Object.keys(runBadges).length === 0) {
	        localStorage.removeItem(RUN_BADGES_STORAGE_KEY)
	      } else {
	        localStorage.setItem(RUN_BADGES_STORAGE_KEY, JSON.stringify(runBadges))
	      }
	    } catch {}
	  }, [runBadges])

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

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('running_battery_saver', String(batterySaver))
    }
  }, [batterySaver])

  // Prevent page/body scroll when dropdowns are open
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const body = document.body
    const prevOverflow = body.style.overflow
    if (anyDropdownOpen) {
      body.style.overflow = 'hidden'
    } else {
      body.style.overflow = ''
    }
    return () => {
      body.style.overflow = prevOverflow
    }
  }, [anyDropdownOpen])

  // Auto-activate screen lock when session starts
  useEffect(() => {
    if (!sessionActive) {
      setSessionKeepAwake(false)
      return
    }
    if (resolvedMode === 'walk') {
      setSessionKeepAwake(false)
      return
    }
    // 배터리 절약 모드가 켜지면 화면 항상 켜기 비활성화
    setSessionKeepAwake(!batterySaver && preventScreenLock)
  }, [sessionActive, preventScreenLock, batterySaver, resolvedMode])

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
    // 배너 광고는 러닝 중(sessionActive && !isPaused && !isWalkMode)에만 표시
    const shouldShowBanner = sessionActive && !isPaused && !isWalkMode
    const adId = capPlatform === 'ios' ? BANNER_AD_UNITS.ios : BANNER_AD_UNITS.android

    if (!shouldShowBanner || !adId) {
      setBannerStatus('unavailable')
      hideBannerAd().catch(() => {})
      return
    }

    const bannerPosition = capPlatform === 'ios' ? 'TOP_CENTER' : 'BOTTOM_CENTER'
    const bannerMargin = capPlatform === 'ios' ? -10 : 0

    let cancelled = false
    setBannerStatus('loading')
    ;(async () => {
      try {
        if (cancelled) return
        const ok = await showBannerAd({ adId, position: bannerPosition, adSize: 'BANNER', margin: bannerMargin })
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
  }, [capPlatform, sessionActive, isPaused, isWalkMode])

  useEffect(() => {
    return () => {
      stopTracking()
      releaseWakeLock().catch(() => {})
      hideBannerAd().catch(() => {})
      stopIdlePoll()
      // 워킹 모드: JavaScript 상태만 정리, 네이티브 세션은 유지
      // 런닝 모드: 네이티브 세션도 종료
      stopPedometer(resolvedMode !== 'walk')
    }
  }, [resolvedMode, stopPedometer, stopTracking, stopIdlePoll])

  useEffect(() => {
    if (!sessionActive || isPaused || isWalkMode) return undefined
    if (batterySaver) {
      const interval = setInterval(() => {
        if (sessionStartRef.current) {
          const now = Date.now()
          const base = now - sessionStartRef.current - pausedAccumulatedRef.current
          const elapsed = (elapsedOffsetRef.current || 0) + base
          setElapsedMs(elapsed)
        }
      }, 1000) // 저전력 모드: 1초 단위로 타이머 업데이트
      return () => clearInterval(interval)
    }

    let raf = 0
    const tick = () => {
      if (sessionStartRef.current) {
        const now = Date.now()
        const base = now - sessionStartRef.current - pausedAccumulatedRef.current
        const elapsed = (elapsedOffsetRef.current || 0) + base
        setElapsedMs(elapsed)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [sessionActive, isPaused, batterySaver, isWalkMode])

  // WALKING: 부드러운 실시간 타임 표시용 경과 업데이트
  useEffect(() => {
    if (!sessionActive || isPaused || !isWalkMode) return undefined
    const tick = () => {
      const now = Date.now()
      const last = walkLastTickRef.current
      const delta = last ? Math.max(0, now - last) : 0
      const clamped = delta > 0 ? Math.min(delta, STEP_SENSOR_STALE_MS) : 0
      const elapsed = (elapsedOffsetRef.current || 0) + walkActiveElapsedRef.current + clamped
      setElapsedMs(elapsed)
    }
    const interval = setInterval(tick, 300)
    return () => clearInterval(interval)
  }, [sessionActive, isPaused, isWalkMode, updateWalkingElapsed])

  useEffect(() => {
    if (!sessionActive || isPaused) return
    if (isWalkMode) return
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
    if (isWalkMode) return
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

  // Location / step handling (steps는 센서/가속도 기반만 사용)
  const handleLocation = useCallback((position) => {
    if (!sessionActive || isPaused) return

    // 1. Common initial processing (날짜 체크에 필요한 최소 값만 먼저 계산)
    const now = Date.now()
    const pedometerActive = resolvedMode === 'walk' && pedometerReady && pedometerActiveRef.current

    // 워킹모드일 때 날짜 변경 체크 (GPS/stride 추정 경로)
    // pedometerActive가 false면 pedometer 이벤트가 없으므로 forceReset=true
    if (resolvedMode === 'walk') {
      const shouldForceReset = !pedometerActive
      const resetResult = checkAndResetForNewDay(null, shouldForceReset)
      if (resetResult.didReset) {
        // 날짜 리셋이 발생한 경우, 센서 베이스 초기화하고 현재 이벤트 처리 중단
        // 다음 이벤트에서 새로운 베이스로 시작
        stepSessionTokenRef.current = null
        stepSensorBaseRef.current = null
        lastSensorStepValueRef.current = null
        lastStepUpdateTsRef.current = null
        lastSensorStepTsRef.current = null
        return
      }
    }

    const sessionToken = sessionStartRef.current
    if (stepSessionTokenRef.current !== sessionToken) {
      stepSessionTokenRef.current = sessionToken
      stepSensorBaseRef.current = null
      lastSensorStepValueRef.current = null
      lastStepUpdateTsRef.current = null
      lastSensorStepTsRef.current = null
    }

    // 2. 나머지 초기 처리
    const nowTsRaw = Number(position?.timestamp)
    const nowTs = Number.isFinite(nowTsRaw) ? nowTsRaw : Date.now()
    const accuracyRaw = Number.isFinite(position?.accuracy)
      ? Number(position.accuracy)
      : Number.isFinite(position?.coords?.accuracy)
        ? Number(position.coords.accuracy)
        : null
    const gpsSpeedRaw = Number.isFinite(position?.coords?.speed)
      ? Number(position.coords.speed)
      : (Number.isFinite(position?.speed) ? Number(position.speed) : null)
    const hasStepCounter = Number.isFinite(position?.stepCounter)
    const usingWalkingGpsFallback = resolvedMode === 'walk' && !pedometerActive

    // Accelerometer magnitude calculation and DEBUG_STEPS logging
    const accelMag = Number.isFinite(position.accelX) && Number.isFinite(position.accelY) && Number.isFinite(position.accelZ)
      ? Math.sqrt(position.accelX * position.accelX + position.accelY * position.accelY + position.accelZ * position.accelZ)
      : null
    if (DEBUG_STEPS && now - (stepDebugLogTsRef.current || 0) > 1000) {
      updateStepDebug({
        rawStepCounter: position.stepCounter ?? null,
        accel: {
          x: position.accelX ?? null,
          y: position.accelY ?? null,
          z: position.accelZ ?? null,
          mag: accelMag,
        },
        source: 'sensor-event',
      })
      stepDebugLogTsRef.current = now
    }
    setLatestAccuracy(Number.isFinite(accuracyRaw) ? Math.round(accuracyRaw) : null)

    // stepCounter 기준값 초기화 (센서 리셋 대비)
    const rawSensorSteps = Number(position?.stepCounter)
    if (Number.isFinite(rawSensorSteps)) {
      if (stepSensorBaseRef.current === null || rawSensorSteps < stepSensorBaseRef.current) {
        stepSensorBaseRef.current = rawSensorSteps
      }
    }
    const relativeSensorSteps = Number.isFinite(rawSensorSteps) && Number.isFinite(stepSensorBaseRef.current)
      ? Math.max(0, rawSensorSteps - stepSensorBaseRef.current)
      : null

    const latitude = Number(position?.latitude ?? position?.coords?.latitude)
    const longitude = Number(position?.longitude ?? position?.coords?.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return
    }

    // 2. Create currentPoint
    const currentPoint = {
      latitude,
      longitude,
      altitude: Number.isFinite(position?.altitude)
        ? position.altitude
        : Number.isFinite(position?.coords?.altitude)
          ? position.coords.altitude
          : null,
      timestamp: nowTs,
      stepCounter: hasStepCounter ? position.stepCounter : null,
      horizontalAccuracy: Number.isFinite(accuracyRaw) ? accuracyRaw : null,
      speed: gpsSpeedRaw ?? null,
      accelX: Number.isFinite(position.accelX) ? position.accelX : null,
      accelY: Number.isFinite(position.accelY) ? position.accelY : null,
      accelZ: Number.isFinite(position.accelZ) ? position.accelZ : null,
    }
    routePointsRef.current.push(currentPoint)

    // WALKING MODE pedometer-first: skip GPS distance accumulation
    if (pedometerActive) {
      lastPointRef.current = currentPoint
      return
    }

    // 3. GPS-based distance calculation (CORE) - 개선된 DistanceCalculator 사용
    const prevTotalDistance = Number.isFinite(totalDistanceRef.current) ? totalDistanceRef.current : 0
    let total = prevTotalDistance
    let deltaM = 0
    let shouldUpdateAnchor = true

    // DistanceCalculator를 사용한 거리 계산
    if (distanceCalculatorRef.current) {
      const result = distanceCalculatorRef.current.onLocationUpdate({
        latitude: currentPoint.latitude,
        longitude: currentPoint.longitude,
        timestamp: nowTs,
        accuracy: currentPoint.horizontalAccuracy,
        speed: gpsSpeedRaw
      })

      if (result.accepted && result.deltaDistance > 0) {
        deltaM = result.deltaDistance
        total = distanceCalculatorRef.current.getTotalDistance()
        shouldUpdateAnchor = true
      } else {
        deltaM = 0
        // DistanceCalculator 정책과 동기화: stationary/below_threshold는 시간 흐름 반영을 위해 앵커 업데이트
        const updateAnchorOnReject = [
          'stationary',
          'below_threshold',
          'below_threshold_after_smoothing',
          'first_location'
        ].includes(result.reason)
        shouldUpdateAnchor = updateAnchorOnReject
      }
    } else {
      // Fallback: DistanceCalculator가 없는 경우 기존 로직 사용
      const prev = lastPointRef.current
      const minDistanceThreshold = usingWalkingGpsFallback ? WALK_GPS_FALLBACK_MIN_SEGMENT_M : MIN_DISTANCE_DELTA

      if (prev && Number.isFinite(prev.latitude) && Number.isFinite(prev.longitude)) {
        const dtMs = nowTs - prev.timestamp
        const prevAccuracy = Number.isFinite(prev.horizontalAccuracy) ? prev.horizontalAccuracy : null
        const currAccuracy = Number.isFinite(currentPoint.horizontalAccuracy) ? currentPoint.horizontalAccuracy : null

        if (!Number.isFinite(dtMs) || dtMs <= 0) {
          shouldUpdateAnchor = false
        } else {
          const dtSeconds = dtMs / 1000
          const accuracySpike = (Number.isFinite(currAccuracy) && currAccuracy > ACCURACY_STRICT_REJECT_M)
            || (Number.isFinite(prevAccuracy) && prevAccuracy > ACCURACY_STRICT_REJECT_M)
          const accuracyBad = (Number.isFinite(currAccuracy) && currAccuracy > MAX_ACCEPTABLE_ACCURACY_M)
            || (Number.isFinite(prevAccuracy) && prevAccuracy > MAX_ACCEPTABLE_ACCURACY_M)

          if (dtMs <= LOCATION_STALE_THRESHOLD_MS && !accuracySpike) {
            let rawDelta = haversineDistanceMeters(
              { latitude: prev.latitude, longitude: prev.longitude },
              { latitude: currentPoint.latitude, longitude: currentPoint.longitude }
            )

            if (!Number.isFinite(rawDelta) || rawDelta < 0) {
              rawDelta = 0
            }

            if (!Number.isFinite(currAccuracy) && !Number.isFinite(prevAccuracy)) {
              rawDelta = Math.min(rawDelta, UNKNOWN_ACCURACY_DELTA_CAP_M)
            } else if (accuracyBad) {
              rawDelta = 0
            }

            const maxSpeedMps = resolvedMode === 'run' ? RUN_MAX_SPEED_MPS : WALK_MAX_SPEED_MPS
            const speedMps = dtSeconds > 0 ? rawDelta / dtSeconds : 0
            const gpsSpeedMps = Number.isFinite(gpsSpeedRaw) ? gpsSpeedRaw : null
            const speedInvalid = !Number.isFinite(speedMps) || speedMps <= 0 || speedMps > maxSpeedMps
            const gpsSpeedInvalid = gpsSpeedMps !== null && gpsSpeedMps > maxSpeedMps * 1.2

            // WALKING MODE GPS fallback: ignore tiny jitter & near-stationary drift
            if (usingWalkingGpsFallback && rawDelta > 0) {
              if (rawDelta < WALK_GPS_FALLBACK_MIN_SEGMENT_M) {
                rawDelta = 0
              } else {
                const speedMpsFiltered = dtSeconds > 0 ? rawDelta / dtSeconds : 0
                if (speedMpsFiltered < WALK_GPS_FALLBACK_MIN_SPEED_MS) {
                  rawDelta = 0
                }
              }
            }

            if (speedInvalid || gpsSpeedInvalid) {
              rawDelta = 0
            } else if (rawDelta > 0 && rawDelta < minDistanceThreshold) {
              rawDelta = 0
            }

            deltaM = Number.isFinite(rawDelta) ? Math.max(0, rawDelta) : 0
          } else {
            // Stale or highly inaccurate sample: record but don't contribute to distance
            deltaM = 0
          }
        }
      }

      if (deltaM > 0 && Number.isFinite(deltaM)) {
        total += deltaM
      }
    }

    const stepDistanceFromSensor = (!usingWalkingGpsFallback && resolvedMode === 'walk' && Number.isFinite(relativeSensorSteps))
      ? relativeSensorSteps * strideLengthM
      : null
    if (Number.isFinite(stepDistanceFromSensor)) {
      total = Math.max(total, stepDistanceFromSensor)
    }

    totalDistanceRef.current = Number.isFinite(total) ? Math.max(prevTotalDistance, total) : prevTotalDistance
    if (shouldUpdateAnchor || !lastPointRef.current) {
      lastPointRef.current = currentPoint
    }
    const safeDistance = Number.isFinite(totalDistanceRef.current) ? totalDistanceRef.current : prevTotalDistance
    const safeDistanceDelta = Math.max(0, safeDistance - prevTotalDistance)

    // GPS 기반 보폭 보정 (워킹 모드 + GPS 백업 또는 일반 GPS 사용 시)
    // DistanceCalculator와 Fallback 모두에서 실행되도록 공통 위치에 배치
    if (resolvedMode === 'walk' && safeDistanceDelta > 0) {
      const recentSteps = stepCountRef.current || 0
      const prevGpsSteps = lastGpsStepCountRef.current || 0
      const stepDeltaGps = recentSteps - prevGpsSteps

      if (stepDeltaGps > 10 && safeDistanceDelta >= 10) {
        // GPS 구간에서 실제 측정된 보폭 계산
        const strideFromGps = safeDistanceDelta / stepDeltaGps

        // 유효 범위 체크 (0.4m ~ 1.2m)
        if (strideFromGps > 0.4 && strideFromGps < 1.2) {
          // EMA(지수이동평균)로 완만하게 보정 (80% 기존, 20% 새 값)
          const newStride = strideLengthM * 0.8 + strideFromGps * 0.2
          setStrideLengthM(newStride)
        }
      }

      lastGpsStepCountRef.current = recentSteps
    }
    const elapsedRaw = sessionStartRef.current
      ? nowTs - sessionStartRef.current - pausedAccumulatedRef.current
      : 0
    const safeElapsed = Number.isFinite(elapsedRaw) ? Math.max(0, elapsedRaw) : 0
    const elapsedWithOffset = (elapsedOffsetRef.current || 0) + safeElapsed
    const distanceOffset = distanceOffsetRef.current || 0
    const rawDistancePortion = Math.max(0, safeDistance - distanceOffset)
    let fallbackElapsed = null

    if (usingWalkingGpsFallback) {
      const res = applyWalkingDistanceSample(rawDistancePortion, nowTs, { isMoving: safeDistanceDelta > 0 })
      fallbackElapsed = res?.safeElapsed ?? null
    } else {
      setDistanceM(safeDistance)

      // 4. Elapsed time / average pace calculation
      setElapsedMs(elapsedWithOffset)

      const avgPace = safeDistance >= MIN_AVG_PACE_DISTANCE_M && elapsedWithOffset > 0
        ? elapsedWithOffset / (safeDistance / 1000)
        : null
      setAvgPaceMs(Number.isFinite(avgPace) ? avgPace : null)

      // 5. Current pace calculation (recent N seconds window)
      if (Number.isFinite(safeDistance)) {
        samplesRef.current.push({ t: nowTs, d: safeDistance })
        const windowStart = nowTs - CURRENT_PACE_WINDOW_MS
        while (samplesRef.current.length && samplesRef.current[0].t < windowStart) {
          samplesRef.current.shift()
        }

        let currentPace = null
        if (samplesRef.current.length >= 2) {
          const first = samplesRef.current[0]
          const distDelta = safeDistance - first.d
          const dtMsWin = nowTs - first.t
          if (distDelta >= CURRENT_PACE_MIN_DISTANCE_M && dtMsWin > 0) {
            currentPace = dtMsWin / (distDelta / 1000)
          }
        }
        setCurrentPaceMs(resolvedMode === 'run' && Number.isFinite(currentPace) ? currentPace : null)
      } else {
        setCurrentPaceMs(null)
      }
    }

    // 6. metricsAccumulator for auxiliary data only (steps, calories, etc.)
    const snap = metricsRef.current?.addSample(currentPoint) || null

    const distanceStepEstimate = resolvedMode === 'walk' && Number.isFinite(strideLengthM) && strideLengthM > 0
      ? Math.max(0, Math.round((Number.isFinite(safeDistance) ? safeDistance : 0) / strideLengthM))
      : null

    if (resolvedMode === 'walk') {
      const prevSteps = Number.isFinite(stepCountRef.current) ? stepCountRef.current : 0
      const strideSteps = Number.isFinite(safeDistance) && strideLengthM > 0
        ? Math.max(0, Math.round(safeDistance / strideLengthM))
        : null
      let nextSteps = prevSteps
      if (Number.isFinite(relativeSensorSteps)) {
        nextSteps = Math.max(nextSteps, relativeSensorSteps)
      }
      if (Number.isFinite(distanceStepEstimate) && distanceStepEstimate > 0) {
        nextSteps = Math.max(nextSteps, distanceStepEstimate)
      }
      if (Number.isFinite(strideSteps)) {
        nextSteps = Math.max(nextSteps, strideSteps)
      }

      stepCountRef.current = nextSteps
      if (nextSteps !== prevSteps) {
        appendStepTimeline({ ts: nowTs, steps: nextSteps })
      }
      if (DEBUG_STEPS) {
        const distanceDelta = safeDistance - (prevDistanceRef.current || 0)
        prevDistanceRef.current = safeDistance
        updateStepDebug({
          distanceM: safeDistance,
          distanceDeltaM: distanceDelta,
          speedMps: Number.isFinite(gpsSpeedRaw) ? gpsSpeedRaw : null,
          sessionSteps: stepCountRef.current,
          rawStepCounter: hasStepCounter ? position.stepCounter : null,
          source: hasStepCounter ? 'sensor-snap' : 'gps-fallback',
          clampedMaxStepDelta: null,
        })
      }
    } else {
      stepCountRef.current = null
    }
    setStepCount(Number.isFinite(stepCountRef.current) ? stepCountRef.current : (resolvedMode === 'walk' ? 0 : null))

    // Activity markers (no idle toggling)
    lastActivityDistanceRef.current = safeDistance
    lastActivityStepsRef.current = Number.isFinite(stepCountRef.current) ? stepCountRef.current : lastActivityStepsRef.current
    lastActiveTsRef.current = Number.isFinite(nowTs) ? nowTs : lastActiveTsRef.current

    // 7. Ghost mode / lap logic
    const elapsedForGhost = (usingWalkingGpsFallback && isWalkMode && Number.isFinite(fallbackElapsed))
      ? fallbackElapsed
      : safeElapsed

    // Ghost comparison at each kilometer mark
    if (ghostSessionRef.current?.enabled) {
      let nextKm = ghostSessionRef.current.nextKmIndex || 1
      const lastGhostLap = ghostSessionRef.current.lapsTimeline?.[ghostSessionRef.current.lapsTimeline.length - 1]
      const ghostMaxKm = lastGhostLap ? Math.ceil((Number(lastGhostLap.cumulativeDistanceM) || 0) / 1000) : Infinity
      while (totalDistanceRef.current >= nextKm * 1000 && nextKm <= ghostMaxKm + 1) {
        const ghostElapsed = getGhostElapsedAtDistance(nextKm * 1000)
        if (ghostElapsed != null && voiceEnabledRef.current) {
          const diffSeconds = Math.round((elapsedForGhost - ghostElapsed) / 1000)
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
      const lapDistance = totalDistanceRef.current - lapStartDistanceRef.current
      const lapDuration = resolvedMode === 'walk'
        ? Math.max(0, elapsedForGhost - (walkLapStartElapsedRef.current || 0))
        : lapStartTimeRef.current
          ? nowTs - lapStartTimeRef.current - lapPausedAccumulatedRef.current
          : elapsedForGhost
      const lapPace = lapDuration / (lapDistance / 1000)
      const lap = {
        index: lapIndex,
        durationMs: lapDuration,
        paceMs: lapPace,
        distanceM: lapDistance,
        timestamp: nowTs,
        elapsedMs: elapsedForGhost,
      }
      lapsRef.current = [...lapsRef.current, lap]
      setLaps(lapsRef.current)
      lapStartTimeRef.current = nowTs
      lapStartDistanceRef.current = totalDistanceRef.current
      if (resolvedMode === 'walk') {
        walkLapStartElapsedRef.current = elapsedForGhost
      }
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
  }, [applyWalkingDistanceSample, checkAndResetForNewDay, getGhostElapsedAtDistance, isPaused, lapDistanceM, language, resolvedMode, sessionActive, pedometerReady, strideLengthM, enterIdleMode, exitIdleMode])

  // keep latest handleLocation in ref for idle polling
  useEffect(() => {
    handleLocationRef.current = handleLocation
  }, [handleLocation])

  useEffect(() => {
    // Accelerometer stream (fallback when no step sensor). Only runs when session is active.
    if (!sessionActive || isPaused) {
      if (motionStopRef.current) {
        try { motionStopRef.current() } catch {}
        motionStopRef.current = null
      }
      return undefined
    }
    const Motion = getCapacitorMotion()
    if (Motion?.addListener) {
      const sub = Motion.addListener('accel', (event) => {
        // Prefer gravity-filtered values when available to reduce false steps
        const accel = event?.acceleration || {}
        const accelG = event?.accelerationIncludingGravity || {}
        const x = Number.isFinite(accel.x) ? accel.x : accelG.x
        const y = Number.isFinite(accel.y) ? accel.y : accelG.y
        const z = Number.isFinite(accel.z) ? accel.z : accelG.z
        if (!metricsRef.current) return
        metricsRef.current.addSample({
          timestamp: Date.now(),
          accelX: Number.isFinite(x) ? x : null,
          accelY: Number.isFinite(y) ? y : null,
          accelZ: Number.isFinite(z) ? z : null,
        })
      })
      motionStopRef.current = () => {
        try { sub?.remove() } catch {}
      }
    } else {
      // Fallback to browser devicemotion when Capacitor Motion plugin is unavailable
      let stopped = false
      ;(async () => {
        const permitted = await requestDeviceMotionPermission()
        if (!permitted) return
        const handler = (event) => {
          if (!metricsRef.current) return
          const accel = event?.acceleration || {}
          const accelG = event?.accelerationIncludingGravity || {}
          const x = Number.isFinite(accel.x) ? accel.x : accelG.x
          const y = Number.isFinite(accel.y) ? accel.y : accelG.y
          const z = Number.isFinite(accel.z) ? accel.z : accelG.z
          metricsRef.current.addSample({
            timestamp: Date.now(),
            accelX: Number.isFinite(x) ? x : null,
            accelY: Number.isFinite(y) ? y : null,
            accelZ: Number.isFinite(z) ? z : null,
          })
        }
        window.addEventListener('devicemotion', handler)
        motionStopRef.current = () => {
          if (stopped) return
          stopped = true
          try { window.removeEventListener('devicemotion', handler) } catch {}
        }
      })()
    }
    return () => {
      try { motionStopRef.current?.() } catch {}
      motionStopRef.current = null
    }
  }, [sessionActive, isPaused])

  useEffect(() => {
    if (!sessionActive || isPaused) {
      stopTracking()
      return undefined
    }
    if (isWalkMode && locationPermission !== 'granted' && locationPermission !== 'limited') {
      // 워킹 모드에서 위치 권한이 없으면 GPS 워치는 건너뛰고 만보기만 사용
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
  }, [sessionActive, isPaused, handleLocation, stopTracking, isWalkMode, locationPermission])

  const handleStartSession = async () => {
    if (starting || sessionActive) return
    clearError()
    setStarting(true)
    try {
      const permission = await ensureLocationPermission()
      setLocationPermission(permission)
      const locationOk = permission === 'granted' || permission === 'limited'
      if (!locationOk) {
        if (resolvedMode !== 'walk') {
          pushError('permission')
          return
        }
        // 워킹 모드는 위치 없이도 만보기로 진행 (경고만 표시 가능)
        console.warn('[running] proceeding with pedometer-only mode (no location permission)')
      }
      const platform = capPlatform || resolveCapacitorPlatform()
      let activityOk = true
      if (platform === 'android') {
        activityOk = await ensureActivityRecognitionPermission()
        if (activityOk) {
          await maybeRequestIgnoreBatteryOptimizations()
        }
      } else if (platform === 'ios') {
        activityOk = await ensurePedometerPermission()
      }
      if (!activityOk) {
        setError(language === 'ko' ? '신체 활동 권한이 필요합니다.' : 'Activity permission is required for step counting.')
        return
      }
      const allowVoice = !isWalkMode && voiceEnabled
      if (allowVoice) {
        try {
          await unlockTTS(language === 'ko' ? 'ko-KR' : 'en-US')
        } catch (err) {
          console.warn('[running] TTS unlock failed', err)
        }
      }
      if (!isWalkMode) {
        prepareGhostSession()
      } else {
        resetGhostSession()
      }
      // 워킹 모드: JavaScript 상태만 초기화, 네이티브 세션은 유지 (복원용)
      // 런닝 모드: 네이티브 세션도 종료
      stopPedometer(!isWalkMode)
      setPedometerReady(false)
      setPedometerError(null)
      setBaseSteps(null)
      setSessionSteps(0)
      baseStepsRef.current = null
      pedometerPausedBaseRef.current = null
      pedometerActiveRef.current = false
      setStrideLengthM(resolveStrideLengthMeters())
      const carry = loadCarryoverState()
      const todayKey = getTodayKey()

      // 워킹모드일 때 세션 시작 날짜 저장
      if (resolvedMode === 'walk') {
        sessionStartDateRef.current = todayKey
        console.log('[walking] Session started on date:', todayKey)
      }

    const validCarry = resolvedMode === 'walk' && carry && carry.dateKey === todayKey && carry.mode === resolvedMode
      const carryLapDistance = validCarry && Number.isFinite(carry.lapDistanceM)
        ? (carry.lapDistanceM === 500 ? 500 : 1000)
        : lapDistanceM
      const carryDistance = validCarry ? Math.max(0, Number(carry.distanceM) || 0) : 0
      const carryElapsed = validCarry ? Math.max(0, Number(carry.elapsedMs) || 0) : 0
      const carrySteps = validCarry ? Math.max(0, Number(carry.steps) || 0) : 0
      const carryLaps = validCarry && Array.isArray(carry.laps) ? carry.laps : []
      if (!validCarry && carry && carry.dateKey !== todayKey) {
        clearCarryoverState()
        console.log('[walking] Cleared old carryover data from different date')
      }
      setLapDistanceM(carryLapDistance)
      distanceOffsetRef.current = carryDistance
      elapsedOffsetRef.current = resolvedMode === 'walk' ? 0 : carryElapsed
      stepOffsetRef.current = carrySteps
      totalDistanceRef.current = carryDistance
      walkActiveElapsedRef.current = resolvedMode === 'walk' ? carryElapsed : 0
      walkLastTickRef.current = null
      walkLapStartElapsedRef.current = resolvedMode === 'walk' ? carryElapsed : 0
      sessionStartRef.current = Date.now()
      lapStartTimeRef.current = sessionStartRef.current
      lapStartDistanceRef.current = carryDistance
      lapPausedAccumulatedRef.current = 0
      lapPauseStartRef.current = 0
      pausedAccumulatedRef.current = 0
      pausedIntervalsRef.current.length = 0
      lapTargetRef.current = Math.floor(carryDistance / carryLapDistance) * carryLapDistance + carryLapDistance
      lastPointRef.current = null
      routePointsRef.current = []
      lastAltitudeRef.current = null
      elevationGainRef.current = 0
      samplesRef.current = []
      lapsRef.current = carryLaps
      smoothedSpeedRef.current = null
      goalRef.current = goalPreset
      goalReachedRef.current = false
      lastTimeCueRef.current = null
      lastGpsStepCountRef.current = resolvedMode === 'walk' ? carrySteps : null  // GPS 보폭 보정 초기화
      if (timeCueMs && timeCueMs > 0) {
        const nextCue = Math.ceil((carryElapsed || 0) / timeCueMs) * timeCueMs || timeCueMs
        nextTimeCueRef.current = nextCue
      } else {
        nextTimeCueRef.current = null
      }
      paceCoachRef.current = { ts: 0, direction: null }
      setGoalBanner(null)
      setLaps(carryLaps)
      setRoutePoints([])
      totalDistanceRef.current = carryDistance
      setDistanceM(carryDistance)
      const initElapsed = carryElapsed
      setElapsedMs(initElapsed)
      const initAvgPace = carryDistance >= MIN_AVG_PACE_DISTANCE_M && initElapsed > 0
        ? initElapsed / (carryDistance / 1000)
        : null
      setAvgPaceMs(Number.isFinite(initAvgPace) ? initAvgPace : null)
      setStepCount(resolvedMode === 'walk' ? carrySteps : null)
      setSessionSteps(resolvedMode === 'walk' ? carrySteps : 0)
      setDisplayStepCount(resolvedMode === 'walk' ? carrySteps : null)
      setCurrentPaceMs(null)
      setLatestAccuracy(null)
      if (resolvedMode === 'walk') {
        if (!validCarry) {
          stepTimelineRef.current = []
          setStepTimeline([])
        }
        appendStepTimeline({ ts: sessionStartRef.current, steps: carrySteps })
      }
      setShowStats(false)
      setWorkoutStats(null)
      setSessionActive(true)
      setIsPaused(false)
      if (resolvedMode === 'walk') {
        setSessionKeepAwake(false)
      }
      stepCountRef.current = resolvedMode === 'walk' ? carrySteps : null
      stepDisplayRef.current = resolvedMode === 'walk' ? carrySteps : null
      setDisplayStepCount(resolvedMode === 'walk' ? carrySteps : null)
      stepSensorSeenRef.current = false
      lastSensorStepTsRef.current = null
      lastActiveTsRef.current = sessionStartRef.current
      lastActivityDistanceRef.current = carryDistance
      lastActivityStepsRef.current = 0
      idleModeRef.current = false
      prevDistanceRef.current = 0
      if (DEBUG_STEPS) {
        setStepDebugInfo({
          rawStepCounter: null,
          sessionSteps: carrySteps,
          displayStepCount: resolvedMode === 'walk' ? carrySteps : null,
          distanceM: carryDistance,
          distanceDeltaM: 0,
          speedMps: null,
          source: 'session-start',
          updatedAt: Date.now(),
        })
      }
      metricsRef.current = createMetricsAccumulator({
        mode: resolvedMode === 'walk' ? 'walking' : 'running',
        userWeightKg: DEFAULT_WEIGHT_KG,
        userStepGoal: STEP_GOAL_DEFAULT,
        sessionStartTime: sessionStartRef.current,
        pausedIntervals: pausedIntervalsRef.current,
        stepCounterAtStart: null,
        enableAccelFallback: resolvedMode === 'walk',
        onDebug: DEBUG_STEPS ? (payload) => updateStepDebug(payload) : null,
      })

      // DistanceCalculator 초기화
      distanceCalculatorRef.current = new DistanceCalculator({
        mode: resolvedMode === 'run' ? 'run' : 'walk',
        enableSmoothing: true,
        initialDistance: carryDistance
      })

      samplesRef.current.push({ t: sessionStartRef.current, d: carryDistance })
    } catch (err) {
      pushError('generic', err?.message)
    } finally {
      setStarting(false)
    }
  }

  const handlePause = () => {
    if (!sessionActive || isPaused) return
    const now = Date.now()
    pauseStartRef.current = now
    lapPauseStartRef.current = pauseStartRef.current
    if (isWalkMode) {
      flushWalkingElapsed(now)
      walkLastTickRef.current = null
    }
    setIsPaused(true)
    lastIdleProbeRef.current = null
    stopIdlePoll()
    idleModeRef.current = false
    pedometerPausedBaseRef.current = null
  }

  const handleResume = () => {
    if (!sessionActive || !isPaused) return
    const now = Date.now()
    pausedAccumulatedRef.current += now - (pauseStartRef.current || now)
    if (lapPauseStartRef.current) {
      lapPausedAccumulatedRef.current += now - lapPauseStartRef.current
    }
    if (pauseStartRef.current) {
      pausedIntervalsRef.current.push({ start: pauseStartRef.current, end: now })
    }
    lapPauseStartRef.current = 0
    pauseStartRef.current = 0
    if (isWalkMode) {
      walkLastTickRef.current = null
    }
    setIsPaused(false)
    lastPointRef.current = null
    smoothedSpeedRef.current = null // Reset speed smoothing after pause
    paceCoachRef.current = { ts: 0, direction: null }
    lastActiveTsRef.current = now
    idleModeRef.current = false
  }

  const finalizeSession = useCallback(() => {
    stopTracking()
    stopIdlePoll()
    idleModeRef.current = false
    const endTs = Date.now()
    if (pauseStartRef.current) {
      pausedIntervalsRef.current.push({ start: pauseStartRef.current, end: endTs })
    }
    const sessionPauseCarry = pauseStartRef.current ? endTs - pauseStartRef.current : 0

    // Get snapshot for auxiliary data only (steps, calories, etc.)
    const snapshot = metricsRef.current?.getSnapshot(endTs, pausedIntervalsRef.current) || null

    // Duration: always use our direct calculation
    const durationRaw = resolvedMode === 'walk'
      ? flushWalkingElapsed(endTs)
      : (sessionStartRef.current
        ? endTs - sessionStartRef.current - pausedAccumulatedRef.current - sessionPauseCarry
        : (snapshot?.elapsedMs ?? 0))
    const duration = Number.isFinite(durationRaw) ? Math.max(0, durationRaw) : 0

    // Distance: always use totalDistanceRef.current
    const distance = Number.isFinite(totalDistanceRef.current) ? Math.max(0, totalDistanceRef.current) : 0

    // Step count calculation (auxiliary data from snapshot)
    const snapSteps = Number.isFinite(snapshot?.steps) ? Math.max(0, snapshot.steps) : null
    const recordedSteps = Number.isFinite(stepCountRef.current) ? Math.max(0, stepCountRef.current) : null
    const distanceStepEstimate = resolvedMode === 'walk' && Number.isFinite(strideLengthM) && strideLengthM > 0
      ? Math.max(0, Math.round(distance / strideLengthM))
      : null
    let stepCount = null
    if (resolvedMode === 'walk') {
      if (Number.isFinite(recordedSteps)) {
        stepCount = recordedSteps
      } else if (Number.isFinite(snapSteps)) {
        stepCount = snapSteps
      }
      if (Number.isFinite(distanceStepEstimate)) {
        stepCount = Math.max(stepCount ?? 0, distanceStepEstimate)
      }
    }

    // Average pace: calculate directly, not from snapshot
    const avgPace = (distance >= MIN_AVG_PACE_DISTANCE_M && duration > 0)
      ? duration / (distance / 1000)
      : null
    const avgPaceSafe = Number.isFinite(avgPace) ? avgPace : null
    const calories = Number.isFinite(snapshot?.calories) ? snapshot.calories : 0
    const cadenceSpmRaw = Number.isFinite(snapshot?.cadenceSpm) ? snapshot.cadenceSpm : (
      distance > 0 && duration > 0 && Number.isFinite(stepCount)
        ? stepCount / Math.max(1, duration / 60000)
        : null
    )
    const cadenceSpm = Number.isFinite(cadenceSpmRaw) ? cadenceSpmRaw : null
    const strideLengthRaw = Number.isFinite(snapshot?.strideLengthM) ? snapshot.strideLengthM : (
      Number.isFinite(stepCount) && stepCount > 0 ? distance / stepCount : null
    )
    const strideLength = Number.isFinite(strideLengthRaw) ? strideLengthRaw : null
    const elevationGain = Number.isFinite(snapshot?.elevationGainM)
      ? snapshot.elevationGainM
      : (Number.isFinite(elevationGainRef.current) ? elevationGainRef.current : 0)
    const intensityLevel = snapshot?.intensity ?? snapshot?.intensityLevel ?? null
    const snapshotGoalProgress = Number.isFinite(snapshot?.goalProgress) ? snapshot.goalProgress : null
    const goalProgress = resolvedMode === 'walk' && Number.isFinite(stepCount) && stepCount > 0
      ? (stepCount / STEP_GOAL_DEFAULT) * 100
      : snapshotGoalProgress
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

    // Carryover 저장: 같은 날짜 재시작 시 이어서 진행
    persistCarryover({
      distanceM: distance,
      elapsedMs: duration,
      steps: stepCount,
      laps: lapSnapshot,
    })

    // Auto-save session to history immediately
    // 세션 시작 타임스탬프를 ID로 사용 (자동 저장과 동일 ID로 덮어쓰기)
    persistHistory({
      id: `${sessionStartRef.current}`,
      mode: resolvedMode,
      startedAt: sessionStartRef.current,
      durationMs: duration,
      distanceM: distance,
      avgPaceMs: avgPaceSafe,
      laps: lapSnapshot,
      route: routeSnapshot,
      lapDistanceM,
      timeCueMs,
      targetPaceMs,
      goal: goalRef.current || null,
      voiceEnabled: voiceEnabledRef.current,
      ghostResult,
      steps: stepCount,
      cadenceSpm,
      strideLengthM: strideLength,
      calories,
      intensityLevel,
      goalProgress,
      elevationGainM: elevationGain,
      autoSaved: false, // 최종 저장은 autoSaved=false (자동 저장 덮어쓰기)
    })

    const summaryText = SESSION_TEXT[language]?.summary || SESSION_TEXT.en.summary
    const caloriesValue = Number.isFinite(calories) ? calories : 0
    setWorkoutStats({
      totalTime: { value: formatClock(duration, { showHours: duration >= 3600000 }), label: summaryText.totalTime },
      totalDistance: { value: formatDistanceLabel(distance, 2), label: summaryText.distance },
      avgPace: { value: Number.isFinite(avgPaceSafe) ? formatPaceLabel(avgPaceSafe) : '--:-- /km', label: summaryText.avgPace },
      laps: { value: `${lapSnapshot.length}`, label: summaryText.laps },
      ...(Number.isFinite(stepCount)
        ? { steps: { value: stepCount.toLocaleString(), label: summaryText.steps || 'Steps' } }
        : {}),
      ...(Number.isFinite(cadenceSpm)
        ? { cadence: { value: `${cadenceSpm.toFixed(0)}`, label: summaryText.cadence || 'Cadence (spm)' } }
        : {}),
      ...(Number.isFinite(strideLength)
        ? { stride: { value: `${(strideLength).toFixed(2)} m`, label: summaryText.stride || 'Stride' } }
        : {}),
      ...(true
        ? { calories: { value: Number.isFinite(caloriesValue) ? `${caloriesValue.toFixed(0)} kcal` : '-- kcal', label: summaryText.calories || 'Calories' } }
        : {}),
      ...(Number.isFinite(elevationGain)
        ? { elevation: { value: `${elevationGain.toFixed(0)} m`, label: summaryText.elevation || 'Elevation Gain' } }
        : {}),
      ...(intensityLevel
        ? { intensity: { value: intensityLevel, label: summaryText.intensity || 'Intensity' } }
        : {}),
      ...(Number.isFinite(goalProgress)
        ? { goalProgress: { value: `${goalProgress.toFixed(0)}%`, label: summaryText.goalProgress || 'Goal' } }
        : {}),
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
      avgPaceMs: avgPaceSafe,
      lapCount: lapSnapshot.length,
      ghostResult,
      cadenceSpm,
      strideLengthM: strideLength,
      calories,
      intensityLevel,
      goalProgress,
      elevationGainM: elevationGain,
      steps: stepCount,
	      // Running weekly/monthly distance goal context (for summary overlay)
	      runWeeklyTotalDistanceM,
	      runMonthlyTotalDistanceM,
	      runWeeklyGoalProgress,
	      runMonthlyGoalProgress,
	      runWeeklyTargetKm: runGoalConfig?.weeklyDistanceKm?.target || RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT,
	      runMonthlyTargetKm: runGoalConfig?.monthlyDistanceKm?.target || RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT,
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
  }, [flushWalkingElapsed, language, lapDistanceM, persistCarryover, persistHistory, resolvedMode, resetGhostSession, resolveRecordDistance, stopTracking, stopIdlePoll, strideLengthM, timeCueMs, targetPaceMs])

  const handleEndSession = () => {
    if (!sessionActive) return
    if (resolvedMode === 'walk') {
      // 워킹 모드: 정지 버튼 = 일시정지 (세션 유지, 걸음수 화면에 표시 유지)
      const endTs = Date.now()
      const carryDistance = Number.isFinite(totalDistanceRef.current) ? totalDistanceRef.current : distanceM
      const finalElapsed = flushWalkingElapsed(endTs) ?? elapsedMs
      const carryElapsed = Number.isFinite(finalElapsed) ? finalElapsed : 0
      const carrySteps = Number.isFinite(stepCountRef.current) ? stepCountRef.current : (Number.isFinite(stepCount) ? stepCount : 0)

      // carryover에 현재 상태 저장 (다시 시작할 때 복원용)
      persistCarryover({
        distanceM: carryDistance,
        elapsedMs: carryElapsed,
        steps: carrySteps,
        laps: lapsRef.current,
        isPaused: true,  // 일시정지 상태 저장
      })

      // GPS 추적만 중지, 네이티브 pedometer는 계속 실행
      stopTracking()
      stopIdlePoll()
      idleModeRef.current = false
      setSessionKeepAwake(false)
      // 워킹 모드에서는 sessionActive=true 유지, isPaused=true로 설정
      // 이렇게 하면 화면에 걸음수가 계속 표시됨
      setIsPaused(true)
      return
    }
    setSessionActive(false)
    setIsPaused(false)
    // DistanceCalculator 리셋
    if (distanceCalculatorRef.current) {
      distanceCalculatorRef.current = null
    }
    // GPS 보폭 보정 ref 초기화
    lastGpsStepCountRef.current = null
    // 세션 종료 시 날짜 ref 초기화
    if (resolvedMode === 'walk') {
      sessionStartDateRef.current = null
    }
    finalizeSession()
  }


  const nextLapMeters = Math.max(0, lapTargetRef.current - totalDistanceRef.current)
  const startButtonLabel = isWalkMode
    ? (language === 'ko' ? '시작' : 'Start')
    : (language === 'ko'
      ? `${modeTitle}${text.setup.startSuffix}`
      : `${text.setup.startPrefix} ${modeTitle}`.trim())
  const timeCueLabel = timeCueMs
    ? `${Math.round(timeCueMs / 60000)}${language === 'ko' ? '분' : 'm'}`
    : language === 'ko'
      ? '끄기'
      : 'Off'
  const paceGuideLabel = targetPaceMs ? formatPaceLabel(targetPaceMs) : language === 'ko' ? '끄기' : 'Off'
  const goalLabel = goalPreset ? formatGoalLabel(goalPreset, language) : ''
  const ghostTargetRecord = ghostTarget || ghostSessionRef.current?.targetRun || null
  const ghostTargetText = formatGhostLabel(ghostTargetRecord)
  const ghostButtonLabel = ghostEnabled
    ? (text.ghost?.disableButton || 'Cancel challenge')
    : (text.ghost?.enableButton || 'Start challenge')

	  // Live derived metrics (walking)
	  const elapsedMinutesLive = elapsedMs > 0 ? elapsedMs / 60000 : 0
	  const avgSpeedKmhLive = elapsedMs > 0 ? (distanceM / 1000) / (elapsedMs / 3600000) : null
	  // 워킹 메인 "걸음 수"는 항상 센서의 최신 stepCount를 우선 사용해서
	  // 위클리/먼슬리 카드 및 다른 만보기 앱과 값이 바로 맞도록 함.
	  // (displayStepCount 는 애니메이션용 보조 값으로만 사용)
	  const uiStepCount = Number.isFinite(stepCount)
	    ? stepCount
	    : (Number.isFinite(displayStepCount) ? displayStepCount : stepCount)
  const cadenceSpmLive = isWalkMode && elapsedMinutesLive > 0 && Number.isFinite(stepCount)
    ? stepCount / elapsedMinutesLive
    : null
  const strideLengthLive = isWalkMode && Number.isFinite(stepCount) && stepCount > 0
    ? distanceM / stepCount
    : null
  const elapsedClockWalk = formatClock(elapsedMs, { showHours: elapsedMs >= 3600000, showCentiseconds: false })
  const elapsedClockRun = formatClock(elapsedMs, { showHours: true, showCentiseconds: true })
  const formatMonthLabel = useCallback((monthIndex) => {
    const month = monthIndex + 1
    const year = new Date().getFullYear()
    if (language === 'ko') return `${year}년 ${month}월`
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${monthNames[monthIndex]} ${year}`
  }, [language])
  const headerDateLabel = useMemo(() => {
    const now = new Date()
    const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`
    if (chartTab === 'day') {
      return fmt(now)
    }
    if (chartTab === 'week') {
      const start = new Date(now)
      start.setDate(now.getDate() - 6)
      return `${fmt(start)} ~ ${fmt(now)}`
    }
    if (chartTab === 'month') {
      return formatMonthLabel(now.getMonth())
    }
    return ''
  }, [chartTab, formatMonthLabel])
  const metLive = (() => {
    if (!avgSpeedKmhLive) return null
    if (avgSpeedKmhLive < 3) return 2.0
    if (avgSpeedKmhLive < 4.5) return 2.8
    if (avgSpeedKmhLive < 5.5) return 3.5
    return 4.3
  })()
  const caloriesLive = metLive && elapsedMinutesLive > 0
    ? metLive * 3.5 * DEFAULT_WEIGHT_KG / 200 * elapsedMinutesLive
    : null
  const elevationGainLive = Number.isFinite(elevationGainRef.current) ? elevationGainRef.current : null
  const goalProgressLive = isWalkMode && Number.isFinite(stepCount) && STEP_GOAL_DEFAULT > 0
    ? (stepCount / STEP_GOAL_DEFAULT) * 100
    : null
	  const walkCurrentSteps = useMemo(() => {
	    if (!isWalkMode) return null
	    if (Number.isFinite(stepCount)) return stepCount
	    if (Number.isFinite(displayStepCount)) return displayStepCount
	    if (Number.isFinite(stepCountRef.current)) return stepCountRef.current
	    return null
	  }, [isWalkMode, stepCount, displayStepCount])
	  const {
	    walkWeeklyTotalSteps,
	    walkWeeklyGoalProgress,
	    walkMonthlyTotalSteps,
	    walkMonthlyGoalProgress,
	  } = useMemo(() => {
	    const base = {
	      walkWeeklyTotalSteps: null,
	      walkWeeklyGoalProgress: null,
	      walkMonthlyTotalSteps: null,
	      walkMonthlyGoalProgress: null,
	    }
	    if (!isWalkMode) return base
	    const weeklyTarget = walkGoalConfig?.weeklySteps?.target || WALK_WEEKLY_STEPS_GOAL_DEFAULT
	    const monthlyTarget = walkGoalConfig?.monthlySteps?.target || WALK_MONTHLY_STEPS_GOAL_DEFAULT
	    const today = new Date()
	    const weekStart = new Date(today)
	    weekStart.setDate(today.getDate() - 6)
	    const dailySteps = {}
	    if (Array.isArray(history)) {
	      for (const entry of history) {
	        if (!entry || entry.mode !== 'walk') continue
	        const steps = Number(entry.steps)
	        if (!Number.isFinite(steps) || steps <= 0) continue
	        const ts = entry.startedAt || entry.timestamp
	        if (!ts) continue
	        const d = new Date(ts)
	        if (Number.isNaN(d.getTime())) continue
	        const key = formatDateKey(d)
	        const prev = dailySteps[key] || 0
	        if (steps > prev) dailySteps[key] = steps
	      }
	    }
	    // 오늘 실시간 걸음수 반영 (history에 있는 값보다 크면 덮어씀)
	    if (Number.isFinite(walkCurrentSteps) && walkCurrentSteps > 0) {
	      const todayKey = formatDateKey(today)
	      const prev = dailySteps[todayKey] || 0
	      if (walkCurrentSteps > prev) dailySteps[todayKey] = walkCurrentSteps
	    }
	    let weekTotal = 0
	    let monthTotal = 0
	    const currentYear = today.getFullYear()
	    const currentMonth = today.getMonth()
	    for (const [key, steps] of Object.entries(dailySteps)) {
	      const [y, m, d] = key.split('-').map((v) => Number(v))
	      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) continue
	      const date = new Date(y, m - 1, d)
	      if (Number.isNaN(date.getTime())) continue
	      if (date > today) continue
	      if (date >= weekStart) {
	        weekTotal += steps
	      }
	      if (date.getFullYear() === currentYear && date.getMonth() === currentMonth) {
	        monthTotal += steps
	      }
	    }
	    const clampPct = (v) => {
	      if (!Number.isFinite(v)) return null
	      return Math.min(v, 300)
	    }
	    const weeklyPct = weeklyTarget > 0 ? clampPct((weekTotal / weeklyTarget) * 100) : null
	    const monthlyPct = monthlyTarget > 0 ? clampPct((monthTotal / monthlyTarget) * 100) : null
	    return {
	      walkWeeklyTotalSteps: weekTotal,
	      walkWeeklyGoalProgress: weeklyPct,
	      walkMonthlyTotalSteps: monthTotal,
	      walkMonthlyGoalProgress: monthlyPct,
	    }
	  }, [history, isWalkMode, walkCurrentSteps, walkGoalConfig])

	  const {
	    runWeeklyTotalDistanceM,
	    runWeeklyGoalProgress,
	    runMonthlyTotalDistanceM,
	    runMonthlyGoalProgress,
	  } = useMemo(() => {
	    const base = {
	      runWeeklyTotalDistanceM: null,
	      runWeeklyGoalProgress: null,
	      runMonthlyTotalDistanceM: null,
	      runMonthlyGoalProgress: null,
	    }
	    if (isWalkMode) return base
	    const weeklyTargetKm = runGoalConfig?.weeklyDistanceKm?.target || RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT
	    const monthlyTargetKm = runGoalConfig?.monthlyDistanceKm?.target || RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT
	    const today = new Date()
	    const weekStart = new Date(today)
	    weekStart.setDate(today.getDate() - 6)
	    let weekTotalM = 0
	    let monthTotalM = 0
	    if (Array.isArray(history)) {
	      for (const entry of history) {
	        if (!entry || entry.mode !== 'run') continue
	        const distM = Number(entry.distanceM)
	        if (!Number.isFinite(distM) || distM <= 0) continue
	        const ts = entry.startedAt || entry.timestamp
	        if (!ts) continue
	        const d = new Date(ts)
	        if (Number.isNaN(d.getTime())) continue
	        if (d > today) continue
	        if (d >= weekStart) {
	          weekTotalM += distM
	        }
	        if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) {
	          monthTotalM += distM
	        }
	      }
	    }
	    const clampPct = (v) => {
	      if (!Number.isFinite(v)) return null
	      return Math.min(v, 300)
	    }
	    const weeklyTargetM = weeklyTargetKm > 0 ? weeklyTargetKm * 1000 : 0
	    const monthlyTargetM = monthlyTargetKm > 0 ? monthlyTargetKm * 1000 : 0
	    const weeklyPct = weeklyTargetM > 0 ? clampPct((weekTotalM / weeklyTargetM) * 100) : null
	    const monthlyPct = monthlyTargetM > 0 ? clampPct((monthTotalM / monthlyTargetM) * 100) : null
	    return {
	      runWeeklyTotalDistanceM: weekTotalM,
	      runWeeklyGoalProgress: weeklyPct,
	      runMonthlyTotalDistanceM: monthTotalM,
	      runMonthlyGoalProgress: monthlyPct,
	    }
	  }, [history, isWalkMode, runGoalConfig])

	  useEffect(() => {
	    if (!isWalkMode) return
	    if (walkWeeklyGoalProgress == null) return
	    if (walkWeeklyGoalProgress < 100) return
	    if (walkBadges && walkBadges[WALK_BADGE_WEEK_GOAL_FIRST]) return
	    unlockWalkBadge(WALK_BADGE_WEEK_GOAL_FIRST)
	  }, [isWalkMode, walkWeeklyGoalProgress, walkBadges, unlockWalkBadge])

	  useEffect(() => {
	    if (isWalkMode) return
	    if (runWeeklyGoalProgress == null) return
	    if (runWeeklyGoalProgress < 100) return
	    if (runBadges && runBadges[RUN_BADGE_WEEK_DISTANCE_FIRST]) return
	    unlockRunBadge(RUN_BADGE_WEEK_DISTANCE_FIRST)
	  }, [isWalkMode, runWeeklyGoalProgress, runBadges, unlockRunBadge])

	  useEffect(() => {
	    if (isWalkMode) return
	    if (runMonthlyGoalProgress == null) return
	    if (runMonthlyGoalProgress < 100) return
	    if (runBadges && runBadges[RUN_BADGE_MONTH_DISTANCE_FIRST]) return
	    unlockRunBadge(RUN_BADGE_MONTH_DISTANCE_FIRST)
	  }, [isWalkMode, runMonthlyGoalProgress, runBadges, unlockRunBadge])

	  useEffect(() => {
	    if (!badgeBanner) return
	    const timer = setTimeout(() => setBadgeBanner(null), 6000)
	    return () => clearTimeout(timer)
	  }, [badgeBanner])
		  const walkGoalsSummary = isWalkMode
		    ? (() => {
		        const cards = []
		        const weeklyCfg = walkGoalConfig?.weeklySteps
		        const monthlyCfg = walkGoalConfig?.monthlySteps
		        if (weeklyCfg?.active && walkWeeklyGoalProgress != null) {
		          const pct = Math.max(0, Math.min(100, walkWeeklyGoalProgress || 0))
		          const current = walkWeeklyTotalSteps || 0
		          const target = weeklyCfg.target || WALK_WEEKLY_STEPS_GOAL_DEFAULT
		          const currentLabel = formatStepsCompact(current, language)
		          const targetLabel = formatStepsCompact(target, language)
		          cards.push(
		            <div key="week" className="rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2">
		              <p className="text-[0.65rem] font-semibold text-emerald-200 uppercase tracking-[0.18em]">
		                {language === 'ko' ? '위클리 골' : 'Weekly goal'}
		              </p>
		              <p className="mt-0.5 text-xs font-semibold text-white">
		                {currentLabel} / {targetLabel} {language === 'ko' ? '보' : 'steps'}
		              </p>
		              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
		                <div
		                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
		                  style={{ width: `${pct}%` }}
		                />
		              </div>
		            </div>,
		          )
		        }
		        if (monthlyCfg?.active && walkMonthlyGoalProgress != null) {
		          const pct = Math.max(0, Math.min(100, walkMonthlyGoalProgress || 0))
		          const current = walkMonthlyTotalSteps || 0
		          const target = monthlyCfg.target || WALK_MONTHLY_STEPS_GOAL_DEFAULT
		          const currentLabel = formatStepsCompact(current, language)
		          const targetLabel = formatStepsCompact(target, language)
		          cards.push(
		            <div key="month" className="rounded-2xl border border-sky-400/25 bg-sky-500/10 px-3 py-2">
		              <p className="text-[0.65rem] font-semibold text-sky-200 uppercase tracking-[0.18em]">
		                {language === 'ko' ? '먼슬리 골' : 'Monthly goal'}
		              </p>
		              <p className="mt-0.5 text-xs font-semibold text-white">
		                {currentLabel} / {targetLabel} {language === 'ko' ? '보' : 'steps'}
		              </p>
		              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
		                <div
		                  className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-400"
		                  style={{ width: `${pct}%` }}
		                />
		              </div>
		            </div>,
		          )
		        }
		        if (!cards.length) return null
		        return (
		          <div className="mt-1 grid grid-cols-2 gap-2">
		            {cards}
		          </div>
		        )
		      })()
		    : null

	  const runGoalsSummary = !isWalkMode
	    ? (() => {
	        const cards = []
	        const weeklyCfg = runGoalConfig?.weeklyDistanceKm
	        const monthlyCfg = runGoalConfig?.monthlyDistanceKm
	        if (weeklyCfg?.active && runWeeklyGoalProgress != null) {
	          const pct = Math.max(0, Math.min(100, runWeeklyGoalProgress || 0))
	          const currentKm = (runWeeklyTotalDistanceM || 0) / 1000
	          const targetKm = weeklyCfg.target || RUN_WEEKLY_DISTANCE_GOAL_KM_DEFAULT
	          const currentLabel = formatKmLabel(currentKm, language)
	          const targetLabel = formatKmLabel(targetKm, language)
	          cards.push(
	            <div key="run-week" className="rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2">
	              <p className="text-[0.65rem] font-semibold text-emerald-200 uppercase tracking-[0.18em]">
	                {language === 'ko' ? '\uc8fc\uac04 \ub7ec\ub2dd' : 'Weekly run'}
	              </p>
	              <p className="mt-0.5 text-xs font-semibold text-white">
	                {currentLabel} / {targetLabel}
	              </p>
	              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
	                <div
	                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
	                  style={{ width: `${pct}%` }}
	                />
	              </div>
	            </div>,
	          )
	        }
	        if (monthlyCfg?.active && runMonthlyGoalProgress != null) {
	          const pct = Math.max(0, Math.min(100, runMonthlyGoalProgress || 0))
	          const currentKm = (runMonthlyTotalDistanceM || 0) / 1000
	          const targetKm = monthlyCfg.target || RUN_MONTHLY_DISTANCE_GOAL_KM_DEFAULT
	          const currentLabel = formatKmLabel(currentKm, language)
	          const targetLabel = formatKmLabel(targetKm, language)
	          cards.push(
	            <div key="run-month" className="rounded-2xl border border-sky-400/25 bg-sky-500/10 px-3 py-2">
	              <p className="text-[0.65rem] font-semibold text-sky-200 uppercase tracking-[0.18em]">
	                {language === 'ko' ? '\uc6d4\uac04 \ub7ec\ub2dd' : 'Monthly run'}
	              </p>
	              <p className="mt-0.5 text-xs font-semibold text-white">
	                {currentLabel} / {targetLabel}
	              </p>
	              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
	                <div
	                  className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-400"
	                  style={{ width: `${pct}%` }}
	                />
	              </div>
	            </div>,
	          )
	        }
	        if (!cards.length) return null
	        return (
	          <div className="mt-1 grid grid-cols-2 gap-2">
	            {cards}
	          </div>
	        )
	      })()
	    : null
	  const intensityLive = (() => {
    if (!avgSpeedKmhLive) return null
    if (avgSpeedKmhLive < 3) return 'Slow'
    if (avgSpeedKmhLive < 4.5) return 'Normal'
    if (avgSpeedKmhLive < 5.5) return 'Power'
    return 'Fast'
  })()
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

  const runningSectionMarginClass = 'mt-3'
  const stackSpacingClass = capPlatform === 'ios' ? 'space-y-1' : 'space-y-2'
  const bannerAtTop = capPlatform === 'ios'
  const hasBannerSpace = (capPlatform === 'ios' || capPlatform === 'android')
  const bannerSpaceHeight = hasBannerSpace
    ? (bannerAtTop ? BANNER_HEIGHT_PX : getBannerPlaceholderHeight(capPlatform))
    : 0
  const recentPreviewCount = (capPlatform === 'ios' || capPlatform === 'android') ? 1 : 2
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
        { value: 1 * 60 * 1000, label: formatPaceLabel(1 * 60 * 1000) },
        { value: 3 * 60 * 1000, label: formatPaceLabel(3 * 60 * 1000) },
        { value: 5 * 60 * 1000, label: formatPaceLabel(5 * 60 * 1000) },
        { value: 7 * 60 * 1000, label: formatPaceLabel(7 * 60 * 1000) },
        { value: 10 * 60 * 1000, label: formatPaceLabel(10 * 60 * 1000) },
      ]
    : (() => {
        const opts = [{ value: null, label: language === 'ko' ? '끄기' : 'Off' }]
        for (let paceMin = 4; paceMin <= 10.0001; paceMin += 0.5) {
          const paceMs = paceMin * 60 * 1000
          opts.push({ value: paceMs, label: formatPaceLabel(paceMs) })
        }
        return opts
      })())

  const modeHistory = Array.isArray(history)
    ? history.filter((item) => !item.mode || item.mode === resolvedMode)
    : []

  return (
    <div
      className={stackSpacingClass}
      style={{
        paddingBottom: bannerAtTop ? 0 : bannerSpaceHeight,
        paddingTop: bannerAtTop ? bannerSpaceHeight : 0,
      }}
    >
      {DEBUG_STEPS && stepDebugInfo && (
        <div
          className="fixed z-50 max-w-xs rounded-lg border border-white/10 bg-black/70 p-3 text-xs text-white/90 shadow-lg backdrop-blur-sm"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          onClick={() => setStepDebugCollapsed((c) => !c)}
        >
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-emerald-200 mb-1">
            STEP DEBUG {stepDebugCollapsed ? '(tap to expand)' : ''}
          </p>
          {!stepDebugCollapsed && (
            <div className="space-y-1 leading-tight">
              <p>raw: {stepDebugInfo?.rawStepCounter ?? '-'}</p>
              <p>session: {stepDebugInfo?.sessionSteps ?? '-'}</p>
              <p>display: {stepDebugInfo?.displayStepCount ?? '-'}</p>
              <p>source: {stepDebugInfo?.source || '-'}</p>
              <p>dist(m): {stepDebugInfo?.distanceM != null ? stepDebugInfo.distanceM.toFixed(1) : '-'}</p>
              <p>dΔ(m): {stepDebugInfo?.distanceDeltaM != null ? stepDebugInfo.distanceDeltaM.toFixed(2) : '-'}</p>
              <p>speed(m/s): {stepDebugInfo?.speedMps != null ? stepDebugInfo.speedMps.toFixed(2) : '-'}</p>
              <p>
                accel:{' '}
                {stepDebugInfo?.accel
                  ? `x=${stepDebugInfo.accel.x ?? '-'} y=${stepDebugInfo.accel.y ?? '-'} z=${stepDebugInfo.accel.z ?? '-'} mag=${stepDebugInfo.accel.mag ?? '-'}`
                  : '-'}
              </p>
              <p className="text-[0.65rem] text-white/70">
                updated:{' '}
                {stepDebugInfo?.updatedAt
                  ? new Date(stepDebugInfo.updatedAt).toLocaleTimeString()
                  : '-'}
              </p>
              <p className="text-[0.65rem] text-white/60">(tap to collapse)</p>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          {error}
        </div>
      )}

      {(sessionActive || isWalkMode) ? (
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
	          {badgeBanner && (
	            <div className="mt-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-amber-50 shadow-lg">
	              <div className="flex items-center justify-between">
	                <div>
	                  <p className="text-xs font-bold uppercase tracking-[0.25em]">{badgeBanner.title}</p>
	                  <p className="text-sm font-semibold">{badgeBanner.detail}</p>
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
            <div className="flex items-center justify-between mb-3">
              <div className="flex-1">
                {!isWalkMode && (
                  <h3 className="text-base font-black tracking-tight text-white/90">{modeTitle}</h3>
                )}
              </div>
              <div className="flex-1 text-center">
                {isWalkMode && (
                  <span className="text-sm font-semibold text-white/80">{headerDateLabel}</span>
                )}
              </div>
              <div className="flex-1 flex justify-end">
                {latestAccuracy ? (
                  <div className="flex items-center gap-1.5 rounded-full bg-black/30 px-3 py-1 backdrop-blur-sm">
                    <span className="text-xs font-medium text-white/80">{`GPS ±${latestAccuracy}m`}</span>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Walk chart on top when session is active */}
            {isWalkMode && (
              <div className="mb-3">
                <StepChart
                  tab={chartTab}
                  language={language}
                  timeline={stepTimeline}
                  history={history}
			              currentSteps={Number.isFinite(walkCurrentSteps) ? walkCurrentSteps : 0}
                  onTabChange={setChartTab}
                />
              </div>
            )}
            {!isWalkMode && (
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
            )}

            {/* Main Timer */}
            <div className="text-center mb-3">
              {isWalkMode ? (
                <>
                  <div className="text-6xl font-black tracking-tighter text-white tabular-nums">
                    {Number.isFinite(uiStepCount) ? uiStepCount.toLocaleString() : '--'}
                  </div>
                  <p className="mt-1 text-sm font-semibold text-white/70">
                    {language === 'ko' ? '걸음 수' : 'Steps'}
                  </p>
                </>
              ) : (
                <>
                  <div className="text-6xl font-black tracking-tighter text-white tabular-nums">
                    {elapsedClockRun}
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
                </>
              )}
            </div>
	            
	            {/* Weekly/monthly goals under the main metric block (steps for walk, distance for run) */}
	            {isWalkMode ? walkGoalsSummary : runGoalsSummary}

	            {/* Stats Grid (walk mode shows elapsed time instead of steps tile) */}
	        <div className={`grid gap-2 ${isWalkMode ? 'grid-cols-2 sm:grid-cols-2 md:grid-cols-2' : 'grid-cols-2 sm:grid-cols-2 md:grid-cols-4'}`}>
              {isWalkMode ? (
                <>
	                  <StatTile label={text.stats.distance} value={formatDistanceLabel(distanceM, 2)} accent={meta.accentColor} size="sm" />
                  <StatTile
                    label={language === 'ko' ? '경과 시간' : 'Elapsed'}
                    value={elapsedClockWalk}
	                    accent={meta.accentColor}
	                    size="sm"
                  />
	                  <StatTile label={text.stats.avgSpeed} value={formatSpeedLabel(avgPaceMs)} accent={meta.accentColor} size="sm" />
                  <StatTile
                    label={text.summary?.calories || (language === 'ko' ? '칼로리' : 'Calories')}
                    value={Number.isFinite(caloriesLive) ? `${caloriesLive.toFixed(0)} kcal` : '--'}
	                    accent={meta.accentColor}
	                    size="sm"
                  />
                </>
              ) : (
                <>
                  <StatTile label={text.stats.distance} value={formatDistanceLabel(distanceM, 2)} accent={meta.accentColor} />
                  <StatTile label={text.stats.current} value={currentPaceMs ? formatPaceLabel(currentPaceMs) : '--:-- /km'} accent={meta.accentColor} />
                  <StatTile label={text.stats.average} value={avgPaceMs ? formatPaceLabel(avgPaceMs) : '--:-- /km'} accent={meta.accentColor} />
                  <StatTile label={text.stats.avgSpeed} value={formatSpeedLabel(avgPaceMs)} accent={meta.accentColor} />
                </>
              )}
            </div>
          </section>

          {/* Lap Progress and Control Buttons - with custom spacing */}
          <div className="space-y-4">
            {/* Lap Progress */}
            {!isWalkMode && (
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
            )}

	            {/* Control Buttons */}
	            <div className="flex items-center justify-center gap-5 mt-4">
              {isWalkMode ? (
                // Walk mode: 시작 / 일시정지 / 재개 버튼
                (!sessionActive ? (
                  <button
                    onClick={handleStartSession}
                    disabled={starting}
                    aria-label={language === 'ko' ? '시작' : 'Start'}
                    className="group relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-emerald-400/90 bg-gradient-to-br from-emerald-500/40 to-emerald-600/30 text-emerald-100 shadow-xl shadow-emerald-500/30 transition-all duration-200 active:scale-95 disabled:opacity-60"
                  >
                    <div className="absolute inset-0 rounded-full bg-emerald-400/25 blur-lg group-hover:bg-emerald-400/40 transition-all"></div>
                    <span className="relative text-2xl">▶</span>
                  </button>
                ) : isPaused ? (
                  // 일시정지 상태: 재개 버튼
                  <button
                    onClick={handleResume}
                    aria-label={language === 'ko' ? '재개' : 'Resume'}
                    className="group relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-emerald-400/90 bg-gradient-to-br from-emerald-500/40 to-emerald-600/30 text-emerald-100 shadow-xl shadow-emerald-500/30 transition-all duration-200 active:scale-95"
                  >
                    <div className="absolute inset-0 rounded-full bg-emerald-400/25 blur-lg group-hover:bg-emerald-400/40 transition-all"></div>
                    <span className="relative text-2xl">▶</span>
                  </button>
                ) : (
                  // 진행 중: 일시정지 버튼
                  <button
                    onClick={handleEndSession}
                    aria-label={language === 'ko' ? '일시정지' : 'Pause'}
                    className="group relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-amber-400/90 bg-gradient-to-br from-amber-500/30 to-amber-600/20 text-amber-100 shadow-xl shadow-amber-500/30 transition-all duration-200 active:scale-95"
                  >
                    <div className="absolute inset-0 rounded-full bg-amber-400/20 blur-lg group-hover:bg-amber-400/40 transition-all"></div>
                    <span className="relative text-2xl">⏸</span>
                  </button>
                ))
              ) : (
                <>
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

                  <button
                    type="button"
                    onClick={() => {
                      if (batterySaver) {
                        setSessionKeepAwake(false)
                        return
                      }
                      setSessionKeepAwake(prev => !prev)
                    }}
                    disabled={!sessionActive}
                    className="group relative flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-full border-2 border-white/40 bg-gradient-to-br from-white/20 to-black/30 text-white shadow-xl backdrop-blur-sm transition-all duration-200 active:scale-95 hover:border-white/60 disabled:opacity-60"
                    style={{ zIndex: 70 }}
                  >
                    <div className="absolute inset-0 rounded-full bg-white/10 blur-lg group-hover:bg-white/20 transition-all"></div>
                    <div className="relative flex flex-col items-center justify-center gap-0.5">
                      {sessionKeepAwake ? (
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8.25 10V7.5a3.75 3.75 0 117.5 0V10" />
                          <rect x="6" y="10" width="12" height="10" rx="2" />
                          <circle cx="12" cy="15" r="1.5" fill="currentColor" />
                        </svg>
                      ) : (
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
                </>
              )}
            </div>
          </div>

        </>
      ) : (
        isWalkMode ? (
          <div className="space-y-3" style={{ marginTop: capPlatform === 'ios' ? '-10px' : '0', paddingBottom: capPlatform === 'ios' ? '30px' : '0' }}>
            <div className="rounded-3xl border border-white/15 bg-gradient-to-br from-white/10 to-white/5 text-white backdrop-blur-xl shadow-xl p-4">
              {latestAccuracy ? (
                <div className="flex justify-end mb-2">
                  <span className="rounded-full bg-black/30 px-3 py-1 text-xs text-white/80">{`GPS ±${latestAccuracy}m`}</span>
                </div>
              ) : null}

              <StepChart
                tab={chartTab}
                language={language}
                timeline={stepTimeline}
                history={history}
	                currentSteps={Number.isFinite(walkCurrentSteps) ? walkCurrentSteps : 0}
                onTabChange={setChartTab}
              />

	              <div className="mt-3 text-center">
                <div className="text-5xl font-black tabular-nums">{Number.isFinite(uiStepCount) ? uiStepCount.toLocaleString() : '0'}</div>
                <p className="text-sm text-white/70">{language === 'ko' ? '걸음 수' : 'Steps'}</p>
              </div>

		          {walkGoalsSummary}

	              <div className="mt-3 grid grid-cols-2 gap-2">
	                <StatTile label={text.stats.distance} value={formatDistanceLabel(distanceM, 2)} accent={meta.accentColor} size="sm" />
	                <StatTile label={language === 'ko' ? '경과 시간' : 'Elapsed'} value={elapsedClock} accent={meta.accentColor} size="sm" />
	              </div>

              <div className="mt-4 flex justify-center">
                <button
                  onClick={handleStartSession}
                  disabled={starting}
                  className="group relative w-full flex-shrink-0 rounded-3xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 px-6 py-4 text-xl font-black text-black shadow-2xl transition-all duration-200 active:scale-95 disabled:opacity-60 hover:shadow-emerald-500/50 overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-white/20 via-transparent to-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                  <span className="relative">{starting ? text.setup.preparing : startButtonLabel}</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-3xl border border-white/15 bg-gradient-to-br from-white/5 to-white/10 text-white backdrop-blur-xl flex flex-col shadow-xl overflow-hidden" style={{ marginTop: capPlatform === 'ios' ? '-10px' : '0', paddingBottom: capPlatform === 'ios' ? '30px' : '0' }}>
            <div className="flex flex-col h-full overflow-y-auto overscroll-contain p-4 space-y-3">
              {/* Header */}
              <div className="text-center flex-shrink-0">
                <h1 className="text-3xl font-black bg-clip-text text-transparent bg-gradient-to-r from-emerald-300 via-blue-300 to-cyan-300">
                  {modeTitle}
                </h1>
              </div>

              {/* Goal Selection */}
              <div className="flex-shrink-0">
                <div className="mb-2 flex items-center gap-2">
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
                <div className="mt-2 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
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

	              {/* Weekly / Monthly running distance goals summary */}
	              <div className="flex-shrink-0">
	                {runGoalsSummary}
	              </div>

              {/* Settings Row */}
              <div className="flex-shrink-0">
                <div className="mb-2 flex items-center gap-2">
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
                    className={`flex w-full items-center justify-center rounded-2xl border-2 px-2 py-2 text-[0.75rem] font-bold shadow-lg transition-all duration-200 active:scale-95 ${
                      voiceEnabled
                        ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 text-emerald-100 hover:shadow-emerald-500/30'
                        : 'border-white/30 bg-gradient-to-br from-black/40 to-black/20 text-white/70 hover:border-white/50'
                    }`}
                  >
                    {voiceEnabled ? text.setup.voiceOn : text.setup.voiceOff}
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPreventScreenLock((prev) => {
                        const next = !prev
                        if (sessionActive) {
                          setSessionKeepAwake(next && !batterySaver)
                        }
                        return next
                      })
                    }}
                    className={`flex w-full items-center justify-between rounded-2xl border-2 px-2 py-2 text-[0.75rem] font-bold shadow-lg transition-all duration-200 active:scale-95 ${
                      preventScreenLock && !batterySaver
                        ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-500/20 to-emerald-600/20 text-emerald-100 hover:shadow-emerald-500/30'
                        : 'border-white/30 bg-gradient-to-br from-black/40 to-black/30 text-white/80 hover:border-white/50'
                    }`}
                  >
                    <span className="truncate">{language === 'ko' ? '화면 꺼짐 방지' : 'Keep screen on'}</span>
                    <span className="text-xs uppercase">
                      {preventScreenLock && !batterySaver ? (language === 'ko' ? '켜짐' : 'On') : (language === 'ko' ? '꺼짐' : 'Off')}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setBatterySaver((prev) => {
                        const next = !prev
                        if (sessionActive) {
                          setSessionKeepAwake(next ? false : preventScreenLock)
                        }
                        return next
                      })
                    }}
                    className={`flex w-full items-center justify-between rounded-2xl border-2 px-2 py-2 text-[0.75rem] font-bold shadow-lg transition-all duration-200 active:scale-95 ${
                      batterySaver
                        ? 'border-emerald-400/70 bg-gradient-to-br from-emerald-500/25 to-emerald-600/20 text-emerald-100 hover:shadow-emerald-500/30'
                        : 'border-white/30 bg-gradient-to-br from-black/40 to-black/30 text-white/80 hover:border-white/50'
                    }`}
                  >
                    <span className="truncate">{language === 'ko' ? '배터리 절약 모드' : 'Battery saver mode'}</span>
                    <span className="text-xs uppercase">
                      {batterySaver ? (language === 'ko' ? '켜짐' : 'On') : (language === 'ko' ? '꺼짐' : 'Off')}
                    </span>
                  </button>
                </div>
                <p className="mt-1 text-[0.65rem] text-white/60 leading-snug">
                  {language === 'ko'
                    ? '배터리 절약 모드를 켜면 화면을 자동으로 끄고 타이머 갱신을 낮춰 전력을 줄입니다. 거리 정확도는 유지됩니다.'
                    : 'Battery saver turns off screen wake locks and updates the timer less often to save power while keeping distance accuracy.'}
                </p>
              </div>

              {/* Recent Records Preview - Only show if there are records */}
              {modeHistory.length > 0 && (
                <div className="flex-shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-white/70 uppercase tracking-wider">
                      {language === 'ko' ? '최근 기록' : 'Recent Records'}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleOpenHistory({})}
                      className="text-xs font-bold text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      {language === 'ko' ? '전체보기 ›' : 'View All ›'}
                    </button>
                  </div>

                  <div className="space-y-2">
                    {modeHistory.slice(0, recentPreviewCount).map((entry, idx) => {
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

                      const entryId = entry.id || entry.startedAt || entry.timestamp || `recent-${idx}`
                      return (
                        <button
                          type="button"
                          key={entryId}
                          onClick={() => {
                            setHistoryInitialSort('recent')
                            handleOpenHistory({ entryId })
                          }}
                          className="w-full text-left rounded-xl border border-white/10 bg-gradient-to-r from-white/5 to-white/10 p-3 backdrop-blur-sm hover:border-white/20 transition-all duration-200"
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
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Start Button */}
              <button
                onClick={handleStartSession}
                disabled={starting}
                className="group relative w-full flex-shrink-0 rounded-3xl bg-gradient-to-r from-emerald-400 via-blue-500 to-cyan-400 px-6 py-4 text-xl font-black text-black shadow-2xl transition-all duration-200 active:scale-95 disabled:opacity-60 hover:shadow-emerald-500/50 overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-white/20 via-transparent to-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                <span className="relative">{starting ? text.setup.preparing : startButtonLabel}</span>
              </button>
            </div>
          </div>
        )
      )}

      <RunningHistoryOverlay
        isVisible={showHistory}
        language={language}
        entries={modeHistory}
        mode={resolvedMode}
        onClose={() => {
          setShowHistory(false)
          setHistoryInitialSort('recent')
          setHistoryExpandedId(null)
        }}
        onDeleteEntry={handleDeleteHistoryEntry}
        onChallengeEntry={handleChallengeRecord}
        initialSortBy={historyInitialSort}
        initialExpandedId={historyExpandedId}
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
        show={((!sessionActive || isWalkMode) && !showStats && !showHistory)}
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
                    ? '러닝 모드에서만 목표 페이스 대비 빠르거나 느릴 때 음성 코칭이 재생돼요. 도보 모드에서는 코칭 음성이 없습니다.'
                    : 'Voice coaching for target pace plays only in running. Walking mode does not play pace coaching.'}
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
  const menuRef = useRef(null)
  const selectedRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const id = window.requestAnimationFrame(() => {
      const el = selectedRef.current
      if (el) {
        try { el.focus({ preventScroll: true }) } catch {}
        try { el.scrollIntoView({ block: 'center' }) } catch {}
      }
    })
    return () => {
      window.cancelAnimationFrame(id)
    }
  }, [open, value])

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
          <div
            ref={menuRef}
            className="absolute bottom-full left-0 right-0 mb-1 rounded-2xl border border-white/30 bg-slate-900/95 backdrop-blur-xl shadow-2xl z-20 max-h-64 overflow-y-auto"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                ref={value === option.value ? selectedRef : null}
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

function StatTile({ label, value, accent = 'emerald', className = '', size = 'md' }) {
  const accentColors = {
    emerald: 'from-emerald-400/10 to-blue-500/10 border-emerald-400/20',
    amber: 'from-amber-400/10 to-orange-500/10 border-amber-400/20',
  }

	  // Split value and unit (e.g., "2.5 km" -> ["2.5", "km"])
	  const parts = value.split(' ')
	  const numericValue = parts[0]
	  const unit = parts.length > 1 ? parts.slice(1).join(' ') : ''

	  const paddingClass = size === 'sm' ? 'p-3' : 'p-4'
	  const valueTextClass = size === 'sm' ? 'text-xl' : 'text-2xl'
	  const unitTextClass = size === 'sm' ? 'text-[0.6rem]' : 'text-[0.65rem]'
	  const labelTextClass = size === 'sm' ? 'text-[0.55rem]' : 'text-[0.6rem]'

	  return (
	    <div
	      className={`group flex h-full flex-col items-center justify-center rounded-2xl border bg-gradient-to-br ${accentColors[accent]} ${paddingClass} text-center text-white shadow-lg backdrop-blur-sm transition-all duration-300 hover:scale-105 hover:shadow-xl ${className}`}
	    >
	      <p className={`${valueTextClass} font-black leading-tight group-hover:scale-110 transition-transform duration-200`}>{numericValue}</p>
	      {unit && (
	        <p className={`${unitTextClass} font-bold text-white/70 mt-0.5`}>{unit}</p>
	      )}
	      <p className={`mt-2 ${labelTextClass} uppercase tracking-[0.25em] text-white/70 font-bold leading-tight`}>{label}</p>
	    </div>
	  )
}

function StepChart({ tab, language, timeline, history, currentSteps, onTabChange }) {
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const dayData = useMemo(() => {
    // 0-23h + terminal 24h placeholder to keep end spacing
    const buckets = Array.from({ length: 25 }, (_, hour) => ({
      label: hour === 24 ? '24' : `${hour}`,
      hourStart: hour,
      value: 0,
    }))
    const sorted = Array.isArray(timeline) ? [...timeline].sort((a, b) => a.ts - b.ts) : []
    const todayKey = new Date(today).toDateString()

    if (sorted.length) {
      // 시간대별로 샘플을 그룹화
      const hourGroups = {}
      sorted.forEach((sample) => {
        const steps = Number(sample.steps)
        const tsRaw = Number(sample.ts)
        const ts = tsRaw < 1e12 ? tsRaw * 1000 : tsRaw
        if (!Number.isFinite(steps) || !Number.isFinite(ts)) return
        const d = new Date(ts)
        if (d.toDateString() !== todayKey) return
        const hour = d.getHours()
        if (!hourGroups[hour]) hourGroups[hour] = []
        hourGroups[hour].push(steps)
      })

      // 각 시간대별 증가분 계산
      let prevHourMax = 0
      for (let hour = 0; hour <= 23; hour++) {
        if (hourGroups[hour] && hourGroups[hour].length > 0) {
          const maxInHour = Math.max(...hourGroups[hour])

          // 이 시간대의 증가분 = 최대값 - 이전 시간대 최대값
          let delta = 0
          if (maxInHour >= prevHourMax) {
            delta = maxInHour - prevHourMax
          } else {
            // 센서 리셋된 경우
            delta = maxInHour
          }

          buckets[hour].value = delta
          prevHourMax = maxInHour
        }
      }
    }

    const liveSteps = Number.isFinite(currentSteps) ? Math.max(0, currentSteps) : null
    if (Number.isFinite(liveSteps) && sorted.length > 0) {
      const now = new Date()
      if (now.toDateString() === todayKey) {
        const currentHour = Math.min(23, Math.max(0, now.getHours()))

        // timeline의 마지막 걸음수 찾기
        const lastTimelineSteps = Math.max(...sorted.map(s => Number(s.steps)).filter(n => Number.isFinite(n)))

        // currentSteps가 timeline보다 크면 현재 시간대에 추가
        if (liveSteps > lastTimelineSteps) {
          const additionalSteps = liveSteps - lastTimelineSteps
          buckets[currentHour].value += additionalSteps
        }
      }
    }

    return buckets
  }, [currentSteps, timeline, today])

  const weekData = useMemo(() => {
    const buckets = []
    const dateKey = (d) => {
      const yy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${yy}-${mm}-${dd}`
    }
    const labelFor = (d) => {
      const month = d.getMonth() + 1
      const day = d.getDate()
      return language === 'ko' ? `${month}/${day}` : `${month}/${day}`
    }
    const map = {}
    const addSteps = (d, steps) => {
      if (!Number.isFinite(steps)) return
      const key = dateKey(d)
      const safe = Math.max(0, steps)
      map[key] = Math.max(map[key] || 0, safe) // 같은 날짜 중복 기록은 최대값만 반영
    }
    const now = new Date()
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      buckets.push({ label: labelFor(d), value: 0, key: dateKey(d) })
    }
    const todaySteps = Number.isFinite(currentSteps) ? Math.max(0, currentSteps) : 0
    const todayKey = dateKey(today)
    addSteps(today, todaySteps)
    if (Array.isArray(history)) {
      history.forEach((entry) => {
        if (entry.mode && entry.mode !== 'walk') return
        const steps = Number(entry.steps)
        if (!Number.isFinite(steps) || steps <= 0) return
        const ts = entry.startedAt || entry.timestamp
        const d = ts ? new Date(ts) : null
        if (!d || Number.isNaN(d.getTime())) return
        d.setHours(0, 0, 0, 0)
        const key = dateKey(d)
        // 오늘 날짜는 currentSteps로 이미 추가했으므로 스킵
        if (key === todayKey) return
        addSteps(d, steps)
      })
    }
    return buckets.map((b) => ({ ...b, value: map[b.key] || 0 }))
  }, [history, today, language, currentSteps])

  const monthData = useMemo(() => {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth()
    const monthNumber = month + 1
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const keyFor = (day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const labelFor = (day) => {
      return `${day}`
    }
    const buckets = Array.from({ length: daysInMonth }, (_, idx) => ({
      label: labelFor(idx + 1),
      dayNum: idx + 1,
      value: 0,
      key: keyFor(idx + 1),
    }))
    const map = {}
    const addSteps = (d, steps) => {
      if (!Number.isFinite(steps)) return
      const key = keyFor(d.getDate())
      const safe = Math.max(0, steps)
      map[key] = Math.max(map[key] || 0, safe) // 같은 날짜 중복 기록은 최대값만 반영
    }
    const todayDate = today.getDate()
    const todayKey = keyFor(todayDate)
    const todaySteps = Number.isFinite(currentSteps) ? Math.max(0, currentSteps) : 0
    addSteps(today, todaySteps)
    if (Array.isArray(history)) {
      history.forEach((entry) => {
        if (entry.mode && entry.mode !== 'walk') return
        const steps = Number(entry.steps)
        if (!Number.isFinite(steps) || steps <= 0) return
        const ts = entry.startedAt || entry.timestamp
        const d = ts ? new Date(ts) : null
        if (!d || Number.isNaN(d.getTime())) return
        if (d.getMonth() !== month || d.getFullYear() !== year) return
        d.setHours(0, 0, 0, 0)
        const key = keyFor(d.getDate())
        // 오늘 날짜는 currentSteps로 이미 추가했으므로 스킵
        if (key === todayKey) return
        addSteps(d, steps)
      })
    }
    return buckets.map((b) => ({ ...b, value: map[b.key] || 0 }))
  }, [history, today, language, currentSteps])

  const data = tab === 'week' ? weekData : tab === 'month' ? monthData : dayData
  const nowHour = new Date().getHours()
  const maxVal = data.reduce((mx, d) => {
    const bucketStart = (d.hourStart ?? d.hour ?? 0)
    const isFuture = tab === 'day' && bucketStart > nowHour
    const val = isFuture ? 0 : (d.value || 0)
    return Math.max(mx, val)
  }, 1)

  // 균등 간격 y축 생성: 2000 단위로, 최소 2000까지
  const stepSize = 2000
  const maxTick = Math.ceil(Math.max(maxVal, 2000) / stepSize) * stepSize
  const yTicks = Array.from({ length: Math.floor(maxTick / stepSize) + 1 }, (_, i) => i * stepSize)
  const scaleMax = maxTick
  const totalSteps = data.reduce((sum, d) => {
    const bucketStart = tab === 'day' ? (d.hourStart ?? d.hour ?? 0) : 0
    if (tab === 'day' && bucketStart > nowHour) return sum
    return sum + (d.value || 0)
  }, 0)
  const lastMonthDay = tab === 'month' ? (monthData?.length || 0) : 0

  const columnGapPx = 1
  const gridTemplateColumns = `repeat(${data.length}, minmax(8px, 1fr))`
  const gridStyle = {
    gridTemplateColumns,
    columnGap: `${columnGapPx}px`,
    paddingLeft: '0px',
    paddingRight: tab === 'month' ? '0px' : '0px',
  }
  const axisTicks = data.map((item, idx) => {
    const dayNum = Number(item.dayNum ?? item.label)
    const hourVal = item.hourStart ?? item.hour ?? 0
    const showLabel = tab === 'day'
      ? (hourVal % 2 === 0 || hourVal === 24)
      : tab !== 'month'
        ? true
        : (Number.isFinite(dayNum) && ((dayNum % 5 === 0 && dayNum + 5 <= lastMonthDay) || dayNum === lastMonthDay))
    const showGuide = showLabel
    const labelText = tab === 'day'
      ? `${hourVal === 24 ? 24 : hourVal}`
      : item.label
    return { key: `${item.label}-${idx}`, label: labelText, showGuide, showLabel }
  })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-white/70">
        <div className="flex gap-2">
          {[
            { key: 'day', label: language === 'ko' ? '일' : 'Day' },
            { key: 'week', label: language === 'ko' ? '주' : 'Week' },
            { key: 'month', label: language === 'ko' ? '월' : 'Month' },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onTabChange?.(opt.key)}
              className={`rounded-full px-3 py-1 font-bold transition-all ${
                tab === opt.key
                  ? 'bg-emerald-500/30 text-emerald-100 border border-emerald-400/50 text-[0.7rem]'
                  : 'bg-white/10 text-white/70 border border-white/20 text-[0.7rem]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        {yTicks.length > 0 && (
          <div className="relative text-[0.65rem] text-white/60 h-40 pr-1 flex flex-col justify-between" style={{ width: '45px' }}>
            {yTicks.slice().reverse().map((t) => (
              <span key={`label-${t}`} className="leading-none">
                {t.toLocaleString()}
              </span>
            ))}
          </div>
        )}
        <div className="flex-1" style={{ marginLeft: tab === 'month' ? '-8px' : '0px' }}>
          <div className="relative h-40 w-full overflow-hidden">
            {yTicks.length === 0 ? null : yTicks.map((t, idx) => {
              // 균등 간격으로 그리드 라인 배치
              const totalTicks = yTicks.length
              const bottomPct = (idx / (totalTicks - 1)) * 100

              return (
                <div
                  key={`grid-${t}`}
                  className="absolute left-0 right-0 border-t border-white/10"
                  style={{ bottom: `${bottomPct}%` }}
                />
              )
            })}
            <div
              className="absolute inset-0 pointer-events-none grid"
              style={gridStyle}
            >
              {axisTicks.map((tick) => (
                <div key={`guide-${tick.key}`} className="relative">
                  {tick.showGuide ? (
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 border-l border-dashed border-white/15" />
                  ) : null}
                </div>
              ))}
            </div>
            <div
              className="absolute inset-0 grid items-end"
              style={gridStyle}
            >
              {data.map((item, idx) => {
                const bucketStart = (item.hourStart ?? item.hour ?? 0)
                const isFuture = tab === 'day' && bucketStart > nowHour
                const heightPct = isFuture ? 0 : (item.value / scaleMax) * 100
                const showDot = !isFuture && item.value <= 0

                // 픽셀로 직접 계산 (그래프 높이 160px 기준)
                const heightPx = (heightPct / 100) * 160
                const finalHeightPx = Math.max(6, heightPx)

                return (
                  <div key={`${item.label}-${idx}`} className="flex flex-col items-center justify-end">
                    {isFuture ? null : showDot ? (
                      <div className="h-[6px] w-[6px] rounded-full bg-white/50" />
                    ) : (
                      <div
                        className="w-full rounded-t-md bg-gradient-to-t from-emerald-400/60 via-emerald-300/50 to-cyan-300/60 shadow-inner"
                        style={{ height: `${finalHeightPx}px` }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div
            className="mt-1 grid text-[0.65rem] text-white/70 tabular-nums"
            style={{
              ...gridStyle,
              justifyItems: 'center'
            }}
          >
            {axisTicks.map((tick) => (
              <span
                key={tick.key}
                className="block text-center whitespace-nowrap"
                style={{ visibility: tick.showLabel ? 'visible' : 'hidden' }}
              >
                {tick.showLabel ? tick.label : '\u00A0'}
              </span>
            ))}
          </div>
        </div>
      </div>
      {totalSteps === 0 && (
        null
      )}
    </div>
  )
}
