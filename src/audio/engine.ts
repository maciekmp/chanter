import workletUrl from './voice-processor.ts?worker&url';
import type { VoiceState } from './voice-dsp';

export type VoiceParamName = 'frequency' | 'gate' | 'vowel' | 'voice' | 'glide' | 'intensity';

export interface VoiceReport extends VoiceState {
  /** AudioContext time at which this state was rendered. */
  t: number;
}

const HISTORY = 96;

/**
 * Owns the AudioContext and the fixed signal graph:
 *
 *   voice worklet ─┬─ dry ───────────────────────────┐
 *                  ├─ ping-pong delay (tempo synced) ─ wet ─┤
 *                  └─ reverb send ─┐                        ├─ master ─ limiter ─ out
 *   backing bus ───┴─ reverb send ─┴─ convolver ────────────┘
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly voiceNode: AudioWorkletNode;
  readonly trackBus: GainNode;
  readonly analyser: AnalyserNode;
  private readonly params: Record<VoiceParamName, AudioParam>;
  private readonly master: GainNode;
  private readonly output: AudioNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly delayL: DelayNode;
  private readonly delayR: DelayNode;
  private readonly trackVolume: GainNode;
  private readonly history: VoiceReport[] = [];
  latest: VoiceReport = { t: 0, f0: 220, env: 0, vowel: 0.5, gate: 0, onsets: 0, rms: 0 };
  /** Optional observer of every synth report (diagnostics/tests). */
  onReport: ((r: VoiceReport) => void) | null = null;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.voiceNode = new AudioWorkletNode(ctx, 'chanter-voice', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const p = this.voiceNode.parameters;
    this.params = {
      frequency: p.get('frequency')!,
      gate: p.get('gate')!,
      vowel: p.get('vowel')!,
      voice: p.get('voice')!,
      glide: p.get('glide')!,
      intensity: p.get('intensity')!,
    };
    this.voiceNode.port.onmessage = (e: MessageEvent<VoiceReport>) => {
      this.latest = e.data;
      this.history.push(e.data);
      if (this.history.length > HISTORY) this.history.shift();
      this.onReport?.(e.data);
    };

    // Master chain
    this.master = new GainNode(ctx, { gain: 0.8 });
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -9, knee: 6, ratio: 14, attack: 0.003, release: 0.18 });
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.5 });
    this.master.connect(limiter).connect(ctx.destination);
    limiter.connect(this.analyser);
    this.output = limiter;

    // Voice: dry / echo
    const voiceOut = new GainNode(ctx, { gain: 1 });
    this.voiceNode.connect(voiceOut);
    this.dry = new GainNode(ctx, { gain: 1 });
    this.wet = new GainNode(ctx, { gain: 0 });
    voiceOut.connect(this.dry).connect(this.master);

    this.delayL = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.4 });
    this.delayR = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.4 });
    const feedback = new GainNode(ctx, { gain: 0.45 });
    const fbLow = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3200, Q: 0.5 });
    const fbHigh = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 220, Q: 0.5 });
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    voiceOut.connect(this.delayL);
    this.delayL.connect(this.delayR);
    this.delayR.connect(fbLow).connect(fbHigh).connect(feedback).connect(this.delayL);
    this.delayL.connect(merger, 0, 0);
    this.delayR.connect(merger, 0, 1);
    merger.connect(this.wet).connect(this.master);

    // Shared room reverb
    const reverb = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 2.4) });
    const reverbReturn = new GainNode(ctx, { gain: 0.9 });
    reverb.connect(reverbReturn).connect(this.master);
    voiceOut.connect(new GainNode(ctx, { gain: 0.22 })).connect(reverb);

    // Backing tracks
    this.trackBus = new GainNode(ctx, { gain: 1 });
    this.trackVolume = new GainNode(ctx, { gain: 0.7 });
    this.trackBus.connect(this.trackVolume).connect(this.master);
    this.trackVolume.connect(new GainNode(ctx, { gain: 0.16 })).connect(reverb);
  }

  /** Must be called from a user gesture handler (creates/resumes the context). */
  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const resumed = ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);
    await resumed;
    return new AudioEngine(ctx);
  }

  /** A MediaStream of the final mix (for audio export). Call `disconnect` when done. */
  captureMix(): { stream: MediaStream; disconnect: () => void } {
    const dest = new MediaStreamAudioDestinationNode(this.ctx);
    this.output.connect(dest);
    return { stream: dest.stream, disconnect: () => this.output.disconnect(dest) };
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Context time of the audio currently reaching the listener's ears. */
  heardTime(): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime && ts.performanceTime) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.ctx.baseLatency;
  }

  /** Voice state as heard now (reports are rendered ahead of playback by the output latency). */
  heardState(): VoiceReport {
    const t = this.heardTime();
    const h = this.history;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i];
    return h[0] ?? this.latest;
  }

  setParam(name: VoiceParamName, value: number, time = this.ctx.currentTime): void {
    this.params[name].setValueAtTime(value, time);
  }

  /** Drop scheduled (replayed) automation from `time` on. */
  cancelScheduled(names: VoiceParamName[], time = this.ctx.currentTime): void {
    for (const n of names) {
      const p = this.params[n];
      p.cancelScheduledValues(time);
    }
  }

  setVolume(v: number): void {
    this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.02);
  }

  setTrackVolume(v: number): void {
    this.trackVolume.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.02);
  }

  /** Equal-power wet/dry crossfade for the echo. */
  setEchoMix(m: number): void {
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(Math.cos((m * Math.PI) / 2), t, 0.02);
    this.wet.gain.setTargetAtTime(Math.sin((m * Math.PI) / 2) * 0.9, t, 0.02);
  }

  /** Dotted-eighth echo locked to the backing-track tempo. */
  setEchoTempo(bpm: number): void {
    const d = Math.min(1.5, (0.75 * 60) / bpm);
    const t = this.ctx.currentTime;
    this.delayL.delayTime.setTargetAtTime(d, t, 0.05);
    this.delayR.delayTime.setTargetAtTime(d, t, 0.05);
  }
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      // Darker as it decays: one-pole lowpass whose cutoff falls over time.
      const k = 0.6 * Math.exp(-t * 1.4) + 0.08;
      lp += ((Math.random() * 2 - 1) - lp) * k;
      const pre = Math.min(1, t / 0.012);
      d[i] = lp * Math.exp(-t * 3.1) * pre * 0.6;
    }
  }
  return buf;
}
