#!/usr/bin/env node
/**
 * End-to-end raw-PII leak test.
 *
 * Drives the real built extension in headless Chrome over the DevTools Protocol. No test
 * framework and no new dependency: Node 22 ships a native WebSocket, and Chrome exposes
 * Extensions.loadUnpacked so the extension can be installed into a throwaway profile.
 *
 * Why it exists: the original defect was a type="text" input holding a person's name being
 * emitted in ax_tree[].value verbatim, which no unit test would have caught because the bug
 * lived in the content script's DOM walk. This test runs that walk.
 *
 * Scope note: the content script is driven directly, so the on-device NER model is NOT
 * involved. That deliberately exercises the fail-closed path — when the entity pass does not
 * complete, node prose must be stripped rather than transmitted. A passing run here means the
 * *degraded* mode is safe, not that the ML path is covered.
 *
 * Run: npm run build && npm run test:e2e
 */
import { createServer } from 'http';
import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, '.output/chrome-mv3');
const PORT = 8123;
const DEBUG_PORT = 9333;
const CHROME = process.env.CHROME_PATH || 'google-chrome';

if (!existsSync(EXT_DIR)) {
  console.error('Extension not built. Run: npm run build');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };

function serveFixture() {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const file = path === '/' ? '/test-pii.html' : path;
    const full = join(ROOT, 'public', file);
    if (!full.startsWith(join(ROOT, 'public')) || !existsSync(full)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(readFileSync(full));
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45000);
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await serveFixture();
  const profile = mkdtempSync(join(tmpdir(), 'vision-e2e-'));
  // Chrome 137+ ignores --load-extension unless unsafe extension debugging is enabled, so the
  // extension is installed over CDP instead. --disable-extensions-except is deliberately not
  // passed: Extensions.loadUnpacked is the supported path in this Chrome.
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let chromeErr = '';
  chrome.stderr.on('data', (d) => (chromeErr += d.toString()));

  let cdp;
  const failures = [];
  const passes = [];
  const check = (name, ok, detail = '') => (ok ? passes : failures).push(`${name}${detail ? ` — ${detail}` : ''}`);

  try {
    // Wait for the DevTools endpoint.
    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (r.ok) version = await r.json();
      } catch {}
      if (!version) await sleep(250);
    }
    if (!version) throw new Error(`Chrome DevTools never came up.\n${chromeErr.slice(-600)}`);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });

    // Open the fixture over http so the content script injects (extension pages never do).
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${PORT}/test-pii.html`,
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    // The content script lives in an isolated world. Its execution context is reported by
    // Runtime.executionContextCreated with auxData.type === 'isolated'.
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));
    await cdp.send('Runtime.enable', {}, sessionId);

    let iso = null;
    for (let i = 0; i < 60 && !iso; i++) {
      iso = contexts.find((c) => c.auxData?.type === 'isolated' && c.origin?.startsWith('chrome-extension://')) || null;
      if (!iso) await sleep(250);
    }
    if (!iso) {
      throw new Error(
        `content script never injected an isolated world (extension ${extId}). ` +
          `The fixture must be served over http and the page must finish loading.`,
      );
    }

    const probe = await cdp.send(
      'Runtime.evaluate',
      { expression: 'typeof window.__visionBuildContext', contextId: iso.id, returnByValue: true },
      sessionId,
    );
    if (probe.result?.value !== 'function') {
      throw new Error('content script injected but __visionBuildContext is missing');
    }
    check('content script injected', true, `extension ${extId}`);

    // Run the real context build.
    const res = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          const c = await window.__visionBuildContext({ task: 'click Submit', includeScreenshot: false });
          return {
            pii_text_scan_complete: c.pii_text_scan_complete,
            redaction_scheme: c.redaction_scheme,
            metrics: c.metrics,
            regions: c.redacted_regions,
            nodes: c.ax_tree,
          };
        })()`,
        contextId: iso.id,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`buildSanitizedContext threw: ${JSON.stringify(res.exceptionDetails).slice(0, 500)}`);
    }
    const ctx = res.result?.value;
    if (!ctx) throw new Error('no context returned');

    check('context built', Array.isArray(ctx.nodes) && ctx.nodes.length > 0, `${ctx.nodes.length} nodes`);
    check(
      'fail-closed flag reported honestly',
      ctx.pii_text_scan_complete === false,
      `pii_text_scan_complete=${ctx.pii_text_scan_complete} (no ML in this harness)`,
    );

    // ---- Leak assertions --------------------------------------------------
    // Serialise exactly what would cross the network boundary.
    const wire = JSON.stringify({ nodes: ctx.nodes, regions: ctx.regions });

    const MUST_NOT_APPEAR = [
      ['person name (type=text input)', 'John Doe'],
      ['person name (page prose)', 'Arjun Sharma'],
      ['credit card', '4111 1111 1111 1111'],
      ['ssn', '123-45-6789'],
      ['password', 's3cr3tP@ss!'],
      ['phone', '+91 98765 43210'],
      ['phone (bare)', '99988 77766'],
      ['email', 'john.doe@example.com'],
      ['email (bare)', 'arjun.sharma@company.co.in'],
      ['aadhaar', '1234 5678 9012'],
      ['pan', 'ABCDE1234F'],
      ['ip address', '192.168.1.42'],
    ];
    for (const [label, needle] of MUST_NOT_APPEAR) {
      check(`no raw ${label}`, !wire.includes(needle), wire.includes(needle) ? `LEAKED "${needle}"` : '');
    }

    // Every form value must be a placeholder, whatever its classification.
    const rawValues = (ctx.nodes || []).filter(
      (n) =>
        ['input', 'textarea'].includes(n.tag) &&
        typeof n.value === 'string' &&
        n.value !== '' &&
        !n.value.startsWith('[REDACTED'),
    );
    check(
      'every form value is a placeholder',
      rawValues.length === 0,
      rawValues.length ? `${rawValues.length} raw: ${rawValues.map((n) => n.value).join(', ')}` : `${(ctx.nodes || []).filter((n) => ['input', 'textarea'].includes(n.tag)).length} fields`,
    );

    // The word "Password" as a label is not PII and must survive, or the AX tree degrades.
    const passwordLabelKept = (ctx.nodes || []).some((n) => /^password$/i.test((n.name || '').trim()));
    check('"Password" label not over-redacted', passwordLabelKept);

    // Labels the executor matches on must survive.
    for (const label of ['Email', 'Phone', 'Cardholder', 'Card Number']) {
      check(`label "${label}" preserved`, (ctx.nodes || []).some((n) => (n.name || '').trim() === label));
    }

    // Structured PII must still be *detected*, not merely absent.
    const types = new Set((ctx.regions || []).map((r) => r.type));
    for (const t of ['CREDIT_CARD', 'SSN', 'AADHAAR', 'PAN', 'EMAIL', 'PHONE', 'IP_ADDRESS', 'PASSWORD']) {
      check(`region typed ${t}`, types.has(t), types.has(t) ? '' : `got: ${[...types].join(',')}`);
    }

    // No box may be claimed by two different PII types.
    const byBox = new Map();
    for (const r of ctx.regions || []) {
      const k = (r.bbox || []).join(',');
      if (!byBox.has(k)) byBox.set(k, new Set());
      byBox.get(k).add(r.type);
    }
    const conflicts = [...byBox.entries()].filter(([, t]) => t.size > 1);
    check('no box claimed by two PII types', conflicts.length === 0, conflicts.length ? `${conflicts.length} conflicting` : '');

    // All region coordinates must be non-negative integers (the server validates these).
    const badBox = (ctx.regions || []).find((r) =>
      (r.bbox || []).some((v) => !Number.isInteger(v) || v < 0),
    );
    check('region bboxes are non-negative integers', !badBox, badBox ? JSON.stringify(badBox.bbox) : '');

    // Regions must live in the same frame of reference as the AX tree. A box below the fold
    // cannot be masked on a viewport-sized screenshot and is not actionable.
    const viewport = await cdp.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})', contextId: iso.id, returnByValue: true },
      sessionId,
    );
    const vp = JSON.parse(viewport.result?.value || '{"w":0,"h":0}');
    const offScreen = (ctx.regions || []).filter(
      (r) => (r.bbox || [])[1] + (r.bbox || [])[3] > vp.h || (r.bbox || [])[0] + (r.bbox || [])[2] > vp.w,
    );
    check(
      'all regions inside the viewport',
      offScreen.length === 0,
      offScreen.length ? `${offScreen.length} outside ${vp.w}x${vp.h}: ${JSON.stringify(offScreen.slice(0, 3).map((r) => r.bbox))}` : `${(ctx.regions || []).length} regions in ${vp.w}x${vp.h}`,
    );

    console.log('\n--- ax_tree (role | name | value) ---');
    for (const n of (ctx.nodes || []).slice(0, 18)) {
      console.log(`  ${String(n.role).padEnd(8)} ${String(n.name).slice(0, 32).padEnd(34)} ${JSON.stringify(n.value)}`);
    }

    // Proves the typed message layer actually routes between contexts. The background creates
    // the offscreen document only when it handles a `scanText` message, and the content script
    // only sends one at the start of a scan. A broken protocol would leave no such target.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const hasOffscreen = targetInfos.some(
      (t) => t.url.includes(`chrome-extension://${extId}/offscreen.html`),
    );
    check(
      'typed messaging routes content -> background -> offscreen',
      hasOffscreen,
      hasOffscreen ? 'offscreen document created by the background' : 'offscreen document absent; the scanText message never reached the background',
    );
    console.log(`\n--- redacted_regions (${(ctx.regions || []).length}) ---`);
    for (const r of ctx.regions || []) console.log(`  ${String(r.type).padEnd(14)} ${JSON.stringify(r.bbox)}`);
  } finally {
    cdp?.close();
    chrome.kill('SIGKILL');
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }

  console.log('');
  for (const p of passes) console.log(`  PASS  ${p}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(`\ne2e error: ${e.message}`);
  process.exit(1);
});
