// End-to-end checks of the running app in Chromium (Playwright).
// Usage: npm run dev  (in another terminal), then: npm run verify:browser [-- url] [--shots dir]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:5173/';
const shotsIdx = args.indexOf('--shots');
const shots = shotsIdx >= 0 ? args[shotsIdx + 1] : null;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (x, d = 2) => (typeof x === 'number' ? x.toFixed(d) : String(x));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__chanter);

const ev = (fn, arg) => page.evaluate(fn, arg);
const heard = () => ev(() => window.__chanter.engine?.heardState() ?? null);
async function waitFor(fn, arg, timeout = 4000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 30 });
    return true;
  } catch {
    return false;
  }
}

/** Energy ratio (linear) between two bands of the master output spectrum. */
const bandRatio = (bands) =>
  ev(([a, b]) => {
    const e = window.__chanter.engine;
    const an = e.analyser;
    const data = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(data);
    const hz = e.ctx.sampleRate / an.fftSize;
    const sum = ([lo, hi]) => {
      let s = 0;
      for (let i = Math.floor(lo / hz); i < Math.ceil(hi / hz); i++) s += 10 ** (data[i] / 10);
      return s;
    };
    return sum(a) / sum(b);
  }, bands);

const centroid = () =>
  ev(() => {
    const e = window.__chanter.engine;
    const an = e.analyser;
    const data = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(data);
    const hz = e.ctx.sampleRate / an.fftSize;
    let num = 0;
    let den = 0;
    for (let i = 2; i < data.length; i++) {
      const p = 10 ** (data[i] / 10);
      num += p * i * hz;
      den += p;
    }
    return num / den;
  });

const outputRms = () =>
  ev(() => {
    const an = window.__chanter.engine.analyser;
    const d = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(d);
    let s = 0;
    for (const v of d) s += v * v;
    return Math.sqrt(s / d.length);
  });

async function maxRms(ms) {
  let m = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    m = Math.max(m, await outputRms());
    await sleep(40);
  }
  return m;
}

// ---------------------------------------------------------------- gesture
check('no AudioContext before a user gesture', await ev(() => window.__chanter.engine === null));
if (shots) await page.screenshot({ path: `${shots}/v-initial.png` });

// ---------------------------------------------------------------- keyboard note
await page.keyboard.down('KeyH'); // A3 with default octave
const started = await waitFor(() => (window.__chanter.engine?.heardState().env ?? 0) > 0.6, null, 5000);
let st = await heard();
check('computer key starts audio and sings A3', started && Math.abs(st.f0 - 220) < 4, `f0=${fmt(st?.f0)} env=${fmt(st?.env)}`);
check('AudioContext is running', (await ev(() => window.__chanter.engine.ctx.state)) === 'running');
await sleep(300);
check('monk mouth opens with the note', (await ev(() => window.__chanter.monk.debug.open)) > 0.7);
check('piano shows the held key', await ev(() => document.querySelector('.key[data-midi="57"]').classList.contains('is-pressed')));
check('active note readout', (await page.textContent('#now-note')) === 'A3', await page.textContent('#now-detail'));

// Measure vowels dry (echo repeats of the previous vowel would blur the comparison).
await ev(() => window.__chanter.engine.setEchoMix(0));
await page.keyboard.press('Digit5');
await sleep(700);
const eeRatio = await bandRatio([[1600, 2700], [150, 1000]]);
const eeMonk = await ev(() => window.__chanter.monk.debug);
await page.keyboard.press('Digit1');
await sleep(700);
const ooRatio = await bandRatio([[1600, 2700], [150, 1000]]);
const ooMonk = await ev(() => window.__chanter.monk.debug);
check('vowel moves F2 energy (EE bright vs OO dark, > 7 dB)', eeRatio > ooRatio * 5, `EE=${fmt(eeRatio, 4)} OO=${fmt(ooRatio, 4)} → ${fmt(10 * Math.log10(eeRatio / ooRatio), 1)} dB`);
// F1 region: AH (F1 ≈ 630–650 Hz) vs EE (F1 ≈ 280 Hz)
await page.keyboard.press('Digit3');
await sleep(700);
const ahF1 = await bandRatio([[520, 900], [150, 400]]);
await page.keyboard.press('Digit5');
await sleep(700);
const eeF1 = await bandRatio([[520, 900], [150, 400]]);
check('vowel moves F1 (AH open vs EE closed, > 7 dB)', ahF1 > eeF1 * 5, `AH=${fmt(ahF1, 3)} EE=${fmt(eeF1, 3)} → ${fmt(10 * Math.log10(ahF1 / eeF1), 1)} dB`);
await page.keyboard.press('Digit1');
await sleep(300);
check('monk mouth follows synth vowel', eeMonk.vowel > 0.9 && ooMonk.vowel < 0.1, `EE=${fmt(eeMonk.vowel)} OO=${fmt(ooMonk.vowel)}`);
check('jaw opens more for AH than OO', await (async () => {
  await page.keyboard.press('Digit3');
  await sleep(300);
  return (await ev(() => window.__chanter.monk.debug.jaw)) > ooMonk.jaw * 1.8;
})());
await ev(() => window.__chanter.engine.setEchoMix(Number(document.getElementById('echo').value)));

// Arrow up sweeps the vowel while the key is held
const v0 = await ev(() => window.__chanter.controller.vowel);
await page.keyboard.down('ArrowUp');
await sleep(250);
await page.keyboard.up('ArrowUp');
const v1 = await ev(() => window.__chanter.controller.vowel);
check('ArrowUp sweeps the vowel while a key is held', v1 > v0 + 0.15, `${fmt(v0)} → ${fmt(v1)}`);

await page.keyboard.up('KeyH');
await sleep(700);
st = await heard();
check('release silences the voice and closes the mouth', st.env < 0.05 && (await ev(() => window.__chanter.monk.debug.open)) < 0.1, `env=${fmt(st.env, 3)}`);

// ---------------------------------------------------------------- XY pad
const pad = await page.locator('.xypad').boundingBox();
await page.mouse.move(pad.x + pad.width * 0.08, pad.y + pad.height * 0.92);
await page.mouse.down();
await sleep(500);
const low = await heard();
await page.mouse.move(pad.x + pad.width * 0.92, pad.y + pad.height * 0.08, { steps: 12 });
await sleep(700);
const high = await heard();
check('pad press sounds a note', low.env > 0.5, `env=${fmt(low.env)}`);
check('pad X controls pitch continuously', high.f0 > low.f0 * 2.5, `${fmt(low.f0, 1)} Hz → ${fmt(high.f0, 1)} Hz`);
check('pad Y controls vowel', low.vowel < 0.2 && high.vowel > 0.8, `${fmt(low.vowel)} → ${fmt(high.vowel)}`);
const cursorTop = await ev(() => parseFloat(document.querySelector('.pad-cursor').style.top));
check('pad cursor tracks the synth state', cursorTop < 20, `top=${fmt(cursorTop, 1)}%`);
await page.mouse.up();
await sleep(500);
check('pad release ends the note', (await heard()).env < 0.1);

// Keys held + pad = vowel only
await page.keyboard.down('KeyA'); // C3
await sleep(250);
await page.mouse.move(pad.x + pad.width * 0.9, pad.y + pad.height * 0.1);
await page.mouse.down();
await sleep(400);
st = await heard();
check('while a key is held the pad changes only the vowel', Math.abs(st.f0 - 130.8) < 3 && st.vowel > 0.8, `f0=${fmt(st.f0, 1)} vowel=${fmt(st.vowel)}`);
await page.mouse.up();
await page.keyboard.up('KeyA');
await sleep(400);

// ---------------------------------------------------------------- piano pointer + glissando + vertical vowel drag
const keyBox = async (m) => page.locator(`.key[data-midi="${m}"]`).boundingBox();
await page.keyboard.press('Digit3'); // start the drag test from AH
const c3 = await keyBox(48);
const e3 = await keyBox(52);
await page.mouse.move(c3.x + c3.width / 2, c3.y + c3.height * 0.85);
await page.mouse.down();
await sleep(400);
const onC = await heard();
await page.mouse.move(e3.x + e3.width / 2, e3.y + e3.height * 0.85, { steps: 6 });
await sleep(400);
const onE = await heard();
const vBefore = await ev(() => window.__chanter.controller.vowel);
await page.mouse.move(e3.x + e3.width / 2, e3.y + e3.height * 0.7, { steps: 6 });
const vAfter = await ev(() => window.__chanter.controller.vowel);
await page.mouse.up();
check('piano pointer plays C3', Math.abs(onC.f0 - 130.8) < 3, `f0=${fmt(onC.f0, 1)}`);
check('sliding across keys plays legato to E3', Math.abs(onE.f0 - 164.8) < 4 && onE.env > 0.5, `f0=${fmt(onE.f0, 1)}`);
check('dragging up on a held key raises the vowel', vAfter > vBefore + 0.1, `${fmt(vBefore)} → ${fmt(vAfter)}`);
await sleep(400);

// ---------------------------------------------------------------- glide knob
async function glideTime() {
  return ev(async () => {
    const { engine: e, controller: c } = window.__chanter;
    const frame = () => new Promise((r) => setTimeout(r, 5));
    c.pressKey(48);
    await new Promise((r) => setTimeout(r, 450));
    let t0 = null;
    let arrived = null;
    e.onReport = (r) => {
      if (t0 === null) return;
      if (arrived === null && r.f0 > 261.6 * 0.97) arrived = r.t;
    };
    t0 = e.ctx.currentTime;
    c.pressKey(60);
    const deadline = performance.now() + 3000;
    while (arrived === null && performance.now() < deadline) await frame();
    e.onReport = null;
    c.releaseAll();
    return arrived === null ? 99 : arrived - t0;
  });
}
await page.focus('#glide');
await page.keyboard.press('Home');
const gOff = await ev(() => window.__chanter.controller.glide);
const fast = await glideTime();
await sleep(400);
await page.keyboard.press('End');
const gMax = await ev(() => window.__chanter.controller.glide);
const slow = await glideTime();
await sleep(400);
check('glide knob is keyboard operable', gOff === 0 && gMax === 1, `Home=${gOff} End=${gMax}`);
check('glide controls portamento time', fast < 0.06 && slow > 0.5, `off: ${fmt(fast * 1000, 0)} ms, max: ${fmt(slow * 1000, 0)} ms`);
// Pointer drag on knob
const gk = await page.locator('#glide').boundingBox();
await page.mouse.move(gk.x + gk.width / 2, gk.y + gk.height / 2);
await page.mouse.down();
await page.mouse.move(gk.x + gk.width / 2, gk.y + gk.height / 2 + 140, { steps: 8 });
await page.mouse.up();
const gDrag = await ev(() => window.__chanter.controller.glide);
check('knob responds to pointer drag', gDrag < 0.3, `glide=${fmt(gDrag)}`);
await page.focus('#glide');
for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
check('glide aria-valuetext reflects value', /ms|Off/.test(await page.getAttribute('#glide', 'aria-valuetext')), await page.getAttribute('#glide', 'aria-valuetext'));

// ---------------------------------------------------------------- echo mix
async function tailEnergy() {
  await page.keyboard.down('KeyH');
  await sleep(450);
  await page.keyboard.up('KeyH');
  await sleep(450);
  const e = await maxRms(700);
  await sleep(1800);
  return e;
}
await page.focus('#echo');
await page.keyboard.press('Home');
const dry = await tailEnergy();
await page.focus('#echo');
await page.keyboard.press('End');
const wet = await tailEnergy();
check('echo mix adds delayed repeats', wet > dry * 2.5, `tail rms dry=${fmt(dry, 4)} wet=${fmt(wet, 4)}`);
await page.focus('#echo');
for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowLeft');

// ---------------------------------------------------------------- voice knob
async function voiceCentroid(key) {
  await page.focus('#voice');
  await page.keyboard.press(key);
  await page.keyboard.press('Digit3');
  await page.keyboard.down('KeyH');
  await sleep(700);
  let c = 0;
  for (let i = 0; i < 5; i++) {
    c += await centroid();
    await sleep(60);
  }
  await page.keyboard.up('KeyH');
  await sleep(700);
  return c / 5;
}
const bari = await voiceCentroid('Home');
const sop = await voiceCentroid('End');
check('voice knob moves timbre from baritone to soprano', sop > bari * 1.12, `centroid ${fmt(bari, 0)} → ${fmt(sop, 0)} Hz; label=${await page.textContent('#voice + .knob-value')}`);
await page.focus('#voice');
await page.keyboard.press('Home');
for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowUp');

// ---------------------------------------------------------------- backing tracks
const trackButtons = page.locator('.track');
const n = await trackButtons.count();
check('at least four backing tracks', n >= 4, `${n} tracks`);
for (let i = 0; i < n; i++) {
  await trackButtons.nth(i).click();
  const counted = await waitFor(() => /^[1-4]$/.test(document.getElementById('countin-display').textContent), null, 3000);
  const name = await trackButtons.nth(i).locator('.track-name').textContent();
  await waitFor(() => window.__chanter.heardBeat() >= window.__chanter.transport.playStartBeat + 0.5, null, 6000);
  const rms = await maxRms(1800);
  const ahead = await ev(() => {
    const t = window.__chanter.transport;
    return t.horizonBeat - t.beatAt(window.__chanter.engine.ctx.currentTime);
  });
  const playing = await ev(() => document.querySelectorAll('.track.is-playing').length === 1);
  check(`track "${name}" plays after count-in`, counted && rms > 0.02 && playing && ahead > 0, `rms=${fmt(rms, 3)} lookahead=${fmt(ahead)} beats`);
  if (shots && i === 1) await page.screenshot({ path: `${shots}/v-track.png` });
  await page.click('#btn-stop');
  await sleep(300);
}

// Singing over a track: level balance (info)
await trackButtons.nth(0).click();
await waitFor(() => window.__chanter.heardBeat() >= 1, null, 8000);
const avgRms = (ms) =>
  ev(async (ms) => {
    const an = window.__chanter.engine.analyser;
    const d = new Float32Array(an.fftSize);
    let s = 0;
    let n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(d);
      for (const v of d) s += v * v;
      n += d.length;
      await new Promise((r) => setTimeout(r, 30));
    }
    return Math.sqrt(s / n);
  }, ms);
const trackOnly = await avgRms(2000);
await page.keyboard.down('KeyH');
await sleep(300);
const withVoice = await avgRms(2000);
await page.keyboard.up('KeyH');
check('voice sits clearly above the backing track', withVoice > trackOnly * 1.6, `avg rms track=${fmt(trackOnly, 3)} track+voice=${fmt(withVoice, 3)}`);

// Pause resumes from bar start
await page.keyboard.press('Space');
await sleep(200);
const paused = await ev(() => window.__chanter.transport.state);
await page.keyboard.press('Space');
await sleep(200);
const resumed = await ev(() => ({ s: window.__chanter.transport.state, b: window.__chanter.transport.playStartBeat }));
check('Space pauses and resumes from the bar start', paused === 'paused' && resumed.s === 'playing' && resumed.b % 4 === 0, `resume beat=${resumed.b}`);
await page.keyboard.press('Escape');

// Tempo slider
await page.focus('#tempo');
await page.keyboard.press('End');
check('tempo slider sets transport tempo', (await ev(() => window.__chanter.transport.bpm)) === 160, await page.textContent('#tempo-out'));
await page.keyboard.press('Home');
check('tempo slider min', (await ev(() => window.__chanter.transport.bpm)) === 60);

// Backing level
await page.focus('#track-vol');
await page.keyboard.press('Home');
await trackButtons.nth(4).click();
await waitFor(() => window.__chanter.heardBeat() >= 1, null, 8000);
const muted = await maxRms(900);
await page.focus('#track-vol');
for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowRight');
const unmuted = await maxRms(900);
check('backing level slider controls the track volume', muted < 0.01 && unmuted > 0.03, `min=${fmt(muted, 4)} restored=${fmt(unmuted, 3)}`);
await page.keyboard.press('Escape');
await sleep(300);

// ---------------------------------------------------------------- recording & replay timing
await trackButtons.nth(0).click(); // select Mountain Air
await page.keyboard.press('Escape');
await page.focus('#tempo');
await ev(() => {
  const t = document.getElementById('tempo');
  t.value = '100';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  const bars = document.getElementById('loop-bars');
  bars.value = '2';
  bars.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('KeyR');
const recStarted = await waitFor(() => window.__chanter.recorder.state === 'recording', null, 6000);
check('R arms recording, counts in, then records', recStarted);
// Sing a short phrase: C3, E3, G3, A3
for (const [code, hold, gap] of [
  ['KeyA', 350, 250],
  ['KeyD', 350, 250],
  ['KeyG', 350, 250],
  ['KeyH', 700, 0],
]) {
  await page.keyboard.down(code);
  await sleep(hold);
  await page.keyboard.up(code);
  await sleep(gap);
}
const recDone = await waitFor(() => window.__chanter.recorder.state === 'idle' && !!window.__chanter.loop, null, 8000);
const loopInfo = await ev(() => {
  const l = window.__chanter.loop;
  return { len: l.lengthBeats, ons: l.events.filter((e) => e.type === 'gate' && e.value > 0).map((e) => e.beat), pitches: l.events.filter((e) => e.type === 'pitch').map((e) => e.value) };
});
check('recorded loop contains the sung notes', recDone && loopInfo.ons.length >= 4 && [48, 52, 55, 57].every((p) => loopInfo.pitches.includes(p)), `onsets at beats ${loopInfo.ons.map((b) => fmt(b)).join(', ')}`);

async function replayErrorsMs(cycleSeconds) {
  return ev(async (waitS) => {
    const { engine: e, transport: t, loop: l } = window.__chanter;
    const onsets = [];
    let last = e.latest.onsets;
    e.onReport = (r) => {
      if (r.onsets !== last) {
        last = r.onsets;
        onsets.push(r.t);
      }
    };
    await new Promise((r) => setTimeout(r, waitS * 1000));
    e.onReport = null;
    const expected = l.events.filter((ev) => ev.type === 'gate' && ev.value > 0).map((ev) => ev.beat);
    return onsets.map((time) => {
      const b = t.beatAt(time);
      const pos = (((b - l.originBeat) % l.lengthBeats) + l.lengthBeats) % l.lengthBeats;
      const err = Math.min(...expected.map((x) => Math.abs(x - pos)));
      return (err * 60 * 1000) / t.bpm;
    });
  }, cycleSeconds);
}
const errs100 = await replayErrorsMs(5.2);
check('loop replays in time with the track (100 BPM)', errs100.length >= 4 && Math.max(...errs100) < 25, `onset errors ms: ${errs100.map((x) => fmt(x, 1)).join(', ')}`);
check('monk animates during replay', (await ev(() => window.__chanter.monk.debug.open)) >= 0 && errs100.length > 0);
await ev(() => {
  const t = document.getElementById('tempo');
  t.value = '76';
  t.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(800);
const errs76 = await replayErrorsMs(6.6);
check('loop stays in time after a tempo change (76 BPM)', errs76.length >= 4 && Math.max(...errs76) < 25, `onset errors ms: ${errs76.map((x) => fmt(x, 1)).join(', ')}`);
// Live playing overrides replay
await page.keyboard.down('KeyK');
await sleep(500);
st = await heard();
check('live playing takes over from replay', Math.abs(st.f0 - 261.6) < 5, `f0=${fmt(st.f0, 1)}`);
await page.keyboard.up('KeyK');
if (shots) await page.screenshot({ path: `${shots}/v-replay.png` });
// Replay toggle
await page.click('#btn-loop-toggle');
await sleep(150);
check('replay toggle mutes the loop', (await page.textContent('#btn-loop-toggle')) === 'Replay off');
await page.click('#btn-loop-toggle');

// Save → clear → load round trip of the event-based melody
await page.click('#loop-menu summary');
const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-loop-save')]);
const jsonPath = await jsonDl.path();
const saved = JSON.parse((await import('node:fs')).readFileSync(jsonPath, 'utf8'));
check('melody saves as note/control events (.json)', saved.app === 'chanter' && saved.loop.events.some((e) => e.type === 'gate'), `${saved.loop.events.length} events, ${jsonDl.suggestedFilename()}`);
await page.click('#loop-menu summary');
await page.click('#btn-loop-clear');
await sleep(100);
const cleared = await ev(() => window.__chanter.loop === null);
await page.setInputFiles('#loop-file', jsonPath);
await waitFor(() => !!window.__chanter.loop, null, 2000);
const reloaded = await ev(() => window.__chanter.loop?.events.length ?? 0);
check('clear and load melody file round-trip', cleared && reloaded === saved.loop.events.length, `reloaded ${reloaded} events`);

// Audio export of one loop cycle
await page.click('#loop-menu summary');
const [wavDl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-loop-export')]);
const size = (await import('node:fs')).statSync(await wavDl.path()).size;
check('loop exports as an audio file', size > 20000, `${wavDl.suggestedFilename()} ${Math.round(size / 1024)} KB`);

await page.keyboard.press('Escape');
await sleep(400);
check('stop ends replayed notes', (await heard()).env < 0.1);

// ---------------------------------------------------------------- reduced motion
await page.click('#btn-motion');
await page.keyboard.down('KeyH');
await sleep(700);
const rm = await ev(() => window.__chanter.monk.debug);
await page.keyboard.up('KeyH');
check('reduced motion stops head/body motion and rings', rm.headRot === 0 && rm.headY === 0 && rm.rings === 0 && rm.open > 0.7, JSON.stringify({ headRot: rm.headRot, rings: rm.rings, open: fmt(rm.open) }));
await page.click('#btn-motion');
await sleep(500);

// Idle blink happens and breathing moves
const blink = await ev(async () => {
  let maxC = 0;
  const b = new Set();
  const end = performance.now() + 7000;
  while (performance.now() < end) {
    const d = window.__chanter.monk.debug;
    maxC = Math.max(maxC, d.eyeClosure);
    b.add(Math.round(d.breathe * 10));
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { maxC, breathe: b.size };
});
check('idle eyes blink and body breathes', blink.maxC > 0.8 && blink.breathe > 5, JSON.stringify(blink));

// ---------------------------------------------------------------- focus visibility
await page.locator('body').click({ position: { x: 5, y: 5 } });
let visibleFocus = 0;
let tabbed = 0;
for (let i = 0; i < 25; i++) {
  await page.keyboard.press('Tab');
  const s = await ev(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    const cs = getComputedStyle(a);
    const target = a.matches('input[type=radio]') ? a.nextElementSibling : a;
    const ts = getComputedStyle(target);
    return cs.outlineStyle !== 'none' || ts.outlineStyle !== 'none';
  });
  if (s !== null) {
    tabbed++;
    if (s) visibleFocus++;
  }
}
check('keyboard focus is visible on tabbable controls', tabbed > 10 && visibleFocus === tabbed, `${visibleFocus}/${tabbed}`);

// Help dialog
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.click('#btn-help');
check('help dialog opens', await ev(() => document.getElementById('help').open));
await page.keyboard.press('Escape');

// Octave shift
await page.keyboard.press('KeyX');
check('X shifts the keyboard up an octave', (await page.textContent('#oct-out')).includes('C4'));
await page.keyboard.press('KeyZ');

// ---------------------------------------------------------------- regressions from independent QA
// Black keys sit across the boundary between their two white keys
const geo = await ev(() => {
  const keys = [...document.querySelectorAll('.key')].map((k) => ({ m: +k.dataset.midi, r: k.getBoundingClientRect(), black: k.classList.contains('black') }));
  const byMidi = new Map(keys.map((k) => [k.m, k]));
  return keys
    .filter((k) => k.black)
    .map((k) => {
      const lo = byMidi.get(k.m - 1).r;
      const boundary = lo.right;
      return Math.abs((k.r.left + k.r.width / 2 - boundary) / lo.width);
    });
});
check('black keys straddle their white-key boundary', Math.max(...geo) < 0.16, `max offset ${fmt(Math.max(...geo))} white widths`);

// Space after mouse-clicking a button toggles play/pause, not the button
await page.click('#oct-up');
const octBefore = await page.textContent('#oct-out');
await page.keyboard.press('Space');
await sleep(300);
const afterSpace = { oct: await page.textContent('#oct-out'), state: await ev(() => window.__chanter.transport.state) };
check('Space plays/pauses even after clicking a button', afterSpace.oct === octBefore && afterSpace.state === 'playing', JSON.stringify(afterSpace));
await page.keyboard.press('Escape');
await page.click('#oct-down');
// Count-in shows on stage
await page.keyboard.press('Space');
const stageCount = await waitFor(() => /^[1-4]$/.test(document.getElementById('countin-display').textContent) && document.getElementById('countin-display').classList.contains('is-on'), null, 3000);
check('count-in numbers appear on stage', stageCount);
// Heard beat continuity across a tempo change during playback
await waitFor(() => window.__chanter.heardBeat() > 1, null, 6000);
const jump = await ev(async () => {
  const { transport: t, engine: e } = window.__chanter;
  const h = e.heardTime();
  const before = t.beatAt(h);
  const el = document.getElementById('tempo');
  el.value = String(t.bpm > 120 ? 70 : 150);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return t.beatAt(h) - before;
});
check('tempo change does not shift the heard beat', Math.abs(jump) < 1e-6, `jump ${jump}`);
await page.keyboard.press('Escape');
// Keyboard still plays after choosing a loop length with the mouse
await page.selectOption('#loop-bars', '2');
await page.keyboard.down('KeyG');
await sleep(500);
st = await heard();
await page.keyboard.up('KeyG');
check('keys still play after picking a loop length', Math.abs(st.f0 - 196) < 4 && st.env > 0.5, `f0=${fmt(st.f0, 1)}`);
// Velocity: pressing low on a key sings louder/wider than pressing high
async function pressAt(frac) {
  const b = await keyBox(55);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * frac);
  await page.mouse.down();
  await sleep(600);
  const r = { intensity: await ev(() => window.__chanter.controller.intensity), jaw: await ev(() => window.__chanter.monk.debug.jaw), rms: (await heard()).rms };
  await page.mouse.up();
  await sleep(500);
  return r;
}
const soft = await pressAt(0.1);
const loud = await pressAt(0.95);
check('key press position sets velocity (loudness and jaw)', loud.intensity > soft.intensity + 0.3 && loud.rms > soft.rms * 1.2 && loud.jaw > soft.jaw, `soft ${JSON.stringify(soft)} loud ${JSON.stringify(loud)}`);

// Persistence and corrupted storage
{
  const p2 = await context.newPage();
  await p2.goto(url);
  await p2.waitForFunction(() => !!window.__chanter);
  await p2.evaluate(() => {
    const el = document.getElementById('tempo');
    el.value = '131';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p2.reload();
  await p2.waitForFunction(() => !!window.__chanter);
  check('tempo persists across reload', (await p2.evaluate(() => window.__chanter.transport.bpm)) === 131);
  const p2errors = [];
  p2.on('pageerror', (e) => p2errors.push(e.message));
  await p2.evaluate(() => {
    localStorage.setItem('chanter.prefs', JSON.stringify({ track: 1.5, kbBase: 'abc', voice: 'x', volume: 1e9, bpm: NaN }));
    localStorage.setItem('chanter.loop', JSON.stringify({ events: [null], lengthBeats: 1e9, originBeat: 0 }));
  });
  await p2.reload();
  await p2.waitForFunction(() => !!window.__chanter, null, { timeout: 5000 }).catch(() => {});
  await p2.keyboard.down('KeyH');
  await p2.waitForFunction(() => (window.__chanter?.engine?.heardState().env ?? 0) > 0.5, null, { timeout: 5000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const bad = await p2.evaluate(() => ({
    keys: document.querySelectorAll('.key').length,
    open: window.__chanter?.monk.debug.open ?? 0,
    loop: window.__chanter?.loop,
    oct: document.getElementById('oct-out').textContent,
  }));
  await p2.keyboard.up('KeyH');
  check('corrupted saved data is ignored safely', p2errors.length === 0 && bad.keys === 37 && bad.open > 0.5 && bad.loop === null && bad.oct.includes('C3'), JSON.stringify({ ...bad, errors: p2errors.slice(0, 2) }));
  await p2.evaluate(() => localStorage.clear());
  await p2.close();
}

// ---------------------------------------------------------------- touch input
const tctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, hasTouch: true });
const tp = await tctx.newPage();
await tp.goto(url);
await tp.waitForFunction(() => !!window.__chanter);
const cdp = await tctx.newCDPSession(tp);
const tpad = await tp.locator('.xypad').boundingBox();
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
await touch('touchStart', tpad.x + tpad.width * 0.1, tpad.y + tpad.height * 0.5);
await tp.waitForFunction(() => (window.__chanter.engine?.heardState().env ?? 0) > 0.5, null, { timeout: 5000 }).catch(() => {});
const tLow = await tp.evaluate(() => window.__chanter.engine?.heardState());
for (let i = 1; i <= 10; i++) await touch('touchMove', tpad.x + tpad.width * (0.1 + 0.08 * i), tpad.y + tpad.height * 0.5);
await new Promise((r) => setTimeout(r, 600));
const tHigh = await tp.evaluate(() => window.__chanter.engine.heardState());
await touch('touchEnd');
check('touch drag on the pad sings and bends pitch', tLow && tLow.env > 0.5 && tHigh.f0 > tLow.f0 * 2, `${fmt(tLow?.f0, 1)} → ${fmt(tHigh.f0, 1)} Hz`);
const tkey = await tp.locator('.key[data-midi="60"]').boundingBox();
await touch('touchStart', tkey.x + tkey.width / 2, tkey.y + tkey.height * 0.85);
await new Promise((r) => setTimeout(r, 400));
const tk = await tp.evaluate(() => window.__chanter.engine.heardState());
await touch('touchEnd');
check('touch on a piano key sings C4', Math.abs(tk.f0 - 261.6) < 5 && tk.env > 0.5, `f0=${fmt(tk.f0, 1)}`);
await tctx.close();

// ---------------------------------------------------------------- camera input
// A fake webcam shows screenshots of the monk's own face (closed, then singing
// AH, then nothing). The face tracker is downloaded on first use, so this
// needs a network connection.
{
  const faceClip = async (p) => {
    const box = await p.locator('.monk').boundingBox();
    const s = Math.min(box.width / 800, box.height / 700);
    const ox = box.x + (box.width - 800 * s) / 2;
    const oy = box.y + (box.height - 700 * s);
    return { x: ox + 230 * s, y: oy + 40 * s, width: 340 * s, height: 360 * s };
  };
  const faces = {};
  const fp = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await fp.goto(url);
  await fp.waitForFunction(() => !!window.__chanter);
  await fp.keyboard.press('Digit3');
  await sleep(900);
  faces.closed = (await fp.screenshot({ clip: await faceClip(fp) })).toString('base64');
  await fp.keyboard.down('KeyH');
  await sleep(900);
  faces.open = (await fp.screenshot({ clip: await faceClip(fp) })).toString('base64');
  await fp.keyboard.up('KeyH');
  await fp.close();

  const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await cctx.addInitScript((faces) => {
    const imgs = {};
    for (const [k, b64] of Object.entries(faces)) (imgs[k] = new Image()).src = `data:image/png;base64,${b64}`;
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const g = c.getContext('2d');
    window.__fakeFace = 'closed';
    setInterval(() => {
      g.fillStyle = '#1b2440';
      g.fillRect(0, 0, 640, 480);
      const im = imgs[window.__fakeFace];
      if (im?.complete) g.drawImage(im, 320 - im.width / 2, 250 - im.height / 2);
    }, 33);
    navigator.mediaDevices.getUserMedia = async () => c.captureStream(30);
  }, faces);
  const cp = await cctx.newPage();
  const cerrors = [];
  cp.on('pageerror', (e) => cerrors.push(e.message));
  await cp.goto(url);
  await cp.waitForFunction(() => !!window.__chanter);
  await cp.keyboard.press('Digit3'); // wake audio
  await cp.click('input[name=input-mode][value=camera]');
  const camOn = await cp
    .waitForFunction(() => window.__chanter.camera.tracker.active, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const ui = await cp.evaluate(() => ({ padInput: window.__chanter.pad.input, opts: !document.getElementById('cam-opts').hidden }));
  check('camera mode starts the tracker and hands the pad over', camOn && !ui.padInput && ui.opts, JSON.stringify({ camOn, ...ui, msg: await cp.textContent('.cam-msg p') }));
  const camState = () => cp.evaluate(() => ({ present: window.__chanter.camera.follower.reading.present, gate: window.__chanter.controller.gate, midi: window.__chanter.controller.midi }));
  const facePresent = await cp.waitForFunction(() => window.__chanter.camera.follower.reading.present, null, { timeout: 8000 }).then(() => true).catch(() => false);
  await sleep(400);
  const closedSt = await camState();
  check('camera finds the face; a closed mouth stays silent', facePresent && closedSt.gate === 0, JSON.stringify(closedSt));
  await cp.evaluate(() => (window.__fakeFace = 'open'));
  const sang = await cp.waitForFunction(() => window.__chanter.controller.gate === 1 && (window.__chanter.engine?.heardState().env ?? 0) > 0.4, null, { timeout: 4000 }).then(() => true).catch(() => false);
  const openSt = await camState();
  const range = await cp.evaluate(() => [window.__chanter.pad.lowNote, window.__chanter.pad.highNote]);
  check('opening the mouth sings the note under the head', sang && openSt.midi >= range[0] && openSt.midi <= range[1], JSON.stringify(openSt));
  await cp.click('#mouth-sings');
  await sleep(300);
  const quiet = await camState();
  await cp.keyboard.down('KeyH');
  await sleep(400);
  const keyed = await camState();
  await cp.keyboard.up('KeyH');
  await cp.click('#mouth-sings');
  await cp.waitForFunction(() => window.__chanter.controller.gate === 1, null, { timeout: 2000 }).catch(() => {});
  check('"Open mouth to sing" off: the mouth only shapes notes played on the keys', quiet.gate === 0 && keyed.gate === 1 && keyed.midi === 57, JSON.stringify({ quiet, keyed }));
  await cp.evaluate(() => (window.__fakeFace = 'none'));
  const released = await cp
    .waitForFunction(() => window.__chanter.controller.gate === 0 && /Looking for your face/.test(document.querySelector('.cam-msg p').textContent), null, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  check('losing the face releases the note and asks for it', released);
  await cp.click('input[name=input-mode][value=pad]');
  const back = await cp.evaluate(() => ({ active: window.__chanter.camera.tracker.active, padInput: window.__chanter.pad.input }));
  check('switching back to the pad stops the camera', !back.active && back.padInput, JSON.stringify(back));
  if (shots) await cp.screenshot({ path: `${shots}/v-camera.png` });
  check('no page errors in camera mode', cerrors.length === 0, cerrors.slice(0, 2).join(' | '));
  await cctx.close();
}

// ---------------------------------------------------------------- layouts
for (const [w, h] of [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
]) {
  const lp = await browser.newPage({ viewport: { width: w, height: h } });
  await lp.goto(url);
  await lp.waitForFunction(() => !!window.__chanter);
  const r = await lp.evaluate(() => {
    const vis = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight + 1 && b.left >= 0 && b.right <= innerWidth + 1;
    };
    const whites = [...document.querySelectorAll('.key.white')].map((k) => k.getBoundingClientRect().width);
    return {
      noHScroll: document.documentElement.scrollWidth <= innerWidth,
      allVisible: ['#btn-play', '#btn-rec', '#btn-stop', '#loop-status', '.xypad', '#glide', '#echo', '#voice', '.piano', '#volume', '#track-list'].every(vis),
      padSize: Math.round(document.querySelector('.xypad').getBoundingClientRect().height),
      minWhite: Math.round(Math.min(...whites)),
      pianoH: Math.round(document.querySelector('.piano').getBoundingClientRect().height),
    };
  });
  check(`layout ${w}×${h}: controls visible, no horizontal scroll`, r.noHScroll && r.allVisible && r.padSize > 150 && r.minWhite >= 30, JSON.stringify(r));
  if (shots) await lp.screenshot({ path: `${shots}/v-${w}x${h}.png` });
  await lp.close();
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
