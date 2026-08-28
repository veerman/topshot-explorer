import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://localhost:5080';
const pagesToCheck = [
  { path: '/', waitFor: 'table, .table, a[href="/plays"]', label: 'home' },
  { path: '/plays', waitFor: 'table tbody tr, .table tr', label: 'plays', timeout: 180000 },
  { path: '/sets/218', waitFor: 'table tbody tr, .table tr', label: 'set 218', timeout: 120000 },
];

const exePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
import { existsSync } from 'fs';
const exe = exePaths.find(p => existsSync(p));
if (!exe) { console.error('NO BROWSER FOUND'); process.exit(1); }
console.log('using', exe);

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();

for (const p of pagesToCheck) {
  const errors = [];
  const failedReqs = [];
  const onConsole = m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); };
  const onReqFail = r => failedReqs.push(`${r.method()} ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`);
  page.on('console', onConsole);
  page.on('requestfailed', onReqFail);
  const t0 = Date.now();
  try {
    await page.goto(base + p.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(p.waitFor, { timeout: p.timeout ?? 60000 });
    const rows = await page.locator('table tr').count();
    const bodyLen = (await page.textContent('body'))?.length ?? 0;
    const sample = (await page.textContent('body'))?.slice(0, 200).replace(/\s+/g, ' ');
    console.log(`\n[${p.label}] OK in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${rows} table rows, body ${bodyLen} chars`);
    console.log(`  sample: ${sample}`);
  } catch (e) {
    console.log(`\n[${p.label}] FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(e).slice(0, 300)}`);
    const sample = (await page.textContent('body').catch(() => ''))?.slice(0, 300).replace(/\s+/g, ' ');
    console.log(`  body: ${sample}`);
  }
  if (errors.length) console.log(`  console errors (${errors.length}): ${errors.slice(0, 5).join(' | ')}`);
  if (failedReqs.length) console.log(`  failed requests (${failedReqs.length}): ${failedReqs.slice(0, 5).join(' | ')}`);
  page.off('console', onConsole);
  page.off('requestfailed', onReqFail);
}
await browser.close();
