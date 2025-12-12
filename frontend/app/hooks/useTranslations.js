import { useState, useEffect } from 'react'

const translations = {
  en: {
    upload: {
      title: 'Upload Your Video',
      description: 'Drag and drop your video file here, or click to browse',
      formats: 'Supports MP4, MOV, AVI • Max 15MB',
      analyzing: 'Analyzing Your Pose',
      processingMessage: 'Your video is being processed with MediaPipe technology…'
    },
    results: {
      complete: 'Analysis Complete!',
      ready: 'Your pose analysis is ready.',
      analysisResult: 'Analysis Result',
      postureAnalysis: 'Posture Analysis',
      noVideoSupport: 'Your browser does not support the video tag.'
    },
    errors: {
      videoOnly: 'Please select a video file',
      fileSizeLimit: 'Video file size must be 15MB or less',
      analysisFailed: 'Analysis failed. Please try again.'
    },
    buttons: {
      back: 'Back',
      startAnalysis: 'Start Analysis',
      analyzing: 'Analyzing...'
    }
  },
  ko: {
    upload: {
      title: '비디오 업로드',
      description: '비디오 파일을 여기에 드래그하거나 클릭하여 선택하세요',
      formats: 'MP4, MOV, AVI 지원 • 최대 15MB',
      analyzing: '자세 분석 중',
      processingMessage: 'MediaPipe 기술로 비디오를 분석하고 있습니다...'
    },
    results: {
      complete: '분석 완료!',
      ready: '자세 분석이 완료되었습니다.',
      analysisResult: '분석 결과',
      postureAnalysis: '자세 분석',
      noVideoSupport: '브라우저가 비디오 태그를 지원하지 않습니다.'
    },
    errors: {
      videoOnly: '비디오 파일을 선택해주세요',
      fileSizeLimit: '비디오 파일 크기는 15MB 이하여야 합니다',
      analysisFailed: '분석에 실패했습니다. 다시 시도해주세요.'
    },
    buttons: {
      back: '뒤로',
      startAnalysis: '분석 시작',
      analyzing: '분석 중...'
    }
  }
}

export function useTranslations() {
  const [locale, setLocale] = useState('en')

  useEffect(() => {
    // Get locale from localStorage or browser language
    const savedLocale = localStorage.getItem('locale')
    if (savedLocale && translations[savedLocale]) {
      setLocale(savedLocale)
    } else {
      const browserLang = navigator.language.split('-')[0]
      if (translations[browserLang]) {
        setLocale(browserLang)
      }
    }
  }, [])

  const changeLocale = (newLocale) => {
    if (translations[newLocale]) {
      setLocale(newLocale)
      localStorage.setItem('locale', newLocale)
    }
  }

  const t = (key) => {
    const keys = key.split('.')
    let value = translations[locale]
    
    for (const k of keys) {
      value = value?.[k]
    }
    
    return value || key
  }

  const tArray = (key) => {
    const result = t(key)
    return Array.isArray(result) ? result : []
  }

  return { t, tArray, locale, changeLocale }
}

export function useAnalyzeTranslations() {
  return useTranslations()
}
