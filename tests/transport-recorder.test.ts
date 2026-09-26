import { describe, expect, it } from 'vitest';
import { Transport, type ScheduleWindow, type Ticker } from '../src/audio/transport';
import { loopEventsInWindow, Recorder, type VoiceSnapshot } from '../src/audio/recorder';

function fakeTransport() {
  let now = 0;
  const ticker: Ticker = { start() {}, stop() {} };
  const t = new Transport(() => now, ticker);
  const windows: ScheduleWindow[] = [];
  t.onWindow = (w) => windows.push(w);
  return { t, windows, advance: (dt: number) => ((now += dt), t.tick()), now: () => now };
}

describe('Transport', () => {
  it('counts in one bar, then maps beats to time at the tempo', () => {
    const { t } = fakeTransport();
    t.bpm = 120;
    t.play();
    expect(t.beatAt(0.06)).toBeCloseTo(-4);
    expect(t.timeAt(0)).toBeCloseTo(0.06 + 2); // 4 beats at 120 bpm
    expect(t.timeAt(4) - t.timeAt(0)).toBeCloseTo(2);
  });

  it('schedules contiguous, non-overlapping windows', () => {
    const { t, windows, advance } = fakeTransport();
    t.play();
    for (let i = 0; i < 200; i++) advance(0.025 + (i % 3) * 0.004);
    for (let i = 1; i < windows.length; i++) expect(windows[i].from).toBe(windows[i - 1].to);
  });

  it('keeps time continuous across tempo changes', () => {
    const { t, windows, advance } = fakeTransport();
    t.bpm = 90;
    t.play();
    for (let i = 0; i < 40; i++) advance(0.025);
    const w = windows[windows.length - 1];
    const tAtHorizon = w.timeAt(w.to);
    t.setBpm(140);
    expect(t.timeAt(w.to)).toBeCloseTo(tAtHorizon, 9);
    advance(0.025);
    const next = windows[windows.length - 1];
    expect(next.from).toBe(w.to);
    // After the change, one beat lasts 60/140 s.
    expect(next.timeAt(next.from + 1) - next.timeAt(next.from)).toBeCloseTo(60 / 140);
  });

  it('keeps past beat positions stable when the tempo changes (no heard-beat jump)', () => {
    const { t, advance, now } = fakeTransport();
    t.bpm = 84;
    t.play();
    for (let i = 0; i < 80; i++) advance(0.025);
    const heard = now() - 0.05; // audio currently reaching the ears
    const before = t.beatAt(heard);
    t.setBpm(160);
    expect(t.beatAt(heard)).toBeCloseTo(before, 9);
    // Beat ↔ time stays invertible across segments
    for (const b of [before, t.horizonBeat + 3]) expect(t.beatAt(t.timeAt(b))).toBeCloseTo(b, 9);
  });

  it('resumes from the start of the paused bar', () => {
    const { t, advance } = fakeTransport();
    t.countIn = false;
    t.bpm = 120;
    t.play();
    advance(2.9); // ≈ beat 5.7
    t.pause();
    t.play();
    expect(t.playStartBeat).toBe(4);
  });
});

describe('Recorder', () => {
  const snap = (over: Partial<VoiceSnapshot> = {}): VoiceSnapshot => ({
    gate: 0,
    midi: 57,
    vowel: 0.5,
    glide: 0.1,
    voice: 0.2,
    intensity: 0.85,
    ...over,
  });

  it('records events relative to the loop start and closes hanging notes', () => {
    const r = new Recorder();
    r.arm(4, 8);
    r.capture(3.5, 'gate', 1, snap({ gate: 1 })); // before start: ignored
    expect(r.state).toBe('armed');
    r.maybeBegin(4, snap({ gate: 1, midi: 60 }));
    r.capture(5, 'pitch', 62, snap());
    r.capture(6.25, 'vowel', 1, snap());
    expect(r.maybeFinish(11.9)).toBeNull();
    const loop = r.maybeFinish(12)!;
    expect(loop.lengthBeats).toBe(8);
    expect(loop.originBeat).toBe(4);
    const gates = loop.events.filter((e) => e.type === 'gate');
    expect(gates[0]).toMatchObject({ beat: 0, value: 1 });
    expect(gates[gates.length - 1].value).toBe(0);
    expect(gates[gates.length - 1].beat).toBeLessThan(8);
    expect(loop.events.find((e) => e.type === 'pitch' && e.value === 62)?.beat).toBe(1);
    expect(loop.events.find((e) => e.type === 'vowel' && e.value === 1)?.beat).toBe(2.25);
  });

  it('does not duplicate the note that starts the take', () => {
    const r = new Recorder();
    r.arm(4, 4);
    r.capture(4.01, 'gate', 1, snap({ gate: 1 }));
    r.capture(4.5, 'gate', 0, snap());
    const loop = r.finish();
    expect(loop.events.filter((e) => e.type === 'gate' && e.value > 0)).toHaveLength(1);
  });

  it('thins continuous control bursts but keeps gates', () => {
    const r = new Recorder();
    r.arm(0, 4);
    r.maybeBegin(0, snap());
    for (let i = 0; i < 100; i++) r.capture(1 + i * 0.001, 'vowel', i / 100, snap());
    r.capture(1.2, 'gate', 1, snap());
    r.capture(1.2005, 'gate', 0, snap());
    const loop = r.finish();
    const vowels = loop.events.filter((e) => e.type === 'vowel' && e.beat > 0);
    expect(vowels.length).toBeLessThan(10);
    expect(vowels[vowels.length - 1].value).toBeCloseTo(0.99);
    expect(loop.events.filter((e) => e.type === 'gate' && e.beat > 0)).toHaveLength(2);
  });

  it('replays events in every loop cycle, exactly once per window partition', () => {
    const loop = {
      lengthBeats: 4,
      originBeat: 0,
      events: [
        { beat: 0, type: 'gate' as const, value: 1 },
        { beat: 1.5, type: 'pitch' as const, value: 64 },
        { beat: 3, type: 'gate' as const, value: 0 },
      ],
    };
    const edges = [-4, -1.3, 0, 0.77, 1.5, 3.99, 4, 7.2, 9.1, 12];
    const seen: number[] = [];
    for (let i = 1; i < edges.length; i++) {
      for (const e of loopEventsInWindow(loop, edges[i - 1], edges[i])) seen.push(e.beat);
    }
    expect(seen).toEqual([0, 1.5, 3, 4, 5.5, 7, 8, 9.5, 11]);
  });
});
