import { AudioEngine, type VoiceParamName } from './audio/engine';
import { Instruments } from './audio/instruments';
import { hasNotes, loopEventsInWindow, Recorder, type LoopEventType, type MelodyLoop } from './audio/recorder';
import { TRACKS, type Track } from './audio/tracks';
import { Transport, workerTicker, type ScheduleWindow } from './audio/transport';
import { VoiceController } from './audio/voice-controller';
import { freqToMidi, midiToFreq, noteName, vowelName } from './music/notes';
import { createBackdrop } from './ui/backdrop';
import { CameraView } from './ui/camera-view';
import { Knob } from './ui/knob';
import { Monk } from './ui/monk';
import { Piano } from './ui/piano';
import { XYPad, type SnapMode } from './ui/xypad';
import { FaceTracker } from './vision/face-tracker';
import {
  CALIBRATION_STEPS,
  Calibrator,
  DEFAULT_CALIBRATION,
  LM,
  MouthFollower,
  MouthModel,
  mouthFeatures,
  OPEN_OFF,
  validCalibration,
  type CalibrationStep,
} from './vision/mouth';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Physical key → semitone offset from the keyboard base C (layout independent). */
const KEY_MAP: Record<string, [number, string]> = {
  KeyA: [0, 'A'], KeyW: [1, 'W'], KeyS: [2, 'S'], KeyE: [3, 'E'], KeyD: [4, 'D'], KeyF: [5, 'F'],
  KeyT: [6, 'T'], KeyG: [7, 'G'], KeyY: [8, 'Y'], KeyH: [9, 'H'], KeyU: [10, 'U'], KeyJ: [11, 'J'],
  KeyK: [12, 'K'], KeyO: [13, 'O'], KeyL: [14, 'L'], KeyP: [15, 'P'], Semicolon: [16, ';'], Quote: [17, "'"],
};

const PARAM_FOR: Record<LoopEventType, VoiceParamName> = {
  gate: 'gate',
  pitch: 'frequency',
  vowel: 'vowel',
  glide: 'glide',
  voice: 'voice',
  intensity: 'intensity',
};

interface Prefs {
  volume: number;
  trackVol: number;
  echo: number;
  glide: number;
  voice: number;
  vowel: number;
  track: number;
  /** User tempo; null = the selected track's default. */
  bpm: number | null;
  snap: SnapMode;
  kbBase: number;
  countIn: boolean;
  loopBars: number;
  reducedMotion: boolean | null;
  /** Camera mode: opening the mouth sings (otherwise it only shapes the vowel). */
  mouthSings: boolean;
}

const DEFAULTS: Prefs = {
  volume: 0.8,
  trackVol: 0.7,
  echo: 0.3,
  glide: 0.12,
  voice: 0.2,
  vowel: 0.5,
  track: 0,
  bpm: null,
  snap: 'scale',
  kbBase: 48,
  countIn: true,
  loopBars: 4,
  reducedMotion: null,
  mouthSings: true,
};

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

/** Stored preferences, with every field type- and range-checked. */
function loadPrefs(): Prefs {
  const raw = readJson('chanter.prefs');
  const p: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (k: keyof Prefs, lo: number, hi: number, int = false): number => {
    const v = p[k];
    const d = DEFAULTS[k] as number;
    if (typeof v !== 'number' || !Number.isFinite(v)) return d;
    const c = Math.min(hi, Math.max(lo, v));
    return int ? Math.round(c) : c;
  };
  const bool = (k: keyof Prefs, d: boolean | null) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
  return {
    volume: num('volume', 0, 1),
    trackVol: num('trackVol', 0, 1),
    echo: num('echo', 0, 1),
    glide: num('glide', 0, 1),
    voice: num('voice', 0, 1),
    vowel: num('vowel', 0, 1),
    track: num('track', 0, TRACKS.length - 1, true),
    bpm: typeof p.bpm === 'number' && Number.isFinite(p.bpm) ? Math.round(Math.min(160, Math.max(60, p.bpm))) : null,
    snap: p.snap === 'free' || p.snap === 'semitone' || p.snap === 'scale' ? p.snap : DEFAULTS.snap,
    kbBase: Math.round(num('kbBase', 36, 72) / 12) * 12,
    countIn: bool('countIn', DEFAULTS.countIn) as boolean,
    loopBars: [2, 4, 8].includes(p.loopBars as number) ? (p.loopBars as number) : DEFAULTS.loopBars,
    reducedMotion: bool('reducedMotion', null),
    mouthSings: bool('mouthSings', DEFAULTS.mouthSings) as boolean,
  };
}

/** A structurally valid melody loop, or null. Used for storage and file loading. */
export function validLoop(value: unknown): MelodyLoop | null {
  const l = value as MelodyLoop | null;
  if (!l || typeof l !== 'object' || !Array.isArray(l.events)) return null;
  const { lengthBeats, originBeat } = l;
  if (!Number.isFinite(lengthBeats) || lengthBeats <= 0 || lengthBeats > 128) return null;
  if (!Number.isFinite(originBeat) || originBeat < 0 || originBeat >= lengthBeats) return null;
  if (l.events.length > 20000) return null;
  const ok = l.events.every(
    (e) =>
      e &&
      typeof e === 'object' &&
      e.type in PARAM_FOR &&
      Number.isFinite(e.beat) &&
      e.beat >= 0 &&
      e.beat < lengthBeats &&
      Number.isFinite(e.value) &&
      (e.type !== 'pitch' || (e.value >= 12 && e.value <= 108)) &&
      (e.type === 'pitch' || (e.value >= 0 && e.value <= 2)),
  );
  if (!ok) return null;
  return {
    lengthBeats,
    originBeat,
    events: l.events.map(({ beat, type, value }) => ({ beat, type, value })).sort((a, b) => a.beat - b.beat),
  };
}

const VOICE_NAMES = ['Baritone', 'Tenor', 'Alto', 'Soprano'];

const CALIBRATION_PROMPTS: Record<CalibrationStep, [string, string]> = {
  closed: ['Close your mouth', 'Relaxed, lips together'],
  OO: ['OO', 'as in “moon”: round, pursed lips'],
  OH: ['OH', 'as in “go”'],
  AH: ['AH', 'as in “father”: jaw dropped'],
  EH: ['EH', 'as in “bed”'],
  EE: ['EE', 'as in “see”: lips spread wide'],
};

export function startApp(): void {
  const prefs = loadPrefs();
  const persist = () => save('chanter.prefs', prefs);

  // ---------------- core objects ----------------
  const controller = new VoiceController();
  controller.vowel = prefs.vowel;
  controller.glide = prefs.glide;
  controller.voice = prefs.voice;

  let engine: AudioEngine | null = null;
  let enginePromise: Promise<AudioEngine> | null = null;
  let instruments: Instruments | null = null;
  const transport = new Transport(() => engine?.ctx.currentTime ?? 0, workerTicker());
  const recorder = new Recorder();
  let loop: MelodyLoop | null = validLoop(readJson('chanter.loop'));
  let replay = true;
  let track: Track = TRACKS[prefs.track];
  let kbBase = prefs.kbBase;
  transport.bpm = prefs.bpm ?? track.bpm;
  transport.countIn = prefs.countIn;

  // ---------------- stage ----------------
  const art = $('stage-art');
  art.appendChild(createBackdrop());
  const monk = new Monk();
  art.appendChild(monk.svg);

  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionBtn = $('btn-motion');
  const setReduced = (on: boolean) => {
    monk.reducedMotion = on;
    document.body.classList.toggle('reduced-motion', on);
    motionBtn.setAttribute('aria-pressed', String(on));
    motionBtn.title = on ? 'Reduced motion is on' : 'Reduce motion';
  };
  setReduced(prefs.reducedMotion ?? reducedQuery.matches);
  motionBtn.addEventListener('click', () => {
    prefs.reducedMotion = !monk.reducedMotion;
    setReduced(prefs.reducedMotion);
    persist();
  });

  // ---------------- audio init (first gesture) ----------------
  const wakeBtn = $('wake');
  function ensureAudio(): Promise<AudioEngine> {
    if (!enginePromise) {
      enginePromise = AudioEngine.create()
        .then((e) => {
          engine = e;
          controller.engine = e;
          instruments = new Instruments(e.ctx, e.trackBus);
          instruments.setTrim(track.trim);
          e.setVolume(prefs.volume);
          e.setTrackVolume(prefs.trackVol);
          e.setEchoMix(prefs.echo);
          e.setEchoTempo(transport.bpm);
          controller.syncAll();
          document.body.classList.add('audio-ready');
          return e;
        })
        .catch((err) => {
          enginePromise = null;
          wakeBtn.querySelector('.wake-sub')!.textContent = `Audio could not start: ${err?.message ?? err}`;
          throw err;
        });
    }
    return enginePromise;
  }
  const wake = () => {
    void ensureAudio().catch(() => {});
    // A context created without activation (or interrupted by the OS) starts
    // suspended: every later gesture retries.
    if (engine && engine.ctx.state !== 'running') void engine.ctx.resume();
  };
  window.addEventListener('pointerdown', wake, { capture: true });
  window.addEventListener('keydown', (e) => e.key !== 'Escape' && wake(), { capture: true });
  wakeBtn.addEventListener('click', wake);

  // Mouse-clicked buttons/toggles give up focus so Space stays play/pause and
  // letter keys keep playing notes. Keyboard users (click.detail === 0) keep focus.
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (e.detail > 0 && t.closest('button, summary, input[type=checkbox], input[type=radio]') && !t.closest('dialog, .menu-pop')) {
      (t.closest('button, summary, input') as HTMLElement).blur();
    }
  });

  // ---------------- scheduling ----------------
  const heardBeat = () => (engine ? transport.beatAt(engine.heardTime()) : -Infinity);

  function scheduleLoop(from: number, to: number, timeAt: (b: number) => number) {
    if (!loop || !replay || !engine || recorder.state !== 'idle' || controller.live) return;
    const now = engine.now;
    for (const { beat, event } of loopEventsInWindow(loop, Math.max(from, transport.playStartBeat), to)) {
      const value = event.type === 'pitch' ? midiToFreq(event.value) : event.value;
      engine.setParam(PARAM_FOR[event.type], value, Math.max(now, timeAt(beat)));
    }
  }

  transport.onWindow = (w: ScheduleWindow) => {
    const I = instruments;
    if (!I) return;
    const steps = track.bars * 16;
    for (let s = Math.ceil(w.from * 4); s < w.to * 4; s++) {
      const beat = s / 4;
      if (beat < transport.playStartBeat) {
        if (s % 4 === 0) I.click(w.timeAt(beat), beat === transport.playStartBeat - transport.countInBeats);
        continue;
      }
      const ls = ((s % steps) + steps) % steps;
      const swing = s % 2 ? track.swing * 0.25 : 0;
      track.play({ s: ls, bar: ls >> 4, i: ls & 15, time: w.timeAt(beat + swing), spb: transport.secondsPerBeat }, I);
    }
    scheduleLoop(w.from, w.to, w.timeAt);
  };

  /** Return the synth to the live controller's state (ends any replayed note). */
  function releaseReplay() {
    if (!controller.live) controller.syncAll();
  }

  controller.onEvent = (type, value) => {
    if (recorder.state !== 'idle' && engine) recorder.capture(heardBeat(), type, value, controller.snapshot());
  };

  // ---------------- tracks & transport UI ----------------
  const list = $('track-list');
  const trackButtons: HTMLButtonElement[] = [];
  TRACKS.forEach((t, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'track';
    b.innerHTML = `
      <span class="track-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" class="i-play"><path d="M7 4.5v15l12.5-7.5z"/></svg>
        <span class="eq"><i></i><i></i><i></i><i></i></span>
      </span>
      <span class="track-text"><span class="track-name">${t.name}</span><span class="track-meta">${t.key} · ${t.bpm}</span></span>`;
    b.title = `${t.mood} — ${t.key}, ${t.bpm} BPM`;
    b.addEventListener('click', () => void chooseTrack(i));
    li.appendChild(b);
    list.appendChild(li);
    trackButtons.push(b);
  });

  const tempo = $<HTMLInputElement>('tempo');
  const tempoOut = $('tempo-out');
  function setTempo(bpm: number) {
    transport.setBpm(bpm);
    engine?.setEchoTempo(bpm);
    tempo.value = String(bpm);
    tempoOut.innerHTML = `${bpm} <small>BPM</small>`;
  }
  tempo.addEventListener('input', () => {
    setTempo(Number(tempo.value));
    prefs.bpm = transport.bpm;
    persist();
  });

  function renderTracks() {
    trackButtons.forEach((b, i) => {
      const sel = TRACKS[i] === track;
      b.classList.toggle('is-selected', sel);
      b.classList.toggle('is-playing', sel && transport.state === 'playing');
      b.setAttribute('aria-pressed', String(sel && transport.state === 'playing'));
      const t = TRACKS[i];
      b.setAttribute('aria-label', `${t.name}: ${t.mood}, ${t.key}, ${t.bpm} BPM. ${sel && transport.state === 'playing' ? 'Playing; press to pause' : 'Press to play'}`);
    });
    const playing = transport.state === 'playing';
    const playBtn = $('btn-play');
    playBtn.classList.toggle('is-playing', playing);
    playBtn.setAttribute('aria-label', playing ? `Pause ${track.name}` : `Play ${track.name}`);
  }

  async function chooseTrack(i: number) {
    await ensureAudio();
    const next = TRACKS[i];
    if (next === track) {
      togglePlay();
      return;
    }
    track = next;
    prefs.track = i;
    prefs.bpm = null;
    persist();
    instruments?.silence(0.15);
    instruments?.setTrim(track.trim);
    setTempo(track.bpm);
    if (transport.state !== 'playing') play();
    renderTracks();
  }

  function play() {
    transport.countIn = $<HTMLInputElement>('countin').checked;
    transport.play();
  }

  async function togglePlay() {
    await ensureAudio();
    if (transport.state === 'playing') {
      transport.pause();
      instruments?.silence();
      recorder.cancel();
      releaseReplay();
    } else play();
    renderTracks();
  }

  function stopAll() {
    transport.stop();
    instruments?.silence();
    recorder.cancel();
    releaseReplay();
    renderTracks();
  }

  transport.onStateChange = () => renderTracks();
  $('btn-play').addEventListener('click', () => void togglePlay());
  $('btn-stop').addEventListener('click', stopAll);
  $('btn-rec').addEventListener('click', () => void toggleRecord());

  const trackVol = $<HTMLInputElement>('track-vol');
  trackVol.value = String(prefs.trackVol);
  trackVol.addEventListener('input', () => {
    prefs.trackVol = Number(trackVol.value);
    engine?.setTrackVolume(prefs.trackVol);
    persist();
  });
  const countin = $<HTMLInputElement>('countin');
  countin.checked = prefs.countIn;
  countin.addEventListener('change', () => {
    prefs.countIn = countin.checked;
    persist();
  });

  // ---------------- recording ----------------
  const loopBars = $<HTMLSelectElement>('loop-bars');
  loopBars.value = String(prefs.loopBars);
  loopBars.addEventListener('change', () => {
    prefs.loopBars = Number(loopBars.value);
    persist();
    loopBars.blur(); // hand the keyboard back to the instrument
  });

  async function toggleRecord() {
    await ensureAudio();
    if (recorder.state !== 'idle') {
      recorder.cancel();
      setStatus('Recording cancelled — previous loop kept.');
      return;
    }
    const len = Number(loopBars.value) * 4;
    if (transport.state !== 'playing') {
      play();
      recorder.arm(transport.playStartBeat, len);
    } else {
      const hb = heardBeat();
      let start = hb < transport.playStartBeat ? transport.playStartBeat : Math.ceil(hb / 4 - 1e-6) * 4;
      // Always leave at least a beat of lead-in before the take starts.
      if (start - hb < 1) start += 4;
      recorder.arm(start, len);
    }
    releaseReplay();
    renderTracks();
  }

  function finishRecording(done: MelodyLoop) {
    if (!hasNotes(done)) {
      setStatus('Nothing was sung — previous loop kept.');
      return;
    }
    loop = done;
    replay = true;
    save('chanter.loop', loop);
    // The scheduler already ran past the loop end while recording; catch up.
    const end = recorder.startBeat + recorder.lengthBeats;
    scheduleLoop(end, transport.horizonBeat, (b) => transport.timeAt(b));
  }

  const loopToggle = $<HTMLButtonElement>('btn-loop-toggle');
  const loopClear = $<HTMLButtonElement>('btn-loop-clear');
  loopToggle.addEventListener('click', () => {
    replay = !replay;
    if (!replay) releaseReplay();
  });
  loopClear.addEventListener('click', () => {
    loop = null;
    releaseReplay();
    closeMenu();
    try {
      localStorage.removeItem('chanter.loop');
    } catch {
      /* ignore */
    }
  });

  // Loop menu: save / load / export
  const loopMenu = $<HTMLDetailsElement>('loop-menu');
  const loopSave = $<HTMLButtonElement>('btn-loop-save');
  const loopExport = $<HTMLButtonElement>('btn-loop-export');
  const loopFile = $<HTMLInputElement>('loop-file');
  function closeMenu() {
    loopMenu.open = false;
  }
  document.addEventListener('pointerdown', (e) => {
    if (loopMenu.open && !loopMenu.contains(e.target as Node)) closeMenu();
  });
  loopMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    loopMenu.querySelector('summary')!.focus();
    e.stopPropagation();
  });

  function download(name: string, blob: Blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  loopSave.addEventListener('click', () => {
    closeMenu();
    if (!loop) return;
    const data = { app: 'chanter', version: 1, track: track.id, bpm: transport.bpm, loop };
    download('chanter-melody.json', new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    setStatus('Melody saved as note & control events.');
  });

  $('btn-loop-load').addEventListener('click', () => {
    closeMenu();
    loopFile.click();
  });
  loopFile.addEventListener('change', async () => {
    const file = loopFile.files?.[0];
    loopFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const valid = validLoop(data?.loop);
      if (!valid) throw new Error('not a Chanter melody file');
      releaseReplay();
      loop = valid;
      replay = true;
      save('chanter.loop', loop);
      const idx = TRACKS.findIndex((t) => t.id === data.track);
      if (idx >= 0 && TRACKS[idx] !== track) {
        track = TRACKS[idx];
        prefs.track = idx;
        instruments?.silence(0.15);
        instruments?.setTrim(track.trim);
        persist();
      }
      if (Number.isFinite(data.bpm)) {
        setTempo(Math.min(160, Math.max(60, Math.round(data.bpm))));
        prefs.bpm = transport.bpm;
        persist();
      }
      renderTracks();
      setStatus(`Loaded ${file.name}.`);
    } catch (err) {
      setStatus(`Could not load: ${(err as Error).message}`);
    }
  });

  // Real-time audio export of exactly one loop cycle (plus echo tail).
  let exporting: { rec: MediaRecorder; endTime: number; startTime: number; done: boolean; release: () => void } | null = null;
  loopExport.addEventListener('click', async () => {
    closeMenu();
    if (!loop || exporting) return;
    const e = await ensureAudio();
    if (typeof MediaRecorder === 'undefined') {
      setStatus('Audio export is not supported in this browser.');
      return;
    }
    if (transport.state !== 'playing') play();
    replay = true;
    const L = loop.lengthBeats;
    const from = Math.max(transport.beatAt(e.now + 0.2), transport.playStartBeat);
    const startBeat = loop.originBeat + Math.ceil((from - loop.originBeat) / L) * L;
    const startTime = transport.timeAt(startBeat);
    const endTime = transport.timeAt(startBeat + L) + 1.5;
    const cap = e.captureMix();
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(cap.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const job = { rec, startTime, endTime, done: false, release: cap.disconnect };
    exporting = job;
    rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    rec.onstop = () => {
      cap.disconnect();
      exporting = null;
      if (!job.done) return setStatus('Audio export cancelled.');
      const type = rec.mimeType || 'audio/webm';
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      download(`chanter-loop.${ext}`, new Blob(chunks, { type }));
      setStatus('Loop audio exported.');
    };
    setTimeout(() => exporting === job && rec.state === 'inactive' && rec.start(), Math.max(0, (startTime - e.now) * 1000 - 15));
  });

  function updateExport() {
    if (!exporting || !engine) return;
    const { rec } = exporting;
    if (transport.state !== 'playing' || !loop) {
      if (rec.state !== 'inactive') rec.stop();
      else {
        exporting.release();
        exporting = null;
        setStatus('Audio export cancelled.');
      }
      return;
    }
    if (engine.now >= exporting.endTime && rec.state === 'recording') {
      exporting.done = true;
      rec.stop();
    }
  }

  const statusEl = $('loop-status');
  let statusOverride = '';
  let statusUntil = 0;
  function setStatus(msg: string) {
    statusOverride = msg;
    statusUntil = performance.now() + 3500;
  }

  // ---------------- sound controls ----------------
  const controls = $('sound-controls');
  const glide = new Knob({
    id: 'glide',
    label: 'Glide',
    min: 0,
    max: 1,
    step: 0.01,
    value: prefs.glide,
    defaultValue: DEFAULTS.glide,
    size: 64,
    format: (v) => (v < 0.005 ? 'Off' : `${Math.round(v * 1000)} ms`),
    onInput: (v) => {
      controller.setGlide(v);
      prefs.glide = v;
      persist();
    },
  });
  const voice = new Knob({
    id: 'voice',
    label: 'Voice',
    min: 0,
    max: 1,
    step: 0.01,
    value: prefs.voice,
    defaultValue: DEFAULTS.voice,
    size: 84,
    ends: ['Baritone', 'Soprano'],
    format: (v) => VOICE_NAMES[Math.min(3, Math.round(v * 3))],
    onInput: (v) => {
      controller.setVoice(v);
      prefs.voice = v;
      persist();
    },
  });
  controls.prepend(glide.el);
  controls.append(voice.el);

  const echo = $<HTMLInputElement>('echo');
  const echoOut = $('echo-out');
  const renderEcho = () => {
    echoOut.textContent = `${Math.round(prefs.echo * 100)}%`;
    echo.setAttribute('aria-valuetext', `${Math.round(prefs.echo * 100)} percent wet`);
  };
  echo.value = String(prefs.echo);
  renderEcho();
  echo.addEventListener('input', () => {
    prefs.echo = Number(echo.value);
    engine?.setEchoMix(prefs.echo);
    renderEcho();
    persist();
  });

  const volume = $<HTMLInputElement>('volume');
  volume.value = String(prefs.volume);
  volume.addEventListener('input', () => {
    prefs.volume = Number(volume.value);
    engine?.setVolume(prefs.volume);
    persist();
  });

  // ---------------- vowel ----------------
  const vowelInput = $<HTMLInputElement>('vowel');
  let vowelSaveTimer = 0;
  const setVowel = (v: number) => {
    controller.setVowel(v);
    prefs.vowel = controller.vowel;
    clearTimeout(vowelSaveTimer);
    vowelSaveTimer = window.setTimeout(persist, 400);
  };
  vowelInput.addEventListener('input', () => setVowel(Number(vowelInput.value)));

  // ---------------- pad ----------------
  const pad = new XYPad({
    onStart: (m, v) => controller.padStart(m, v),
    onMove: (m, v) => controller.padMove(m, v),
    onEnd: () => controller.padEnd(),
  });
  pad.snap = prefs.snap;
  $('pad-slot').appendChild(pad.el);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=snap]')) {
    r.checked = r.value === prefs.snap;
    r.addEventListener('change', () => {
      pad.snap = r.value as SnapMode;
      prefs.snap = pad.snap;
      persist();
    });
  }

  // ---------------- camera (face) input ----------------
  // Head left–right = pitch, open mouth = sing, lip shape = vowel.
  const tracker = new FaceTracker();
  const cam = new CameraView(pad.el, tracker.video);
  const follower = new MouthFollower(new MouthModel(validCalibration(readJson('chanter.mouth')) ?? DEFAULT_CALIBRATION));
  const camOpts = $('cam-opts');
  const mouthSings = $<HTMLInputElement>('mouth-sings');
  const calibrateBtn = $<HTMLButtonElement>('btn-calibrate');
  const LOOKING = 'Looking for your face. Sit facing the camera, in good light.';
  let cameraOn = false;
  let camSinging = false;
  let headNote = NaN;
  let calibrator: Calibrator | null = null;
  let calibratedUntil = 0;
  let lastCamFrame = 0;
  let camMsg = '';

  mouthSings.checked = prefs.mouthSings;
  mouthSings.addEventListener('change', () => {
    prefs.mouthSings = mouthSings.checked;
    persist();
  });

  const camMessage = (text: string, action?: { label: string; run: () => void }) => {
    if (text === camMsg && !action) return;
    camMsg = text;
    cam.setMessage(text, action);
  };

  function camRelease() {
    if (!camSinging) return;
    camSinging = false;
    controller.padEnd();
  }

  /** Snapped note under the head; holds the current note until the head is clearly past a boundary. */
  function headMidi(x: number): number {
    let m = pad.midiAt(x);
    if (pad.snap !== 'free' && Number.isFinite(headNote) && m !== headNote) {
      const lo = pad.lowNote;
      const span = pad.highNote - lo;
      const raw = lo + Math.min(1, Math.max(0, x)) * span;
      const back = raw - Math.sign(raw - headNote) * 0.35;
      if (pad.midiAt((back - lo) / span) === headNote) m = headNote;
    }
    return (headNote = m);
  }

  function setCalibrating(on: boolean) {
    calibrator = on ? new Calibrator() : null;
    calibrateBtn.textContent = on ? 'Cancel calibration' : 'Calibrate mouth';
    calibrateBtn.setAttribute('aria-pressed', String(on));
    if (on) camRelease();
    else cam.setPrompt(null);
  }
  calibrateBtn.addEventListener('click', () => setCalibrating(!calibrator));

  tracker.onFrame = (face) => {
    const now = performance.now();
    const dt = lastCamFrame ? Math.min(0.2, (now - lastCamFrame) / 1000) : 1 / 30;
    lastCamFrame = now;
    cam.layout();
    const features = face && mouthFeatures(face.landmarks, face.blendshapes, face.aspect);
    const noseX = face ? cam.toPad(face.landmarks[LM.noseTip])[0] : 0.5;

    if (calibrator) {
      const done = calibrator.update(features, dt);
      if (done) {
        follower.model = new MouthModel(done);
        save('chanter.mouth', done);
        setCalibrating(false);
        calibratedUntil = now + 1600;
      } else {
        const step = calibrator.current!;
        const [title, hint] = CALIBRATION_PROMPTS[step];
        const n = `${CALIBRATION_STEPS.indexOf(step) + 1}/${CALIBRATION_STEPS.length}`;
        cam.setPrompt({ title, hint: features ? `${hint} · ${n}` : 'Face the camera…', progress: calibrator.progress });
      }
      camMessage('');
      cam.show(face && features ? { landmarks: face.landmarks, noseX, note: '', open: follower.model.openness(features), singing: false } : null);
      return;
    }
    if (calibratedUntil) {
      if (now < calibratedUntil) cam.setPrompt({ title: 'Calibrated', hint: 'Your mouth shapes are saved.', progress: 1 });
      else {
        calibratedUntil = 0;
        cam.setPrompt(null);
      }
    }

    const r = follower.update(features ? { features, x: noseX } : null, dt);
    // The vowel follows the lips whenever the mouth is open, also for notes played on the keys.
    if (r.present && r.open >= OPEN_OFF && Math.abs(r.vowel - controller.vowel) > 0.006) controller.setVowel(r.vowel);
    const midi = headMidi(r.x);
    if (mouthSings.checked && r.singing) {
      const intensity = Math.round(r.intensity * 50) / 50;
      if (!camSinging) {
        camSinging = true;
        controller.padStart(midi, controller.vowel, intensity);
      } else controller.padMove(midi, controller.vowel, intensity);
    } else camRelease();

    camMessage(r.present ? '' : LOOKING);
    cam.show(
      r.present && face
        ? { landmarks: face.landmarks, noseX: r.x, note: mouthSings.checked ? noteName(midi) : '', open: r.open, singing: camSinging }
        : null,
    );
  };

  const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name=input-mode]');
  async function startCamera() {
    camMessage('Starting the camera… The video stays on this computer.');
    try {
      await tracker.start();
      if (cameraOn && tracker.active) camMessage(LOOKING);
    } catch (err) {
      if (cameraOn) camMessage((err as Error).message, { label: 'Try again', run: () => void startCamera() });
    }
  }
  function setInputMode(mode: 'pad' | 'camera') {
    const on = mode === 'camera';
    for (const r of modeRadios) r.checked = r.value === mode;
    if (on === cameraOn) return;
    cameraOn = on;
    pad.input = !on;
    cam.visible = on;
    camOpts.hidden = !on;
    $('axis-x-title').textContent = on ? 'Pitch · head' : 'Pitch';
    $('axis-y-title').textContent = on ? 'Vowel · mouth' : 'Vowel';
    pad.el.setAttribute(
      'aria-label',
      on
        ? 'Camera input. Move your head left or right for pitch, open your mouth to sing, and shape the vowel with your lips.'
        : 'Pitch and vowel pad. Horizontal is pitch, vertical is vowel. With focus, arrow keys move, hold Space or Enter to sing.',
    );
    if (on) {
      follower.reset();
      lastCamFrame = 0;
      headNote = NaN;
      void startCamera();
    } else {
      tracker.stop();
      setCalibrating(false);
      camRelease();
      camMessage('');
    }
  }
  for (const r of modeRadios) r.addEventListener('change', () => r.checked && setInputMode(r.value as 'pad' | 'camera'));

  // ---------------- piano & octave ----------------
  const piano = new Piano({
    onDown: (m, velocity) => controller.pressKey(m, velocity),
    onUp: (m) => controller.releaseKey(m),
    onVowelDelta: (d) => setVowel(controller.vowel + d),
  });
  $('piano-slot').appendChild(piano.el);

  function layoutKeys() {
    const labels = new Map<number, string>();
    for (const [off, label] of Object.values(KEY_MAP)) labels.set(kbBase + off, label);
    piano.build(kbBase - 12, kbBase + 24, labels);
    pad.setRange(kbBase - 5, kbBase + 19);
    $('oct-out').textContent = `A = ${noteName(kbBase)}`;
  }
  function shiftOctave(d: number) {
    kbBase = Math.min(72, Math.max(36, kbBase + d * 12));
    prefs.kbBase = kbBase;
    persist();
    layoutKeys();
  }
  $('oct-down').addEventListener('click', () => shiftOctave(-1));
  $('oct-up').addEventListener('click', () => shiftOctave(1));
  layoutKeys();

  // ---------------- computer keyboard ----------------
  const heldCodes = new Map<string, number>();
  const arrows = { up: false, down: false };
  const help = $<HTMLDialogElement>('help');

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || help.open) return;
    const t = e.target as HTMLElement;
    if (t.closest('select, textarea, input[type=text]')) return;
    const onWidget = !!t.closest('input, .knob, .xypad');
    const onButton = !!t.closest('button, summary');

    const mapped = KEY_MAP[e.code];
    if (mapped) {
      e.preventDefault();
      if (e.repeat || heldCodes.has(e.code)) return;
      const midi = kbBase + mapped[0];
      heldCodes.set(e.code, midi);
      controller.pressKey(midi);
      return;
    }
    if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
    switch (e.code) {
      case 'KeyZ':
        shiftOctave(-1);
        break;
      case 'KeyX':
        shiftOctave(1);
        break;
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
      case 'Digit5':
        setVowel((Number(e.code.slice(5)) - 1) / 4);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        if (onWidget) return;
        arrows[e.code === 'ArrowUp' ? 'up' : 'down'] = true;
        break;
      case 'Space':
        if (onWidget || onButton) return;
        void togglePlay();
        break;
      case 'KeyR':
        void toggleRecord();
        break;
      case 'Escape':
        if (calibrator) setCalibrating(false);
        else stopAll();
        break;
      case 'Slash':
        if (!e.shiftKey) return;
        help.showModal();
        break;
      default:
        return;
    }
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const midi = heldCodes.get(e.code);
    if (midi !== undefined) {
      heldCodes.delete(e.code);
      controller.releaseKey(midi);
    }
    if (e.code === 'ArrowUp') arrows.up = false;
    if (e.code === 'ArrowDown') arrows.down = false;
  });
  const releaseEverything = () => {
    heldCodes.clear();
    arrows.up = arrows.down = false;
    controller.releaseAll();
    piano.releaseAll();
  };
  window.addEventListener('blur', releaseEverything);
  document.addEventListener('visibilitychange', () => document.hidden && releaseEverything());

  $('btn-help').addEventListener('click', () => help.showModal());
  help.addEventListener('click', (e) => e.target === help && help.close());

  // ---------------- frame loop ----------------
  const nowNote = $('now-note');
  const nowDetail = $('now-detail');
  const countinEl = $('countin-display');
  const dots = Array.from($('beat-dots').children) as HTMLElement[];
  const loopBar = $('loop-bar');
  const recBtn = $('btn-rec');
  let last = performance.now();
  let lastText = '';
  let lastCount = '';

  function frame(ts: number) {
    const dt = (ts - last) / 1000;
    last = ts;

    if (arrows.up !== arrows.down) setVowel(controller.vowel + (arrows.up ? 1 : -1) * dt * 1.2);
    if (Math.abs(Number(vowelInput.value) - controller.vowel) > 0.004) vowelInput.value = String(controller.vowel);
    vowelInput.setAttribute('aria-valuetext', vowelName(controller.vowel));

    const st = engine ? engine.heardState() : { f0: midiToFreq(controller.midi), env: 0, vowel: controller.vowel, gate: 0, onsets: 0, rms: 0 };
    monk.update(st, ts / 1000, dt);

    const midi = freqToMidi(st.f0);
    const sounding = Math.min(1, st.env * 1.3);
    pad.show(midi, st.vowel, sounding);
    piano.setPressed(controller.heldKeys);
    piano.setSounding(st.env > 0.1 ? Math.round(midi) : null);

    let text = '—';
    let detail = 'silent';
    if (st.env > 0.03) {
      const cents = Math.round((midi - Math.round(midi)) * 100);
      text = noteName(midi);
      detail = `${Math.round(st.f0)} Hz${Math.abs(cents) >= 5 ? ` · ${cents > 0 ? '+' : ''}${cents}¢` : ''} · ${vowelName(st.vowel)}`;
    }
    if (text + detail !== lastText) {
      lastText = text + detail;
      nowNote.textContent = text;
      nowDetail.textContent = detail;
    }

    // Transport visuals from the heard beat
    // Heard beat, not earlier than the first count-in click (the run starts 60 ms ahead).
    const hb = Math.max(heardBeat(), transport.playStartBeat - (transport.countIn ? transport.countInBeats : 0));
    const playing = transport.state === 'playing';
    let count = '';
    if (playing && hb < transport.playStartBeat) count = String(Math.max(1, Math.ceil(transport.playStartBeat - hb)));
    if (count !== lastCount) {
      lastCount = count;
      countinEl.textContent = count;
      countinEl.classList.toggle('is-on', !!count);
    }
    const beatIdx = playing ? Math.floor(((hb % 4) + 4) % 4) : -1;
    dots.forEach((d, i) => d.classList.toggle('is-on', i === beatIdx && (hb >= transport.playStartBeat || !!count)));

    // Recording lifecycle (heard-time based so it matches what the user hears)
    if (engine && recorder.state !== 'idle') {
      recorder.maybeBegin(hb, controller.snapshot());
      const done = recorder.maybeFinish(hb);
      if (done) finishRecording(done);
    }
    updateExport();
    let status: string;
    let progress = 0;
    const loopBeats = loop?.lengthBeats ?? 0;
    if (exporting && engine) {
      const { startTime, endTime } = exporting;
      const p = Math.max(0, (engine.now - startTime) / (endTime - startTime));
      status = engine.now < startTime ? 'Export starts at the next loop cycle…' : `Exporting audio… ${Math.min(99, Math.round(p * 100))}%`;
      progress = p;
    } else if (recorder.state === 'armed') {
      const beats = Math.max(0, Math.ceil(recorder.startBeat - hb));
      status = `Recording starts in ${beats} beat${beats === 1 ? '' : 's'}…`;
    } else if (recorder.state === 'recording') {
      progress = (hb - recorder.startBeat) / recorder.lengthBeats;
      const bar = Math.min(recorder.lengthBeats / 4, Math.floor((hb - recorder.startBeat) / 4) + 1);
      status = `Recording bar ${bar} of ${recorder.lengthBeats / 4} — sing!`;
    } else if (loop && hasNotes(loop)) {
      const bars = loop.lengthBeats / 4;
      const notes = loop.events.filter((e) => e.type === 'gate' && e.value > 0).length;
      status = `${bars}-bar loop · ${notes} note${notes === 1 ? '' : 's'} · ${replay ? (playing ? 'replaying' : 'replays with the track') : 'muted'}`;
      if (playing && replay && hb >= transport.playStartBeat) {
        progress = (((hb - loop.originBeat) % loopBeats) + loopBeats) % loopBeats / loopBeats;
      }
    } else status = 'Press ● to record a melody over the track.';
    if (performance.now() < statusUntil) status = statusOverride;
    if (statusEl.textContent !== status) statusEl.textContent = status;
    loopBar.style.transform = `scaleX(${Math.max(0, Math.min(1, progress)).toFixed(4)})`;
    loopBar.classList.toggle('is-rec', recorder.state === 'recording');
    recBtn.classList.toggle('is-armed', recorder.state === 'armed');
    recBtn.classList.toggle('is-recording', recorder.state === 'recording');
    recBtn.setAttribute('aria-pressed', String(recorder.state !== 'idle'));
    const hasLoop = !!loop && hasNotes(loop);
    loopToggle.disabled = !hasLoop;
    loopClear.disabled = !hasLoop || !!exporting;
    loopSave.disabled = !hasLoop;
    loopExport.disabled = !hasLoop || !!exporting;
    loopToggle.setAttribute('aria-pressed', String(replay));
    loopToggle.textContent = replay ? 'Replay on' : 'Replay off';

    requestAnimationFrame(frame);
  }

  renderTracks();
  setTempo(transport.bpm);
  requestAnimationFrame(frame);

  // Diagnostics hook for automated browser checks.
  Object.assign(window, {
    __chanter: {
      get engine() {
        return engine;
      },
      controller,
      transport,
      recorder,
      monk,
      pad,
      camera: {
        tracker,
        follower,
        setInputMode,
        get calibrating() {
          return calibrator?.current ?? null;
        },
      },
      get loop() {
        return loop;
      },
      get track() {
        return track;
      },
      heardBeat,
      ensureAudio,
    },
  });
}
