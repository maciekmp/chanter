// Captures the monk's face for each vowel while singing, plus idle/closed.
// node scripts/poses.mjs <outDir>
import { chromium } from 'playwright';

const out = process.argv[2] ?? '.';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5173/');
await page.waitForTimeout(400);

const faceClip = async () => {
  const box = await page.locator('.monk').boundingBox();
  // Head region of the 800×700 viewBox (meet, bottom aligned) → approximate crop.
  const s = Math.min(box.width / 800, box.height / 700);
  const ox = box.x + (box.width - 800 * s) / 2;
  const oy = box.y + (box.height - 700 * s);
  return { x: ox + 230 * s, y: oy + 40 * s, width: 340 * s, height: 360 * s };
};

// Wake audio, then hold A3 and step through the vowels.
await page.keyboard.press('Digit3');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/pose-closed.png`, clip: await faceClip() });
await page.keyboard.down('KeyH');
await page.waitForTimeout(900);
for (const [key, name] of [
  ['Digit1', 'OO'],
  ['Digit2', 'OH'],
  ['Digit3', 'AH'],
  ['Digit4', 'EH'],
  ['Digit5', 'EE'],
]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(350);
  const d = await page.evaluate(() => ({ ...window.__chanter.monk.debug }));
  console.log(name, JSON.stringify(d, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
  await page.screenshot({ path: `${out}/pose-${name}.png`, clip: await faceClip() });
}
await page.keyboard.up('KeyH');
await page.waitForTimeout(500);
// Fresh onset → sound rings
await page.keyboard.press('Digit3');
await page.keyboard.down('KeyK');
await page.waitForTimeout(260);
const wide = await faceClip();
wide.x -= wide.width * 0.35;
wide.width *= 1.7;
console.log('onset', JSON.stringify(await page.evaluate(() => window.__chanter.monk.debug)));
await page.screenshot({ path: `${out}/pose-rings.png`, clip: wide });
await page.keyboard.up('KeyK');
await page.waitForTimeout(800);
const d = await page.evaluate(() => ({ ...window.__chanter.monk.debug }));
console.log('released', JSON.stringify(d, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
await page.screenshot({ path: `${out}/pose-released.png`, clip: await faceClip() });
await browser.close();
