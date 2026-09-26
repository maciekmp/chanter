/**
 * Mouth shape → vowel, openness and loudness, from MediaPipe face landmarks
 * and blendshapes. Pure (no DOM), so it can be unit-tested.
 */

export interface Landmark {
  x: number;
  y: number;
}

export type Blendshapes = Record<string, number>;

/**
 * One frame's mouth measurements. Lengths are divided by the outer eye-corner
 * span, so they don't change with distance to the camera.
 */
export interface MouthFeatures {
  /** Mouth-corner distance. */
  width: number;
  /** Inner-lip opening. */
  gap: number;
  /** Lip rounding (pucker/funnel blendshapes), 0..1. */
  round: number;
  /** Lip spreading (smile/stretch blendshapes), 0..1. */
  spread: number;
}

type Key = keyof MouthFeatures;
const KEYS: Key[] = ['width', 'gap', 'round', 'spread'];

/** Landmark indices in the MediaPipe face mesh. */
export const LM = { noseTip: 1, eyeOuterR: 33, eyeOuterL: 263, lipTop: 13, lipBottom: 14, cornerR: 61, cornerL: 291 };
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** `aspect` = image width / height (landmarks are normalised per axis). */
export function mouthFeatures(lm: readonly Landmark[], bs: Blendshapes, aspect: number): MouthFeatures | null {
  if (lm.length < 292) return null;
  const d = (a: number, b: number) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const eyes = d(LM.eyeOuterR, LM.eyeOuterL);
  if (!(eyes > 1e-4)) return null;
  const b = (k: string) => bs[k] ?? 0;
  return {
    width: d(LM.cornerR, LM.cornerL) / eyes,
    gap: d(LM.lipTop, LM.lipBottom) / eyes,
    round: clamp(Math.max(b('mouthPucker'), b('mouthFunnel'))),
    spread: clamp((b('mouthSmileLeft') + b('mouthSmileRight') + b('mouthStretchLeft') + b('mouthStretchRight')) / 2),
  };
}

export const CALIBRATION_STEPS = ['closed', 'OO', 'OH', 'AH', 'EH', 'EE'] as const;
export type CalibrationStep = (typeof CALIBRATION_STEPS)[number];

/** Reference shapes: a closed mouth and the five vowels (OO … EE). */
export interface MouthCalibration {
  closed: MouthFeatures;
  vowels: MouthFeatures[];
}

/** Typical adult shapes, used until the player calibrates. */
export const DEFAULT_CALIBRATION: MouthCalibration = {
  closed: { width: 0.56, gap: 0.015, round: 0.02, spread: 0.1 },
  vowels: [
    { width: 0.41, gap: 0.08, round: 0.6, spread: 0 },
    { width: 0.47, gap: 0.2, round: 0.4, spread: 0 },
    { width: 0.55, gap: 0.34, round: 0.05, spread: 0.05 },
    { width: 0.62, gap: 0.22, round: 0.02, spread: 0.2 },
    { width: 0.68, gap: 0.1, round: 0, spread: 0.4 },
  ],
};

/** Smallest spread a feature is assumed to have, so a flat one can't dominate. */
const MIN_RANGE: MouthFeatures = { width: 0.1, gap: 0.12, round: 0.25, spread: 0.25 };

/** A calibration that came from storage, or null if it's malformed. */
export function validCalibration(value: unknown): MouthCalibration | null {
  const c = value as MouthCalibration | null;
  const ok = (f: unknown) => !!f && typeof f === 'object' && KEYS.every((k) => Number.isFinite((f as MouthFeatures)[k]));
  if (!c || typeof c !== 'object' || !ok(c.closed) || !Array.isArray(c.vowels) || c.vowels.length !== 5 || !c.vowels.every(ok)) return null;
  const pick = (f: MouthFeatures): MouthFeatures => ({ width: f.width, gap: f.gap, round: f.round, spread: f.spread });
  return { closed: pick(c.closed), vowels: c.vowels.map(pick) };
}

/**
 * Maps features onto the vowel line through the calibrated OO → OH → AH → EH
 * → EE shapes: the nearest point on that polyline gives a continuous vowel.
 */
export class MouthModel {
  readonly calibration: MouthCalibration;
  private readonly weight: MouthFeatures;
  /** Gap below which the lips count as closed, and the least-open vowel's gap. */
  private readonly closedGap: number;
  private readonly minVowelGap: number;

  constructor(calibration: MouthCalibration = DEFAULT_CALIBRATION) {
    this.calibration = calibration;
    const w = {} as MouthFeatures;
    for (const k of KEYS) {
      const vals = calibration.vowels.map((v) => v[k]);
      w[k] = 1 / Math.max(Math.max(...vals) - Math.min(...vals), MIN_RANGE[k]);
    }
    this.weight = w;
    this.minVowelGap = Math.min(...calibration.vowels.map((v) => v.gap));
    this.closedGap = Math.min(calibration.closed.gap, this.minVowelGap - 0.02);
  }

  /** 0 = OO … 1 = EE. */
  vowel(f: MouthFeatures): number {
    const P = this.calibration.vowels;
    let best = Infinity;
    let at = 0.5;
    for (let i = 0; i < P.length - 1; i++) {
      // Project f onto segment P[i] → P[i+1] in the weighted feature space.
      let dd = 0;
      let dx = 0;
      for (const k of KEYS) {
        const w = this.weight[k];
        const seg = (P[i + 1][k] - P[i][k]) * w;
        dd += seg * seg;
        dx += (f[k] - P[i][k]) * w * seg;
      }
      const t = dd > 0 ? clamp(dx / dd) : 0;
      let dist = 0;
      for (const k of KEYS) {
        const e = (f[k] - (P[i][k] + t * (P[i + 1][k] - P[i][k]))) * this.weight[k];
        dist += e * e;
      }
      if (dist < best) {
        best = dist;
        at = (i + t) / (P.length - 1);
      }
    }
    return at;
  }

  /** 0 = lips closed, 1 = as open as the least-open vowel. */
  openness(f: MouthFeatures): number {
    return Math.max(0, (f.gap - this.closedGap) / Math.max(0.02, this.minVowelGap - this.closedGap));
  }

  /**
   * Loudness 0..1 from how wide the mouth is for this vowel: its calibrated
   * opening sings at the default key velocity, wider is louder.
   */
  intensity(f: MouthFeatures, vowel: number): number {
    const P = this.calibration.vowels;
    const x = clamp(vowel) * (P.length - 1);
    const i = Math.min(P.length - 2, Math.floor(x));
    const expected = P[i].gap + (x - i) * (P[i + 1].gap - P[i].gap);
    const level = (f.gap - this.closedGap) / Math.max(0.02, expected - this.closedGap);
    return clamp(0.45 + 0.4 * level, 0.45, 1);
  }
}

/** What the face means for the voice this frame. */
export interface MouthReading {
  /** A face is being tracked. */
  present: boolean;
  /** Mouth open enough to sing (with hysteresis). */
  singing: boolean;
  /** Raw openness (see MouthModel.openness), for the meter. */
  open: number;
  vowel: number;
  intensity: number;
  /** Nose position, 0 = left … 1 = right of the mirrored picture. */
  x: number;
}

export const OPEN_ON = 0.6;
export const OPEN_OFF = 0.3;
const LOST_AFTER = 0.25;
const CLOSE_AFTER = 0.06;

/** Smooths per-frame readings and turns openness into a clean note gate. */
export class MouthFollower {
  model: MouthModel;
  private r: MouthReading = { present: false, singing: false, open: 0, vowel: 0.5, intensity: 0.85, x: 0.5 };
  private missing = 0;
  private closing = 0;
  private shaping = false;

  constructor(model = new MouthModel()) {
    this.model = model;
  }

  get reading(): Readonly<MouthReading> {
    return this.r;
  }

  /** `x` is the nose's horizontal position in the mirrored picture (0..1). */
  update(sample: { features: MouthFeatures; x: number } | null, dt: number): Readonly<MouthReading> {
    const r = this.r;
    if (!sample) {
      this.missing += dt;
      if (this.missing >= LOST_AFTER) {
        r.present = false;
        r.singing = false;
        r.open = 0;
        this.shaping = false;
      }
      return r;
    }
    const first = !r.present;
    this.missing = 0;
    r.present = true;
    const { features: f } = sample;
    const k = (tau: number) => (first ? 1 : 1 - Math.exp(-dt / tau));
    r.open = this.model.openness(f);
    r.x += (sample.x - r.x) * k(0.05);
    // A closed mouth has no vowel: hold the last one, and jump straight to
    // the new shape as the lips part.
    const shaping = r.open >= OPEN_OFF;
    if (shaping) {
      const snap = !this.shaping;
      r.vowel += (this.model.vowel(f) - r.vowel) * (snap ? 1 : k(0.06));
      r.intensity += (this.model.intensity(f, r.vowel) - r.intensity) * (snap ? 1 : k(0.05));
    }
    this.shaping = shaping;
    if (!r.singing) {
      this.closing = 0;
      if (r.open >= OPEN_ON) r.singing = true;
    } else if (r.open < OPEN_OFF) {
      this.closing += dt;
      if (this.closing >= CLOSE_AFTER) r.singing = false;
    } else this.closing = 0;
    return r;
  }

  reset(): void {
    this.r = { ...this.r, present: false, singing: false, open: 0 };
    this.missing = 0;
    this.closing = 0;
    this.shaping = false;
  }
}

const STEP_SECONDS = 1.7;
const SETTLE_SECONDS = 0.7;

/**
 * Guided calibration: holds each shape in CALIBRATION_STEPS for a moment and
 * averages the frames after it has settled.
 */
export class Calibrator {
  private step = 0;
  private t = 0;
  private sum: MouthFeatures = { width: 0, gap: 0, round: 0, spread: 0 };
  private n = 0;
  private readonly shapes: MouthFeatures[] = [];

  get current(): CalibrationStep | null {
    return CALIBRATION_STEPS[this.step] ?? null;
  }

  /** 0..1 progress through the current step. */
  get progress(): number {
    return Math.min(1, this.t / STEP_SECONDS);
  }

  /** Feed a frame; returns the calibration once every step is captured. */
  update(f: MouthFeatures | null, dt: number): MouthCalibration | null {
    if (!this.current) return null;
    if (!f) {
      // Lost the face: start this step over.
      this.t = 0;
      this.n = 0;
      this.sum = { width: 0, gap: 0, round: 0, spread: 0 };
      return null;
    }
    this.t += dt;
    if (this.t >= SETTLE_SECONDS) {
      for (const k of KEYS) this.sum[k] += f[k];
      this.n++;
    }
    if (this.t < STEP_SECONDS || this.n === 0) return null;
    const avg = {} as MouthFeatures;
    for (const k of KEYS) avg[k] = this.sum[k] / this.n;
    this.shapes.push(avg);
    this.step++;
    this.t = 0;
    this.n = 0;
    this.sum = { width: 0, gap: 0, round: 0, spread: 0 };
    if (this.current) return null;
    const [closed, ...vowels] = this.shapes;
    return { closed, vowels };
  }
}
