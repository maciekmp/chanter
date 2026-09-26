import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_STEPS,
  Calibrator,
  DEFAULT_CALIBRATION,
  LM,
  MouthFollower,
  MouthModel,
  mouthFeatures,
  OPEN_OFF,
  OPEN_ON,
  validCalibration,
  type Landmark,
  type MouthFeatures,
} from '../src/vision/mouth';

const FRAME = 1 / 30;
const V = DEFAULT_CALIBRATION.vowels;
const CLOSED = DEFAULT_CALIBRATION.closed;

/** Frames of `f` for `seconds`; returns the last reading. */
function feed(fol: MouthFollower, f: MouthFeatures | null, seconds: number, x = 0.5) {
  let r = fol.reading;
  for (let t = 0; t < seconds - 1e-9; t += FRAME) r = fol.update(f && { features: f, x }, FRAME);
  return { ...r };
}

describe('mouthFeatures', () => {
  it('normalises by the eye span and corrects for the frame aspect', () => {
    const lm: Landmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    // 4:3 frame: x is in units of width, y of height.
    lm[LM.eyeOuterR] = { x: 0.4, y: 0.4 };
    lm[LM.eyeOuterL] = { x: 0.6, y: 0.4 }; // span = 0.2 * 4/3
    lm[LM.cornerR] = { x: 0.45, y: 0.7 };
    lm[LM.cornerL] = { x: 0.55, y: 0.7 }; // width = 0.1 * 4/3
    lm[LM.lipTop] = { x: 0.5, y: 0.66 };
    lm[LM.lipBottom] = { x: 0.5, y: 0.74 }; // gap = 0.08 (vertical)
    const f = mouthFeatures(lm, { mouthPucker: 0.3, mouthFunnel: 0.5, mouthSmileLeft: 0.2, mouthSmileRight: 0.4 }, 4 / 3)!;
    expect(f.width).toBeCloseTo(0.5, 5);
    expect(f.gap).toBeCloseTo(0.08 / (0.2 * (4 / 3)), 5);
    expect(f.round).toBeCloseTo(0.5, 5);
    expect(f.spread).toBeCloseTo(0.3, 5);
  });

  it('rejects incomplete meshes', () => {
    expect(mouthFeatures([{ x: 0, y: 0 }], {}, 1)).toBeNull();
  });
});

describe('MouthModel', () => {
  const m = new MouthModel();

  it('maps each calibrated shape to its vowel', () => {
    V.forEach((f, i) => expect(m.vowel(f)).toBeCloseTo(i / 4, 5));
  });

  it('interpolates continuously between neighbouring shapes', () => {
    const mix = (a: MouthFeatures, b: MouthFeatures, t: number): MouthFeatures => ({
      width: a.width + (b.width - a.width) * t,
      gap: a.gap + (b.gap - a.gap) * t,
      round: a.round + (b.round - a.round) * t,
      spread: a.spread + (b.spread - a.spread) * t,
    });
    let prev = -1;
    for (let i = 0; i < 4; i++) {
      for (let t = 0; t <= 1; t += 0.25) {
        const v = m.vowel(mix(V[i], V[i + 1], t));
        expect(v).toBeCloseTo((i + t) / 4, 5);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('reads openness from the lip gap: closed is 0, the least-open vowel is 1', () => {
    expect(m.openness(CLOSED)).toBeLessThan(0.05);
    const least = V.reduce((a, b) => (b.gap < a.gap ? b : a));
    expect(m.openness(least)).toBeCloseTo(1, 5);
    expect(m.openness(V[2])).toBeGreaterThan(OPEN_ON);
  });

  it('sings a vowel at its calibrated opening near the default velocity, louder when wider', () => {
    for (let i = 0; i < 5; i++) expect(m.intensity(V[i], i / 4)).toBeCloseTo(0.85, 5);
    expect(m.intensity({ ...V[2], gap: V[2].gap * 1.5 }, 0.5)).toBeGreaterThan(0.95);
    expect(m.intensity({ ...V[2], gap: V[2].gap * 0.5 }, 0.5)).toBeLessThan(0.7);
  });
});

describe('MouthFollower', () => {
  it('opens the gate with the mouth and closes it with the lips', () => {
    const fol = new MouthFollower();
    expect(feed(fol, CLOSED, 0.3).singing).toBe(false);
    const r = feed(fol, V[2], 0.2);
    expect(r.present).toBe(true);
    expect(r.singing).toBe(true);
    expect(r.vowel).toBeCloseTo(0.5, 2);
    expect(feed(fol, CLOSED, 0.2).singing).toBe(false);
  });

  it('ignores a blip of closed lips shorter than a couple of frames', () => {
    const fol = new MouthFollower();
    feed(fol, V[2], 0.2);
    expect(feed(fol, CLOSED, FRAME).singing).toBe(true);
    expect(feed(fol, V[2], 0.1).singing).toBe(true);
  });

  it('has hysteresis between the on and off thresholds', () => {
    const fol = new MouthFollower();
    const between = { ...V[0], gap: 0 };
    // Find a gap whose openness sits between OPEN_OFF and OPEN_ON.
    const m = fol.model;
    for (let g = 0; g < 0.1; g += 0.001) {
      between.gap = g;
      const o = m.openness(between);
      if (o > OPEN_OFF + 0.05 && o < OPEN_ON - 0.05) break;
    }
    expect(feed(fol, between, 0.3).singing).toBe(false); // not open enough to start
    feed(fol, V[2], 0.1);
    expect(feed(fol, between, 0.3).singing).toBe(true); // not closed enough to stop
  });

  it('jumps to the new vowel as the lips part instead of gliding from the last one', () => {
    const fol = new MouthFollower();
    feed(fol, V[4], 0.3);
    feed(fol, CLOSED, 0.3);
    const r = fol.update({ features: V[0], x: 0.5 }, FRAME);
    expect(r.vowel).toBeCloseTo(0, 5);
  });

  it('holds through a short tracking dropout, and releases when the face is gone', () => {
    const fol = new MouthFollower();
    feed(fol, V[2], 0.2);
    expect(feed(fol, null, 0.1).singing).toBe(true);
    const gone = feed(fol, null, 0.3);
    expect(gone.present).toBe(false);
    expect(gone.singing).toBe(false);
  });

  it('smooths the head position', () => {
    const fol = new MouthFollower();
    feed(fol, V[2], 0.2, 0.2);
    const r = fol.update({ features: V[2], x: 0.8 }, FRAME);
    expect(r.x).toBeGreaterThan(0.2);
    expect(r.x).toBeLessThan(0.8);
    expect(feed(fol, V[2], 0.5, 0.8).x).toBeCloseTo(0.8, 2);
  });
});

describe('Calibrator', () => {
  const shapes = [CLOSED, ...V].map((f) => ({ ...f, width: f.width + 0.01 }));

  it('captures each step and returns a calibration the model reproduces', () => {
    const c = new Calibrator();
    let done = null;
    for (let i = 0; i < CALIBRATION_STEPS.length && !done; i++) {
      expect(c.current).toBe(CALIBRATION_STEPS[i]);
      // The first frames of a step are ignored while the face settles.
      for (let t = 0; t < 0.3; t += FRAME) c.update(CLOSED, FRAME);
      for (let t = 0; t < 2 && !done && c.current === CALIBRATION_STEPS[i]; t += FRAME) done = c.update(shapes[i], FRAME);
    }
    expect(done).not.toBeNull();
    expect(done!.closed.width).toBeCloseTo(shapes[0].width, 5);
    done!.vowels.forEach((v, i) => expect(v.width).toBeCloseTo(shapes[i + 1].width, 5));
    const m = new MouthModel(done!);
    shapes.slice(1).forEach((f, i) => expect(m.vowel(f)).toBeCloseTo(i / 4, 5));
  });

  it('restarts a step when the face is lost', () => {
    const c = new Calibrator();
    for (let t = 0; t < 1.5; t += FRAME) c.update(CLOSED, FRAME);
    expect(c.progress).toBeGreaterThan(0.8);
    c.update(null, FRAME);
    expect(c.progress).toBe(0);
    expect(c.current).toBe('closed');
  });
});

describe('validCalibration', () => {
  it('accepts a stored calibration and rejects malformed ones', () => {
    expect(validCalibration(JSON.parse(JSON.stringify(DEFAULT_CALIBRATION)))).toEqual(DEFAULT_CALIBRATION);
    expect(validCalibration(null)).toBeNull();
    expect(validCalibration({ closed: CLOSED, vowels: V.slice(0, 4) })).toBeNull();
    expect(validCalibration({ closed: { ...CLOSED, gap: 'x' }, vowels: V })).toBeNull();
  });
});
