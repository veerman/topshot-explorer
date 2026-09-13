// Headless smoke test over raw Chrome DevTools Protocol (no puppeteer):
// opens a URL, waits real time for the app to sync, reports console
// errors / exceptions and a text probe of the rendered page.
//
//   node scripts/dev/cdp-smoke.mjs <url> [waitMs] [probe|probe2|...]
//
// Environment knobs: SCRATCH (Chrome profile dir; default OS temp),
// PRESET_LS="key=value;;key2=__DELETE__" (localStorage before load),
// DESKTOP_WIDTH/DESKTOP_HEIGHT/DEVICE_SCALE or MOBILE_WIDTH (viewport),
// EVAL (an expression evaluated in the page; awaited, printed as JSON),
// SCREENSHOT=<file.png>. Needs Chrome at the standard Windows path.
import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const [url, waitMs = "60000", probe = ""] = process.argv.slice(2);
// SCRATCH: where the throwaway Chrome profile lives (default: the OS temp dir)
const S = process.env.SCRATCH || join(tmpdir(), "topshot-explorer-smoke");
mkdirSync(`${S}/chrome-cdp-profile`, { recursive: true });
// CHROME_PATH overrides the default Windows install location
const chrome = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${S}/chrome-cdp-profile`, "--remote-debugging-port=9333", "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await (await fetch("http://127.0.0.1:9333/json")).json();
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) { console.log("chrome did not expose a page"); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") errors.push("EXCEPTION " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split("\n").slice(0, 3).join(" | "));
  if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    errors.push(msg.params.type.toUpperCase() + " " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
  }
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Runtime.enable");
await send("Page.enable");
// Headless pages never hold system focus, so element.focus() would fire
// no focus events without this
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
if (process.env.DESKTOP_WIDTH) {
  await send("Emulation.setDeviceMetricsOverride", { width: Number(process.env.DESKTOP_WIDTH), height: Number(process.env.DESKTOP_HEIGHT || 900), deviceScaleFactor: Number(process.env.DEVICE_SCALE || 1), mobile: false });
}
if (process.env.MOBILE_WIDTH) {
  await send("Emulation.setDeviceMetricsOverride", { width: Number(process.env.MOBILE_WIDTH), height: 900, deviceScaleFactor: 2, mobile: true });
}
// PRESET_LS="key=value": set a localStorage entry on the app origin first
// PRESET_LS="key=value;;key2=value2": set localStorage entries on the app
// origin first; the value __DELETE__ removes the key instead
if (process.env.PRESET_LS) {
  await send("Page.navigate", { url: new URL("/", url).href });
  await sleep(2500);
  for (const entry of process.env.PRESET_LS.split(";;")) {
    const i = entry.indexOf("=");
    const k = entry.slice(0, i), v = entry.slice(i + 1);
    const expr = v === "__DELETE__"
      ? `localStorage.removeItem(${JSON.stringify(k)})`
      : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`;
    await send("Runtime.evaluate", { expression: expr });
  }
}
await send("Page.navigate", { url });
await sleep(Number(waitMs));
const text = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
const body = text.result?.result?.value || "";
console.log("--- console errors/warnings:", errors.length);
errors.slice(0, 20).forEach((e) => console.log(e));
console.log("--- body text length", body.length);
for (const p of probe.split("|").filter(Boolean)) console.log(`${body.includes(p) ? "FOUND  " : "MISSING"} ${p}`);
console.log("--- first 600 chars of body:\n" + body.slice(0, 600));
if (process.env.EVAL) {
  const r = await send("Runtime.evaluate", { expression: process.env.EVAL, returnByValue: true, awaitPromise: true });
  console.log("--- eval:", JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text));
}
// SCREENSHOT=<file.png>: full-viewport capture after the wait (and any EVAL)
if (process.env.SCREENSHOT) {
  const { writeFileSync } = await import("fs");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.result.data, "base64"));
  console.log("--- screenshot saved", process.env.SCREENSHOT);
}
ws.close();
chrome.kill();
