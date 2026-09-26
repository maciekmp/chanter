import { freqToMidi } from '../music/notes';

/** Synth state that drives the character (from the audio thread). */
export interface MonkInput {
  env: number;
  f0: number;
  vowel: number;
  gate: number;
  onsets: number;
  rms: number;
}

const NS = 'http://www.w3.org/2000/svg';

// Palette (kept flat so edges stay crisp while animating)
const INK = '#1b2036';
const SKIN = '#e6ad7b';
const SKIN_SHADE = '#cf8f5f';
const SKIN_LINE = '#a9683f';

/** Mouth pose per vowel: half-width, upper/lower opening, corner sharpness, teeth, tongue, max jaw drop. */
interface MouthPose {
  w: number;
  rt: number;
  rb: number;
  s: number;
  teeth: number;
  tongue: number;
  jaw: number;
}
// Order follows the vowel axis: OO, OH, AH, EH, EE
const POSES: MouthPose[] = [
  { w: 10.5, rt: 8, rb: 10, s: 0, teeth: 0, tongue: 0, jaw: 6 },
  { w: 16, rt: 10, rb: 19, s: 0.08, teeth: 0.1, tongue: 0.5, jaw: 11 },
  { w: 24, rt: 8, rb: 28, s: 0.42, teeth: 0.55, tongue: 1, jaw: 17 },
  { w: 28, rt: 6.5, rb: 17, s: 0.68, teeth: 0.85, tongue: 0.6, jaw: 10 },
  { w: 31, rt: 5, rb: 10, s: 0.88, teeth: 1, tongue: 0.15, jaw: 5 },
];

function poseAt(v: number): MouthPose {
  const p = Math.max(0, Math.min(4, v * 4));
  const i = Math.min(3, Math.floor(p));
  const f = p - i;
  const a = POSES[i];
  const b = POSES[i + 1];
  const l = (x: number, y: number) => x + (y - x) * f;
  return {
    w: l(a.w, b.w),
    rt: l(a.rt, b.rt),
    rb: l(a.rb, b.rb),
    s: l(a.s, b.s),
    teeth: l(a.teeth, b.teeth),
    tongue: l(a.tongue, b.tongue),
    jaw: l(a.jaw, b.jaw),
  };
}

const f1 = (n: number) => n.toFixed(1);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Closed mouth-like shape from four cubic segments, blending ellipse → lens corners. */
function mouthPath(cx: number, cy: number, w: number, rt: number, rb: number, s: number): string {
  const k = 0.552;
  const e = (ell: number, lens: number) => ell + (lens - ell) * s;
  const L = `${f1(cx - w)} ${f1(cy)}`;
  return (
    `M${L}` +
    `C${f1(e(cx - w, cx - w * 0.6))} ${f1(e(cy - rt * k, cy - rt * 0.75))} ${f1(cx - w * e(k, 0.35))} ${f1(cy - rt)} ${f1(cx)} ${f1(cy - rt)}` +
    `C${f1(cx + w * e(k, 0.35))} ${f1(cy - rt)} ${f1(e(cx + w, cx + w * 0.6))} ${f1(e(cy - rt * k, cy - rt * 0.75))} ${f1(cx + w)} ${f1(cy)}` +
    `C${f1(e(cx + w, cx + w * 0.6))} ${f1(e(cy + rb * k, cy + rb * 0.75))} ${f1(cx + w * e(k, 0.35))} ${f1(cy + rb)} ${f1(cx)} ${f1(cy + rb)}` +
    `C${f1(cx - w * e(k, 0.35))} ${f1(cy + rb)} ${f1(e(cx - w, cx - w * 0.6))} ${f1(e(cy + rb * k, cy + rb * 0.75))} ${L}Z`
  );
}

/** Face silhouette with a parametric jaw drop, so chin and cheeks never separate. */
function facePath(j: number): string {
  return (
    `M300 62C372 62 420 118 420 196C420 244 413 282 396 314` +
    `C374 ${f1(352 + j * 0.5)} 339 ${f1(368 + j)} 300 ${f1(370 + j)}` +
    `C261 ${f1(368 + j)} 226 ${f1(352 + j * 0.5)} 204 314` +
    `C187 282 180 244 180 196C180 118 228 62 300 62Z`
  );
}

/** Almond eye; c = closure 0 (open) … 1 (closed, a soft downward arc). */
function eyePath(cx: number, cy: number, c: number): { shape: string; upper: string; lower: string } {
  // Closed = upper lid meets the lower lid in a serene downward arc.
  const up = cy - 13 * (1 - c) + 8 * c;
  const lo = cy + 9 - 1 * c;
  const upper = `M${cx - 23} ${cy}C${cx - 11} ${f1(up)} ${cx + 11} ${f1(up)} ${cx + 23} ${cy}`;
  const lower = `M${cx + 23} ${cy}C${cx + 11} ${f1(lo)} ${cx - 11} ${f1(lo)} ${cx - 23} ${cy}`;
  return { shape: upper + lower.replace(/^M[^C]+/, '') + 'Z', upper, lower };
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

interface Ring {
  born: number;
  strength: number;
  sides: SVGGElement[];
}

export class Monk {
  readonly svg: SVGSVGElement;
  reducedMotion = false;

  private body: SVGGElement;
  private chest: SVGGElement;
  private head: SVGGElement;
  private face: SVGPathElement;
  private eyes: Array<{ cx: number; cy: number; white: SVGPathElement; clip: SVGPathElement; upper: SVGPathElement; lower: SVGPathElement; iris: SVGGElement }> = [];
  private brows: SVGGElement;
  private cheeks: SVGGElement;
  private mouthOpen: SVGGElement;
  private mouthShape: SVGPathElement;
  private mouthStroke: SVGPathElement;
  private mouthClip: SVGPathElement;
  private teeth: SVGRectElement;
  private tongue: SVGEllipseElement;
  private lowerLip: SVGPathElement;
  private mouthClosed: SVGGElement;
  private ringsGroup: SVGGElement;
  private rings: Ring[] = [];

  // Smoothed animation state
  private open = 0;
  private sing = 0;
  private pitchN = 0.4;
  private vowel = 0.5;
  private loud = 0;
  private eyesSoft = 0;
  private swayPhase = 0;
  private lastOnsets = -1;
  private nextBlink = 2;
  private blinkStart = -10;
  private gaze = 0;
  /** Exposed for tests/diagnostics. */
  readonly debug = { open: 0, jaw: 0, eyeClosure: 0, headRot: 0, headY: 0, vowel: 0.5, rings: 0, breathe: 0 };

  constructor() {
    const svg = el('svg', {
      // Same coordinate space as the 800×700 backdrop; the rig is drawn in x 0…600.
      viewBox: '-100 0 800 700',
      preserveAspectRatio: 'xMidYMax meet',
      class: 'monk',
      role: 'img',
      'aria-label': 'Singing monk character',
    });
    this.svg = svg;
    const defs = el('defs', {}, svg);
    const eyeClipL = el('clipPath', { id: 'eye-clip-l' }, defs);
    const eyeClipR = el('clipPath', { id: 'eye-clip-r' }, defs);
    const mouthClipEl = el('clipPath', { id: 'mouth-clip' }, defs);
    this.mouthClip = el('path', {}, mouthClipEl);

    this.body = el('g', { class: 'monk-body' }, svg);
    this.chest = el('g', {}, this.body);
    // Robe stretched up from the bottom edge: raises the collar for a shorter neck.
    const robe = el('g', { transform: 'translate(0 700) scale(1 1.07) translate(0 -700)' }, this.chest);

    // --- Robe ---
    el('path', {
      d: 'M300 700H40C44 560 92 470 190 440C222 431 246 425 258 421L300 505L342 421C354 425 378 431 410 440C508 470 556 560 560 700Z',
      fill: '#7b2531',
      stroke: INK,
      'stroke-width': 3,
      'stroke-linejoin': 'round',
    }, robe);
    // Drape folds
    for (const d of [
      'M118 700C128 612 160 540 214 478',
      'M190 700C196 640 214 590 246 548',
      'M476 700C470 626 452 566 424 520',
      'M532 700C526 640 508 590 476 552',
    ]) el('path', { d, fill: 'none', stroke: '#5a1822', 'stroke-width': 7, 'stroke-linecap': 'round', opacity: 0.7 }, robe);
    el('path', { d: 'M92 610C110 540 150 494 206 466', fill: 'none', stroke: '#9a3842', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: 0.55 }, robe);
    // Inner collar (left lapel)
    el('path', { d: 'M258 421L300 505L291 520L244 426Z', fill: '#561721', stroke: INK, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, robe);
    // Neck (behind the collar opening)
    el('path', { d: 'M258 318V440L300 506L342 440V318Z', fill: SKIN_SHADE, stroke: INK, 'stroke-width': 3, 'stroke-linejoin': 'round' }, robe);
    el('path', { d: 'M262 400Q300 432 338 400', fill: 'none', stroke: SKIN_LINE, 'stroke-width': 2, opacity: 0.45 }, robe);
    // Sash
    el('path', {
      d: 'M344 422C378 428 404 436 424 448C372 520 300 606 262 700H148C196 600 276 506 344 422Z',
      fill: '#c8942f',
      stroke: INK,
      'stroke-width': 3,
      'stroke-linejoin': 'round',
    }, robe);
    el('path', { d: 'M372 434C326 500 262 590 222 700', fill: 'none', stroke: '#a8761f', 'stroke-width': 6, opacity: 0.8 }, robe);
    el('path', { d: 'M404 444C352 516 296 600 262 690', fill: 'none', stroke: '#dcb055', 'stroke-width': 4, opacity: 0.7, 'stroke-linecap': 'round' }, robe);

    // --- Head (pivot at the neck) ---
    this.head = el('g', { class: 'monk-head' }, this.body);
    // Ears
    for (const side of [1, -1]) {
      const m = (x: number) => (side === 1 ? x : 600 - x);
      el('path', {
        d: `M${m(186)} 208C${m(160)} 192 ${m(138)} 212 ${m(144)} 246C${m(149)} 276 ${m(166)} 294 ${m(192)} 290Z`,
        fill: SKIN,
        stroke: INK,
        'stroke-width': 3,
        'stroke-linejoin': 'round',
      }, this.head);
      el('path', {
        d: `M${m(178)} 226C${m(160)} 222 ${m(157)} 244 ${m(164)} 258C${m(168)} 268 ${m(176)} 273 ${m(183)} 270`,
        fill: 'none',
        stroke: SKIN_LINE,
        'stroke-width': 2.5,
        'stroke-linecap': 'round',
      }, this.head);
    }
    this.face = el('path', { d: facePath(0), fill: SKIN, stroke: INK, 'stroke-width': 3.5, 'stroke-linejoin': 'round' }, this.head);
    // Skull light and temple shade (static, inside head group)
    el('ellipse', { cx: 262, cy: 118, rx: 54, ry: 30, fill: '#fff4e0', opacity: 0.18, transform: 'rotate(-18 262 118)' }, this.head);
    el('path', { d: 'M404 150C414 180 416 214 410 246', fill: 'none', stroke: SKIN_SHADE, 'stroke-width': 8, 'stroke-linecap': 'round', opacity: 0.5 }, this.head);

    this.cheeks = el('g', {}, this.head);
    el('ellipse', { cx: 238, cy: 292, rx: 24, ry: 14, fill: '#e2735f', opacity: 0.28 }, this.cheeks);
    el('ellipse', { cx: 362, cy: 292, rx: 24, ry: 14, fill: '#e2735f', opacity: 0.28 }, this.cheeks);

    // Eyes
    for (const [cx, clip] of [
      [252, eyeClipL],
      [348, eyeClipR],
    ] as const) {
      const cy = 234;
      const p = eyePath(cx, cy, 0);
      const clipPathEl = el('path', { d: p.shape }, clip);
      const white = el('path', { d: p.shape, fill: '#f6eedc' }, this.head);
      const irisG = el('g', { 'clip-path': `url(#${clip.id})` }, this.head);
      const iris = el('g', {}, irisG);
      el('circle', { cx, cy: cy + 1, r: 9, fill: '#2b1d17' }, iris);
      el('circle', { cx: cx + 3, cy: cy - 2.5, r: 2.4, fill: '#fff6e6' }, iris);
      const lower = el('path', { d: p.lower, fill: 'none', stroke: INK, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: 0.55 }, this.head);
      const upper = el('path', { d: p.upper, fill: 'none', stroke: INK, 'stroke-width': 3.6, 'stroke-linecap': 'round' }, this.head);
      this.eyes.push({ cx, cy, white, clip: clipPathEl, upper, lower, iris });
    }

    // Brows
    this.brows = el('g', {}, this.head);
    el('path', { d: 'M213 204C226 188 256 182 281 192L280 198C256 190 230 194 213 204Z', fill: INK, stroke: INK, 'stroke-width': 2, 'stroke-linejoin': 'round' }, this.brows);
    el('path', { d: 'M387 204C374 188 344 182 319 192L320 198C344 190 370 194 387 204Z', fill: INK, stroke: INK, 'stroke-width': 2, 'stroke-linejoin': 'round' }, this.brows);

    // Nose
    el('path', { d: 'M307 246C313 262 317 276 314 285', fill: 'none', stroke: SKIN_LINE, 'stroke-width': 2.5, 'stroke-linecap': 'round' }, this.head);
    el('path', { d: 'M287 290C293 297 308 297 314 290', fill: 'none', stroke: SKIN_LINE, 'stroke-width': 2.5, 'stroke-linecap': 'round' }, this.head);

    // Mouth: open shape (interior, teeth, tongue) and closed smile, cross-faded.
    this.mouthOpen = el('g', { opacity: 0 }, this.head);
    this.mouthShape = el('path', { d: '', fill: '#5b1a1f' }, this.mouthOpen);
    const inner = el('g', { 'clip-path': 'url(#mouth-clip)' }, this.mouthOpen);
    this.tongue = el('ellipse', { cx: 300, cy: 340, rx: 12, ry: 8, fill: '#c2585c' }, inner);
    this.teeth = el('rect', { x: 270, y: 300, width: 60, height: 0, fill: '#f7f0e2' }, inner);
    this.lowerLip = el('path', { d: '', fill: 'none', stroke: SKIN_LINE, 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: 0.7 }, this.mouthOpen);
    this.mouthStroke = el('path', { d: '', fill: 'none', stroke: INK, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, this.mouthOpen);

    this.mouthClosed = el('g', {}, this.head);
    el('path', { d: 'M281 321Q300 330 319 321', fill: 'none', stroke: INK, 'stroke-width': 2.8, 'stroke-linecap': 'round' }, this.mouthClosed);
    el('path', { d: 'M291 334Q300 337 309 334', fill: 'none', stroke: SKIN_LINE, 'stroke-width': 2.2, 'stroke-linecap': 'round', opacity: 0.8 }, this.mouthClosed);

    // Sound rings (pool of three), drawn beside the jaw
    this.ringsGroup = el('g', { class: 'monk-rings', fill: 'none', 'stroke-linecap': 'round' }, this.head);
    for (let i = 0; i < 3; i++) {
      const sides = [0, 1].map(() => {
        const g = el('g', { opacity: 0 }, this.ringsGroup);
        el('path', { d: '', stroke: INK }, g);
        el('path', { d: '', stroke: '#e2b653' }, g);
        return g;
      });
      this.rings.push({ born: -10, strength: 0, sides });
    }
    this.apply(0);
  }

  /** Advance the rig. `now` in seconds, `dt` frame delta in seconds. */
  update(s: MonkInput, now: number, dt: number): void {
    dt = Math.min(dt, 0.1);
    const k = (tau: number) => 1 - Math.exp(-dt / tau);

    // Envelope → openness (fast), singing weight (slower), loudness from RMS.
    const openTarget = Math.pow(clamp01(s.env * 1.15), 0.75);
    this.open += (openTarget - this.open) * k(0.025);
    this.sing += ((s.env > 0.08 ? 1 : 0) - this.sing) * k(s.env > 0.08 ? 0.12 : 0.45);
    this.loud += (clamp01(s.rms / 0.12) - this.loud) * k(0.05);
    this.vowel += (s.vowel - this.vowel) * k(0.02);
    if (s.env > 0.02 && s.f0 > 0) {
      const target = clamp01((freqToMidi(s.f0) - 40) / 44);
      this.pitchN += (target - this.pitchN) * k(0.08);
    }

    // Eyes: gently closed while sustaining, blinking while idle.
    this.eyesSoft += ((this.sing > 0.6 ? 1 : 0) - this.eyesSoft) * k(this.sing > 0.6 ? 0.35 : 0.12);
    if (now > this.nextBlink && this.sing < 0.3) {
      this.blinkStart = now;
      this.nextBlink = now + 2.2 + Math.random() * 3.8;
    }
    const bp = (now - this.blinkStart) / 0.16;
    const blink = bp >= 0 && bp <= 1 ? Math.sin(Math.PI * bp) : 0;

    // Onset rings
    if (this.lastOnsets < 0) this.lastOnsets = s.onsets;
    if (s.onsets !== this.lastOnsets) {
      this.lastOnsets = s.onsets;
      const r = this.rings.reduce((a, b) => (a.born < b.born ? a : b));
      r.born = now;
      r.strength = 0.5 + 0.5 * clamp01(s.env + 0.3);
    }

    this.swayPhase += dt * (0.9 + this.pitchN * 0.6) * this.sing * 2;
    this.gaze = Math.sin(now * 0.37) * 1.6 * (1 - this.sing);
    this.apply(now, Math.max(this.eyesSoft, blink));
  }

  private apply(now: number, eyeClosure = 0): void {
    const rm = this.reducedMotion;
    const pose = poseAt(this.vowel);
    const o = this.open;
    const jaw = pose.jaw * o * (0.65 + 0.35 * this.loud);
    this.face.setAttribute('d', facePath(jaw));

    // Mouth
    const cx = 300;
    const cy = 324 + jaw * 0.5;
    const w = pose.w * (0.8 + 0.2 * o);
    const rt = Math.max(0.5, pose.rt * o);
    const rb = Math.max(0.5, pose.rb * o + jaw * 0.25);
    const d = mouthPath(cx, cy, w, rt, rb, pose.s);
    this.mouthShape.setAttribute('d', d);
    this.mouthClip.setAttribute('d', d);
    this.mouthStroke.setAttribute('d', d);
    this.teeth.setAttribute('x', f1(cx - w));
    this.teeth.setAttribute('width', f1(w * 2));
    this.teeth.setAttribute('y', f1(cy - rt - 1));
    this.teeth.setAttribute('height', f1(1 + pose.teeth * Math.min(6, rt + rb * 0.35)));
    this.tongue.setAttribute('cy', f1(cy + rb * 0.85));
    this.tongue.setAttribute('rx', f1(w * 0.72));
    this.tongue.setAttribute('ry', f1(rb * 0.55 * pose.tongue + 0.5));
    this.lowerLip.setAttribute('d', `M${f1(cx - w * 0.45)} ${f1(cy + rb + 6)}Q${cx} ${f1(cy + rb + 10)} ${f1(cx + w * 0.45)} ${f1(cy + rb + 6)}`);
    const mo = smoothstep(0.04, 0.16, o);
    this.mouthOpen.setAttribute('opacity', f1(mo));
    this.mouthClosed.setAttribute('opacity', f1(1 - mo));

    // Eyes
    for (const e of this.eyes) {
      const p = eyePath(e.cx, e.cy, eyeClosure);
      e.white.setAttribute('d', p.shape);
      e.clip.setAttribute('d', p.shape);
      e.upper.setAttribute('d', p.upper);
      e.lower.setAttribute('d', p.lower);
      e.iris.setAttribute('transform', `translate(${f1(rm ? 0 : this.gaze)} 0)`);
    }

    // Brows rise with pitch and openness; cheeks lift for EE.
    const browY = -(this.pitchN * 5 + o * 2.5) * this.sing;
    this.brows.setAttribute('transform', `translate(0 ${f1(browY)})`);
    this.cheeks.setAttribute('transform', `translate(0 ${f1(-pose.teeth * o * 3)})`);

    // Head, body, breathing
    const breathe = rm ? 0 : Math.sin(now * ((2 * Math.PI) / 4.6));
    const sway = rm ? 0 : Math.sin(this.swayPhase) * 1.4 * this.sing;
    const headRot = rm ? 0 : (this.pitchN - 0.45) * 7 * this.sing + sway;
    const headY = rm ? 0 : -this.pitchN * 9 * this.sing - breathe * 1.2 * (1 - this.sing);
    this.head.setAttribute('transform', `translate(0 ${f1(headY)}) rotate(${headRot.toFixed(2)} 300 400)`);
    const bodyRot = rm ? 0 : Math.sin(this.swayPhase * 0.5) * 0.8 * this.sing;
    const lift = rm ? 0 : breathe * 1.8 * (1 - this.sing) - 2.5 * this.sing * this.loud;
    this.body.setAttribute('transform', `translate(0 ${f1(lift)}) rotate(${bodyRot.toFixed(2)} 300 700)`);
    const chestScale = 1 + (rm ? 0 : breathe * 0.007 * (1 - this.sing));
    this.chest.setAttribute('transform', `translate(0 ${f1(700 * (1 - chestScale))}) scale(1 ${chestScale.toFixed(4)})`);

    // Rings: small brass arcs with an ink edge (reads on skin, halo and robe),
    // emanating from the mouth corners; fade with age and current loudness.
    let visible = 0;
    for (const r of this.rings) {
      const age = (now - r.born) / 0.9;
      if (rm || age < 0 || age > 1) {
        for (const g of r.sides) g.setAttribute('opacity', '0');
        continue;
      }
      visible++;
      const rad = w + 12 + age * 58;
      const a = (38 * Math.PI) / 180;
      const dx = rad * Math.cos(a);
      const dy = rad * Math.sin(a);
      const alpha = r.strength * Math.pow(1 - age, 1.3) * (0.45 + 0.55 * this.loud);
      const left = `M${f1(cx - dx)} ${f1(cy - dy)}A${f1(rad)} ${f1(rad)} 0 0 0 ${f1(cx - dx)} ${f1(cy + dy)}`;
      const right = `M${f1(cx + dx)} ${f1(cy - dy)}A${f1(rad)} ${f1(rad)} 0 0 1 ${f1(cx + dx)} ${f1(cy + dy)}`;
      const sw = 4.2 - age * 2;
      r.sides.forEach((g, i) => {
        g.setAttribute('opacity', alpha.toFixed(3));
        const [under, over] = g.children as unknown as SVGPathElement[];
        under.setAttribute('d', i ? right : left);
        over.setAttribute('d', i ? right : left);
        under.setAttribute('stroke-width', f1(sw + 2.6));
        over.setAttribute('stroke-width', f1(sw));
      });
    }

    Object.assign(this.debug, {
      open: o,
      jaw,
      eyeClosure,
      headRot,
      headY,
      vowel: this.vowel,
      rings: visible,
      breathe,
    });
  }
}
