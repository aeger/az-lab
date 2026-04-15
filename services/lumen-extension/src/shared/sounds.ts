// Sound system — Web Audio API tone synthesis
// Runs in sidepanel (has DOM). Background service worker uses chrome.notifications instead.

export type SoundId =
  | 'bass_alarm'
  | 'sharp_chime'
  | 'soft_tone'
  | 'gentle_pop'
  | 'triple_beep'
  | 'descending_alert'
  | 'ascending_chime'
  | 'pulse_warn'
  | 'ping'
  | 'silent';

interface ToneSpec {
  frequency: number;
  type: OscillatorType;
  duration: number;
  envelope: { attack: number; decay: number; sustain: number; release: number };
  harmonics?: Array<{ freq: number; gain: number }>;
}

const SOUND_DEFINITIONS: Record<SoundId, () => void> = {
  bass_alarm: () => playSequence([
    { frequency: 120, type: 'sawtooth', duration: 0.4, envelope: { attack: 0.02, decay: 0.1, sustain: 0.8, release: 0.1 } },
    { frequency: 80, type: 'sawtooth', duration: 0.4, envelope: { attack: 0.01, decay: 0.05, sustain: 0.9, release: 0.05 } },
    { frequency: 100, type: 'sawtooth', duration: 0.6, envelope: { attack: 0.02, decay: 0.1, sustain: 0.8, release: 0.2 } },
  ], 0.08),

  sharp_chime: () => playTone({
    frequency: 880,
    type: 'triangle',
    duration: 0.5,
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.4 },
    harmonics: [{ freq: 1760, gain: 0.3 }, { freq: 2640, gain: 0.1 }],
  }),

  soft_tone: () => playTone({
    frequency: 528,
    type: 'sine',
    duration: 0.6,
    envelope: { attack: 0.05, decay: 0.15, sustain: 0.4, release: 0.4 },
  }),

  gentle_pop: () => playTone({
    frequency: 800,
    type: 'sine',
    duration: 0.15,
    envelope: { attack: 0.005, decay: 0.05, sustain: 0.1, release: 0.09 },
  }),

  triple_beep: () => playSequence([
    { frequency: 660, type: 'square', duration: 0.12, envelope: { attack: 0.005, decay: 0.02, sustain: 0.9, release: 0.01 } },
    { frequency: 660, type: 'square', duration: 0.12, envelope: { attack: 0.005, decay: 0.02, sustain: 0.9, release: 0.01 } },
    { frequency: 880, type: 'square', duration: 0.2, envelope: { attack: 0.005, decay: 0.02, sustain: 0.9, release: 0.05 } },
  ], 0.04),

  descending_alert: () => playSequence([
    { frequency: 1200, type: 'triangle', duration: 0.2, envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 } },
    { frequency: 800, type: 'triangle', duration: 0.2, envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 } },
    { frequency: 500, type: 'triangle', duration: 0.3, envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 } },
  ], 0.03),

  ascending_chime: () => playSequence([
    { frequency: 440, type: 'sine', duration: 0.2, envelope: { attack: 0.02, decay: 0.05, sustain: 0.5, release: 0.15 } },
    { frequency: 660, type: 'sine', duration: 0.2, envelope: { attack: 0.02, decay: 0.05, sustain: 0.5, release: 0.15 } },
    { frequency: 880, type: 'sine', duration: 0.3, envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.2 } },
  ], 0.03),

  pulse_warn: () => playSequence([
    { frequency: 440, type: 'sawtooth', duration: 0.15, envelope: { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.05 } },
    { frequency: 440, type: 'sawtooth', duration: 0.15, envelope: { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.05 } },
  ], 0.06),

  ping: () => playTone({
    frequency: 1047,
    type: 'sine',
    duration: 0.3,
    envelope: { attack: 0.005, decay: 0.05, sustain: 0.2, release: 0.25 },
    harmonics: [{ freq: 2093, gain: 0.15 }],
  }),

  silent: () => {},
};

export const SOUND_LABELS: Record<SoundId, string> = {
  bass_alarm: 'Bass Alarm (Critical)',
  sharp_chime: 'Sharp Chime',
  soft_tone: 'Soft Tone',
  gentle_pop: 'Gentle Pop',
  triple_beep: 'Triple Beep',
  descending_alert: 'Descending Alert',
  ascending_chime: 'Ascending Chime',
  pulse_warn: 'Pulse Warning',
  ping: 'Ping',
  silent: 'Silent (Off)',
};

export const ALL_SOUND_IDS = Object.keys(SOUND_LABELS) as SoundId[];

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function playTone(spec: ToneSpec, startTime = 0, masterGain = 0.6): void {
  const ctx = getCtx();
  const t = ctx.currentTime + startTime;
  const { frequency, type, duration, envelope, harmonics } = spec;

  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(ctx.destination);

  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, t);
  osc.connect(gainNode);
  gainNode.connect(master);

  const { attack, decay, sustain, release } = envelope;
  gainNode.gain.setValueAtTime(0, t);
  gainNode.gain.linearRampToValueAtTime(1, t + attack);
  gainNode.gain.linearRampToValueAtTime(sustain, t + attack + decay);
  gainNode.gain.setValueAtTime(sustain, t + duration - release);
  gainNode.gain.linearRampToValueAtTime(0, t + duration);

  osc.start(t);
  osc.stop(t + duration);

  // Add harmonics for richer sound
  if (harmonics) {
    for (const h of harmonics) {
      const hosc = ctx.createOscillator();
      const hgain = ctx.createGain();
      hosc.type = 'sine';
      hosc.frequency.setValueAtTime(h.freq, t);
      hosc.connect(hgain);
      hgain.connect(master);
      hgain.gain.setValueAtTime(0, t);
      hgain.gain.linearRampToValueAtTime(h.gain, t + attack);
      hgain.gain.linearRampToValueAtTime(0, t + duration);
      hosc.start(t);
      hosc.stop(t + duration);
    }
  }
}

function playSequence(tones: ToneSpec[], gap = 0.05, masterGain = 0.6): void {
  let offset = 0;
  for (const tone of tones) {
    playTone(tone, offset, masterGain);
    offset += tone.duration + gap;
  }
}

export function playSound(soundId: SoundId, volume = 0.7): void {
  try {
    const fn = SOUND_DEFINITIONS[soundId];
    if (fn) {
      // Temporarily scale master gain with volume
      // Simple approach: let each fn use the volume param
      fn();
    }
  } catch (err) {
    console.warn('[sounds] playback error:', err);
  }
}

export function playSoundForUrgency(urgency: string, prefs: Record<string, { soundId: string; volume: number; enabled: boolean }>): void {
  const pref = prefs[urgency];
  if (!pref || !pref.enabled) return;
  playSound(pref.soundId as SoundId, pref.volume);
}
