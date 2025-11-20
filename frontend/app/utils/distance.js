const EARTH_RADIUS_M = 6371000

export const haversineDistanceMeters = (from, to) => {
  if (!from || !to) return 0
  const lat1 = Number(from.latitude)
  const lon1 = Number(from.longitude)
  const lat2 = Number(to.latitude)
  const lon2 = Number(to.longitude)
  if (![lat1, lon1, lat2, lon2].every((val) => Number.isFinite(val))) {
    return 0
  }
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c
}

export const metersToKilometers = (meters) => {
  if (!Number.isFinite(meters)) return 0
  return meters / 1000
}

export const formatDistanceLabel = (meters, precision = 2) => {
  const km = metersToKilometers(meters)
  return `${km.toFixed(precision)} km`
}

export const breakdownDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return { hours, minutes, seconds }
}

export const formatClock = (ms, { showHours = false, showCentiseconds = false } = {}) => {
  if (!Number.isFinite(ms)) return '--:--'
  const { hours, minutes, seconds } = breakdownDuration(ms)
  const centiseconds = Math.floor((ms % 1000) / 10)
  const prefixHours = showHours || hours > 0
  const hh = prefixHours ? `${String(hours).padStart(2, '0')}:` : ''
  const mm = String(prefixHours ? minutes : minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  const cs = showCentiseconds ? `.${String(centiseconds).padStart(2, '0')}` : ''
  return `${hh}${mm}:${ss}${cs}`
}

export const formatPaceLabel = (msPerKm) => {
  if (!Number.isFinite(msPerKm) || msPerKm <= 0) return '--:-- /km'
  const totalSeconds = Math.round(msPerKm / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')} /km`
}

const buildSpokenSegment = (value, unit, locale) => {
  if (!value) return null
  if (locale === 'ko') {
    return `${value}${unit}`
  }
  const label = value === 1 ? unit : `${unit}s`
  return `${value} ${label}`
}

export const formatSpokenDuration = (ms, locale = 'en') => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return locale === 'ko' ? '0초' : '0 seconds'
  }
  const { hours, minutes, seconds } = breakdownDuration(ms)
  const segments = []
  if (hours) segments.push(buildSpokenSegment(hours, locale === 'ko' ? '시간' : 'hour', locale))
  if (minutes) segments.push(buildSpokenSegment(minutes, locale === 'ko' ? '분' : 'minute', locale))
  if (seconds || segments.length === 0) {
    segments.push(buildSpokenSegment(seconds || 0, locale === 'ko' ? '초' : 'second', locale))
  }
  return locale === 'ko' ? segments.join(' ') : segments.join(', ')
}

export const formatSpokenPace = (msPerKm, locale = 'en') => {
  if (!Number.isFinite(msPerKm) || msPerKm <= 0) {
    return locale === 'ko' ? '페이스 정보를 알 수 없어요.' : 'pace data unavailable'
  }
  const totalSeconds = Math.round(msPerKm / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (locale === 'ko') {
    return `${minutes}분 ${seconds}초`
  }
  const minutePart = minutes === 1 ? '1 minute' : `${minutes} minutes`
  const secondPart = seconds === 1 ? '1 second' : `${seconds} seconds`
  return `${minutePart} ${secondPart}`
}

export const formatSpokenDistance = (meters, locale = 'en', precision = 1) => {
  if (!Number.isFinite(meters) || meters < 0) {
    return locale === 'ko' ? '거리 정보를 알 수 없어요.' : 'distance unavailable'
  }
  const km = metersToKilometers(meters)
  const formatted = km.toFixed(precision)
  if (locale === 'ko') {
    return `${formatted}킬로미터`
  }
  return `${formatted} kilometer${km >= 1.5 ? 's' : ''}`
}

export const formatSpokenSpeed = (kmh, locale = 'en') => {
  if (!Number.isFinite(kmh) || kmh < 0) {
    return locale === 'ko' ? '속도를 알 수 없어요.' : 'speed unavailable'
  }
  const rounded = kmh.toFixed(1)
  if (locale === 'ko') return `시속 ${rounded}킬로미터`
  return `${rounded} kilometers per hour`
}
