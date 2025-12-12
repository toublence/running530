import { haversineDistanceMeters } from './distance.js'

/**
 * DistanceCalculator
 *
 * 런닝/워킹 앱을 위한 고정밀 GPS 거리 계산 클래스
 * GPS 노이즈 필터링, Drift 방지, 속도 제한, 좌표 스무딩을 통해
 * 실제 운동 환경에서의 정확한 거리 측정을 제공합니다.
 *
 * @example
 * const calculator = new DistanceCalculator({ mode: 'run' })
 * calculator.onLocationUpdate(location)
 * const distance = calculator.getTotalDistance()
 */
export class DistanceCalculator {
  // ==================== 상수 정의 ====================

  /**
   * GPS 정확도 임계값 (미터)
   * 이 값보다 낮은 정확도(수치가 큰 경우)의 위치 데이터는 신뢰할 수 없어 무시됩니다.
   */
  static MAX_ACCEPTABLE_ACCURACY_M = 20

  /**
   * 최소 이동 거리 임계값 (미터)
   * GPS Drift(제자리에서 좌표가 흔들리는 현상) 방지를 위해
   * 이 값 이상 이동했을 때만 거리에 합산됩니다.
   */
  static MIN_DISTANCE_THRESHOLD_M = 3

  /**
   * 모드별 최대 속도 제한 (km/h)
   * 인간의 한계를 초과하는 속도는 GPS 튐(Glitch) 현상으로 간주하여 무시됩니다.
   * - 런닝: 40 km/h (세계 최고 기록 약 37km/h + 여유)
   * - 워킹: 15 km/h (빠른 걷기 약 8km/h + 여유)
   */
  static MAX_SPEED_LIMITS_KMH = {
    run: 40,
    walk: 15
  }

  /**
   * 위치 데이터 만료 시간 (밀리초)
   * 이 시간보다 오래된 위치 데이터는 stale로 간주하여 거부합니다.
   */
  static LOCATION_STALE_THRESHOLD_MS = 120000 // 2분

  /**
   * 이동평균 윈도우 크기
   * 좌표 스무딩을 위해 최근 N개의 위치 샘플을 평균냅니다.
   */
  static SMOOTHING_WINDOW_SIZE = 5

  /**
   * 정지 상태 감지를 위한 연속 저속 샘플 수
   * 이 수만큼 연속으로 저속(< 0.5 m/s)이면 정지로 간주하여 drift 방지
   */
  static STATIONARY_LOW_SPEED_COUNT = 3
  static STATIONARY_SPEED_THRESHOLD_MPS = 0.5 // m/s

  // ==================== 생성자 ====================

  /**
   * DistanceCalculator 인스턴스 생성
   *
   * @param {Object} options - 설정 옵션
   * @param {string} options.mode - 운동 모드 ('run' | 'walk')
   * @param {boolean} options.enableSmoothing - 좌표 스무딩 활성화 여부 (기본: true)
   * @param {number} options.initialDistance - 초기 거리 (미터, 기본: 0)
   */
  constructor({ mode = 'run', enableSmoothing = true, initialDistance = 0 } = {}) {
    this.mode = mode
    this.enableSmoothing = enableSmoothing

    // 총 누적 거리 (미터)
    this.totalDistance = initialDistance

    // 마지막 유효 위치 (앵커 포인트)
    this.lastValidLocation = null

    // 좌표 스무딩을 위한 최근 위치 버퍼 (이동평균용)
    this.locationBuffer = []

    // 정지 감지를 위한 연속 저속 카운터
    this.lowSpeedCounter = 0

    // 통계 (디버깅/분석용)
    this.stats = {
      totalSamples: 0,
      rejectedByAccuracy: 0,
      rejectedBySpeed: 0,
      rejectedByMinDistance: 0,
      rejectedByStale: 0,
      rejectedByStationary: 0
    }
  }

  // ==================== 공개 메서드 ====================

  /**
   * 새로운 GPS 위치 업데이트 처리
   *
   * @param {Object} location - 위치 객체
   * @param {number} location.latitude - 위도
   * @param {number} location.longitude - 경도
   * @param {number} location.timestamp - 타임스탬프 (밀리초)
   * @param {number} [location.accuracy] - 수평 정확도 (미터, 선택)
   * @param {number} [location.speed] - GPS 속도 (m/s, 선택)
   * @returns {Object} 처리 결과 { accepted, deltaDistance, reason }
   */
  onLocationUpdate(location) {
    this.stats.totalSamples++

    // 1. 필수 필드 검증
    if (!this._isValidLocation(location)) {
      return { accepted: false, deltaDistance: 0, reason: 'invalid_location' }
    }

    // 2. 첫 번째 위치인 경우에도 필터 적용 후 앵커로 설정
    if (!this.lastValidLocation) {
      // 첫 위치도 Accuracy 체크
      if (!this._checkAccuracy(location)) {
        this.stats.rejectedByAccuracy++
        return { accepted: false, deltaDistance: 0, reason: 'poor_accuracy' }
      }

      // 첫 위치도 Stale 체크
      if (!this._checkStale(location)) {
        this.stats.rejectedByStale++
        return { accepted: false, deltaDistance: 0, reason: 'stale_location' }
      }

      this._updateAnchor(location)
      return { accepted: true, deltaDistance: 0, reason: 'first_location' }
    }

    // 3. Accuracy 필터링
    if (!this._checkAccuracy(location)) {
      this.stats.rejectedByAccuracy++
      return { accepted: false, deltaDistance: 0, reason: 'poor_accuracy' }
    }

    // 4. Stale 위치 필터링
    if (!this._checkStale(location)) {
      this.stats.rejectedByStale++
      return { accepted: false, deltaDistance: 0, reason: 'stale_location' }
    }

    // 5. 거리 및 속도 계산
    const rawDistance = haversineDistanceMeters(this.lastValidLocation, location)
    const timeDeltaMs = location.timestamp - this.lastValidLocation.timestamp
    const timeDeltaSec = timeDeltaMs / 1000

    if (timeDeltaSec <= 0) {
      return { accepted: false, deltaDistance: 0, reason: 'invalid_time' }
    }

    const speedMps = rawDistance / timeDeltaSec

    // 6. 속도 제한 필터링
    if (!this._checkSpeed(speedMps)) {
      this.stats.rejectedBySpeed++
      return { accepted: false, deltaDistance: 0, reason: 'excessive_speed' }
    }

    // 7. 정지 상태 감지 (연속 저속 체크)
    if (speedMps < DistanceCalculator.STATIONARY_SPEED_THRESHOLD_MPS) {
      this.lowSpeedCounter++
      if (this.lowSpeedCounter >= DistanceCalculator.STATIONARY_LOW_SPEED_COUNT) {
        this.stats.rejectedByStationary++
        // 앵커는 업데이트하여 시간 흐름 반영
        this._updateAnchor(location)
        return { accepted: false, deltaDistance: 0, reason: 'stationary' }
      }
    } else {
      this.lowSpeedCounter = 0 // 리셋
    }

    // 8. 최소 거리 임계값 필터링 (Drift 방지)
    if (rawDistance < DistanceCalculator.MIN_DISTANCE_THRESHOLD_M) {
      this.stats.rejectedByMinDistance++
      // 임계값 이하지만 앵커는 업데이트 (시간 흐름 반영)
      this._updateAnchor(location)
      return { accepted: false, deltaDistance: 0, reason: 'below_threshold' }
    }

    // 9. 좌표 스무딩 적용 (선택적)
    let finalDistance = rawDistance
    let smoothedLocation = null
    if (this.enableSmoothing) {
      smoothedLocation = this._applySmoothingAndGetDistance(location)
      if (smoothedLocation) {
        finalDistance = haversineDistanceMeters(this.lastValidLocation, smoothedLocation)

        // 스무딩 후에도 최소 거리 임계값 재적용 (Drift 방지 일관성)
        if (finalDistance < DistanceCalculator.MIN_DISTANCE_THRESHOLD_M) {
          this.stats.rejectedByMinDistance++
          // 스무딩된 좌표로 앵커 업데이트 (시간 흐름 반영)
          this._updateAnchor(smoothedLocation)
          return { accepted: false, deltaDistance: 0, reason: 'below_threshold_after_smoothing' }
        }
      }
    }

    // 10. 거리 누적
    this.totalDistance += finalDistance

    // 앵커 업데이트: 스무딩을 사용했다면 스무딩된 좌표로, 아니면 원본으로
    if (this.enableSmoothing && smoothedLocation) {
      this._updateAnchor(smoothedLocation)
    } else {
      this._updateAnchor(location)
    }

    return {
      accepted: true,
      deltaDistance: finalDistance,
      reason: 'accepted',
      speed: speedMps,
      rawDistance
    }
  }

  /**
   * 현재까지 누적된 총 거리 반환
   *
   * @returns {number} 총 거리 (미터)
   */
  getTotalDistance() {
    return this.totalDistance
  }

  /**
   * 통계 정보 반환 (디버깅/분석용)
   *
   * @returns {Object} 통계 객체
   */
  getStats() {
    return {
      ...this.stats,
      acceptanceRate: this.stats.totalSamples > 0
        ? ((this.stats.totalSamples - this._getRejectedCount()) / this.stats.totalSamples * 100).toFixed(1) + '%'
        : 'N/A'
    }
  }

  /**
   * 계산기 상태 초기화
   */
  reset() {
    this.totalDistance = 0
    this.lastValidLocation = null
    this.locationBuffer = []
    this.lowSpeedCounter = 0
    this.stats = {
      totalSamples: 0,
      rejectedByAccuracy: 0,
      rejectedBySpeed: 0,
      rejectedByMinDistance: 0,
      rejectedByStale: 0,
      rejectedByStationary: 0
    }
  }

  // ==================== 내부 메서드 ====================

  /**
   * 위치 객체 유효성 검증
   */
  _isValidLocation(location) {
    if (!location) return false

    const { latitude, longitude, timestamp } = location

    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Number.isFinite(timestamp) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    )
  }

  /**
   * GPS 정확도 체크
   */
  _checkAccuracy(location) {
    const { accuracy } = location

    // Accuracy 정보가 없는 경우는 통과 (보수적으로 처리)
    if (!accuracy || !Number.isFinite(accuracy)) {
      return true
    }

    // Accuracy가 임계값보다 나쁜 경우 거부
    return accuracy <= DistanceCalculator.MAX_ACCEPTABLE_ACCURACY_M
  }

  /**
   * 위치 데이터 신선도 체크
   */
  _checkStale(location) {
    const now = Date.now()
    const age = now - location.timestamp

    return age <= DistanceCalculator.LOCATION_STALE_THRESHOLD_MS
  }

  /**
   * 속도 제한 체크
   */
  _checkSpeed(speedMps) {
    const maxSpeedKmh = DistanceCalculator.MAX_SPEED_LIMITS_KMH[this.mode] || 40
    const maxSpeedMps = (maxSpeedKmh * 1000) / 3600 // km/h -> m/s

    return speedMps >= 0 && speedMps <= maxSpeedMps
  }

  /**
   * 좌표 스무딩 적용 (가중 이동평균)
   * 최근 N개의 위치를 평균내어 노이즈 감소
   */
  _applySmoothingAndGetDistance(location) {
    // 버퍼에 추가
    this.locationBuffer.push(location)

    // 윈도우 크기 초과 시 오래된 샘플 제거
    if (this.locationBuffer.length > DistanceCalculator.SMOOTHING_WINDOW_SIZE) {
      this.locationBuffer.shift()
    }

    // 충분한 샘플이 없으면 스무딩 스킵
    if (this.locationBuffer.length < 3) {
      return location
    }

    // 가중 이동평균 계산 (최근 샘플에 더 높은 가중치)
    let totalWeight = 0
    let weightedLat = 0
    let weightedLon = 0

    this.locationBuffer.forEach((loc, index) => {
      const weight = index + 1 // 최근일수록 가중치 증가 (1, 2, 3, 4, 5)
      weightedLat += loc.latitude * weight
      weightedLon += loc.longitude * weight
      totalWeight += weight
    })

    return {
      latitude: weightedLat / totalWeight,
      longitude: weightedLon / totalWeight,
      timestamp: location.timestamp,
      accuracy: location.accuracy
    }
  }

  /**
   * 마지막 유효 위치(앵커) 업데이트
   */
  _updateAnchor(location) {
    this.lastValidLocation = {
      latitude: location.latitude,
      longitude: location.longitude,
      timestamp: location.timestamp,
      accuracy: location.accuracy
    }
  }

  /**
   * 전체 거부된 샘플 수 계산
   */
  _getRejectedCount() {
    return (
      this.stats.rejectedByAccuracy +
      this.stats.rejectedBySpeed +
      this.stats.rejectedByMinDistance +
      this.stats.rejectedByStale +
      this.stats.rejectedByStationary
    )
  }
}

/**
 * 편의 함수: 단일 인스턴스 생성 헬퍼
 */
export const createDistanceCalculator = (options) => {
  return new DistanceCalculator(options)
}
