import { describe, expect, it } from 'vitest';
import { VoiceDSP } from '../src/audio/voice-dsp';
import { bandEnergy, peakHarmonic, render, rms, SR } from './dsp-helpers';

const OO = 0;
const AH = 0.5;
const EE = 1;

describe('VoiceDSP', () => {
  it('produces finite, bounded audio across the whole control space', () => {
    for (const voice of [0, 0.5, 1]) {
      for (const f of [65, 220, 880, 1500]) {
        const x = render(0.5, (t) => ({ frequency: f, vowel: (t * 3) % 1, voice }));
        for (const v of x) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(0.95);
        }
      }
    }
  }, 30_000);

  it('is silent with the gate closed and decays after release', () => {
    expect(rms(render(0.3, { gate: 0 }))).toBeLessThan(1e-6);
    const x = render(1.2, (t) => ({ gate: t < 0.5 ? 1 : 0 }));
    const held = rms(x, SR * 0.3, SR * 0.5);
    const tail = rms(x, SR * 1.0, SR * 1.2);
    expect(held).toBeGreaterThan(0.05);
    expect(tail).toBeLessThan(held * 0.01);
  });

  it('moves F2 energy: EE is bright, OO is dark', () => {
    const f0 = 147;
    const ee = render(1, { frequency: f0, vowel: EE });
    const oo = render(1, { frequency: f0, vowel: OO });
    const ratio = (x: Float32Array) => bandEnergy(x, f0, 1500, 2600) / bandEnergy(x, f0, 100, 1000);
    expect(ratio(ee)).toBeGreaterThan(ratio(oo) * 20);
  });

  it('places the first formant peak where the vowel table says', () => {
    const f0 = 110;
    const ah = render(1, { frequency: f0, vowel: AH });
    const ee = render(1, { frequency: f0, vowel: EE });
    const f1Ah = peakHarmonic(ah, f0, 150, 1000);
    const f1Ee = peakHarmonic(ee, f0, 150, 1000);
    expect(f1Ah).toBeGreaterThan(500); // baritone AH F1 ≈ 630 Hz
    expect(f1Ee).toBeLessThan(400); // baritone EE F1 ≈ 280 Hz
    const f2Ee = peakHarmonic(ee, f0, 1200, 2400);
    expect(f2Ee).toBeGreaterThan(1700); // EE F2 ≈ 1950 Hz
  });

  it('interpolates formants continuously (no jumps) during a vowel sweep', () => {
    const dsp = new VoiceDSP(SR);
    const block = new Float32Array(128);
    const p = { frequency: 180, gate: 1, voice: 0.3, glide: 0.05, intensity: 1 };
    for (let i = 0; i < 100; i++) dsp.process(block, 128, { ...p, vowel: 0 }); // settle on OO
    let prev = -1;
    let maxStep = 0;
    for (let i = 0; i < 400; i++) {
      dsp.process(block, 128, { frequency: 180, gate: 1, vowel: i / 400, voice: 0.3, glide: 0.05, intensity: 1 });
      const f2 = dsp.formants()[1];
      if (prev > 0) maxStep = Math.max(maxStep, Math.abs(f2 - prev));
      prev = f2;
    }
    expect(maxStep).toBeLessThan(40); // Hz per 2.7 ms block
  });

  it('raises formants for the soprano voice', () => {
    const bari = new VoiceDSP(SR);
    const sop = new VoiceDSP(SR);
    const b = new Float32Array(128);
    for (let i = 0; i < 200; i++) {
      bari.process(b, 128, { frequency: 262, gate: 1, vowel: AH, voice: 0, glide: 0, intensity: 1 });
      sop.process(b, 128, { frequency: 262, gate: 1, vowel: AH, voice: 1, glide: 0, intensity: 1 });
    }
    expect(sop.formants()[0]).toBeGreaterThan(bari.formants()[0] * 1.15);
    expect(sop.formants()[2]).toBeGreaterThan(bari.formants()[2] * 1.1);
  });

  it('glide time controls portamento speed', () => {
    const arrival = (glide: number) => {
      const dsp = new VoiceDSP(SR);
      const b = new Float32Array(128);
      const base = { gate: 1, vowel: AH, voice: 0, intensity: 1, glide };
      for (let i = 0; i < 100; i++) dsp.process(b, 128, { ...base, frequency: 220 });
      for (let i = 0; i < 1000; i++) {
        dsp.process(b, 128, { ...base, frequency: 440 });
        const st = dsp.readState(1);
        if (st.f0 > 440 * 0.97) return ((i + 1) * 128) / SR;
      }
      return Infinity;
    };
    const fast = arrival(0);
    const slow = arrival(0.5);
    expect(fast).toBeLessThan(0.05);
    expect(slow).toBeGreaterThan(0.25);
    expect(slow).toBeLessThan(0.8);
  });

  it('reports onsets and envelope for animation', () => {
    const dsp = new VoiceDSP(SR);
    const b = new Float32Array(128);
    const p = { frequency: 200, vowel: AH, voice: 0, glide: 0, intensity: 1 };
    dsp.process(b, 128, { ...p, gate: 1 });
    for (let i = 0; i < 60; i++) dsp.process(b, 128, { ...p, gate: 1 });
    const on = dsp.readState(1);
    expect(on.onsets).toBe(1);
    expect(on.env).toBeGreaterThan(0.8);
    expect(on.rms).toBeGreaterThan(0.02);
    for (let i = 0; i < 400; i++) dsp.process(b, 128, { ...p, gate: 0 });
    const off = dsp.readState(0);
    expect(off.env).toBeLessThan(0.01);
    dsp.process(b, 128, { ...p, gate: 1 });
    expect(dsp.readState(1).onsets).toBe(2);
  });
});
