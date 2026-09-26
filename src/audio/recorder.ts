export type LoopEventType = 'gate' | 'pitch' | 'vowel' | 'glide' | 'voice' | 'intensity';

export interface LoopEvent {
  /** Beat offset from the loop start. */
  beat: number;
  type: LoopEventType;
  /** gate: 0/1, pitch: MIDI (fractional), others: 0..1 / seconds. */
  value: number;
}

export interface VoiceSnapshot {
  gate: number;
  midi: number;
  vowel: number;
  glide: number;
  voice: number;
  intensity: number;
}

export interface MelodyLoop {
  events: LoopEvent[];
  lengthBeats: number;
  /** Loop cycles start at originBeat + k·lengthBeats (0 ≤ origin < length). */
  originBeat: number;
}

export type RecorderState = 'idle' | 'armed' | 'recording';

/**
 * Records voice control events against the musical beat grid, so the melody
 * replays in time with the backing track at any tempo.
 */
export class Recorder {
  state: RecorderState = 'idle';
  startBeat = 0;
  lengthBeats = 16;
  private buffer: LoopEvent[] = [];
  private gateOpen = false;

  arm(startBeat: number, lengthBeats: number): void {
    this.state = 'armed';
    this.startBeat = startBeat;
    this.lengthBeats = lengthBeats;
    this.buffer = [];
  }

  cancel(): void {
    this.state = 'idle';
    this.buffer = [];
  }

  /** Begin capturing once the heard beat reaches startBeat. */
  maybeBegin(beat: number, snapshot: VoiceSnapshot): boolean {
    if (this.state !== 'armed' || beat < this.startBeat) return false;
    this.state = 'recording';
    this.buffer = [
      { beat: 0, type: 'glide', value: snapshot.glide },
      { beat: 0, type: 'voice', value: snapshot.voice },
      { beat: 0, type: 'vowel', value: snapshot.vowel },
      { beat: 0, type: 'intensity', value: snapshot.intensity },
      { beat: 0, type: 'pitch', value: snapshot.midi },
      { beat: 0, type: 'gate', value: snapshot.gate },
    ];
    this.gateOpen = snapshot.gate > 0;
    return true;
  }

  capture(beat: number, type: LoopEventType, value: number, snapshot: VoiceSnapshot): void {
    if (this.state === 'armed') {
      // If this event starts the take, the snapshot (taken after the change)
      // already holds it at beat 0 — don't store it twice.
      this.maybeBegin(beat, snapshot);
      return;
    }
    if (this.state !== 'recording') return;
    const rel = beat - this.startBeat;
    if (rel < 0 || rel >= this.lengthBeats) return;
    // Collapse bursts of continuous control events (pointer moves) to ≤ 1 per 1/64 beat.
    const last = this.buffer[this.buffer.length - 1];
    if (last && last.type === type && type !== 'gate' && rel - last.beat < 1 / 64) {
      last.value = value;
    } else {
      this.buffer.push({ beat: rel, type, value });
    }
    if (type === 'gate') this.gateOpen = value > 0;
  }

  /** Returns the finished loop once the heard beat passes the end, else null. */
  maybeFinish(beat: number): MelodyLoop | null {
    if (this.state !== 'recording' || beat < this.startBeat + this.lengthBeats) return null;
    return this.finish();
  }

  finish(): MelodyLoop {
    if (this.gateOpen) {
      this.buffer.push({ beat: this.lengthBeats - 1 / 32, type: 'gate', value: 0 });
    }
    const loop: MelodyLoop = {
      events: this.buffer.slice().sort((a, b) => a.beat - b.beat),
      lengthBeats: this.lengthBeats,
      originBeat: ((this.startBeat % this.lengthBeats) + this.lengthBeats) % this.lengthBeats,
    };
    this.state = 'idle';
    this.buffer = [];
    return loop;
  }
}

/** True when the loop contains at least one sung note. */
export function hasNotes(loop: MelodyLoop | null): boolean {
  return !!loop && loop.events.some((e) => e.type === 'gate' && e.value > 0);
}

/** Loop events whose absolute beat falls in [from, to), across loop cycles. */
export function loopEventsInWindow(
  loop: MelodyLoop,
  from: number,
  to: number,
): Array<{ beat: number; event: LoopEvent }> {
  const out: Array<{ beat: number; event: LoopEvent }> = [];
  const L = loop.lengthBeats;
  const first = Math.floor((from - loop.originBeat) / L);
  const last = Math.floor((to - loop.originBeat) / L);
  for (let k = first; k <= last; k++) {
    const base = loop.originBeat + k * L;
    for (const e of loop.events) {
      const b = base + e.beat;
      if (b >= from && b < to && b >= 0) out.push({ beat: b, event: e });
    }
  }
  return out;
}
