// Calibration helper (not a real assertion suite): prints per-voice/per-vowel
// RMS so LEVEL_COMP in voice-dsp.ts can be tuned. Run with MEASURE=1.
import { describe, it } from 'vitest';
import { render, rms, SR } from './dsp-helpers';

declare const process: { env: Record<string, string | undefined> };

describe.skipIf(!process.env.MEASURE)('level calibration', () => {
  it('prints RMS per voice/vowel', () => {
    const voices = [0, 1 / 3, 2 / 3, 1];
    const pitches = [110, 196, 330, 523];
    const rows: string[] = [];
    const table: number[][] = [];
    for (let vi = 0; vi < 4; vi++) {
      const row: number[] = [];
      for (let wi = 0; wi < 5; wi++) {
        let acc = 0;
        for (const f of pitches) {
          const x = render(1.2, { frequency: f, vowel: wi / 4, voice: voices[vi] });
          acc += rms(x, Math.floor(SR * 0.6));
        }
        row.push(acc / pitches.length);
      }
      table.push(row);
      rows.push(row.map((v) => v.toFixed(4)).join('  '));
    }
    const target = 0.12;
    console.log('RMS\n' + rows.join('\n'));
    console.log(
      'suggested LEVEL_COMP (current × target/rms)\n' +
        JSON.stringify(table.map((r) => r.map((v) => +(target / v).toFixed(3)))),
    );
  });
});
