import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const base = process.env.BASE || 'http://localhost:5081';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));

// home should now be fast and show the two numbers
let t0 = Date.now();
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h3:has-text("Total Supply")', { timeout: 30000 });
console.log(`home loaded numbers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('home text:', (await page.textContent('h3:has-text("Total Supply")')).trim(), '|', (await page.textContent('h3:has-text("Current Series")')).trim());

// nav must be SPA navigation: a window marker must survive the click
await page.evaluate(() => { window.__spa_marker = 42; });
await page.getByRole('link', { name: 'Plays' }).click();
t0 = Date.now();
await page.waitForSelector('table tbody tr', { timeout: 120000 });
const marker = await page.evaluate(() => window.__spa_marker);
console.log(`plays via nav in ${((Date.now() - t0) / 1000).toFixed(1)}s; SPA marker (expect 42):`, marker);

// navigate away and back: plays should come from the in-memory cache, near-instant
await page.getByRole('link', { name: 'Topshot Explorer' }).click();
await page.waitForSelector('h3:has-text("Total Supply")', { timeout: 30000 });
await page.getByRole('link', { name: 'Plays' }).click();
t0 = Date.now();
await page.waitForSelector('table tbody tr', { timeout: 30000 });
console.log(`plays revisit (cached) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// set page via nav dropdown
await page.getByText('s8 sets').click();
await page.getByText('Base Set').first().click();
await page.waitForSelector('table tbody tr', { timeout: 60000 });
console.log('set page title:', (await page.textContent('h1')).replace(/\s+/g, ' ').trim());
console.log('SPA marker still (expect 42):', await page.evaluate(() => window.__spa_marker));

await browser.close();
