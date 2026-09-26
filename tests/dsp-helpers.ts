import { VoiceDSP, type VoiceInputs } from '../src/audio/voice-dsp';

export const SR = 48000;

export function render(
  seconds: number,
  inputs: Partial<VoiceInputs> | ((t: number) => Partial<VoiceInputs>),
  dsp = new VoiceDSP(SR),
): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const block = new Float32Array(128);
  const base: VoiceInputs = { frequency: 220, gate: 1, vowel: 0.5, voice: 0, glide: 0.05, intensity: 0.85 };
  for (let i = 0; i < n; i += 128) {
    const p = typeof inputs === 'function' ? inputs(i / SR) : inputs;
    dsp.process(block, 128, { ...base, ...p });
    out.set(block.subarray(0, Math.min(128, n - i)), i);
  }
  return out;
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Energy at a single frequency (Goertzel), Hann-windowed. */
export function goertzel(x: Float32Array, freq: number, from: number, len: number): number {
  const w = (2 * Math.PI * freq) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    const s0 = x[from + i] * win + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / len;
}

/** Sum of harmonic energies of f0 falling in [lo, hi) Hz. */
export function bandEnergy(x: Float32Array, f0: number, lo: number, hi: number): number {
  const from = Math.floor(x.length / 2);
  const len = 8192;
  let e = 0;
  for (let h = 1; h * f0 < hi; h++) {
    const f = h * f0;
    if (f >= lo) e += goertzel(x, f, from, len) ** 2;
  }
  return e;
}

/** Frequency of the strongest harmonic within [lo, hi). */
export function peakHarmonic(x: Float32Array, f0: number, lo: number, hi: number): number {
  const from = Math.floor(x.length / 2);
  let best = 0;
  let bestF = 0;
  for (let h = 1; h * f0 < hi; h++) {
    const f = h * f0;
    if (f < lo) continue;
    const m = goertzel(x, f, from, 8192);
    if (m > best) {
      best = m;
      bestF = f;
    }
  }
  return bestF;
}
