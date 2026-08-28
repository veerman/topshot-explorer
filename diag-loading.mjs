import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const base = process.env.BASE || 'https://topshotexplorer.com';
const out = process.env.OUT || 'loading';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--host-resolver-rules=MAP topshotexplorer.com 172.64.80.1, MAP www.topshotexplorer.com 172.64.80.1'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)));

await page.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
// catch the progress state mid-load
try {
  await page.waitForSelector('.progress-bar', { timeout: 15000 });
  await page.waitForFunction(() => /Fetching Plays: [\d,]+ of [\d,]+/.test(document.body.textContent), { timeout: 20000 });
  const line = (await page.textContent('h3')).trim();
  const width = await page.locator('.progress-bar').evaluate(el => el.style.width);
  console.log('progress line:', line, '| bar width:', width);
  await page.screenshot({ path: `${out}.png` });
} catch (e) {
  console.log('did not observe progress state (may have loaded from a fast cache):', String(e).slice(0, 120));
}
await page.waitForSelector('table tbody tr', { timeout: 120000 });
console.log('plays table rendered; rows:', await page.locator('table tbody tr').count());
await browser.close();
