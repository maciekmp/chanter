import { VOWEL_NAMES, type VowelName } from '../audio/voice-dsp';

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);

export const midiToFreq = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const pitchClass = (m: number) => ((Math.round(m) % 12) + 12) % 12;
export const isWhite = (m: number) => WHITE.has(pitchClass(m));

export function noteName(midi: number): string {
  const m = Math.round(midi);
  return NOTE_NAMES[pitchClass(m)] + (Math.floor(m / 12) - 1);
}

/** Nearest white-key (C major / A minor family) midi note. */
export function snapToWhite(midi: number): number {
  const r = Math.round(midi);
  if (isWhite(r)) return r;
  // Black key: pick the closer white neighbour.
  return midi < r ? r - 1 : r + 1;
}

/** 0..1 vowel control → nearest vowel label (0 = OO … 1 = EE). */
export function vowelName(v: number): VowelName {
  return VOWEL_NAMES[Math.max(0, Math.min(4, Math.round(v * 4)))];
}

export const VOWEL_POSITIONS: Record<VowelName, number> = { OO: 0, OH: 0.25, AH: 0.5, EH: 0.75, EE: 1 };
