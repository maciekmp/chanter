// Quick screenshot helper: node scripts/shot.mjs [url] [out.png] [width] [height] [--play]
import { chromium } from 'playwright';

const [url = 'http://localhost:5173/', out = 'shot.png', w = '1440', h = '900'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const play = process.argv.includes('--play');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(600);
if (play) {
  await page.keyboard.down('KeyH');
  await page.waitForTimeout(700);
}
await page.screenshot({ path: out });
if (play) await page.keyboard.up('KeyH');
console.log(logs.join('\n') || 'no console output');
await browser.close();
