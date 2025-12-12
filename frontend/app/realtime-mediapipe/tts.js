// Lightweight TTS helpers dedicated to Mediapipe realtime feedback
// Keeps boxing TTS untouched while giving posture analysis resilient speech handling

let nativeTTS = null; // wrapped helper with safe methods
let nativeStatus = 'unknown';
let nativeLoadPromise = null;
let nativeRawPlugin = null; // holds the Capacitor proxy directly
let nativeDiagLogged = false;
let speakQueue = Promise.resolve();

const fallbackLocales = ['en-US', 'ko-KR'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const delay = (ms) => new Promise(res => setTimeout(res, ms));

const nativeDuckHelper = {
  async duck() {
    try {
      const cap = getWindowCapacitor();
      const duckPlugin = cap?.Plugins?.MotionFitAudioDuck;
      if (!duckPlugin || typeof duckPlugin.duck !== 'function') return null;
      await duckPlugin.duck();
      return duckPlugin;
    } catch {
      return null;
    }
  },
  async unduck(plugin) {
    const p = plugin || getWindowCapacitor()?.Plugins?.MotionFitAudioDuck;
    if (!p || typeof p.unduck !== 'function') return;
    try { await p.unduck(); } catch {}
  },
};

export async function forceUnduck() {
  try {
    await nativeDuckHelper.unduck();
  } catch {}
}

const withMediaDuck = (duckVolume = 0.25) => {
  if (typeof document === 'undefined') return () => {};
  const targets = Array.from(document.querySelectorAll('audio,video'))
    .filter((el) => {
      try {
        return !el.paused && !el.muted && typeof el.volume === 'number' && el.volume > 0;
      } catch {
        return false;
      }
    });
  const snapshots = targets.map((el) => ({ el, volume: el.volume }));
  snapshots.forEach(({ el }) => {
    try {
      el.volume = Math.min(1, Math.max(0, duckVolume));
    } catch {}
  });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    snapshots.forEach(({ el, volume }) => {
      try { el.volume = volume; } catch {}
    });
  };
};

const LOG_PREFIX = '[squat tts test]';
const logTTS = (...args) => {
  if (typeof console === 'undefined') return;
  try {
    console.info(LOG_PREFIX, ...args);
  } catch (err) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch {}
  }
};

const previewText = (text) => {
  if (typeof text !== 'string') return text;
  if (text.length <= 48) return text;
  return `${text.slice(0, 48)}…`;
};

const isNativeUnavailableError = (err) => {
  if (!err) return false;
  const code = err.code || err?.data?.code;
  if (code === 'UNAVAILABLE') return true;
  const message = String(err.message ?? err ?? '').toLowerCase();
  return message.includes('not yet initialized') || message.includes('not available on this device');
};

const isNativeUnsupportedLangError = (err) => {
  if (!err) return false;
  const message = String(err.message ?? err ?? '').toLowerCase();
  return message.includes('this language is not supported');
};

const getWindowCapacitor = () => (typeof window === 'undefined' ? null : (window.Capacitor ?? null));

const isMaybeNativePlatform = (cap) => {
  if (!cap) return false;
  try {
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
    const platform = cap.getPlatform?.();
    return platform && platform !== 'web' && platform !== 'electron';
  } catch {
    return false;
  }
};

const shouldRetryNative = () => isMaybeNativePlatform(getWindowCapacitor());

const loadCapacitor = async () => {
  const globalCap = getWindowCapacitor();
  if (globalCap) return globalCap;
  try {
    const mod = await import('@capacitor/core');
    return mod?.Capacitor || getWindowCapacitor();
  } catch {
    return getWindowCapacitor();
  }
};

const loadNativePlugin = async (cap) => {
  let plugin = null;
  try {
    const mod = await import('@capacitor-community/text-to-speech');
    if (mod?.TextToSpeech && typeof mod.TextToSpeech.speak === 'function') {
      plugin = mod.TextToSpeech;
    }
  } catch (err) {
    console.warn('native TTS import failed', err);
  }
  if (!plugin) {
    const fromCap = cap?.Plugins?.TextToSpeech || getWindowCapacitor()?.Plugins?.TextToSpeech;
    if (fromCap && typeof fromCap.speak === 'function') {
      plugin = fromCap;
    }
  }
  if (!plugin) {
    logTTS('loadNativePlugin: no plugin instance located');
  } else {
    logTTS('loadNativePlugin: plugin module resolved');
  }
  return { plugin: plugin || null };
};

const waitNativeReady = async (plugin, attempts = 6) => {
  if (!plugin) return false;
  if (typeof plugin.getSupportedLanguages !== 'function') {
    logTTS('waitNativeReady: plugin missing getSupportedLanguages, assuming ready');
    return true;
  }
  for (let i = 0; i < attempts; i += 1) {
    try {
      await plugin.getSupportedLanguages();
      logTTS('waitNativeReady: native engine reported ready', `attempt=${i + 1}`);
      return true;
    } catch (err) {
      if (!isNativeUnavailableError(err)) {
        logTTS('waitNativeReady: non-unavailable error, treating as ready', err?.message || err);
        return true;
      }
      logTTS('waitNativeReady: native unavailable, retrying', `attempt=${i + 1}`, err?.message || err);
      await delay(120 + i * 160);
    }
  }
  logTTS('waitNativeReady: native plugin not ready after retries', `attempts=${attempts}`);
  return false;
};

const wrapNativePlugin = (plugin) => {
  if (!plugin) return null;
  const call = (method) => {
    const fn = plugin?.[method];
    if (typeof fn !== 'function') return undefined;
    return (...args) => {
      try {
        const out = fn.apply(plugin, args);
        return out instanceof Promise ? out : Promise.resolve(out);
      } catch (err) {
        return Promise.reject(err);
      }
    };
  };
  const safe = Object.create(null);
  safe.speak = call('speak');
  safe.stop = call('stop');
  safe.isLanguageSupported = call('isLanguageSupported');
  safe.getSupportedLanguages = call('getSupportedLanguages');
  Object.defineProperty(safe, Symbol.toStringTag, {
    value: 'NativeTTS',
    writable: false,
    configurable: false,
  });
  return Object.freeze(safe);
};

const ensureNativeTTS = async () => {
  logTTS('ensureNativeTTS: invoked', `status=${nativeStatus}`);
  if (nativeStatus === 'available' && nativeTTS) return nativeTTS;
  if (nativeLoadPromise) return nativeLoadPromise;
  if (nativeStatus === 'unavailable' && !shouldRetryNative()) return null;

  const settleWithPlugin = async (plugin, attemptLabel) => {
    if (!plugin) return null;
    nativeRawPlugin = plugin;
    const ready = await waitNativeReady(plugin, 8);
    if (!ready) {
      nativeTTS = null;
      nativeStatus = 'unknown';
      logTTS('ensureNativeTTS: plugin not yet ready', attemptLabel);
      return null;
    }
    const wrapped = wrapNativePlugin(plugin);
    nativeTTS = wrapped || null;
    nativeStatus = wrapped ? 'available' : 'unavailable';
    if (wrapped) {
      if (!nativeDiagLogged) {
        nativeDiagLogged = true;
        try {
          logTTS('diag: protoIsNull', Object.getPrototypeOf(wrapped) === null);
          logTTS('diag: hasThen', wrapped && ('then' in wrapped));
        } catch (diagErr) {
          logTTS('diag: error', diagErr?.message || diagErr);
        }
      }
      logTTS('ensureNativeTTS: native plugin wrapped and available');
      return wrapped;
    }
    logTTS('ensureNativeTTS: wrapping failed, marking unavailable');
    return null;
  };

  nativeLoadPromise = (async () => {
    if (nativeRawPlugin && nativeStatus !== 'unavailable') {
      const existing = await settleWithPlugin(nativeRawPlugin, 'existing');
      if (existing) return existing;
    }

    if (typeof window === 'undefined') {
      nativeStatus = 'unavailable';
      nativeTTS = null;
      logTTS('ensureNativeTTS: window undefined, marking unavailable');
      return null;
    }

    const cap = await loadCapacitor();
    const maybeNative = isMaybeNativePlatform(cap);
    const { plugin } = await loadNativePlugin(cap);
    if (plugin) {
      const readyPlugin = await settleWithPlugin(plugin, 'fresh');
      if (readyPlugin) return readyPlugin;
      return null;
    }

    nativeTTS = null;
    nativeRawPlugin = null;
    nativeStatus = maybeNative ? 'unknown' : 'unavailable';
    logTTS('ensureNativeTTS: plugin missing', `status=${nativeStatus}`);
    return null;
  })();

  try {
    const result = await nativeLoadPromise;
    return result;
  } finally {
    nativeLoadPromise = null;
  }
};

const buildLanguagePriority = (requestedLang) => {
  const list = [];
  const push = (lang) => {
    if (typeof lang === 'string' && lang && !list.includes(lang)) list.push(lang);
  };
  const trimmed = typeof requestedLang === 'string' ? requestedLang.trim() : '';
  if (trimmed) push(trimmed);
  const base = trimmed.split('-')[0];
  if (base) {
    if (base === 'en') push('en-US');
    else if (base === 'ko') push('ko-KR');
    else push(`${base}-${base.toUpperCase()}`);
  }
  fallbackLocales.forEach(push);
  return list;
};

const isNativeLanguageSupported = async (native, lang) => {
  if (!native || !lang || typeof native.isLanguageSupported !== 'function') return true;
  try {
    const res = await native.isLanguageSupported({ lang });
    if (res) {
      if (typeof res.supported === 'boolean') return res.supported;
      if (typeof res.value === 'boolean') return res.value;
    }
  } catch (err) {
    if (!isNativeUnavailableError(err)) {
      console.warn('native TTS language check failed', err);
    }
  }
  return true;
};

const resolveNativeLanguage = async (native, requestedLang) => {
  const priorities = buildLanguagePriority(requestedLang);
  for (const lang of priorities) {
    if (await isNativeLanguageSupported(native, lang)) return lang;
  }
  return requestedLang || 'en-US';
};

const attemptNativeSpeak = async (native, payload) => {
  if (!native || typeof native.speak !== 'function') return false;
  try {
    if (typeof native.stop === 'function') {
      try {
        await native.stop();
      } catch (err) {
        if (!isNativeUnavailableError(err)) {
          logTTS('attemptNativeSpeak: stop failed', err?.message || err);
        }
      }
    }
    logTTS('attemptNativeSpeak: invoking native speak', `lang=${payload?.lang}`, `rate=${payload?.rate}`, `pitch=${payload?.pitch}`, `volume=${payload?.volume}`, `text=${previewText(payload?.text)}`);
    await native.speak(payload);
    logTTS('attemptNativeSpeak: native speak resolved');
    return true;
  } catch (err) {
    if (isNativeUnavailableError(err)) throw err;
    if (isNativeUnsupportedLangError(err)) throw err;
    logTTS('attemptNativeSpeak: native speak error', err?.message || err);
    throw err;
  }
};

const speakNative = async (native, text, rate, { requestedLang, pitch, volume, maxAttempts = 6 }) => {
  if (!native) return false;
  const langCandidates = buildLanguagePriority(requestedLang);
  let lastInitError = null;
  for (const candidate of langCandidates) {
    let resolvedLang = candidate;
    try {
      resolvedLang = await resolveNativeLanguage(native, candidate);
    } catch (err) {
      if (isNativeUnavailableError(err)) {
        lastInitError = err;
        logTTS('speakNative: native unavailable during resolve', `candidate=${candidate}`, err?.message || err);
        continue;
      }
      logTTS('speakNative: language resolve failed', `candidate=${candidate}`, err?.message || err);
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await delay(180 + attempt * 120);
      try {
        logTTS('speakNative: attempt', `lang=${resolvedLang}`, `attempt=${attempt + 1}`, `text=${previewText(text)}`);
        const success = await attemptNativeSpeak(native, {
          text,
          lang: resolvedLang,
          rate: clamp(rate, 0.1, 2),
          pitch: clamp(pitch, 0, 2),
          volume: clamp(volume, 0, 1),
          category: 'ambient',
          queueStrategy: 0,
        });
        if (success) return true;
      } catch (err) {
        if (isNativeUnavailableError(err)) {
          lastInitError = err;
          logTTS('speakNative: native unavailable during speak', `lang=${resolvedLang}`, `attempt=${attempt + 1}`, err?.message || err);
          continue;
        }
        if (isNativeUnsupportedLangError(err)) {
          logTTS('speakNative: unsupported language', `lang=${resolvedLang}`);
          break;
        }
        // Other errors: move on to next candidate
        logTTS('speakNative: other error, switching candidate', err?.message || err);
        break;
      }
    }
  }

  if (lastInitError) {
    logTTS('speakNative: native unavailable after retries', lastInitError?.message || lastInitError);
  }
  return false;
};

const ensureVoices = async (timeout = 800) => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const synth = window.speechSynthesis;
  const immediate = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
  if (Array.isArray(immediate) && immediate.length) return immediate;
  return new Promise((resolve) => {
    const handler = () => {
      try { synth.removeEventListener?.('voiceschanged', handler); } catch {}
      resolve(typeof synth.getVoices === 'function' ? synth.getVoices() : []);
    };
    try { synth.addEventListener?.('voiceschanged', handler); } catch {}
    setTimeout(() => {
      try { synth.removeEventListener?.('voiceschanged', handler); } catch {}
      resolve(typeof synth.getVoices === 'function' ? synth.getVoices() : []);
    }, timeout);
  });
};

const selectVoice = (voices, requestedLang) => {
  if (!Array.isArray(voices) || !voices.length) return null;
  const langLower = (requestedLang || '').toLowerCase();
  const base = langLower.split('-')[0];
  return (
    voices.find(v => langLower && v?.lang?.toLowerCase() === langLower)
    || voices.find(v => base && v?.lang?.toLowerCase().startsWith(base))
    || voices.find(v => v?.default)
    || voices[0]
  );
};

export async function unlockTTS(preferredLang = 'en-US') {
  const native = await ensureNativeTTS();
  if (native) {
    if (typeof native.stop === 'function') {
      try { await native.stop(); } catch {}
    }
    try {
      const langToUse = await resolveNativeLanguage(native, preferredLang);
      logTTS('unlockTTS: issuing silent native speak', `lang=${langToUse}`);
      const speakP = native.speak({
        text: ' ',
        lang: langToUse,
        rate: 0.1,
        pitch: 1,
        volume: 0,
        category: 'ambient',
        queueStrategy: 0,
      });
      await Promise.race([speakP, delay(800)]);
      logTTS('unlockTTS: native unlock attempt completed');
    } catch (err) {
      logTTS('unlockTTS: native unlock error', err?.message || err);
    }
    return true;
  }
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const synth = window.speechSynthesis;
  await ensureVoices();
  try {
    const langCandidates = buildLanguagePriority(preferredLang);
    const probe = new SpeechSynthesisUtterance(' ');
    probe.lang = langCandidates[0] || preferredLang || 'en-US';
    probe.rate = 1;
    probe.pitch = 1;
    try { probe.volume = 0; } catch {}
    probe.onend = () => {};
    probe.onerror = () => {};
    try { synth.resume?.(); } catch {}
    try { synth.speak(probe); } catch {}
    logTTS('unlockTTS: web speech unlock issued', `lang=${probe.lang}`);
  } catch {
    return false;
  }
  await delay(120);
  return true;
}


let __ttsUninterruptibleUntil = 0;
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
const isUninterruptibleActive = () => nowMs() < __ttsUninterruptibleUntil;
const setUninterruptibleFor = (ms) => { __ttsUninterruptibleUntil = Math.max(__ttsUninterruptibleUntil, nowMs() + Math.max(0, ms || 0)); };

export async function stopAllTTS() {
  try {
    const native = await ensureNativeTTS();
    if (native && typeof native.stop === 'function') {
      try { await native.stop(); } catch (err) {
        if (!isNativeUnavailableError(err)) {
          logTTS('stopAllTTS: native stop error', err?.message || err);
        }
      }
    }
  } catch (err) {
    logTTS('stopAllTTS: ensureNativeTTS failed', err?.message || err);
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch (err) {
      logTTS('stopAllTTS: web cancel error', err?.message || err);
    }
  }
  // Reset queue/lock so future speakOnce calls are not blocked by an interrupted speech
  speakQueue = Promise.resolve();
  __ttsUninterruptibleUntil = 0;
}

const speakWithMode = (synth, text, rate, pitch, volume, voice, requestedLang, mode) => {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    const langToUse = mode === 2 ? undefined : (requestedLang || voice?.lang || 'en-US');
    if (mode === 0) {
      try { if (voice) utter.voice = voice; } catch {}
      if (langToUse) { try { utter.lang = langToUse; } catch {} }
    } else if (mode === 1) {
      try { if (voice) utter.voice = voice; } catch {}
      if (!voice && requestedLang) { try { utter.lang = requestedLang; } catch {} }
    } else if (requestedLang && !voice) {
      try { utter.lang = requestedLang; } catch {}
    }
    utter.rate = rate;
    utter.pitch = pitch;
    utter.volume = volume;

    const cleanup = (success) => {
      try { utter.onend = null; utter.onerror = null; } catch {}
      resolve(success);
    };

    const fallback = setTimeout(() => cleanup(false), 2200);
    utter.onend = () => { clearTimeout(fallback); cleanup(true); };
    utter.onerror = () => { clearTimeout(fallback); cleanup(false); };

    try {
      synth.speak(utter);
    } catch (err) {
      clearTimeout(fallback);
      cleanup(false);
    }
  });
};

export async function speakOnce(text, rate, options = {}) {
  const runSpeak = async () => {
    // Uninterruptible policy: if another uninterruptible speech is active, skip this call (do not preempt)
    const uninterruptible = !!options?.uninterruptible;
    const lockMs = Math.max(0, options?.lockMs ?? (uninterruptible ? 1800 : 0));
    if (!uninterruptible && isUninterruptibleActive()) {
      logTTS('speakOnce: skipped due to active uninterruptible speech');
      return false;
    }
    if (uninterruptible) {
      try { await stopAllTTS(); } catch {}
      setUninterruptibleFor(lockMs);
    }

    logTTS('speakOnce: requested', `rate=${rate}`, `lang=${options?.lang}`, `text=${previewText(text)}`);
    const native = await ensureNativeTTS();
    const optsIsVoiceOnly = options && typeof options === 'object'
      && !('voice' in options || 'lang' in options || 'pitch' in options || 'volume' in options || 'delayMs' in options);
    const requestedLang = optsIsVoiceOnly ? undefined : options?.lang;
    const pitch = optsIsVoiceOnly ? 1.12 : (options?.pitch ?? 1.12);
    const volume = optsIsVoiceOnly ? 1 : (options?.volume ?? 1);
    const delayMs = optsIsVoiceOnly ? 0 : (options?.delayMs ?? 60);
    const duckVolume = typeof options?.duckVolume === 'number' ? options.duckVolume : 0.25;
    const restoreDuck = withMediaDuck(duckVolume);
    const nativeDuck = await nativeDuckHelper.duck();

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !options?.allowHiddenPlayback) {
      try { restoreDuck(); } catch {}
      try { await nativeDuckHelper.unduck(nativeDuck); } catch {}
      return false;
    }

    try {
      if (native) {
        const nativeResult = await speakNative(native, text, rate, { requestedLang, pitch, volume });
        if (nativeResult) {
          logTTS('speakOnce: native playback succeeded');
          return true;
        }
        logTTS('speakOnce: native playback failed, falling back to web');
      }

      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
      const synth = window.speechSynthesis;
      try { synth.resume?.(); } catch {}

      const voices = await ensureVoices();
      const langCandidates = buildLanguagePriority(requestedLang);
      if (!langCandidates.includes(undefined)) langCandidates.push(undefined);

      const providedVoice = optsIsVoiceOnly ? options : options?.voice;
      const combos = [];
      if (providedVoice) combos.push({ lang: requestedLang, voice: providedVoice });
      for (const lang of langCandidates) {
        combos.push({ lang, voice: selectVoice(voices, lang) });
      }

      if (delayMs > 0) await delay(delayMs);

      for (const { lang, voice } of combos) {
        for (let mode = 0; mode < 3; mode += 1) {
          logTTS('speakOnce: web attempt', `lang=${lang}`, `mode=${mode}`, voice ? `voice=${voice.name || voice.voiceURI || 'custom'}` : 'voice=auto');
          const success = await speakWithMode(synth, text, rate, pitch, volume, voice, lang, mode);
          if (success) {
            logTTS('speakOnce: web speech succeeded', `lang=${lang}`, `mode=${mode}`);
            return true;
          }
        }
      }
      logTTS('speakOnce: all playback attempts failed');
      return false;
    } finally {
      try { restoreDuck(); } catch {}
      try { await nativeDuckHelper.unduck(nativeDuck); } catch {}
    }
  };

  // Queue to prevent overlapping/cutting speech: each call waits for the previous to finish
  speakQueue = speakQueue.then(runSpeak).catch((err) => {
    logTTS('speakOnce: queued speak error', err?.message || err);
    return false;
  });
  return speakQueue;
}
