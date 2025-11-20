'use client'

import { useEffect } from 'react'
import { acquireNativeVisibilityBridge } from '../utils/native-visibility'

export default function useNativeAppVisibility(tag = 'app') {
  useEffect(() => {
    const release = acquireNativeVisibilityBridge(tag)
    return () => {
      try {
        if (typeof release === 'function') release()
      } catch (err) {
        console.warn('[useNativeAppVisibility] release failed', err)
      }
    }
  }, [tag])
}
