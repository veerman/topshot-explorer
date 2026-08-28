import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const base = process.env.BASE || 'http://localhost:5081';
const addr = process.env.ADDR || '0x3795d42c0fc3a373';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR', m.text().slice(0, 300)); });

const t0 = Date.now();
await page.goto(base + '/account/' + addr, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForSelector('table tbody tr td:not(:empty)', { timeout: 90000 });
  console.log(`account loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch {
  console.log('account tables did not render in 90s');
}
const body = (await page.textContent('body')).replace(/\s+/g, ' ');
console.log('moments header:', body.match(/Moments[^|]{0,80}/)?.[0]?.slice(0, 90));
console.log('has error text:', /Error/i.test(body) ? body.match(/[^.]*Error[^.]{0,120}/)?.[0] : 'no');
console.log('tables:', await page.locator('table').count(), '| rows:', await page.locator('table tbody tr').count());
// pagination: click page 3 of moments if present
const pag = page.locator('.pagination').first();
if (await pag.locator('a', { hasText: '3' }).count()) {
  await pag.locator('a', { hasText: '3' }).first().click();
  await page.waitForTimeout(4000);
  console.log('after page 3 click, rows:', await page.locator('table tbody tr').count());
}
console.log('body sample:', body.slice(0, 400));
await browser.close();
