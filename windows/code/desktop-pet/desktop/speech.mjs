// Local text-to-speech for the desktop pet.
//
// The backend already synthesizes replies through Qwen TTS, but that path needs
// a working provider credential and it bills per character. This module speaks
// with the operating system's own voices through the Web Speech API instead:
// no network, no API key, no cost. It is used for ambient small talk, and as a
// fallback for chat replies whenever the cloud voice produced no audio.

/** Matches a configured voice name loosely (case- and prefix-insensitive). */
function pickVoice(voices, wanted) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const name = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
  if (name) {
    const exact = voices.find(voice => voice.name.toLowerCase() === name);
    if (exact) return exact;
    const partial = voices.find(voice => voice.name.toLowerCase().includes(name));
    if (partial) return partial;
  }
  // Prefer a Chinese voice: the preset lines are all Chinese.
  return voices.find(voice => /^zh/i.test(voice.lang)) ?? voices[0];
}

export class LocalSpeaker {
  #settings;
  #supported;
  #voice = null;
  #current = null;

  constructor(settings = {}) {
    this.#settings = {
      enabled: settings.enabled !== false,
      ambient: settings.ambient !== false,
      replies: settings.replies === true,
      voice: typeof settings.voice === 'string' ? settings.voice : '',
      rate: typeof settings.rate === 'number' && settings.rate > 0 ? settings.rate : 1.05,
      pitch: typeof settings.pitch === 'number' && settings.pitch > 0 ? settings.pitch : 1.15,
      volume: typeof settings.volume === 'number' && settings.volume >= 0 ? settings.volume : 1,
    };
    this.#supported = typeof globalThis.speechSynthesis !== 'undefined'
      && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';
    if (this.#supported) {
      const load = () => { this.#voice = pickVoice(speechSynthesis.getVoices(), this.#settings.voice); };
      load();
      // Chromium fills the voice list asynchronously on first use.
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  get enabled() { return this.#supported && this.#settings.enabled; }
  get voiceName() { return this.#voice?.name ?? null; }
  wantsAmbient() { return this.enabled && this.#settings.ambient; }
  wantsReplies() { return this.enabled && this.#settings.replies; }

  speak(text) {
    if (!this.enabled) return false;
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return false;
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(body);
      if (this.#voice) utterance.voice = this.#voice;
      utterance.rate = this.#settings.rate;
      utterance.pitch = this.#settings.pitch;
      utterance.volume = this.#settings.volume;
      // Keep a handle so the GC cannot collect an utterance that is still queued.
      this.#current = utterance;
      utterance.onend = () => { if (this.#current === utterance) this.#current = null; };
      speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      console.warn('[speech] failed:', error?.message ?? error);
      return false;
    }
  }

  /**
   * Change the level of the fallback voice.
   *
   * The speaker was constructed once at startup with a snapshot of the settings,
   * so moving the volume slider afterwards did nothing on this path. Cached clips
   * were fine because their gain is read at play time; the OS voice was not.
   */
  setVolume(value) {
    if (Number.isFinite(value) && value >= 0) this.#settings.volume = Math.min(1, value);
  }

  cancel() { if (this.#supported) { try { speechSynthesis.cancel(); } catch {} } }
}
