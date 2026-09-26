import { midiToFreq } from '../music/notes';
import type { AudioEngine, VoiceParamName } from './engine';
import type { LoopEventType, VoiceSnapshot } from './recorder';

const REPLAYED: VoiceParamName[] = ['frequency', 'gate', 'vowel', 'glide', 'voice', 'intensity'];
const DEFAULT_VELOCITY = 0.85;

/**
 * Turns live input (keys, XY pad or camera, controls) into mono-synth parameter
 * changes. Keys use last-note priority with legato fall-back; while any key
 * is held, the XY pad only steers the vowel.
 */
export class VoiceController {
  engine: AudioEngine | null = null;
  /** Called for every live control change (used by the recorder). */
  onEvent: (type: LoopEventType, value: number) => void = () => {};

  private held: number[] = [];
  private padActive = false;
  private padMidi = 57;

  midi = 57;
  gate = 0;
  vowel = 0.5;
  glide = 0.12;
  voice = 0.2;
  intensity = DEFAULT_VELOCITY;

  get live(): boolean {
    return this.held.length > 0 || this.padActive;
  }

  get heldKeys(): readonly number[] {
    return this.held;
  }

  snapshot(): VoiceSnapshot {
    return { gate: this.gate, midi: this.midi, vowel: this.vowel, glide: this.glide, voice: this.voice, intensity: this.intensity };
  }

  /** Push all current values to the synth (after init or after replay stops). */
  syncAll(): void {
    const e = this.engine;
    if (!e) return;
    e.cancelScheduled(REPLAYED);
    e.setParam('frequency', midiToFreq(this.midi));
    e.setParam('vowel', this.vowel);
    e.setParam('glide', this.glide);
    e.setParam('voice', this.voice);
    e.setParam('intensity', this.intensity);
    e.setParam('gate', this.gate);
  }

  /** `velocity` 0..1 sets the note's loudness (and how wide the monk sings). */
  pressKey(midi: number, velocity = DEFAULT_VELOCITY): void {
    if (this.held.includes(midi)) return;
    this.setIntensity(velocity);
    this.held.push(midi);
    this.apply();
  }

  releaseKey(midi: number): void {
    const i = this.held.indexOf(midi);
    if (i < 0) return;
    this.held.splice(i, 1);
    this.apply();
  }

  releaseAll(): void {
    this.held = [];
    this.padActive = false;
    this.apply();
  }

  /** Pad or camera note. `intensity` defaults to the standard key velocity. */
  padStart(midi: number, vowel: number, intensity = DEFAULT_VELOCITY): void {
    this.padActive = true;
    this.padMidi = midi;
    this.setIntensity(intensity);
    this.setVowel(vowel);
    this.apply();
  }

  padMove(midi: number, vowel: number, intensity?: number): void {
    if (!this.padActive) return;
    this.padMidi = midi;
    if (intensity !== undefined) this.setIntensity(intensity);
    this.setVowel(vowel);
    this.apply();
  }

  padEnd(): void {
    if (!this.padActive) return;
    this.padActive = false;
    this.apply();
  }

  setVowel(v: number): void {
    v = Math.max(0, Math.min(1, v));
    if (v === this.vowel) return;
    this.vowel = v;
    this.engine?.setParam('vowel', v);
    this.onEvent('vowel', v);
  }

  private setIntensity(v: number): void {
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(v - this.intensity) < 1e-3) return;
    this.intensity = v;
    this.engine?.setParam('intensity', v);
    this.onEvent('intensity', v);
  }

  setGlide(seconds: number): void {
    this.glide = seconds;
    this.engine?.setParam('glide', seconds);
    this.onEvent('glide', seconds);
  }

  setVoice(v: number): void {
    this.voice = v;
    this.engine?.setParam('voice', v);
    this.onEvent('voice', v);
  }

  private wasLive = false;

  private apply(): void {
    const live = this.live;
    if (live && !this.wasLive) {
      // Live playing takes over from any replayed loop automation.
      this.syncAll();
    }
    this.wasLive = live;

    const midi = this.held.length ? this.held[this.held.length - 1] : this.padActive ? this.padMidi : this.midi;
    const gate = live ? 1 : 0;
    if (midi !== this.midi) {
      this.midi = midi;
      this.engine?.setParam('frequency', midiToFreq(midi));
      this.onEvent('pitch', midi);
    }
    if (gate !== this.gate) {
      this.gate = gate;
      this.engine?.setParam('gate', gate);
      this.onEvent('gate', gate);
    }
  }
}
