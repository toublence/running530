'use client'

/**
 * Pure calculation utilities for running / walking metrics.
 * UI나 렌더링 코드는 포함하지 않는다.
 */

import { haversineDistanceMeters } from '../utils/distance'

// 기본 상수
const MIN_DISTANCE_DELTA_M = 0.5       // GPS 흔들림 보정: 기본 최소 이동거리
const ACCURACY_DISTANCE_FACTOR = 0.02  // 정확도 기반 추가 임계치 (거리 누락 최소화)
const MAX_DISTANCE_THRESHOLD_M = 10    // 정확도 스케일링 상한 (고정 최대 필터)
const MAX_DISTANCE_ACCURACY_M = 1200   // 이보다 크면 샘플 자체를 버림(완전 손상된 데이터)
const SPEED_WINDOW_MS = 10000     // 현재 속도 추정 윈도우 (10초)
const CADENCE_WINDOW_MS = 20000   // 케이던스 계산 윈도우 (20초)
const DEFAULT_WEIGHT_KG = 65

// 가속도 기반 걸음 검출 보정 (센서 없음 전용)
const ACCEL_STEP_THRESHOLD_G = 1.28 // 피크 임계값 (g 단위) - 과검출 방지
const ACCEL_MIN_GAP_MS = 380        // 피크 간 최소 간격 (짧은 흔들림 무시)
const ACCEL_MOTION_WINDOW_MS = 1200 // 최근 동작 에너지 확인 윈도우
const ACCEL_MOTION_RMS_FLOOR = 0.35 // 윈도우 RMS가 이보다 낮으면 정지로 간주
const ACCEL_LPF_ALPHA = 0.08        // LPF 알파 (낮을수록 부드럽게)
const STEP_SENSOR_STALE_MS = 5000   // 센서 이벤트가 끊겼다고 보는 임계값

// ----------------------------------------------------------------------------
// 보조 함수
// ----------------------------------------------------------------------------

export const computeElapsedTime = (now, sessionStartTime, pausedIntervals = []) => {
  const pausedMs = (pausedIntervals || []).reduce((sum, it) => {
    if (!it || !it.start || !it.end) return sum
    return sum + Math.max(0, it.end - it.start)
  }, 0)
  return Math.max(0, now - sessionStartTime - pausedMs)
}

const hasValidLocation = (sample) =>
  Number.isFinite(sample?.latitude) && Number.isFinite(sample?.longitude)

const calcIncrementalDistance = (prev, curr) => {
  if (!hasValidLocation(prev) || !hasValidLocation(curr)) return 0
  return haversineDistanceMeters(
    { latitude: prev.latitude, longitude: prev.longitude },
    { latitude: curr.latitude, longitude: curr.longitude },
  )
}

// ----------------------------------------------------------------------------
// Step counter / fallback
// ----------------------------------------------------------------------------

const computeStepsFromCounter = (rawStepsNow, startValue) => {
  if (!Number.isFinite(rawStepsNow) || !Number.isFinite(startValue)) return null
  const diff = rawStepsNow - startValue
  return diff >= 0 ? diff : 0
}

const createAccelStepDetector = (onDebug) => {
  let lastMagnitude = 0
  let lp = 0
  let lastStepTs = 0
  let steps = 0
  const motionWindow = [] // {ts, high}

  const addSample = (ts, ax, ay, az) => {
    if (![ax, ay, az].every(Number.isFinite)) return steps
    const mag = Math.sqrt(ax * ax + ay * ay + az * az)
    lp = ACCEL_LPF_ALPHA * mag + (1 - ACCEL_LPF_ALPHA) * lp
    const high = mag - lp
    const now = ts || Date.now()
    const gap = now - lastStepTs

    // 최근 동작 에너지 기록
    motionWindow.push({ ts: now, high })
    while (motionWindow.length && now - motionWindow[0].ts > ACCEL_MOTION_WINDOW_MS) motionWindow.shift()
    const rms = (() => {
      if (!motionWindow.length) return 0
      const sumSq = motionWindow.reduce((sum, it) => sum + (it.high * it.high), 0)
      return Math.sqrt(sumSq / motionWindow.length)
    })()

    // 피크 검출: 상승→하강 && threshold 초과 && 최소 간격 && 동작 에너지 충족
    if (
      lastMagnitude > high &&
      lastMagnitude > ACCEL_STEP_THRESHOLD_G &&
      gap >= ACCEL_MIN_GAP_MS &&
      rms >= ACCEL_MOTION_RMS_FLOOR
    ) {
      steps += 1
      lastStepTs = now
      if (onDebug) {
        onDebug({
          sessionSteps: steps,
          accel: { x: ax, y: ay, z: az, mag: lastMagnitude, rms },
          source: 'accel-peak',
          timestamp: now,
        })
      }
    }
    lastMagnitude = high
    return steps
  }

  const getSteps = () => steps

  return { addSample, getSteps }
}

// ----------------------------------------------------------------------------
// 메인 계산 훅/모듈
// ----------------------------------------------------------------------------

export const createMetricsAccumulator = (params) => {
  const {
    mode = 'running',
    userWeightKg = DEFAULT_WEIGHT_KG,
    userStepGoal = 10000,
    sessionStartTime = Date.now(),
    pausedIntervals = [],
    stepCounterAtStart = null,
    enableAccelFallback = true, // 센서가 없을 때만 가속도 사용
    onDebug = null,
  } = params || {}

  const locationSamples = [] // 위치 기반 샘플만 저장 (가속도 이벤트는 제외)
  const stepWindow = [] // {ts, steps}
  const speedWindow = [] // {ts, distance}
  const accelDetector = createAccelStepDetector(onDebug)

  let totalDistanceM = 0
  let elevationGainM = 0
  let sessionSteps = 0
  let lastLocationSample = null
  let stepCounterStart = Number.isFinite(stepCounterAtStart) ? stepCounterAtStart : null
  let stepSensorActive = Number.isFinite(stepCounterAtStart) // 센서 감지 후에도 끊기면 accel 사용
  let lastSensorUpdateTs = Number.isFinite(stepCounterAtStart) ? sessionStartTime : null

  const addSample = (sample) => {
    if (!sample) return getSnapshot()
    const timestamp = Number.isFinite(sample.timestamp) ? sample.timestamp : Date.now()
    const altitude = Number.isFinite(sample.altitude) ? sample.altitude : null
    const prevSteps = sessionSteps
    const sensorStale = stepSensorActive && lastSensorUpdateTs && (timestamp - lastSensorUpdateTs > STEP_SENSOR_STALE_MS)
    const hasLocation = hasValidLocation(sample)
    const accuracyNow = Number.isFinite(sample?.horizontalAccuracy) ? sample.horizontalAccuracy : null
    const accuracyTooPoor = Number.isFinite(accuracyNow) && accuracyNow > MAX_DISTANCE_ACCURACY_M // 절대적으로 신뢰 불가한 경우만 드랍
    const locationUsable = hasLocation && !accuracyTooPoor

    // 위치가 있을 때만 거리/고도 계산
    if (locationUsable && hasValidLocation(lastLocationSample)) {
      const dist = calcIncrementalDistance(lastLocationSample, sample)
      const accNow = Number.isFinite(sample.horizontalAccuracy) ? sample.horizontalAccuracy : null
      const accPrev = Number.isFinite(lastLocationSample?.horizontalAccuracy) ? lastLocationSample.horizontalAccuracy : null
      const accuracyForThreshold = Math.max(accNow || 0, accPrev || 0)
      const minDistanceThreshold = Math.max(
        MIN_DISTANCE_DELTA_M,
        Math.min(
          MAX_DISTANCE_THRESHOLD_M,
          accuracyForThreshold ? accuracyForThreshold * ACCURACY_DISTANCE_FACTOR : 0,
        ),
      )
      const distanceTooSmall = dist < minDistanceThreshold
      if (!distanceTooSmall) {
        totalDistanceM += dist
        speedWindow.push({ ts: timestamp, distance: totalDistanceM })
        if (speedWindow.length > 120) speedWindow.shift()
      }
      if (
        altitude !== null &&
        Number.isFinite(altitude) &&
        lastLocationSample.altitude !== undefined &&
        lastLocationSample.altitude !== null
      ) {
        const deltaAlt = altitude - lastLocationSample.altitude
        if (deltaAlt > 1) elevationGainM += deltaAlt
      }
    }
    if (locationUsable) {
      lastLocationSample = {
        ...sample,
        timestamp,
        altitude,
      }
      locationSamples.push(lastLocationSample)
      if (locationSamples.length > 200) locationSamples.shift()
    }

    // 스텝 카운터 우선 (초기값 자동 설정)
    let stepsNow = null
    if (Number.isFinite(sample.stepCounter)) {
      if (!Number.isFinite(stepCounterStart)) {
        stepCounterStart = sample.stepCounter
      }
      stepsNow = computeStepsFromCounter(sample.stepCounter, stepCounterStart)
      if (stepsNow !== null) {
        stepSensorActive = true
        if (stepsNow > prevSteps) {
          lastSensorUpdateTs = timestamp
        }
        sessionSteps = stepsNow
        if (onDebug) {
          onDebug({
            sessionSteps,
            rawStepCounter: sample.stepCounter,
            source: 'sensor-metrics',
            timestamp,
          })
        }
      }
    }

    const accelAllowed = mode === 'walking' && enableAccelFallback && (!stepSensorActive || sensorStale)
    if (accelAllowed) {
      // 가속도 기반 백업 (센서가 없거나 끊긴 경우)
      const s = accelDetector.addSample(timestamp, sample.accelX, sample.accelY, sample.accelZ)
      sessionSteps = Math.max(sessionSteps, s)
      if (onDebug) {
        onDebug({
          sessionSteps,
          accel: {
            x: sample.accelX,
            y: sample.accelY,
            z: sample.accelZ,
          },
          source: 'accel-metrics',
          timestamp,
        })
      }
    }

    // 케이던스 계산용 윈도우
    stepWindow.push({ ts: timestamp, steps: sessionSteps })
    while (stepWindow.length && timestamp - stepWindow[0].ts > CADENCE_WINDOW_MS) stepWindow.shift()

    return getSnapshot()
  }

  const calcCurrentSpeed = (nowTs) => {
    // 1) native speed
    const latest = locationSamples[locationSamples.length - 1] || lastLocationSample
    const nativeSpeed = latest?.speed
    if (Number.isFinite(nativeSpeed) && nativeSpeed > 0) {
      return nativeSpeed * 3.6
    }
    // 2) 윈도우 속도
    if (speedWindow.length < 2) return null
    const windowEnd = nowTs || (speedWindow[speedWindow.length - 1]?.ts) || Date.now()
    let anchor = speedWindow[speedWindow.length - 1]
    for (let i = speedWindow.length - 2; i >= 0; i -= 1) {
      const cand = speedWindow[i]
      if (windowEnd - cand.ts >= SPEED_WINDOW_MS) {
        anchor = cand
        break
      }
    }
    const distDelta = totalDistanceM - anchor.distance
    const timeDelta = Math.max(1, windowEnd - anchor.ts) / 1000
    if (distDelta <= 0 || timeDelta <= 0) return null
    return (distDelta / timeDelta) * 3.6
  }

  const calcAvgSpeed = (movingTimeSeconds) => {
    if (movingTimeSeconds <= 0 || totalDistanceM <= 0) return null
    return (totalDistanceM / movingTimeSeconds) * 3.6
  }

  const calcPace = (speedKmh) => {
    if (!speedKmh || speedKmh <= 0) return null
    return 60 / speedKmh
  }

  const calcAvgPace = (movingTimeSeconds) => {
    if (totalDistanceM < 100 || movingTimeSeconds <= 0) return null
    const km = totalDistanceM / 1000
    return (movingTimeSeconds / 60) / km
  }

  const calcCadence = () => {
    if (stepWindow.length < 2) return null
    const first = stepWindow[0]
    const last = stepWindow[stepWindow.length - 1]
    const stepsDelta = last.steps - first.steps
    const timeDeltaMin = (last.ts - first.ts) / 60000
    if (stepsDelta <= 0 || timeDeltaMin <= 0) return null
    return stepsDelta / timeDeltaMin
  }

  const calcCalories = (distance, durationMs) => {
    if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return 0
    const speedKmh = (distance / 1000) / (durationMs / 3600000)
    let met
    if (mode === 'walking') {
      if (speedKmh < 3) met = 2.0
      else if (speedKmh < 4.5) met = 2.8
      else if (speedKmh < 5.5) met = 3.5
      else met = 4.3
    } else {
      if (speedKmh < 7) met = 5.0
      else if (speedKmh < 9) met = 7.0
      else if (speedKmh < 11) met = 9.0
      else met = 11.0
    }
    const minutes = durationMs / 60000
    return met * 3.5 * userWeightKg / 200 * minutes
  }

  const calcIntensity = (speedKmh) => {
    if (!speedKmh || speedKmh <= 0) return null
    if (speedKmh < 3) return 'Slow'
    if (speedKmh < 4.5) return 'Normal'
    if (speedKmh < 5.5) return 'Power'
    return 'Fast'
  }

  const getSnapshot = (now = Date.now(), pausedOverride) => {
    const elapsedMs = computeElapsedTime(now, sessionStartTime, pausedOverride || pausedIntervals)
    // 이동 시간: 일시정지 제외, 정지 주행 제외 등 추가 규칙이 있으면 확장
    const movingTimeMs = elapsedMs
    const movingTimeSec = movingTimeMs / 1000

    const currentSpeedKmh = calcCurrentSpeed(now)
    const avgSpeedKmh = calcAvgSpeed(movingTimeSec)
    const currentPace = calcPace(currentSpeedKmh)
    const avgPace = calcAvgPace(movingTimeSec)
    const cadenceSpm = mode === 'walking' ? calcCadence() : null
    const strideLength = mode === 'walking' && sessionSteps > 0 ? totalDistanceM / sessionSteps : null
    const goalProgress = mode === 'walking' && userStepGoal > 0
      ? (sessionSteps / userStepGoal) * 100
      : null

    const calories = calcCalories(totalDistanceM, elapsedMs)
    const intensity = calcIntensity(avgSpeedKmh || currentSpeedKmh)

    return {
      elapsedMs,
      movingTimeMs,
      distanceM: totalDistanceM,
      distanceKm: totalDistanceM / 1000,
      elevationGainM,
      currentSpeedKmh,
      avgSpeedKmh,
      currentPaceMinPerKm: mode === 'running' ? currentPace : null,
      avgPaceMinPerKm: avgPace,
      steps: sessionSteps,
      cadenceSpm,
      strideLengthM: strideLength,
      goalProgress,
      calories,
      intensity,
    }
  }

  return {
    addSample,
    getSnapshot,
  }
}

// Fallback: 거리 기반 걸음수 추정 (필요 시에만 사용)
export const estimateStepsFromDistance = (distanceM, stride = 0.78) => {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(stride) || stride <= 0) return 0
  return Math.max(0, Math.round(distanceM / stride))
}
