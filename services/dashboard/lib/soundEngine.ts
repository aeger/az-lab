// AZ-Lab Sentinel — Dashboard Sound Engine
// 21 CC0 alert sounds synthesized via Web Audio API (no sampled audio, no copyright)

export interface SoundEntry {
  id: string
  label: string
  category: 'critical' | 'high' | 'medium' | 'low'
}

export interface UrgencySoundConfig {
  enabled: boolean
  sound: string
  volume: number
  tts: boolean
}

export type SoundSettings = Record<'critical' | 'high' | 'medium' | 'low', UrgencySoundConfig>

export const SOUND_CATALOG: SoundEntry[] = [
  // CRITICAL
  { id: 'klaxon',            label: 'Klaxon Alarm',     category: 'critical' },
  { id: 'bass-siren',        label: 'Bass Siren',        category: 'critical' },
  { id: 'alert-pulse',       label: 'Alert Pulse',       category: 'critical' },
  { id: 'emergency-triple',  label: 'Emergency Triple',  category: 'critical' },
  { id: 'alarm-horn',        label: 'Alarm Horn',        category: 'critical' },
  { id: 'danger-sweep',      label: 'Danger Sweep',      category: 'critical' },
  // HIGH
  { id: 'sharp-chime',       label: 'Sharp Chime',       category: 'high' },
  { id: 'double-ping',       label: 'Double Ping',       category: 'high' },
  { id: 'crystal-bell',      label: 'Crystal Bell',      category: 'high' },
  { id: 'attention-tone',    label: 'Attention Tone',    category: 'high' },
  { id: 'notification-ding', label: 'Notification Ding', category: 'high' },
  // MEDIUM
  { id: 'soft-chime',        label: 'Soft Chime',        category: 'medium' },
  { id: 'bubble',            label: 'Bubble Pop',        category: 'medium' },
  { id: 'marimba',           label: 'Marimba Hit',       category: 'medium' },
  { id: 'warm-bell',         label: 'Warm Bell',         category: 'medium' },
  { id: 'pluck',             label: 'String Pluck',      category: 'medium' },
  // LOW
  { id: 'tick',              label: 'Soft Tick',         category: 'low' },
  { id: 'soft-click',        label: 'Soft Click',        category: 'low' },
  { id: 'whisper-tone',      label: 'Whisper Tone',      category: 'low' },
  { id: 'drip',              label: 'Water Drip',        category: 'low' },
  { id: 'subtle-pop',        label: 'Subtle Pop',        category: 'low' },
]

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  critical: { enabled: true,  sound: 'klaxon',      volume: 0.8, tts: true  },
  high:     { enabled: true,  sound: 'sharp-chime', volume: 0.6, tts: false },
  medium:   { enabled: true,  sound: 'soft-chime',  volume: 0.4, tts: false },
  low:      { enabled: true,  sound: 'tick',        volume: 0.25, tts: false },
}

type SynthFn = (ctx: AudioContext, vol: number) => void

const SOUND_DEFS: Record<string, SynthFn> = {

  // ── CRITICAL ────────────────────────────────────────────────────────────────

  'klaxon': (ctx, vol) => {
    ;[440, 880, 440, 880].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.22
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sawtooth'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.35 * vol, t + 0.01)
      gain.gain.setValueAtTime(0.35 * vol, t + 0.18)
      gain.gain.linearRampToValueAtTime(0, t + 0.21)
      osc.start(t); osc.stop(t + 0.22)
    })
  },

  'bass-siren': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.linearRampToValueAtTime(80, t + 0.75)
    osc.frequency.linearRampToValueAtTime(150, t + 1.5)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.5 * vol, t + 0.05)
    gain.gain.setValueAtTime(0.5 * vol, t + 1.4)
    gain.gain.linearRampToValueAtTime(0, t + 1.5)
    osc.start(t); osc.stop(t + 1.5)
  },

  'alert-pulse': (ctx, vol) => {
    for (let i = 0; i < 5; i++) {
      const t = ctx.currentTime + i * 0.15
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'square'; osc.frequency.value = 660
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.28 * vol, t + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
      osc.start(t); osc.stop(t + 0.13)
    }
  },

  'emergency-triple': (ctx, vol) => {
    ;[1000, 800, 600].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.28
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.4 * vol, t + 0.01)
      gain.gain.setValueAtTime(0.4 * vol, t + 0.2)
      gain.gain.linearRampToValueAtTime(0, t + 0.25)
      osc.start(t); osc.stop(t + 0.26)
    })
  },

  'alarm-horn': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    const gain = ctx.createGain()
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency)
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sawtooth'; osc.frequency.value = 220
    lfo.frequency.value = 8; lfoGain.gain.value = 15
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.4 * vol, t + 0.05)
    gain.gain.setValueAtTime(0.4 * vol, t + 0.8)
    gain.gain.linearRampToValueAtTime(0, t + 1.0)
    lfo.start(t); lfo.stop(t + 1.0)
    osc.start(t); osc.stop(t + 1.0)
  },

  'danger-sweep': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'square'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(100, t)
    osc.frequency.exponentialRampToValueAtTime(2000, t + 0.3)
    gain.gain.setValueAtTime(0.22 * vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
    osc.start(t); osc.stop(t + 0.4)
  },

  // ── HIGH ────────────────────────────────────────────────────────────────────

  'sharp-chime': (ctx, vol) => {
    ;[2093, 4186, 6279].forEach((freq, i) => {
      const amp = [0.3, 0.09, 0.03][i]
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = freq
      const t = ctx.currentTime
      gain.gain.setValueAtTime(amp * vol, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8)
      osc.start(t); osc.stop(t + 0.8)
    })
  },

  'double-ping': (ctx, vol) => {
    ;[880, 1760].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.2
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0.28 * vol, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
      osc.start(t); osc.stop(t + 0.5)
    })
  },

  'crystal-bell': (ctx, vol) => {
    ;[1.0, 2.756, 5.404, 8.933].forEach((ratio, i) => {
      const amp = [0.35, 0.18, 0.08, 0.04][i]
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = 1047 * ratio
      const t = ctx.currentTime
      gain.gain.setValueAtTime(amp * vol, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2)
      osc.start(t); osc.stop(t + 1.2)
    })
  },

  'attention-tone': (ctx, vol) => {
    ;[440, 660].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.22
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'triangle'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.32 * vol, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38)
      osc.start(t); osc.stop(t + 0.4)
    })
  },

  'notification-ding': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(1318, t)
    osc.frequency.linearRampToValueAtTime(1760, t + 0.12)
    gain.gain.setValueAtTime(0.28 * vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
    osc.start(t); osc.stop(t + 0.5)
  },

  // ── MEDIUM ──────────────────────────────────────────────────────────────────

  'soft-chime': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 880
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0.22 * vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
    osc.start(t); osc.stop(t + 0.9)
  },

  'bubble': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(200, t)
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.2)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.18 * vol, t + 0.05)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    osc.start(t); osc.stop(t + 0.3)
  },

  'marimba': (ctx, vol) => {
    ;[440, 880, 1320].forEach((freq, i) => {
      const amp = [0.28, 0.09, 0.04][i]
      const decay = [0.9, 0.4, 0.2][i]
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = freq
      const t = ctx.currentTime
      gain.gain.setValueAtTime(amp * vol, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + decay)
      osc.start(t); osc.stop(t + decay)
    })
  },

  'warm-bell': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'triangle'; osc.frequency.value = 523
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.18 * vol, t + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0)
    osc.start(t); osc.stop(t + 1.0)
  },

  'pluck': (ctx, vol) => {
    const bufSize = Math.floor(ctx.sampleRate * 0.04)
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.3))
    }
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'; filter.frequency.value = 440; filter.Q.value = 5
    const gain = ctx.createGain()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.35 * vol, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
    src.start(ctx.currentTime)
  },

  // ── LOW ─────────────────────────────────────────────────────────────────────

  'tick': (ctx, vol) => {
    const bufSize = Math.floor(ctx.sampleRate * 0.018)
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize)
    }
    const gain = ctx.createGain()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(gain); gain.connect(ctx.destination)
    gain.gain.value = 0.14 * vol
    src.start(ctx.currentTime)
  },

  'soft-click': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 800
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.13 * vol, t + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    osc.start(t); osc.stop(t + 0.07)
  },

  'whisper-tone': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'; osc.frequency.value = 440
    const t = ctx.currentTime
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.07 * vol, t + 0.06)
    gain.gain.setValueAtTime(0.07 * vol, t + 0.22)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
    osc.start(t); osc.stop(t + 0.56)
  },

  'drip': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(1200, t)
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.18)
    gain.gain.setValueAtTime(0.11 * vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
    osc.start(t); osc.stop(t + 0.22)
  },

  'subtle-pop': (ctx, vol) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain); gain.connect(ctx.destination)
    osc.type = 'sine'
    const t = ctx.currentTime
    osc.frequency.setValueAtTime(200, t)
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.1)
    gain.gain.setValueAtTime(0.09 * vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    osc.start(t); osc.stop(t + 0.12)
  },
}

// ── SoundEngine class ─────────────────────────────────────────────────────────

export class SoundEngine {
  private ctx: AudioContext | null = null

  private getCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
    return this.ctx
  }

  play(soundId: string, volume = 1.0): void {
    const fn = SOUND_DEFS[soundId]
    if (!fn) {
      console.warn(`[sentinel-sound] Unknown sound: ${soundId}`)
      return
    }
    try {
      const ctx = this.getCtx()
      fn(ctx, Math.max(0, Math.min(1, volume)))
    } catch (err) {
      console.error(`[sentinel-sound] Playback error for ${soundId}:`, err)
    }
  }

  async playBuffer(arrayBuffer: ArrayBuffer, volume = 1.0): Promise<void> {
    const ctx = this.getCtx()
    const audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0))
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = audioBuf
    src.connect(gain); gain.connect(ctx.destination)
    gain.gain.value = Math.max(0, Math.min(1, volume))
    src.start(ctx.currentTime)
  }

  speakTTS(text: string, volume = 1.0): void {
    if (!('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utt = new SpeechSynthesisUtterance(`Critical alert: ${text}`)
    utt.rate = 0.95
    utt.pitch = 1.0
    utt.volume = Math.min(1, volume * 1.3)
    window.speechSynthesis.speak(utt)
  }

  resume(): void {
    this.ctx?.resume()
  }
}

// Singleton for app-wide use
let _engine: SoundEngine | null = null
export function getSoundEngine(): SoundEngine {
  if (!_engine) _engine = new SoundEngine()
  return _engine
}
