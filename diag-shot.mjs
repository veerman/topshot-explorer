import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const base = process.env.BASE || 'http://localhost:5081';
const out = process.env.OUT || 'shot';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));

await page.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 120000 });
await page.screenshot({ path: `${out}-plays.png`, clip: { x: 0, y: 0, width: 1900, height: 500 } });

// search interaction
await page.locator('input[type=search]').fill('lebron');
await page.waitForTimeout(800);
console.log('plays search "lebron" info:', await page.locator('div', { hasText: /^Showing/ }).first().textContent());
await page.screenshot({ path: `${out}-plays-search.png`, clip: { x: 0, y: 0, width: 1900, height: 500 } });

await page.goto(base + '/sets/218', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 60000 });
await page.screenshot({ path: `${out}-set.png`, clip: { x: 0, y: 0, width: 1900, height: 500 } });
console.log('done');
await browser.close();
