/// <reference lib="webworker" />
// AudioWorklet processor: runs VoiceDSP on the audio thread and periodically
// reports the real synthesis state (pitch, envelope, vowel, onsets, level) so
// the UI and monk animation can follow what is actually sounding.
import { VoiceDSP } from './voice-dsp';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: unknown): void;

const REPORT_EVERY = 4; // render quanta (~10.7 ms at 48 kHz)

class ChanterVoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'vowel', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'voice', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'glide', defaultValue: 0.12, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'intensity', defaultValue: 0.85, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  private dsp = new VoiceDSP(sampleRate);
  private counter = 0;

  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    const gate = params.gate[0];
    this.dsp.process(ch0, ch0.length, {
      frequency: params.frequency[0],
      gate,
      vowel: params.vowel[0],
      voice: params.voice[0],
      glide: params.glide[0],
      intensity: params.intensity[0],
    });
    for (let c = 1; c < out.length; c++) out[c].set(ch0);

    if (++this.counter >= REPORT_EVERY) {
      this.counter = 0;
      const s = this.dsp.readState(gate);
      this.port.postMessage({ t: currentTime, ...s });
    }
    return true;
  }
}

registerProcessor('chanter-voice', ChanterVoiceProcessor);
