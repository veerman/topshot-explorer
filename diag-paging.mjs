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
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR', m.text().slice(0, 200)); });

const topInfo = () => page.locator('div', { hasText: /^Showing/ }).first().textContent();
const bottomInfo = () => page.locator('.asrt-table-foot .col-md-6').first().textContent();
const top = () => page.locator('ul.pagination-sm');
const bottom = () => page.locator('.asrt-table-foot');

// ---- /plays ----
await page.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 120000 });
console.log('plays: menu options (expect 100, All):', (await page.locator('label select option').allTextContents()).join(', '));
console.log('plays: top info:', await topInfo());
await top().getByText('Next').click();
console.log('plays: after top Next:', await topInfo());
await top().getByText('Last').click();
console.log('plays: after top Last:', await topInfo());
console.log('plays: bottom info agrees:', await bottomInfo());
await top().getByText('First').click();
await bottom().getByText('Next').click();
await page.waitForTimeout(300);
console.log('plays: top info after bottom Next (expect 101 to 200):', await topInfo());
// select All while not on page 1 (regression: must snap back to page 1)
await page.locator('label select').selectOption({ label: 'All' });
await page.waitForTimeout(1500);
console.log('plays: after All (expect 1 to 9087):', await topInfo());
console.log('plays: rows after All:', await page.locator('table tbody tr').count());
// search via the top bar
await page.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 120000 });
await page.locator('input[type=search]').fill('lebron');
await page.waitForTimeout(800);
console.log('plays: search "lebron":', await topInfo());

// ---- /sets/218 ----
await page.goto(base + '/sets/218', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 60000 });
console.log('set218: menu options (expect 100, All):', (await page.locator('label select option').allTextContents()).join(', '));
console.log('set218: top info:', await topInfo());
console.log('set218: rows on page 1:', await page.locator('table tbody tr').count());

await browser.close();
