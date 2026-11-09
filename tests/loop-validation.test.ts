import { describe, expect, it } from 'vitest';
import { validLoop } from '../src/app';

const loopWith = (type: unknown, value = 1) => ({
  lengthBeats: 8,
  originBeat: 0,
  events: [{ beat: 0, type, value }],
});

describe('imported melody validation', () => {
  it.each(['toString', 'constructor', '__proto__', ['gate'], null])('rejects an unsupported event type %j', (type) => {
    expect(validLoop(loopWith(type))).toBeNull();
  });

  it.each(['vowel', 'voice', 'intensity'])('rejects out-of-range %s values', (type) => {
    expect(validLoop(loopWith(type, 1.5))).toBeNull();
    expect(validLoop(loopWith(type, -0.1))).toBeNull();
  });

  it('accepts the full glide range but only binary gate values', () => {
    expect(validLoop(loopWith('glide', 2))).not.toBeNull();
    expect(validLoop(loopWith('gate', 0))).not.toBeNull();
    expect(validLoop(loopWith('gate', 1))).not.toBeNull();
    expect(validLoop(loopWith('gate', 0.5))).toBeNull();
  });

  it('rejects invalid timing and non-finite values', () => {
    expect(validLoop({ ...loopWith('pitch', 57), lengthBeats: 0 })).toBeNull();
    expect(validLoop({ ...loopWith('pitch', 57), originBeat: 8 })).toBeNull();
    expect(validLoop(loopWith('pitch', NaN))).toBeNull();
    expect(validLoop({ ...loopWith('pitch', 57), events: [{ beat: 8, type: 'gate', value: 1 }] })).toBeNull();
  });

  it('sorts valid events without mutating the imported object', () => {
    const input = { lengthBeats: 8, originBeat: 0, events: [
      { beat: 2, type: 'gate', value: 0 },
      { beat: 0, type: 'gate', value: 1 },
    ] };
    expect(validLoop(input)?.events.map((e) => e.beat)).toEqual([0, 2]);
    expect(input.events.map((e) => e.beat)).toEqual([2, 0]);
  });
});
