import { midiToFreq } from '../music/notes';

/**
 * Synthesized backing-track instruments. Every call schedules one sound at an
 * absolute AudioContext time; nothing here uses timers, so timing is exactly
 * what the transport computes.
 */
export class Instruments {
  private readonly ctx: AudioContext;
  private readonly noise: AudioBuffer;
  private readonly ksCache = new Map<string, AudioBuffer>();
  private out: GainNode;
  private trim = 1;
  private readonly bus: AudioNode;

  constructor(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.bus = bus;
    this.out = this.newSession();
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private newSession(): GainNode {
    const g = new GainNode(this.ctx, { gain: this.trim });
    g.connect(this.bus);
    return g;
  }

  /** Fade out everything already scheduled (used by stop/pause/track switch). */
  silence(fade = 0.08): void {
    const old = this.out;
    const t = this.ctx.currentTime;
    old.gain.cancelScheduledValues(t);
    old.gain.setValueAtTime(old.gain.value, t);
    old.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => old.disconnect(), (fade + 0.2) * 1000);
    this.out = this.newSession();
  }

  /** Per-track level trim. */
  setTrim(v: number): void {
    this.trim = v;
    this.out.gain.value = v;
  }

  // ---------- helpers ----------

  private env(t: number, peak: number, attack: number, decay: number, dest: AudioNode): GainNode {
    const g = new GainNode(this.ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0, t + attack, decay / 4);
    g.connect(dest);
    return g;
  }

  private osc(type: OscillatorType, freq: number, t: number, stop: number, dest: AudioNode, detune = 0) {
    const o = new OscillatorNode(this.ctx, { type, frequency: freq, detune });
    o.connect(dest);
    o.start(t);
    o.stop(stop);
    return o;
  }

  private noiseSrc(t: number, dur: number, dest: AudioNode) {
    const s = new AudioBufferSourceNode(this.ctx, { buffer: this.noise });
    s.connect(dest);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur);
    return s;
  }

  private filter(type: BiquadFilterType, frequency: number, Q: number, dest: AudioNode) {
    const f = new BiquadFilterNode(this.ctx, { type, frequency, Q });
    f.connect(dest);
    return f;
  }

  // ---------- drums ----------

  kick(t: number, v = 1): void {
    const g = this.env(t, 0.9 * v, 0.002, 0.42, this.out);
    const o = this.osc('sine', 150, t, t + 0.6, g);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.13);
    const c = this.env(t, 0.25 * v, 0.001, 0.012, this.out);
    this.noiseSrc(t, 0.03, this.filter('highpass', 2500, 0.7, c));
  }

  snare(t: number, v = 1): void {
    const n = this.env(t, 0.42 * v, 0.001, 0.2, this.out);
    this.noiseSrc(t, 0.3, this.filter('bandpass', 1900, 0.8, n));
    const b = this.env(t, 0.3 * v, 0.001, 0.09, this.out);
    const o = this.osc('triangle', 200, t, t + 0.15, b);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
  }

  clap(t: number, v = 1): void {
    const f = this.filter('bandpass', 1300, 1.2, this.out);
    for (let i = 0; i < 3; i++) {
      const g = this.env(t + i * 0.011, 0.35 * v, 0.001, i === 2 ? 0.16 : 0.012, f);
      this.noiseSrc(t + i * 0.011, 0.25, g);
    }
  }

  hat(t: number, v = 1, open = false): void {
    const g = this.env(t, 0.16 * v, 0.001, open ? 0.28 : 0.045, this.out);
    this.noiseSrc(t, open ? 0.4 : 0.08, this.filter('highpass', 7200, 0.7, g));
  }

  shaker(t: number, v = 1): void {
    const g = new GainNode(this.ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12 * v, t + 0.018);
    g.gain.setTargetAtTime(0, t + 0.02, 0.025);
    g.connect(this.out);
    this.noiseSrc(t, 0.15, this.filter('bandpass', 5800, 1.4, g));
  }

  /** Tabla-like hand drum. 'na'/'tin' = treble drum, 'ge' = bass drum with rising pitch. */
  tabla(t: number, kind: 'na' | 'tin' | 'ge', v = 1, midi = 62): void {
    if (kind === 'ge') {
      const g = this.env(t, 0.7 * v, 0.003, 0.55, this.out);
      const o = this.osc('sine', 78, t, t + 0.8, g);
      o.frequency.setValueAtTime(74, t);
      o.frequency.linearRampToValueAtTime(96, t + 0.28);
      const s = this.env(t, 0.12 * v, 0.001, 0.02, this.out);
      this.noiseSrc(t, 0.04, this.filter('lowpass', 900, 0.7, s));
      return;
    }
    const f = midiToFreq(midi);
    const partials = kind === 'na' ? [1, 2, 3, 4.02] : [1, 2.01, 3];
    const amps = kind === 'na' ? [0.5, 0.3, 0.2, 0.12] : [0.35, 0.12, 0.06];
    const dec = kind === 'na' ? 0.32 : 0.16;
    partials.forEach((p, i) => {
      const g = this.env(t, amps[i] * v, 0.001, dec / (1 + i * 0.6), this.out);
      this.osc('sine', f * p, t, t + dec * 1.5, g);
    });
    const s = this.env(t, 0.14 * v, 0.001, 0.012, this.out);
    this.noiseSrc(t, 0.03, this.filter('bandpass', 3200, 1.5, s));
  }

  woodblock(t: number, v = 1, freq = 900): void {
    const g = this.env(t, 0.32 * v, 0.001, 0.07, this.out);
    this.osc('sine', freq, t, t + 0.15, g);
    const g2 = this.env(t, 0.12 * v, 0.001, 0.03, this.out);
    this.osc('sine', freq * 2.71, t, t + 0.08, g2);
  }

  click(t: number, accent: boolean): void {
    const g = this.env(t, accent ? 0.5 : 0.32, 0.001, 0.04, this.out);
    this.osc('sine', accent ? 1760 : 1320, t, t + 0.08, g);
  }

  // ---------- tonal ----------

  /** Struck metal bar/bell: inharmonic partials with individual decays. */
  bell(t: number, midi: number, v = 1, decay = 2.5): void {
    const f = midiToFreq(midi);
    const ratios = [1, 2.76, 5.4, 8.93];
    const amps = [0.32, 0.12, 0.05, 0.02];
    ratios.forEach((r, i) => {
      if (f * r > 16000) return;
      const d = decay / (1 + i * 1.6);
      const g = this.env(t, amps[i] * v, 0.002, d, this.out);
      this.osc('sine', f * r, t, t + d * 1.3, g);
    });
  }

  /** Electric-piano style FM keys. */
  keys(t: number, midis: number[], dur: number, v = 1): void {
    const scale = 0.16 / Math.sqrt(midis.length);
    for (const m of midis) {
      const f = midiToFreq(m);
      const amp = new GainNode(this.ctx, { gain: 0 });
      amp.connect(this.out);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(scale * v, t + 0.006);
      amp.gain.setTargetAtTime(scale * v * 0.45, t + 0.006, 0.35);
      amp.gain.setTargetAtTime(0, t + dur, 0.12);
      const car = this.osc('sine', f, t, t + dur + 0.8, amp);
      const modGain = new GainNode(this.ctx, { gain: 0 });
      modGain.gain.setValueAtTime(f * 2.2, t);
      modGain.gain.setTargetAtTime(f * 0.35, t, 0.25);
      this.osc('sine', f, t, t + dur + 0.8, modGain);
      modGain.connect(car.frequency);
      // Tine "ping"
      const tine = this.env(t, 0.03 * v, 0.001, 0.12, amp);
      this.osc('sine', f * 7.1, t, t + 0.3, tine);
    }
  }

  /** Soft, slow pad: detuned saws through a lowpass. */
  pad(t: number, midis: number[], dur: number, v = 1, cutoff = 1100): void {
    const lp = this.filter('lowpass', cutoff, 0.4, this.out);
    const amp = new GainNode(this.ctx, { gain: 0 });
    amp.connect(lp);
    const peak = (0.075 * v) / Math.sqrt(midis.length);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + Math.min(0.9, dur * 0.4));
    amp.gain.setValueAtTime(peak, t + dur);
    amp.gain.linearRampToValueAtTime(0, t + dur + 0.9);
    for (const m of midis) {
      const f = midiToFreq(m);
      this.osc('sawtooth', f, t, t + dur + 1, amp, -7);
      this.osc('sawtooth', f, t, t + dur + 1, amp, 7);
    }
  }

  bass(t: number, midi: number, dur: number, v = 1): void {
    const f = midiToFreq(midi);
    const amp = new GainNode(this.ctx, { gain: 0 });
    amp.connect(this.out);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.42 * v, t + 0.006);
    amp.gain.setTargetAtTime(0.3 * v, t + 0.006, 0.15);
    amp.gain.setTargetAtTime(0, t + dur, 0.04);
    this.osc('sine', f, t, t + dur + 0.3, amp);
    const lp = this.filter('lowpass', 520, 0.8, amp);
    const g = new GainNode(this.ctx, { gain: 0.35 });
    g.connect(lp);
    this.osc('sawtooth', f, t, t + dur + 0.3, g);
  }

  /** Plucked string (Karplus–Strong, pre-rendered and cached per pitch). */
  pluck(t: number, midi: number, v = 1, bright = 0.6, decay = 1.6): void {
    const key = `${midi}:${bright}:${decay}`;
    let buf = this.ksCache.get(key);
    if (!buf) {
      buf = karplusStrong(this.ctx, midiToFreq(midi), decay, bright);
      this.ksCache.set(key, buf);
    }
    const src = new AudioBufferSourceNode(this.ctx, { buffer: buf });
    const g = new GainNode(this.ctx, { gain: 0.5 * v });
    src.connect(g).connect(this.out);
    src.start(t);
  }
}

function karplusStrong(ctx: BaseAudioContext, freq: number, seconds: number, bright: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const y = buf.getChannelData(0);
  const P = sr / freq;
  let N = Math.floor(P - 0.5);
  let frac = P - 0.5 - N;
  if (frac < 0.1) {
    N -= 1;
    frac += 1;
  }
  const C = (1 - frac) / (1 + frac); // allpass for fractional tuning
  // Per-period loss so the note decays ~60 dB over `seconds`.
  const damp = Math.pow(10, -3 / (seconds * freq));
  let apX = 0;
  let apY = 0;
  let lp = 0;
  for (let n = 0; n < len; n++) {
    let x = 0;
    if (n < N + 1) {
      const nz = Math.random() * 2 - 1;
      lp += (nz - lp) * (0.15 + 0.8 * bright);
      x = lp;
    }
    const a = n - N >= 0 ? y[n - N] : 0;
    const b = n - N - 1 >= 0 ? y[n - N - 1] : 0;
    const v = 0.5 * (a + b) * damp;
    const ap = C * v + apX - C * apY;
    apX = v;
    apY = ap;
    y[n] = x + ap;
  }
  // DC-block and fade the tail.
  const fade = Math.floor(sr * 0.05);
  let dcX = 0;
  let dcY = 0;
  for (let n = 0; n < len; n++) {
    const s = y[n];
    dcY = s - dcX + 0.995 * dcY;
    dcX = s;
    y[n] = n > len - fade ? (dcY * (len - n)) / fade : dcY;
  }
  return buf;
}
