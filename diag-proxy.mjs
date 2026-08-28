import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const base = process.env.BASE || 'http://localhost:8787';
const exe = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true });

const loadHome = async (label) => {
  const context = await browser.newContext(); // fresh page, no in-memory caches
  const page = await context.newPage();
  const flowResponses = [];
  page.on('response', r => {
    if (r.url().includes('/flow/')) flowResponses.push({ status: r.status(), cache: r.headers()['x-flow-cache'] || '-', url: r.url().split('/').pop() });
  });
  page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)));
  const t0 = Date.now();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h3:has-text("Total Supply")', { timeout: 30000 });
  console.log(`${label}: home in ${((Date.now() - t0) / 1000).toFixed(1)}s; title="${await page.title()}"`);
  for (const r of flowResponses) console.log(`  flow call: ${r.status} ${r.cache} ${r.url}`);
  await context.close();
};

await loadHome('visit 1 (expect MISS)');
await loadHome('visit 2 (expect HIT)');

// plays through the proxy in a fresh context, timed
const context = await browser.newContext();
const page = await context.newPage();
let miss = 0, hit = 0;
page.on('response', r => {
  if (r.url().includes('/flow/')) {
    const c = r.headers()['x-flow-cache'];
    if (c === 'HIT') hit++; else if (c === 'MISS') miss++;
  }
});
let t0 = Date.now();
await page.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: 120000 });
console.log(`plays cold: ${((Date.now() - t0) / 1000).toFixed(1)}s (MISS ${miss} / HIT ${hit}); title="${await page.title()}"`);
await context.close();

const context2 = await browser.newContext();
const page2 = await context2.newPage();
let miss2 = 0, hit2 = 0;
page2.on('response', r => {
  if (r.url().includes('/flow/')) {
    const c = r.headers()['x-flow-cache'];
    if (c === 'HIT') hit2++; else if (c === 'MISS') miss2++;
  }
});
t0 = Date.now();
await page2.goto(base + '/plays', { waitUntil: 'domcontentloaded' });
await page2.waitForSelector('table tbody tr', { timeout: 120000 });
console.log(`plays warm (new visitor): ${((Date.now() - t0) / 1000).toFixed(1)}s (MISS ${miss2} / HIT ${hit2})`);
await context2.close();

await browser.close();
