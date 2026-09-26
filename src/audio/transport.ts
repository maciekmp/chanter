export type TransportState = 'stopped' | 'playing' | 'paused';

export interface ScheduleWindow {
  /** Half-open beat range [from, to) to schedule. Beats < 0 are count-in. */
  from: number;
  to: number;
  timeAt(beat: number): number;
}

export interface Ticker {
  start(cb: () => void): void;
  stop(): void;
}

/** Interval ticker running in a Worker so it is not throttled in background tabs. */
export function workerTicker(ms = 25): Ticker {
  let worker: Worker | null = null;
  let fallback: ReturnType<typeof setInterval> | null = null;
  return {
    start(cb) {
      this.stop();
      try {
        const src = `let id;onmessage=e=>{clearInterval(id);if(e.data)id=setInterval(()=>postMessage(0),${ms})}`;
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = cb;
        worker.postMessage(1);
      } catch {
        fallback = setInterval(cb, ms);
      }
    },
    stop() {
      worker?.terminate();
      worker = null;
      if (fallback) clearInterval(fallback);
      fallback = null;
    },
  };
}

/**
 * Musical clock. Beat position is a piecewise-linear function of AudioContext
 * time; tempo changes re-anchor at the scheduling horizon so already-scheduled
 * audio and new audio stay continuous.
 */
export class Transport {
  bpm = 84;
  state: TransportState = 'stopped';
  countInBeats = 4;
  countIn = true;
  lookahead = 0.12;
  onWindow: (w: ScheduleWindow) => void = () => {};
  onStateChange: (s: TransportState) => void = () => {};

  /** Tempo segments, oldest first; each maps beats linearly from its anchor. */
  private segments: Array<{ time: number; beat: number; bpm: number }> = [{ time: 0, beat: 0, bpm: 84 }];
  private horizon = 0;
  private resumeBeat = 0;
  /** Beat at which the music (not the count-in) starts for this run. */
  playStartBeat = 0;

  private readonly clock: () => number;
  private readonly ticker: Ticker;

  constructor(clock: () => number, ticker: Ticker) {
    this.clock = clock;
    this.ticker = ticker;
  }

  get running(): boolean {
    return this.state === 'playing';
  }

  private segmentForTime(time: number) {
    const s = this.segments;
    for (let i = s.length - 1; i > 0; i--) if (time >= s[i].time) return s[i];
    return s[0];
  }

  private segmentForBeat(beat: number) {
    const s = this.segments;
    for (let i = s.length - 1; i > 0; i--) if (beat >= s[i].beat) return s[i];
    return s[0];
  }

  /** Beat position at a context time (uses the tempo that was active then). */
  beatAt(time: number): number {
    const g = this.segmentForTime(time);
    return g.beat + ((time - g.time) * g.bpm) / 60;
  }

  timeAt(beat: number): number {
    const g = this.segmentForBeat(beat);
    return g.time + ((beat - g.beat) * 60) / g.bpm;
  }

  /** Beat up to which audio has already been scheduled. */
  get horizonBeat(): number {
    return this.horizon;
  }

  get secondsPerBeat(): number {
    return 60 / this.bpm;
  }

  /** Start (or resume from pause) with an optional count-in. */
  play(): void {
    if (this.state === 'playing') return;
    const from = this.state === 'paused' ? this.resumeBeat : 0;
    const startBeat = this.countIn ? from - this.countInBeats : from;
    this.segments = [{ time: this.clock() + 0.06, beat: startBeat, bpm: this.bpm }];
    this.horizon = startBeat;
    this.playStartBeat = from;
    this.state = 'playing';
    this.onStateChange(this.state);
    this.ticker.start(() => this.tick());
    this.tick();
  }

  /** Pause; resuming restarts from the beginning of the current bar. */
  pause(): void {
    if (this.state !== 'playing') return;
    const b = Math.max(0, this.beatAt(this.clock()));
    this.resumeBeat = Math.floor(b / 4) * 4;
    this.ticker.stop();
    this.state = 'paused';
    this.onStateChange(this.state);
  }

  stop(): void {
    this.ticker.stop();
    this.resumeBeat = 0;
    this.state = 'stopped';
    this.onStateChange(this.state);
  }

  /** Tempo changes take effect at the scheduling horizon, so nothing already scheduled moves. */
  setBpm(bpm: number): void {
    if (this.state === 'playing') {
      const beat = this.horizon;
      const seg = { time: this.timeAt(beat), beat, bpm };
      const last = this.segments[this.segments.length - 1];
      if (last.beat === beat) this.segments[this.segments.length - 1] = seg;
      else this.segments.push(seg);
      if (this.segments.length > 32) this.segments.shift();
    } else {
      this.segments = [{ ...this.segments[this.segments.length - 1], bpm }];
    }
    this.bpm = bpm;
  }

  /** Schedule everything up to now + lookahead. Public for tests. */
  tick(): void {
    if (this.state !== 'playing') return;
    const to = this.beatAt(this.clock() + this.lookahead);
    if (to <= this.horizon) return;
    const from = this.horizon;
    this.horizon = to;
    this.onWindow({ from, to, timeAt: (b) => this.timeAt(b) });
  }
}
