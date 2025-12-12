'use client'

export const RUNNING_LANGUAGE_STORAGE_KEY = 'running_language'

export const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
]

export const MODE_LABELS = {
  run: { en: 'Running', ko: '러닝' },
  walk: { en: 'Walking', ko: '도보' },
}

export const MENU_TEXT = {
  heroStats: {
    en: [
      { label: 'Lap coaching', value: 'Lap voice alerts (500m / 1km)' },
      { label: 'GPS accuracy', value: 'High precision' },
      { label: 'Supported modes', value: 'Run & Walk' },
    ],
    ko: [
      { label: '랩 안내', value: '500m/1km 음성 안내' },
      { label: 'GPS 정확도', value: '고정밀 추적' },
      { label: '지원 모드', value: '러닝 · 도보' },
    ],
  },
  descriptions: {
    run: {
      en: 'Outdoor runs with live pace & lap TTS',
      ko: '실시간 페이스와 구간 음성 안내',
    },
    walk: {
      en: 'Mindful walks with distance tracking',
      ko: '거리 추적이 포함된 도보 모드',
    },
  },
  languageLabel: {
    en: 'Language',
    ko: '언어',
  },
}

export const SESSION_TEXT = {
  en: {
    heroDescription: 'Track elapsed time, distance, and pace with live GPS.',
    hero: {
      permission: 'Permission',
      gps: 'GPS',
    },
    status: {
      ready: 'Ready',
      active: 'Active',
      paused: 'Paused',
    },
    stats: {
      elapsed: 'Elapsed',
      distance: 'Distance',
      current: 'Current Pace',
      average: 'Avg Pace',
      currentSpeed: 'Current Speed',
      avgSpeed: 'Avg Speed',
      steps: 'Steps',
    },
    controls: {
      title: 'Controls',
      running: 'In Session',
      paused: 'Paused',
      resume: 'Resume',
      pause: 'Pause',
      end: 'Stop',
    },
    laps: {
      heading: 'Lap Splits',
      empty: 'No laps completed yet.',
      next: 'Next lap distance',
    },
    setup: {
      title: 'Session Setup',
      subtitle: 'Configure your session and start moving.',
      voiceOn: 'Voice: On',
      voiceOff: 'Voice: Off',
      timeCue: 'Time voice',
      paceGuide: 'Pace guide',
      screenLockOn: 'Screen on',
      screenLockOff: 'Allow sleep',
      language: 'Language',
      lapDistanceLabel: 'Lap distance for voice alerts',
      startPrefix: 'Start',
      startSuffix: '',
      preparing: 'Preparing...',
    },
    goal: {
      title: 'Goals',
      distance: 'Distance',
      time: 'Time',
      clear: 'Clear goal',
      none: 'No goal set',
      reached: 'Goal reached',
    },
    history: {
      title: 'Recent Sessions',
      subtitle: 'History',
      clear: 'Clear',
      empty: 'No sessions yet.',
    },
    errors: {
      permission: 'Location permission is required.',
      generic: 'Location request failed.',
      watch: 'Unable to update location.',
    },
    ghost: {
      title: 'Ghost mode',
      subtitle: 'Race against your fastest past run nearby.',
      enableButton: 'Start challenge',
      disableButton: 'Cancel challenge',
      targetLabel: 'Target record',
      notFound: 'No comparable past run for this distance yet. Ghost mode is off.',
      targetReady: 'Ghost target loaded and settings synced.',
      historySuccess: 'Ghost success',
      historyFail: 'Ghost missed',
      challengeButton: 'Challenge',
    },
    summary: {
      totalTime: 'Total Time',
      distance: 'Distance',
      avgPace: 'Avg Pace',
      laps: 'Laps',
      lapList: 'Lap Summary',
      steps: 'Steps',
      calories: 'Calories',
      cadence: 'Cadence',
      stride: 'Stride',
      elevation: 'Elevation Gain',
      intensity: 'Intensity',
      goalProgress: 'Goal Progress',
    },
  },
  ko: {
    heroDescription: '경과 시간과 페이스를 실시간으로 확인하세요.',
    hero: {
      permission: '권한',
      gps: 'GPS',
    },
    status: {
      ready: '대기 중',
      active: '진행 중',
      paused: '일시정지',
    },
    stats: {
      elapsed: '경과 시간',
      distance: '총 거리',
      current: '현재 페이스',
      average: '평균 페이스',
      currentSpeed: '현재 속도',
      avgSpeed: '평균 속도',
      steps: '걸음수',
    },
    controls: {
      title: '컨트롤',
      running: '러닝 중',
      paused: '휴식 중',
      resume: '재개',
      pause: '일시정지',
      end: '정지',
    },
    laps: {
      heading: '구간 랩',
      empty: '아직 랩 기록이 없습니다.',
      next: '다음 랩까지 남은 거리',
    },
    setup: {
      title: '세션 설정',
      subtitle: '모드를 선택하고 러닝을 시작하세요.',
      voiceOn: '음성: 켜짐',
      voiceOff: '음성: 꺼짐',
      timeCue: '시간 음성',
      paceGuide: '페이스 가이드',
      screenLockOn: '화면 항상 켜기',
      screenLockOff: '자동 꺼짐 허용',
      language: '언어',
      lapDistanceLabel: '음성 안내 거리',
      startPrefix: '',
      startSuffix: ' 시작하기',
      preparing: '시작 준비 중...',
    },
    goal: {
      title: '목표',
      distance: '거리',
      time: '시간',
      clear: '목표 해제',
      none: '설정된 목표 없음',
      reached: '목표 달성',
    },
    history: {
      title: '최근 기록',
      subtitle: '히스토리',
      clear: '초기화',
      empty: '아직 기록이 없습니다.',
    },
    errors: {
      permission: '위치 권한이 필요합니다.',
      generic: '위치를 가져오지 못했습니다.',
      watch: '위치 업데이트에 실패했어요.',
    },
    ghost: {
      title: '고스트 모드',
      subtitle: '기록에 다시 도전하세요.',
      enableButton: '기록보기',
      disableButton: '도전 해제',
      targetLabel: '도전 대상 기록',
      notFound: '이 거리에 맞는 완료 기록이 없어 고스트 모드를 끌게요.',
      targetReady: '도전 기록을 불러왔어요. 설정을 맞춰둘게요.',
      historySuccess: '도전 성공',
      historyFail: '도전 실패',
      challengeButton: '이 기록에 도전',
    },
    summary: {
      totalTime: '총 시간',
      distance: '총 거리',
      avgPace: '평균 페이스',
      laps: '구간 랩',
      lapList: '랩 요약',
      steps: '걸음수',
      calories: '칼로리',
      cadence: '케이던스',
      stride: '스트라이드',
      elevation: '고도 상승',
      intensity: '강도',
      goalProgress: '목표 달성률',
    },
  },
}
