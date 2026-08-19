import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const EDGE = process.env.E2E_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9223;
const root = process.env.E2E_ROOT || "http://127.0.0.1:4173";
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "poe2-e2e-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let id = 0, ws;
const pending = new Map();
const events = [];
async function connect() {
  for (let i = 0; i < 60; i++) { try { const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const page = pages.find(p => p.type === 'page' && (p.url === 'about:blank' || p.url.startsWith('http'))) || pages.find(p => p.type === 'page'); if (page?.webSocketDebuggerUrl) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else events.push(m); }; }); return; } } catch {} await sleep(100); }
  throw new Error("CDP unavailable");
}
function cdp(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id:n, method, params })); }); }
async function js(expression) { const r = await cdp("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function nav(url) { await cdp("Page.navigate", { url }); for (let i=0;i<80;i++) { if (await js("document.readyState === 'complete'")) return; await sleep(100); } }
async function click(selector) { await cdp("Page.bringToFront"); await js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`); const p = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`); if (!p) throw new Error(`missing ${selector}`); await cdp("Input.dispatchMouseEvent", {type:"mousePressed",x:p.x,y:p.y,button:"left",buttons:1,clickCount:1}); await cdp("Input.dispatchMouseEvent", {type:"mouseReleased",x:p.x,y:p.y,button:"left",buttons:0,clickCount:1}); }
async function key(key, code, vk) { await cdp("Input.dispatchKeyEvent", {type:"keyDown",key,code,windowsVirtualKeyCode:vk}); await cdp("Input.dispatchKeyEvent", {type:"keyUp",key,code,windowsVirtualKeyCode:vk}); }
const result = { demo:{}, live:{} };
try {
  await connect(); await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Network.enable");
  await nav(`${root}/demo.html`); await sleep(500);
  result.demo.rowCount = await js("document.querySelectorAll('#routes tr.clickable').length");
  result.demo.demoBanner = await js("document.body.innerText.includes('DEMO DATA')");
  console.log('demo diagnostics', await js("({ready:document.readyState, body:document.body.innerText.slice(0,500), rows:document.querySelectorAll('#routes tr').length, clickable:document.querySelectorAll('#routes tr.clickable').length, scripts:[...document.scripts].map(s=>s.src)})"));
  await click("#routes tr.clickable"); await sleep(150); result.demo.mouseState = await js("({aria:document.querySelector('#drawer').getAttribute('aria-hidden'), cls:document.querySelector('#drawer').className, active:document.activeElement?.tagName, rect:(()=>{const r=document.querySelector('#routes tr.clickable').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})(), hit:(()=>{const r=document.querySelector('#routes tr.clickable').getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.tagName})()})"); result.demo.mouseActivation = await js("document.querySelector('#drawer').getAttribute('aria-hidden') === 'false'");
  await key("Escape","Escape",27); result.demo.escapeClose = await js("document.querySelector('#drawer').getAttribute('aria-hidden') === 'true'");
  await js("document.querySelector('#routes tr.clickable').focus()"); await key("Enter","Enter",13); result.demo.keyboardActivation = await js("document.querySelector('#drawer').getAttribute('aria-hidden') === 'false'");
  await js("document.querySelector('.close').click()"); result.demo.closeButton = await js("document.querySelector('#drawer').getAttribute('aria-hidden') === 'true'");
  result.demo.focusRestoration = await js("document.activeElement?.id === 'routes' || document.activeElement?.tagName === 'BODY' || document.activeElement?.tagName === 'TR'");
  await cdp("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:2,mobile:true}); await cdp("Page.reload", {ignoreCache:true}); await sleep(500);
  result.demo.mobile = await js("document.documentElement.scrollWidth <= innerWidth + 2 && document.querySelector('#drawer').getBoundingClientRect().width <= innerWidth");
  const eventStart = events.length; await nav(`${root}/index.html`); await sleep(500);
  result.live.rowCount = await js("document.querySelectorAll('#routes tr.clickable').length");
  result.live.demoBanner = await js("document.body.innerText.includes('DEMO DATA')");
  const liveEvents = events.slice(eventStart);
  result.live.demoRequests = liveEvents.filter(e=>e.method==='Network.requestWillBeSent' && /demo|fixture/i.test(e.params.request.url)).map(e=>e.params.request.url);
  result.live.consoleErrors = liveEvents.filter(e=>e.method==='Runtime.consoleAPICalled' && e.params.type==='error').map(e=>e.params.args.map(a=>a.value ?? a.description ?? '').join(' '));
  result.live.failedRequests = liveEvents.filter(e=>e.method==='Network.loadingFailed' && !e.params.canceled).map(e=>e.params.errorText);
  console.log(JSON.stringify(result,null,2));
  if (!result.demo.mouseActivation || !result.demo.keyboardActivation || !result.demo.escapeClose || !result.demo.closeButton || !result.demo.mobile || result.live.demoBanner || result.live.demoRequests.length || result.live.consoleErrors.length || result.live.failedRequests.length) process.exitCode=1;
} catch (e) { console.error(e.stack); process.exitCode=1; } finally { edge.kill(); }
