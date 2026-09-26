// Measures average output RMS of the voice alone and of each backing track (trim 1).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => !!window.__chanter);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => !!window.__chanter);

const avgRms = (ms) =>
  page.evaluate(async (ms) => {
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

await page.keyboard.down('KeyH');
await page.waitForTimeout(1500);
console.log('voice A3 AH', (await avgRms(2000)).toFixed(4));
await page.keyboard.up('KeyH');
await page.keyboard.press('Digit5');
await page.keyboard.down('KeyK');
await page.waitForTimeout(800);
console.log('voice C4 EE', (await avgRms(1500)).toFixed(4));
await page.keyboard.up('KeyK');
await page.waitForTimeout(1500);

const n = await page.locator('.track').count();
for (let i = 0; i < n; i++) {
  await page.locator('.track').nth(i).click();
  await page.evaluate(() => (window.__chanter.transport.countIn = false));
  await page.waitForFunction(() => window.__chanter.heardBeat() >= 0.5);
  const trim = await page.evaluate(() => window.__chanter.track.trim);
  const r = await avgRms(4000);
  console.log(await page.locator('.track-name').nth(i).textContent(), 'rms', r.toFixed(4), 'trim', trim, '→ rms/trim', (r / trim).toFixed(4));
  await page.click('#btn-stop');
  await page.waitForTimeout(400);
}
await browser.close();
