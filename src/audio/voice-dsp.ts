/**
 * Monophonic vocal synthesis core.
 *
 * Source: Rosenberg glottal-flow derivative (band-limited at the closure
 * instant with polyBLEP) plus flow-modulated aspiration noise.
 * Filter: five cascaded Klatt resonators whose frequencies/bandwidths are
 * interpolated in log space across five vowels (OO, OH, AH, EH, EE) and four
 * voice types (baritone → soprano).
 *
 * This file has no Web Audio dependencies so it runs both inside the
 * AudioWorklet and in Node tests.
 */

export const VOWEL_NAMES = ['OO', 'OH', 'AH', 'EH', 'EE'] as const;
export type VowelName = (typeof VOWEL_NAMES)[number];

type FormantSet = { f: number[][]; b: number[][] };

// Rows follow VOWEL_NAMES order. Values adapted from classic sung-vowel
// formant tables, with bandwidths widened slightly for a cascade topology.
const BARITONE: FormantSet = {
  f: [
    [340, 640, 2400, 2700, 3100],
    [420, 780, 2450, 2700, 3000],
    [630, 1060, 2450, 2700, 3000],
    [430, 1650, 2500, 3000, 3350],
    [280, 1950, 2600, 3150, 3450],
  ],
  b: [
    [70, 90, 120, 140, 160],
    [70, 90, 120, 140, 160],
    [90, 100, 130, 140, 160],
    [70, 100, 130, 140, 160],
    [60, 100, 120, 140, 160],
  ],
};
const TENOR: FormantSet = {
  f: [
    [350, 620, 2700, 2900, 3300],
    [400, 800, 2600, 2800, 3000],
    [650, 1080, 2650, 2900, 3250],
    [440, 1750, 2600, 3200, 3580],
    [290, 2050, 2800, 3250, 3540],
  ],
  b: BARITONE.b,
};
const ALTO: FormantSet = {
  f: [
    [325, 700, 2530, 3500, 4950],
    [450, 800, 2830, 3500, 4950],
    [800, 1150, 2800, 3500, 4950],
    [450, 1800, 2700, 3300, 4950],
    [350, 2100, 2800, 3700, 4950],
  ],
  b: [
    [70, 90, 150, 170, 200],
    [80, 90, 150, 170, 200],
    [100, 110, 150, 170, 200],
    [80, 110, 150, 170, 200],
    [70, 110, 150, 170, 200],
  ],
};
const SOPRANO: FormantSet = {
  f: [
    [325, 700, 2700, 3800, 4950],
    [450, 800, 2830, 3800, 4950],
    [800, 1150, 2900, 3900, 4950],
    [450, 2000, 2800, 3600, 4950],
    [270, 2300, 2950, 3900, 4950],
  ],
  b: [
    [80, 90, 170, 180, 200],
    [90, 90, 150, 180, 200],
    [110, 120, 150, 180, 200],
    [90, 120, 150, 180, 200],
    [80, 120, 150, 180, 200],
  ],
};
const VOICE_SETS = [BARITONE, TENOR, ALTO, SOPRANO];
const NF = 5;

// Per [voice][vowel] loudness compensation so vowels sit at similar levels
// (the cascade's overall gain depends strongly on formant spacing).
// Measured with tests/voice-dsp.test.ts → see `measureCompensation`.
export const LEVEL_COMP: number[][] = [
  [0.175, 0.168, 0.14, 0.217, 0.243],
  [0.169, 0.166, 0.14, 0.221, 0.234],
  [0.186, 0.183, 0.147, 0.236, 0.224],
  [0.188, 0.187, 0.156, 0.241, 0.246],
];

const LOG_F = VOICE_SETS.map((s) => s.f.map((row) => row.map(Math.log)));
const LOG_B = VOICE_SETS.map((s) => s.b.map((row) => row.map(Math.log)));

export interface VoiceInputs {
  /** Target fundamental frequency in Hz. */
  frequency: number;
  /** 1 = sing, 0 = release. */
  gate: number;
  /** 0 = OO … 1 = EE (continuous). */
  vowel: number;
  /** 0 = baritone … 1 = soprano. */
  voice: number;
  /** Portamento time in seconds (≈95% arrival time). */
  glide: number;
  /** Note loudness 0..1. */
  intensity: number;
}

export interface VoiceState {
  f0: number;
  env: number;
  vowel: number;
  gate: number;
  onsets: number;
  rms: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Interpolate a [voice][vowel][formant] log table at continuous positions. */
function lookup(table: number[][][], voicePos: number, vowelPos: number, k: number): number {
  const vi = Math.min(Math.floor(voicePos), 2);
  const vf = voicePos - vi;
  const wi = Math.min(Math.floor(vowelPos), 3);
  const wf = vowelPos - wi;
  const a = table[vi][wi][k] * (1 - wf) + table[vi][wi + 1][k] * wf;
  const b = table[vi + 1][wi][k] * (1 - wf) + table[vi + 1][wi + 1][k] * wf;
  return a * (1 - vf) + b * vf;
}

function lookupComp(voicePos: number, vowelPos: number): number {
  const vi = Math.min(Math.floor(voicePos), 2);
  const vf = voicePos - vi;
  const wi = Math.min(Math.floor(vowelPos), 3);
  const wf = vowelPos - wi;
  const a = LEVEL_COMP[vi][wi] * (1 - wf) + LEVEL_COMP[vi][wi + 1] * wf;
  const b = LEVEL_COMP[vi + 1][wi] * (1 - wf) + LEVEL_COMP[vi + 1][wi + 1] * wf;
  return a * (1 - vf) + b * vf;
}

const CONTROL_INTERVAL = 16; // samples between filter coefficient updates

export class VoiceDSP {
  readonly sr: number;

  // Pitch
  private logF = Math.log(220);
  private lastTargetLogF = Math.log(220);
  private phase = 0;
  private vibPhase = 0;
  private vibAmount = 0; // 0..1 ramp
  private heldTime = 0; // seconds since last note change
  private drift = 0; // slow random pitch wander, semitones
  private driftTarget = 0;
  private driftCounter = 0;

  // Amplitude
  private env = 0;
  private prevGate = 0;
  private breath = 0; // onset breath burst

  // Timbre (smoothed controls)
  private vowelS = 0.5;
  private voiceS = 0.25;

  // Filters
  private readonly fF = new Float64Array(NF);
  private readonly fB = new Float64Array(NF);
  private readonly ca = new Float64Array(NF);
  private readonly cb = new Float64Array(NF);
  private readonly cc = new Float64Array(NF);
  private readonly y1 = new Float64Array(NF);
  private readonly y2 = new Float64Array(NF);
  private comp = 1;
  private tilt = 0;
  private noiseHp = 0;
  private dcX = 0;
  private dcY = 0;
  private ctrlCounter = 0;
  private seed = 22222;

  // Reporting
  onsets = 0;
  private sumSq = 0;
  private sumN = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.updateFormants(0);
  }

  private rand(): number {
    // xorshift32 → [-1, 1)
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed / 4294967296) * 2 - 1;
  }

  private updateFormants(f0: number) {
    const voicePos = clamp(this.voiceS, 0, 1) * 3;
    const vowelPos = clamp(this.vowelS, 0, 1) * 4;
    const nyq = this.sr * 0.45;
    for (let k = 0; k < NF; k++) {
      let f = Math.exp(lookup(LOG_F, voicePos, vowelPos, k));
      const bw = Math.exp(lookup(LOG_B, voicePos, vowelPos, k));
      // Singers raise F1 above the fundamental on high notes ("formant tuning").
      if (k === 0 && f < f0 * 1.15) f = f0 * 1.15;
      if (k === 1 && f < f0 * 1.9) f = f0 * 1.9;
      f = Math.min(f, nyq);
      this.fF[k] = f;
      this.fB[k] = bw;
      const r = Math.exp((-Math.PI * bw) / this.sr);
      const c = -r * r;
      const b = 2 * r * Math.cos((2 * Math.PI * f) / this.sr);
      this.cc[k] = c;
      this.cb[k] = b;
      this.ca[k] = 1 - b - c;
    }
    this.comp = lookupComp(voicePos, vowelPos);
  }

  /** Fill `out` with `n` samples. Inputs are treated as constant for the block. */
  process(out: Float32Array, n: number, p: VoiceInputs): void {
    const sr = this.sr;
    const dtSec = 1 / sr;
    const gate = p.gate >= 0.5 ? 1 : 0;
    const intensity = clamp(p.intensity, 0, 1);
    const targetLogF = Math.log(clamp(p.frequency, 30, 2000));
    const voiceTarget = clamp(p.voice, 0, 1);
    const vowelTarget = clamp(p.vowel, 0, 1);

    // Onset handling: new note from silence jumps to pitch with a small scoop,
    // otherwise pitch glides (portamento).
    if (gate && !this.prevGate) {
      this.onsets++;
      this.breath = 1;
      this.heldTime = 0;
      this.vibAmount = 0;
      if (this.env < 0.02) {
        this.logF = targetLogF - 0.35 * (Math.LN2 / 12); // scoop from ~35 cents below
        this.lastTargetLogF = targetLogF;
      }
    }
    if (Math.abs(targetLogF - this.lastTargetLogF) > 0.25 * (Math.LN2 / 12)) {
      // Pitch target changed noticeably: restart vibrato onset (legato note change).
      this.heldTime = 0;
      this.vibAmount = Math.min(this.vibAmount, 0.3);
    }
    this.lastTargetLogF = targetLogF;
    this.prevGate = gate;

    const glideTau = Math.max(0.004, clamp(p.glide, 0, 2) / 3);
    const kPitch = 1 - Math.exp(-dtSec / glideTau);
    const kVowel = 1 - Math.exp(-dtSec / 0.03);
    const kVoice = 1 - Math.exp(-dtSec / 0.06);
    const envTarget = gate * (0.35 + 0.65 * intensity);
    const kAtt = 1 - Math.exp(-dtSec / 0.045);
    const kRel = 1 - Math.exp(-dtSec / 0.11);
    const kBreath = 1 - Math.exp(-dtSec / 0.06);

    const vibRate = 5.2 + 0.7 * this.voiceS;
    const vibDepthSemis = 0.32 + 0.12 * this.voiceS;
    const breathiness = 0.035 + 0.05 * this.voiceS;
    const semitone = Math.LN2 / 12;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      // --- control-rate smoothing ---
      this.logF += (targetLogF - this.logF) * kPitch;
      this.vowelS += (vowelTarget - this.vowelS) * kVowel;
      this.voiceS += (voiceTarget - this.voiceS) * kVoice;
      this.env += (envTarget - this.env) * (envTarget > this.env ? kAtt : kRel);
      this.breath -= this.breath * kBreath;

      if (--this.driftCounter <= 0) {
        this.driftCounter = (sr * 0.12) | 0;
        this.driftTarget = this.rand() * 0.06; // ±6 cents wander
      }
      this.drift += (this.driftTarget - this.drift) * 0.0004;

      // Vibrato fades in after ~0.3 s of a steady note.
      this.heldTime += dtSec;
      if (this.heldTime > 0.3 && gate) this.vibAmount = Math.min(1, this.vibAmount + dtSec / 0.6);
      else if (!gate) this.vibAmount = Math.max(0, this.vibAmount - dtSec / 0.3);
      // Suppress vibrato while gliding between pitches.
      const gliding = Math.min(1, Math.abs(targetLogF - this.logF) / (semitone * 0.5));
      this.vibPhase += vibRate * dtSec;
      if (this.vibPhase >= 1) this.vibPhase -= 1;
      const vib = Math.sin(2 * Math.PI * this.vibPhase) * vibDepthSemis * this.vibAmount * (1 - gliding);

      const f0 = Math.exp(this.logF + (vib + this.drift) * semitone);

      if (this.ctrlCounter-- <= 0) {
        this.ctrlCounter = CONTROL_INTERVAL;
        this.updateFormants(f0);
      }

      // --- glottal source ---
      const dt = f0 / sr;
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;
      // Louder = shorter open phase = brighter; soprano = slightly more open.
      const oq = clamp(0.72 - 0.2 * this.env + 0.08 * this.voiceS, 0.4, 0.85);
      const op = oq * 0.72;
      const cl = oq * 0.28;
      const ph = this.phase;
      let src: number;
      let flow: number;
      if (ph < op) {
        src = (cl / op) * Math.sin((Math.PI * ph) / op);
        flow = 0.5 * (1 - Math.cos((Math.PI * ph) / op));
      } else if (ph < op + cl) {
        const x = (Math.PI * (ph - op)) / (2 * cl);
        src = -Math.sin(x);
        flow = Math.cos(x);
      } else {
        src = 0;
        flow = 0;
      }
      // Closure step of +1 (from −1 to 0): smooth with polyBLEP.
      let t = ph - (op + cl);
      if (t < 0) t += 1;
      src += 0.5 * polyBlep(t, dt);

      // Spectral tilt: softer notes are darker.
      const tiltK = 0.35 + 0.6 * this.env;
      this.tilt += (src - this.tilt) * tiltK;

      // Aspiration: high-passed noise gated by glottal flow + onset breath.
      const nz = this.rand();
      const hp = nz - this.noiseHp;
      this.noiseHp = nz;
      const asp = hp * (breathiness * (0.3 + flow) + 0.18 * this.breath);

      let x = this.tilt + asp;

      // --- formant cascade ---
      for (let k = 0; k < NF; k++) {
        const y = this.ca[k] * x + this.cb[k] * this.y1[k] + this.cc[k] * this.y2[k];
        this.y2[k] = this.y1[k];
        this.y1[k] = y;
        x = y;
      }

      // DC blocker, gain and gentle saturation.
      const dc = x - this.dcX + 0.995 * this.dcY;
      this.dcX = x;
      this.dcY = dc;
      const s = 0.95 * Math.tanh(dc * this.env * this.comp);
      out[i] = s;
      sumSq += s * s;
    }
    this.sumSq += sumSq;
    this.sumN += n;
  }

  /** Snapshot of the synthesis state for UI/animation. Resets the RMS window. */
  readState(gate: number): VoiceState {
    const rms = this.sumN > 0 ? Math.sqrt(this.sumSq / this.sumN) : 0;
    this.sumSq = 0;
    this.sumN = 0;
    return {
      f0: Math.exp(this.logF),
      env: this.env,
      vowel: this.vowelS,
      gate,
      onsets: this.onsets,
      rms,
    };
  }

  /** Current formant frequencies (for tests/diagnostics). */
  formants(): number[] {
    return Array.from(this.fF);
  }
}
