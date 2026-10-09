#!/usr/bin/env node
/**
 * Regenerates the user-manual screenshots (docs/manual/images/*.png) from a DEMO instance with 100% synthetic data.
 *
 *   node docs/manual/tools/capture.mjs
 *
 * What it does (no network, no real data, no npm dependencies):
 *  1. Phase A: starts demo-server.ts on port 3100 with a fresh temp data dir (/tmp/social-demo-*) and drives the real UI
 *     through connection creation, discovery and account selection (shots 01-04).
 *  2. Phase B: seeds a second temp data dir with seed-demo.ts, restarts the demo server on it and drives the rest (05-21).
 *  Chrome (headless, throwaway profile) is driven over the DevTools protocol with Node's built-in WebSocket.
 *  Only the processes started here are stopped (by PID). The real app on :3000 and ./data are never touched.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const IMAGES = join(ROOT, 'docs/manual/images');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const VIEW_W = 1280;
const VIEW_H = 860;
const SCALE = 1.5;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => process.stdout.write(`[capture] ${message}\n`);
const warnings = [];
const produced = [];

/* ---------------------------------- processes ---------------------------------- */

const children = []; // { name, child }

function spawnTracked(name, command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => { if (process.env.CAPTURE_DEBUG) process.stderr.write(`[${name}] ${chunk}`); });
  children.push({ name, child });
  return child;
}

async function stopChild(entry) {
  const { child } = entry;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
    server.on('error', fail);
  });
}

async function startServer(dataDir) {
  const child = spawnTracked('demo-server', process.execPath, ['--import', 'tsx', 'docs/manual/tools/demo-server.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), LOCAL_SOCIAL_DATA_DIR: dataDir },
  });
  const entry = children.find((item) => item.child === child);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('demo server exited early (run with CAPTURE_DEBUG=1)');
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return entry;
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error('demo server did not become ready');
}

async function runSeed(dataDir) {
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'docs/manual/tools/seed-demo.ts'], {
      cwd: ROOT, env: { ...process.env, LOCAL_SOCIAL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => { if (code === 0) { log(`seed: ${out.trim()}`); done(); } else fail(new Error(`seed failed: ${out}`)); });
  });
}

/* ------------------------------------ CDP ------------------------------------ */

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((done, fail) => { this.ws.addEventListener('open', done); this.ws.addEventListener('error', fail); });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: ok, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`)); else ok(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((ok, reject) => {
      this.pending.set(id, { resolve: ok, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((done) => {
      const list = this.listeners.get(method) ?? [];
      const listener = (params) => { this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== listener)); done(params); };
      list.push(listener);
      this.listeners.set(method, list);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Page-side helpers (installed on every document).
const PAGE_HELPERS = `
(() => {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  window.__h = {
    find(selector, wanted, exact = true) {
      return [...document.querySelectorAll(selector)].filter(visible).find((el) => exact ? text(el) === wanted : text(el).includes(wanted)) || null;
    },
    click(selector, wanted, exact = true) {
      const el = this.find(selector, wanted, exact);
      if (!el) throw new Error('not found: ' + selector + ' ' + wanted);
      el.scrollIntoView({ block: 'center' }); el.click(); return true;
    },
    control(label) {
      const field = [...document.querySelectorAll('label.field')].filter(visible).find((l) => { const s = l.querySelector(':scope > span'); return s && text(s).startsWith(label); });
      return field ? field.querySelector('input, select, textarea') : null;
    },
    focus(label) {
      const el = this.control(label);
      if (!el) throw new Error('no control: ' + label);
      el.scrollIntoView({ block: 'center' }); el.focus(); if (el.select) el.select(); return true;
    },
    setSelect(el, value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
    },
    selectByLabel(label, value) {
      const el = this.control(label); if (!el) throw new Error('no select: ' + label);
      return this.setSelect(el, value);
    },
    selectByOptionText(el, optionText) {
      const option = [...el.options].find((o) => text(o).includes(optionText));
      if (!option) throw new Error('no option: ' + optionText);
      return this.setSelect(el, option.value);
    },
    busy() { return !!document.querySelector('.loading-line'); },
    errorToast() { const el = document.querySelector('.toast.error'); return el ? text(el) : ''; },
    dismissToasts() { document.querySelectorAll('.toast button').forEach((b) => b.click()); },
    overflow() { return document.documentElement.scrollWidth - document.documentElement.clientWidth; },
  };
})();
`;

/* --------------------------------- browser driver --------------------------------- */

class Browser {
  async launch() {
    const debugPort = await freePort();
    this.profile = mkdtempSync('/tmp/social-demo-chrome-');
    spawnTracked('chrome', CHROME, [
      '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${this.profile}`,
      `--window-size=${VIEW_W},${VIEW_H}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--disable-extensions', '--disable-background-networking', '--lang=es-CO', '--accept-lang=es-CO,es', '--mute-audio',
      '--disable-features=Translate', 'about:blank',
    ], {});
    let target;
    for (let attempt = 0; attempt < 60 && !target; attempt++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((item) => item.type === 'page');
      } catch { /* not ready */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Chrome DevTools endpoint not available');
    this.cdp = new Cdp(target.webSocketDebuggerUrl);
    await this.cdp.ready;
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HELPERS });
    await this.cdp.send('Emulation.setLocaleOverride', { locale: 'es-CO' }).catch(() => {});
    await this.metrics(VIEW_W, VIEW_H, SCALE, false);
  }

  async metrics(width, height, scale = SCALE, mobile = false) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    this.size = { width, height, scale, mobile };
  }

  async eval(expression) {
    const result = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async goto(url) {
    const loaded = this.cdp.once('Page.loadEventFired');
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    await this.waitFor('!!document.querySelector("main.page")');
  }

  async waitFor(expression, timeout = 30000, label = expression) {
    const started = Date.now();
    for (;;) {
      let value = false;
      try { value = await this.eval(`!!(${expression})`); } catch { value = false; }
      if (value) return value;
      if (Date.now() - started > timeout) throw new Error(`Timed out waiting for: ${label}`);
      await sleep(120);
    }
  }

  async settle() {
    await this.waitFor('!window.__h.busy()', 30000, 'data loaded');
    await sleep(500);
  }

  click(selector, text, exact = true) { return this.eval(`window.__h.click(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${exact})`); }
  nav(label) { return this.click('nav button', label); }

  async fill(label, value) {
    await this.eval(`window.__h.focus(${JSON.stringify(label)})`);
    await this.cdp.send('Input.insertText', { text: value });
  }

  async scrollTop() { await this.eval('window.scrollTo(0, 0)'); }

  async check() {
    const problem = await this.eval('window.__h.errorToast()');
    if (problem) throw new Error(`Error toast on screen: ${problem}`);
  }

  async prepare() {
    await this.eval('window.__h.dismissToasts(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();');
    await this.check();
    await sleep(250);
  }

  /** Saves a screenshot. fit: grow the viewport to the full page height (so nothing is cut); clip: {x,y,width,height} in CSS px. */
  async shot(name, { fit = true, clip, element, pad = 12, maxHeight = 2400 } = {}) {
    await this.prepare();
    await this.scrollTop();
    const overflow = await this.eval('window.__h.overflow()');
    if (overflow > 0) warnings.push(`${name}: horizontal overflow of ${overflow}px`);
    const base = { ...this.size };
    let params = { format: 'png', fromSurface: true, captureBeyondViewport: false };
    if (element) {
      const rect = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(element)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      if (!rect) throw new Error(`element not found: ${element}`);
      const x = Math.max(0, rect.x - pad); const y = Math.max(0, rect.y - pad);
      params = { ...params, captureBeyondViewport: true, clip: { x, y, width: Math.min(base.width - x, rect.width + pad * 2), height: rect.height + pad * 2, scale: 1 } };
    } else if (clip) {
      params = { ...params, clip: { ...clip, scale: 1 } };
    } else if (fit) {
      const height = await this.eval('Math.ceil(document.documentElement.scrollHeight)');
      const target = Math.min(Math.max(height, base.height), maxHeight);
      if (target !== base.height) { await this.metrics(base.width, target, base.scale, base.mobile); await sleep(350); }
      const settled = await this.eval('Math.ceil(document.documentElement.scrollHeight)');
      if (settled > target + 4 && settled <= maxHeight) { await this.metrics(base.width, settled, base.scale, base.mobile); await sleep(300); }
    }
    const { data } = await this.cdp.send('Page.captureScreenshot', params);
    if (this.size.height !== base.height) await this.metrics(base.width, base.height, base.scale, base.mobile);
    const file = join(IMAGES, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    produced.push(`${name}.png`);
    log(`saved ${name}.png`);
  }

  async close() {
    this.cdp?.close();
  }
}

/* ------------------------------------ scenarios ------------------------------------ */

const FAKE_TOKEN = 'DEMO-TOKEN-NOT-REAL';

async function phaseA(browser) {
  log('Phase A: fresh data directory (first run)');
  await browser.goto(BASE);
  await browser.waitFor('window.__h.find("h3", "Primeros pasos")');
  await browser.waitFor('window.__h.find("button.mode-pill", "Dry Run · Activo")');
  await browser.settle();
  await browser.shot('01-dashboard-onboarding');

  await browser.nav('Conexiones');
  await browser.waitFor('window.__h.find("strong", "Aún no hay conexiones")');
  await browser.settle();
  await browser.shot('02-connections-empty');

  // Real UI flow: save a (fake) connection, validate and discover, then select the account.
  await browser.fill('Nombre', 'Mi cuenta de Instagram');
  await browser.fill('Token de acceso', FAKE_TOKEN);
  await browser.click('button', 'Guardar conexión cifrada');
  await browser.waitFor('window.__h.find("button", "Probar y descubrir")');
  await browser.settle();
  await browser.click('button', 'Probar y descubrir');
  await browser.waitFor('window.__h.find("strong", "@tu_otra_cuenta") && window.__h.find("span.status-badge", "Validada", false)', 30000, 'discovered accounts');
  await browser.settle();
  await browser.shot('04-discover-accounts');

  await browser.eval(`(() => { const row = [...document.querySelectorAll('.list-row')].find((r) => r.textContent.includes('@tu_cuenta') && r.querySelector('button')); row.querySelector('button').click(); return true; })()`);
  await browser.waitFor('[...document.querySelectorAll("span.muted")].some((s) => s.textContent.startsWith("Validada ·"))', 30000, 'account selected');
  await browser.settle();
  await browser.shot('03-connection-saved');
}

async function pickAccountFilter(browser) {
  // Seeded data has a single selected account, which the app auto-selects; make sure it is the chosen filter.
  await browser.waitFor('[...document.querySelectorAll("select[aria-label=\\"Filtrar por cuenta\\"] option")].some((o) => o.textContent === "@tu_cuenta")');
  await browser.eval(`(() => { const s = document.querySelector('select[aria-label="Filtrar por cuenta"]'); const o = [...s.options].find((x) => x.textContent === '@tu_cuenta'); window.__h.setSelect(s, o.value); return true; })()`);
  await browser.settle();
}

async function phaseB(browser) {
  log('Phase B: seeded data directory');
  await browser.goto(BASE);
  await browser.waitFor('window.__h.find("button.mode-pill", "Dry Run · Activo")');
  await pickAccountFilter(browser);

  // 05 Publicaciones
  await browser.nav('Publicaciones');
  await browser.waitFor('document.querySelectorAll(".media-card").length === 8', 30000, '8 publications');
  await browser.settle();
  await browser.shot('05-publications');

  // 06 New general automation form (filled, not submitted)
  await browser.nav('Automatizaciones');
  await browser.waitFor('window.__h.control("Palabras clave")');
  await browser.settle();
  await browser.eval(`window.__h.selectByOptionText(window.__h.control('Publicación'), 'Todas las publicaciones')`);
  await browser.fill('Nombre', 'Guía gratuita');
  await browser.fill('Palabras clave', 'guia');
  await browser.fill('Respuesta', 'Hola {{username}}, ¡gracias por comentar! Aquí tienes tu guía gratuita sobre {{keyword}}.');
  await browser.fill('Botón URL opcional', 'Descargar guía');
  await browser.fill('URL HTTPS', 'https://ejemplo.com/guia');
  await browser.fill('Segundo botón · título', 'Ver más');
  await browser.fill('Segundo botón · URL', 'https://ejemplo.com/mas');
  await browser.eval(`document.getElementById('new-public-enabled').click()`);
  await browser.waitFor('document.getElementById("new-public-variants")');
  await browser.fill('Variantes de la respuesta pública', [
    '¡Listo @{{username}}! Te escribí por mensaje privado 💌',
    'Revisa tu bandeja de entrada, @{{username}} 📬',
    '@{{username}} ya te envié la {{keyword}} por privado',
    '¡Gracias por comentar, @{{username}}! Te la mandé por DM ✨',
    'Hecho, @{{username}}: mira tus mensajes 😉',
    '@{{username}} te respondí por mensaje directo, revísalo 🙌',
    '¡Enviado, @{{username}}! Si no te llega, avísame',
    'Ya está en tu bandeja, @{{username}}. ¡Disfrútala!',
  ].join('\n'));
  await browser.waitFor('document.querySelector(".preview-box li")');
  await sleep(300);
  await browser.shot('06-automation-new-general');

  // 07 List of automations (reload to drop the unsaved form)
  await browser.goto(BASE);
  await browser.waitFor('window.__h.find("button.mode-pill", "Dry Run · Activo")');
  await browser.nav('Automatizaciones');
  await browser.waitFor('document.querySelectorAll(".automation-row").length === 2', 30000, '2 automations');
  await browser.settle();
  await browser.shot('07-automation-list');

  // 08 Edit dialog of the general automation
  await browser.eval(`(() => { const row = [...document.querySelectorAll('.automation-row')].find((r) => r.textContent.includes('Guía gratuita')); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Editar').click(); return true; })()`);
  await browser.waitFor('document.querySelector(".modal.wide")');
  await sleep(500);
  await browser.metrics(VIEW_W, 1100);
  await sleep(300);
  await browser.shot('08-automation-edit', { fit: false });
  await browser.metrics(VIEW_W, VIEW_H);
  await browser.click('.modal-actions button', 'Cancelar');
  await sleep(300);

  // 09/10 Pending review: analysis with progress, then the finished summary
  // The pending table is wide: use a wider viewport for this section so no column is cut off.
  await browser.metrics(1700, VIEW_H);
  await browser.nav('Revisión pendiente');
  await browser.waitFor('window.__h.find("span.count-badge", "6 pendientes")', 30000, '6 pending');
  await browser.settle();
  await browser.eval(`window.__h.selectByLabel('Ventana', '7d')`);
  await browser.click('button#backlog-start', 'Iniciar análisis');
  await browser.waitFor(`(() => { const f = document.querySelector('.progress-fill'); if (!f) return false; const w = parseFloat(f.style.width); return w >= 25 && w <= 75; })()`, 40000, 'progress between 25% and 75%');
  await sleep(200);
  await browser.shot('09-review-progress');
  await browser.waitFor('document.querySelector(".scan-summary")', 60000, 'scan summary');
  await browser.waitFor('window.__h.find("span.count-badge", "6 pendientes")', 30000, '6 pending after analysis');
  await browser.settle();
  await browser.shot('10-review-summary');

  // 11 Pending list with one message preview expanded
  await browser.eval(`(() => { const d = document.querySelector('.pending-review details.message-preview'); d.open = true; document.querySelectorAll('.table-wrap').forEach((w) => { w.scrollLeft = 0; }); return true; })()`);
  await sleep(300);
  await browser.shot('11-review-list-preview');

  // 12 Confirmation dialog (cancelled afterwards: nothing is queued)
  await browser.eval(`(() => { const s = [...document.querySelectorAll('label.field')].find((l) => l.textContent.startsWith('Procesar con automatización')).querySelector('select'); window.__h.selectByOptionText(s, 'Guía gratuita'); return true; })()`);
  await sleep(300);
  await browser.click('button', 'Seleccionar todos los visibles');
  await sleep(300);
  await browser.click('button', 'Procesar selección revisada');
  await browser.waitFor('document.querySelector(".modal")');
  await sleep(400);
  await browser.shot('12-review-confirm', { fit: false });
  await browser.click('.modal-actions button', 'Cancelar');
  await sleep(300);

  // 13-15 Queue and history
  await browser.nav('Cola e historial');
  await browser.waitFor('document.querySelectorAll("tbody tr").length >= 10', 30000, 'queue rows');
  await browser.settle();
  await browser.shot('13-queue-list');
  await browser.metrics(VIEW_W, VIEW_H);

  await setQueueFilter(browser, 'Enviado');
  await browser.eval(`document.querySelector('tbody tr .text-button').click()`);
  await browser.waitFor('document.querySelector(".readback-check") && document.querySelector(".attempt-list")', 30000, 'sent detail');
  await browser.waitFor('[...document.querySelectorAll(".attempt-list")].some((a) => a.textContent.includes("Lectura confirmada"))', 30000, 'readback line');
  await browser.settle();
  await browser.shot('14-queue-detail-sent');

  await setQueueFilter(browser, 'Simulado');
  await browser.eval(`document.querySelector('tbody tr .text-button').click()`);
  await browser.waitFor('[...document.querySelectorAll(".queue-message strong")].some((s) => s.textContent.includes("WOULD_REPLY_PUBLIC"))', 30000, 'simulated detail');
  await browser.settle();
  await browser.shot('15-queue-simulated');
  await setQueueFilter(browser, 'Todos los estados');

  // 16 Monitoring (viewed, not started)
  await browser.nav('Monitoreo');
  await browser.waitFor('window.__h.find("button", "Iniciar todas")');
  await browser.settle();
  await browser.shot('16-monitor');

  // 17-19 Mode: Dry Run, confirmation dialog, real mode, and back
  await browser.nav('Resumen');
  await browser.settle();
  const header = await browser.eval(`(() => { const b = document.querySelector('.mode-banner').getBoundingClientRect(); const s = { right: 0 }; return { x: Math.round(s.right), bottom: Math.ceil(b.bottom) + 14 }; })()`);
  const headerClip = { x: header.x, y: 0, width: VIEW_W - header.x, height: header.bottom };
  await browser.shot('17-mode-dryrun-banner', { fit: false, clip: headerClip });

  await browser.click('button.mode-pill', 'Dry Run · Activo');
  await browser.waitFor('document.querySelector(".modal")');
  await sleep(400);
  await browser.shot('19-mode-confirm-dialog', { fit: false });
  await browser.click('.modal-actions button', 'Desactivar Dry Run');
  await browser.waitFor('window.__h.find("button.mode-pill", "Modo real · Activo")');
  await browser.settle();
  await browser.shot('18-mode-real-banner', { fit: false, clip: headerClip });
  await browser.click('button.mode-pill', 'Modo real · Activo'); // back to Dry Run (no confirmation needed)
  await browser.waitFor('window.__h.find("button.mode-pill", "Dry Run · Activo")');
  await browser.settle();

  // 20 Settings
  await browser.nav('Ajustes');
  await browser.waitFor('window.__h.find("strong", "Modo de envío")');
  await browser.settle();
  await browser.shot('20-settings');

  // 21 Mobile (375 px, scale 2)
  await browser.metrics(375, 812, 2, true);
  await browser.goto(BASE);
  await browser.waitFor('window.__h.find("button.mode-pill", "Dry Run · Activo")');
  await browser.waitFor('window.__h.find("h3", "Primeros pasos")');
  await browser.settle();
  await browser.shot('21-mobile', { fit: true, maxHeight: 3200 });
  await browser.metrics(VIEW_W, VIEW_H, SCALE, false);
}

async function setQueueFilter(browser, label) {
  await browser.eval(`(() => { const s = document.querySelector('.queue-filter select'); window.__h.selectByOptionText(s, ${JSON.stringify(label)}); return true; })()`);
  await browser.settle();
  await browser.waitFor(label === 'Todos los estados' ? 'document.querySelectorAll("tbody tr").length >= 10' : 'document.querySelectorAll("tbody tr").length >= 1', 30000, 'queue filter');
}

/* -------------------------------------- main -------------------------------------- */

async function main() {
  mkdirSync(IMAGES, { recursive: true });
  const dirs = [];
  const browser = new Browser();
  try {
    await browser.launch();

    const dirA = mkdtempSync('/tmp/social-demo-a-');
    dirs.push(dirA);
    const serverA = await startServer(dirA);
    await phaseA(browser);
    await stopChild(serverA);

    const dirB = mkdtempSync('/tmp/social-demo-b-');
    dirs.push(dirB);
    await runSeed(dirB);
    const serverB = await startServer(dirB);
    await phaseB(browser);
    await stopChild(serverB);
  } finally {
    await browser.close();
    for (const entry of [...children].reverse()) await stopChild(entry);
    await sleep(300);
    for (const dir of [...dirs, browser.profile].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
  }
  log(`done: ${produced.length} images`);
  if (warnings.length) log(`WARNINGS:\n  ${warnings.join('\n  ')}`);
}

main().catch((error) => {
  process.stderr.write(`[capture] FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
