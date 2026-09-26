# Chanter — singing-monk vocal synthesizer

A playable, desktop-first web instrument. You play a melody with the XY pad, the on-screen piano or your computer keyboard. A monophonic formant voice sings it, and an illustrated monk sings along. The monk is driven by the synth's actual state.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
```

Audio starts on your first click or key press, as browsers require. Press `H` to sing A3 straight away, or click a backing track.

```bash
npm test             # DSP, transport and recorder unit tests (Vitest)
npm run build        # type-check + production build to dist/
npm run verify:browser   # end-to-end checks in headless Chromium (needs `npm run dev` running)
```

Other dev scripts (they also need the dev server): `node scripts/poses.mjs <dir>` captures the monk's mouth shapes; `node scripts/levels.mjs` measures voice and track loudness; `node scripts/shot.mjs <url> <out.png> <w> <h>` takes a screenshot.

## Playing

| Action | Input |
| --- | --- |
| Sing notes | Piano keys (pointer/touch; pressing lower on a key sings louder), or `A W S E D F T G Y H U J K O L P ; '` |
| Octave | `Z` / `X`, or the Oct buttons |
| Vowel | `1`–`5` (OO … EE), hold `↑`/`↓` to sweep, the vowel strip, or drag up/down on a held piano key |
| Pitch + vowel | Press and drag the XY pad (X = pitch, Y = vowel). While a key is held, the pad changes only the vowel |
| Backing track | Click a track; `Space` play/pause, `Esc` stop |
| Record loop | `R` or ●: records 2/4/8 bars in time with the track (after the count-in if stopped, or from the next bar), then replays every cycle. Playing live takes over from the replay |
| Help | `?` |

The pad can snap to *white keys* (the default), *semitones*, or be *free* (continuous). Every backing track uses a white-key mode (A minor, D dorian, E phrygian, C major), so the white keys always fit.

## How it works

- **Voice** (`src/audio/voice-dsp.ts`, run in an AudioWorklet by `voice-processor.ts`)
  - Source: a Rosenberg glottal-flow-derivative pulse, band-limited at the glottal closure with polyBLEP, plus aspiration noise shaped by the glottal flow.
  - Filter: five cascaded Klatt resonators. Formant frequencies and bandwidths are interpolated in log space across five vowels (OO, OH, AH, EH, EE) and four voice types (baritone, tenor, alto, soprano), with per-vowel level compensation.
  - Expressiveness: F1/F2 rise with high notes (formant tuning), louder notes are brighter, vibrato fades in on held notes, and there is a small pitch scoop on onsets.
  - Glide is portamento in log-frequency space.
  - The worklet reports its state (f0, envelope, vowel, onsets, RMS) every ~11 ms.
- **Animation sync** (`engine.heardState()`): the UI picks the report matching the audio *currently reaching the speakers*, using `getOutputTimestamp`. Mouth, jaw, head, eyes, rings, the pad cursor, the note readout and the piano highlight therefore follow what you hear, including replayed loops.
- **Monk rig** (`src/ui/monk.ts`): editable SVG built from separate shapes. The face outline and mouth are regenerated from parameters every frame, so the jaw, chin and mouth cannot come apart. Vowel poses are interpolated continuously. The rich texture lives in a separate static backdrop SVG (`backdrop.ts`), so animating the monk never repaints the filters.
- **Transport** (`transport.ts`): a lookahead scheduler on a Worker-driven ticker, so it isn't throttled in background tabs.
  - Beat↔time is piecewise linear. Tempo changes re-anchor at the scheduling horizon, so audio stays continuous.
  - Backing tracks (`tracks.ts`, synthesized by `instruments.ts`) are scheduled at exact AudioContext times.
  - The echo is a ping-pong dotted-eighth delay synced to the tempo.
- **Recording** (`recorder.ts`): stores gate, pitch, vowel, intensity, glide and voice events against the beat grid, timestamped at the *heard* beat (latency-compensated). Replay schedules them as AudioParam automation, so a loop stays in time at any tempo. Melodies can be saved and loaded as JSON; *Export audio* captures one loop cycle in real time to WebM/Opus.

## Known limitations

- Audio export runs in real time: it waits for the next loop cycle and records one cycle plus a 1.5 s echo tail.
- Browsers add some output latency. Recorded timing is compensated using `getOutputTimestamp`, but live monitoring still has the device's inherent latency.
- The first note after page load waits for the AudioContext and worklet to start (usually a fraction of a second).
- Replaying a loop and playing live share the one monophonic voice; live input temporarily takes over.
- If playback resumes in the middle of a replayed note, that note stays silent until the next recorded note onset.
- Desktop-first. Below 860 px wide the layout stacks vertically, which works but is not the primary target.
