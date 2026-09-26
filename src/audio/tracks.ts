import type { Instruments } from './instruments';

export interface Step {
  /** 16th-note index within the loop (0 … bars*16-1). */
  s: number;
  /** Bar index within the loop. */
  bar: number;
  /** 16th index within the bar (0–15). */
  i: number;
  /** Context time of this (swung) step. */
  time: number;
  /** Seconds per beat at the current tempo. */
  spb: number;
}

export interface Track {
  id: string;
  name: string;
  mood: string;
  key: string;
  bpm: number;
  /** Delay of odd 16ths as a fraction of a 16th (0 = straight). */
  swing: number;
  bars: number;
  trim: number;
  play(st: Step, I: Instruments): void;
}

/** Velocity from a pattern char: x = accent, o = normal, - = ghost. */
function hit(pattern: string, i: number): number {
  const c = pattern[i % pattern.length];
  return c === 'x' ? 1 : c === 'o' ? 0.7 : c === '-' ? 0.38 : 0;
}

const R = null;

export const TRACKS: Track[] = [
  {
    id: 'mountain-air',
    name: 'Mountain Air',
    mood: 'Warm lo-fi sway',
    key: 'A minor',
    bpm: 84,
    swing: 0.28,
    bars: 4,
    trim: 0.5,
    play({ bar, i, time, spb }, I) {
      const chords = [
        { bass: 45, notes: [55, 59, 60, 64] }, // Am9
        { bass: 41, notes: [55, 57, 60, 64] }, // Fmaj9
        { bass: 48, notes: [55, 59, 62, 64] }, // Cmaj9
        { bass: 43, notes: [57, 59, 62, 64] }, // G6/9
      ][bar];
      let v: number;
      if ((v = hit('x......o..o.....', i))) I.kick(time, v * 0.85);
      if ((v = hit('....o.......o..-', i))) I.snare(time, v * 0.7);
      if ((v = hit('o-o-o-o-o-o-o-oo', i))) I.hat(time, v * 0.55);
      if (i === 0) I.keys(time, chords.notes, spb * 1.6, 0.9);
      if (i === 6) I.keys(time, chords.notes.slice(1), spb * 0.9, 0.55);
      if (i === 0) I.bass(time, chords.bass, spb * 1.4);
      if (i === 7) I.bass(time, chords.bass + 7, spb * 0.4, 0.7);
      if (i === 10) I.bass(time, chords.bass + 12, spb * 0.9, 0.75);
      if (i === 0) I.pad(time, chords.notes.map((n) => n - 12).slice(1), spb * 4, 0.5, 800);
    },
  },
  {
    id: 'temple-groove',
    name: 'Temple Groove',
    mood: 'Head-nod boom-bap',
    key: 'D dorian',
    bpm: 92,
    swing: 0.22,
    bars: 4,
    trim: 0.41,
    play({ bar, i, time, spb }, I) {
      const B = [
        { root: 38, keys: [53, 57, 60, 64], riff: [0, R, R, 0, R, R, 7, R, 10, R, 12, R, R, R, 7, R] }, // Dm9
        { root: 43, keys: [53, 59, 64], riff: [0, R, R, 0, R, R, 7, R, 10, R, 12, R, R, R, 7, R] }, // G13
        { root: 38, keys: [53, 57, 60, 64], riff: [0, R, R, 0, R, R, 7, R, 10, R, 12, R, 10, R, 7, R] },
        { root: 36, keys: [52, 55, 59, 62], riff: [0, R, R, 0, R, R, 7, R, 11, R, 12, R, R, R, 11, R] }, // Cmaj7
      ][bar];
      let v: number;
      const kick = bar % 2 === 0 ? 'x.....x.x.......' : 'x.x...x...x..o..';
      if ((v = hit(kick, i))) I.kick(time, v);
      if ((v = hit('....x.......x...', i))) I.snare(time, v * 0.85);
      if ((v = hit('o.o.o-o.o.o.o-oo', i))) I.hat(time, v * 0.6, i === 14 && bar === 3);
      const r = B.riff[i];
      if (r !== null) I.bass(time, B.root + r, spb * 0.45, r === 0 ? 1 : 0.8);
      if (i === 0 || i === 7) I.keys(time, B.keys, spb * (i === 0 ? 0.9 : 0.5), i === 0 ? 0.8 : 0.55);
      if (i === 3 && bar % 2 === 1) I.bell(time, [74, 76, 72, 74][bar], 0.4, 1.4);
      if (i === 11) I.bell(time, [69, 71, 69, 67][bar], 0.32, 1.2);
    },
  },
  {
    id: 'silk-road',
    name: 'Silk Road',
    mood: 'Driving strings & hand drums',
    key: 'E phrygian',
    bpm: 104,
    swing: 0.08,
    bars: 4,
    trim: 0.58,
    play({ bar, i, time, spb }, I) {
      const phraseA = [64, R, 65, 64, R, 62, 64, R, 67, R, 65, 64, R, 62, 60, 62];
      const phraseB = [64, R, 65, 64, R, 62, 64, R, 69, 67, 65, 64, 62, R, 64, R];
      const phrase = bar % 2 === 0 ? phraseA : phraseB;
      const n = phrase[i];
      if (n !== null) I.pluck(time, n, i % 4 === 0 ? 0.9 : 0.65, 0.7, 1.1);
      // Tanpura-like drone: Pa Sa Sa Sa
      if (i % 4 === 0) I.pluck(time, [47, 52, 52, 40][i / 4], 0.55, 0.35, 3);
      if (i === 0) I.bass(time, bar === 2 ? 41 : 40, spb * 1.8, 0.7);
      let v: number;
      if ((v = hit('x.....x...x.....', i))) I.tabla(time, 'ge', v);
      if ((v = hit('....x..-....x..-', i))) I.tabla(time, 'na', v * 0.9, 64);
      if ((v = hit('..o.....o.....o.', i))) I.tabla(time, 'tin', v, 71);
      if ((v = hit('-.-.-.-.-.-.-.-.', i))) I.shaker(time, v);
    },
  },
  {
    id: 'dawn-bells',
    name: 'Dawn Bells',
    mood: 'Slow, luminous & open',
    key: 'C major',
    bpm: 70,
    swing: 0,
    bars: 4,
    trim: 0.7,
    play({ bar, i, time, spb }, I) {
      const C = [
        { bass: 36, pad: [52, 55, 59, 62], bells: [79, R, R, R, 76, R, 74, R, 72, R, R, R, 74, R, 76, R] },
        { bass: 45, pad: [48, 52, 55, 60], bells: [81, R, R, R, 76, R, 72, R, 69, R, R, R, 72, R, 76, R] },
        { bass: 41, pad: [53, 57, 60, 64], bells: [77, R, R, R, 76, R, 72, R, 69, R, R, R, 72, R, 74, R] },
        { bass: 43, pad: [50, 55, 59, 64], bells: [79, R, R, R, 74, R, 71, R, 67, R, 71, R, 74, R, R, R] },
      ][bar];
      if (i === 0) I.pad(time, C.pad, spb * 4, 0.9, 1400);
      if (i === 0) I.bass(time, C.bass, spb * 3.7, 0.55);
      const b = C.bells[i];
      if (b !== null) I.bell(time, b, i === 0 ? 0.7 : 0.45, 2.6);
      let v: number;
      if ((v = hit('o.-.o.-.o.-.o.-.', i))) I.shaker(time, v * 0.7);
      if (i === 0) I.kick(time, 0.45);
      if (i === 8 && bar % 2 === 1) I.kick(time, 0.3);
    },
  },
  {
    id: 'river-pulse',
    name: 'River Pulse',
    mood: 'Flowing four-on-the-floor',
    key: 'A minor',
    bpm: 118,
    swing: 0,
    bars: 4,
    trim: 0.44,
    play({ bar, i, time, spb }, I) {
      const C = [
        { root: 45, arp: [57, 60, 64, 69] }, // Am
        { root: 41, arp: [57, 60, 65, 69] }, // F
        { root: 48, arp: [55, 60, 64, 67] }, // C
        { root: 43, arp: [55, 59, 62, 67] }, // G
      ][bar];
      let v: number;
      if (i % 4 === 0) I.kick(time, 0.95);
      if ((v = hit('....x.......x...', i))) I.clap(time, v * 0.8);
      if ((v = hit('..x...x...x...x.', i))) I.hat(time, v * 0.75, true);
      if ((v = hit('-.-.-.-.-.-.-.-.', i))) I.hat(time, v * 0.8);
      if (i % 4 === 2) I.bass(time, C.root + (i === 10 ? 12 : 0), spb * 0.4, 0.9);
      const order = [0, 1, 2, 1, 3, 2, 1, 2];
      I.pluck(time, C.arp[order[i % 8]], i % 4 === 0 ? 0.55 : 0.38, 0.8, 0.8);
      if (i === 0) I.pad(time, C.arp.slice(0, 3).map((n) => n - 12), spb * 4, 0.55, 900);
    },
  },
  {
    id: 'stone-garden',
    name: 'Stone Garden',
    mood: 'Sparse, spacious drone',
    key: 'D dorian',
    bpm: 66,
    swing: 0.1,
    bars: 4,
    trim: 1.35,
    play({ bar, i, time, spb }, I) {
      if (i === 0 && bar % 2 === 0) I.pad(time, [38, 45, 50, 57], spb * 8, 0.8, 700);
      if (i === 0) I.pluck(time, bar % 2 ? 45 : 38, 0.5, 0.3, 3.5);
      if (i === 0 || i === 10) I.woodblock(time, i === 0 ? 0.8 : 0.5, i === 0 ? 820 : 1020);
      if (i === 6 && bar === 3) I.woodblock(time, 0.4, 1020);
      if (i === 0) I.tabla(time, 'ge', 0.55);
      if (i === 6) I.tabla(time, 'ge', 0.35);
      const bells: Record<string, number> = { '0:0': 74, '1:8': 69, '2:4': 76, '3:12': 72, '3:14': 74 };
      const b = bells[`${bar}:${i}`];
      if (b) I.bell(time, b, 0.55, 3.2);
    },
  },
];
