import './style.css';

const app = document.getElementById('app')!;

app.innerHTML = `
  <div class="wrap">
    <header>
      <h1>Vision Privacy Agent</h1>
      <span class="badge">on-device • WebGPU</span>
    </header>

    <section class="card">
      <label>Task for agent (server sees only sanitized data)</label>
      <input id="task" placeholder="e.g., Click Submit, Scroll down, Summarize page" />
      <div class="row">
        <label class="check"><input type="checkbox" id="includeShot" checked /> include redacted screenshot</label>
        <label class="check"><input type="checkbox" id="showMasks" checked /> show local masks</label>
      </div>
      <div class="row">
        <button id="btnSanitize" class="primary">1. Scan & Redact Locally</button>
        <button id="btnClear" class="ghost">Clear masks</button>
      </div>
      <div id="metrics" class="metrics hidden"></div>
      <div id="progress" class="progress hidden"><div class="bar"></div><span class="pct">0%</span></div>
      <pre id="contextPreview" class="preview hidden"></pre>
    </section>

    <section class="card">
      <div class="row space">
        <strong>2. Send sanitized context to server</strong>
        <span id="latency" class="muted"></span>
      </div>
      <div class="row">
        <input id="serverUrl" placeholder="http://localhost:8000" />
        <button id="btnSaveServer" class="ghost">Save</button>
      </div>
      <div class="row">
        <button id="btnAgent" class="primary">Ask Agent (sanitized only)</button>
        <button id="btnExecute" class="ghost" disabled>Execute action</button>
      </div>
      <pre id="agentOut" class="preview hidden"></pre>
      <div id="confirmRow" class="row hidden">
        <span class="muted">Fill actions need confirm:</span>
        <button id="btnConfirm" class="danger">Confirm Fill</button>
      </div>
    </section>

    <section class="card muted-card">
      <div class="tiny">Local ML: <span id="deviceInfo">detecting…</span> • <span id="storageInfo">storage: …</span> • No raw PII leaves device</div>
      <div class="row">
        <button id="btnPreload" class="ghost">Preload models</button>
        <button id="btnDispose" class="ghost">Free memory</button>
        <button id="btnTestPage" class="ghost">Open PII test page</button>
      </div>
      <div class="row">
        <label class="check">Quant: <select id="quantSel"><option value="q8">q8 (balanced)</option><option value="q4">q4 (low-RAM)</option><option value="fp16">fp16 (GPU)</option></select></label>
        <span id="memInfo" class="tiny"></span>
      </div>
      <div id="toast" class="toast hidden"></div>
    </section>

    <footer>ISRO SIH • Privacy-preserving vision agent • <a href="#" id="viewLast">view lastContext</a></footer>
  </div>
`;

const $ = (s: string) => document.querySelector(s) as any;

const taskEl = $('#task') as HTMLInputElement;
const includeShotEl = $('#includeShot') as HTMLInputElement;
const showMasksEl = $('#showMasks') as HTMLInputElement;
const btnSanitize = $('#btnSanitize') as HTMLButtonElement;
const btnClear = $('#btnClear') as HTMLButtonElement;
const metricsEl = $('#metrics') as HTMLDivElement;
const progressEl = $('#progress') as HTMLDivElement;
const barEl = progressEl.querySelector('.bar') as HTMLDivElement;
const pctEl = progressEl.querySelector('.pct') as HTMLSpanElement;
const previewEl = $('#contextPreview') as HTMLPreElement;
const serverUrlEl = $('#serverUrl') as HTMLInputElement;
const btnSaveServer = $('#btnSaveServer') as HTMLButtonElement;
const btnAgent = $('#btnAgent') as HTMLButtonElement;
const btnExecute = $('#btnExecute') as HTMLButtonElement;
const agentOut = $('#agentOut') as HTMLPreElement;
const latencyEl = $('#latency') as HTMLSpanElement;
const deviceInfoEl = $('#deviceInfo') as HTMLSpanElement;
const btnPreload = $('#btnPreload') as HTMLButtonElement;
const btnDispose = $('#btnDispose') as HTMLButtonElement;
const btnTestPage = $('#btnTestPage') as HTMLButtonElement;
const confirmRow = $('#confirmRow') as HTMLDivElement;
const btnConfirm = $('#btnConfirm') as HTMLButtonElement;
const toastEl = $('#toast') as HTMLDivElement;
const storageInfoEl = $('#storageInfo') as HTMLSpanElement;
const quantSel = $('#quantSel') as HTMLSelectElement;
const memInfoEl = $('#memInfo') as HTMLSpanElement;

let lastContext: any = null;
let lastAction: any = null;

function toast(msg: string, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  setTimeout(() => toastEl.classList.add('hidden'), ms);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setProgress(pct: number, label?: string) {
  progressEl.classList.remove('hidden');
  barEl.style.width = `${Math.max(2, Math.min(100, pct))}%`;
  pctEl.textContent = label ? `${Math.round(pct)}% ${label}` : `${Math.round(pct)}%`;
  if (pct >= 100) setTimeout(() => progressEl.classList.add('hidden'), 800);
}

// Poll storage for offscreen mlProgress
chrome.storage.onChanged.addListener((changes) => {
  if (changes.mlProgress) {
    const v: any = changes.mlProgress.newValue;
    if (v?.progress != null) setProgress(v.progress, v.file || v.status);
    else if (v?.status === 'done') setProgress(100, 'ready');
  }
});

async function refreshDeviceInfo() {
  let device = 'wasm (fallback)';
  try {
    if ((navigator as any).gpu) {
      const a = await (navigator as any).gpu?.requestAdapter?.();
      if (a) device = 'webgpu (GPU)';
    }
  } catch {}
  const { mlProgress, quantMode } = (await chrome.storage.local.get(['mlProgress', 'quantMode'])) as any;
  const q = quantMode || 'q8';
  deviceInfoEl.textContent = `${device} • ${q} • ${mlProgress ? 'model loading…' : 'lazy'}`;
  quantSel.value = q;
  // storage estimate + memory
  try {
    const est: any = await (navigator as any).storage?.estimate?.();
    if (est?.quota && est?.usage != null) {
      const pct = ((est.usage / est.quota) * 100).toFixed(1);
      storageInfoEl.textContent = `storage ${(est.usage / 1e6).toFixed(1)}MB / ${(est.quota / 1e6).toFixed(0)}MB (${pct}%)`;
    } else storageInfoEl.textContent = 'storage: n/a';
  } catch { storageInfoEl.textContent = 'storage: n/a'; }
  if ((performance as any).memory) {
    const m: any = (performance as any).memory;
    memInfoEl.textContent = `heap ${(m.usedJSHeapSize / 1e6).toFixed(0)}MB / ${(m.jsHeapSizeLimit / 1e6).toFixed(0)}MB`;
  } else if ((navigator as any).deviceMemory) {
    memInfoEl.textContent = `deviceMemory ${(navigator as any).deviceMemory}GB`;
  }
}
refreshDeviceInfo();
setInterval(refreshDeviceInfo, 3000);

// quant switch
quantSel.addEventListener('change', async () => {
  const mode = quantSel.value;
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SET_QUANT', mode } as any).catch(() => {});
  await chrome.storage.local.set({ quantMode: mode });
  toast(`Quant set to ${mode} — next load will use it (preload to apply)`);
  refreshDeviceInfo();
});

// Server URL persist
chrome.storage.local.get('serverUrl').then((v: any) => {
  serverUrlEl.value = v?.serverUrl || 'http://localhost:8000';
});
btnSaveServer.addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: serverUrlEl.value.trim() });
  toast('Server URL saved');
});

btnSanitize.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return toast('No active tab');
  btnSanitize.disabled = true;
  btnSanitize.textContent = 'Scanning…';
  setProgress(8, 'extracting DOM');
  try {
    const t0 = performance.now();
    const ctx = await chrome.tabs.sendMessage(tab.id!, {
      type: 'GET_SANITIZED_CONTEXT',
      task: taskEl.value.trim() || undefined,
      includeScreenshot: includeShotEl.checked,
    });
    const ms = Math.round(performance.now() - t0);
    lastContext = ctx;
    // metrics
    const m = ctx.metrics || {};
    metricsEl.classList.remove('hidden');
    metricsEl.innerHTML = `
      <span>extract ${m.extractionMs ?? '-'}ms</span> •
      <span>pii ${m.piiDetectionMs ?? '-'}ms</span> •
      <span>vision ${m.visionMs ?? '-'}ms</span> •
      <span>redact ${m.redactionMs ?? '-'}ms</span> •
      <span>total ${ms}ms</span> •
      <span>${ctx.redacted_regions.length} regions</span> •
      <span>${ctx.ax_tree.length} nodes</span>
    `;
    previewEl.classList.remove('hidden');
    previewEl.textContent = JSON.stringify(
      { url: ctx.url, title: ctx.title, ax_tree: ctx.ax_tree.slice(0, 6), redacted_regions: ctx.redacted_regions, hasScreenshot: !!ctx.screenshot_redacted_b64 },
      null,
      2,
    );
    setProgress(100, 'redacted locally');
    latencyEl.textContent = `local ${ms}ms`;
    if (!showMasksEl.checked) {
      await chrome.tabs.sendMessage(tab.id!, { type: 'CLEAR_MASKS' }).catch(() => {});
    }
    toast(`Redacted ${ctx.redacted_regions.length} regions — nothing sent yet`);
  } catch (e: any) {
    toast(`Scan failed: ${e?.message || e}`);
  } finally {
    btnSanitize.disabled = false;
    btnSanitize.textContent = '1. Scan & Redact Locally';
  }
});

btnClear.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_MASKS' }).catch(() => {});
  previewEl.classList.add('hidden');
  metricsEl.classList.add('hidden');
  toast('Masks cleared');
});

btnAgent.addEventListener('click', async () => {
  if (!lastContext) return toast('Run Scan & Redact first');
  btnAgent.disabled = true;
  btnAgent.textContent = 'Contacting server…';
  agentOut.classList.remove('hidden');
  agentOut.textContent = 'Sending ONLY sanitized context (no raw PII)...';
  try {
    const t0 = performance.now();
    const serverUrl = (await chrome.storage.local.get('serverUrl') as any)?.serverUrl || serverUrlEl.value.trim() || 'http://localhost:8000';
    // Route via background so only sanitized data hits fetch (background does fetch)
    const tab = await getActiveTab();
    // Prefer background agent step; fallback direct fetch
    let resp: any;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'AGENT_STEP', context: lastContext });
      if (resp?.error) throw new Error(resp.error);
    } catch {
      const r = await fetch(`${serverUrl.replace(/\/$/, '')}/api/agent/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastContext),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      resp = await r.json();
    }
    const ms = Math.round(performance.now() - t0);
    latencyEl.textContent = `server ${ms}ms`;
    lastAction = resp.action || resp;
    agentOut.textContent = JSON.stringify(resp, null, 2);
    btnExecute.disabled = false;
    // Show confirm if fill
    if (lastAction?.type === 'fill') confirmRow.classList.remove('hidden');
    else confirmRow.classList.add('hidden');
    toast(`Agent replied in ${ms}ms`);
  } catch (e: any) {
    agentOut.textContent = `Error: ${e?.message || e}\n\nTip: start server with: npm run server:dev`;
  } finally {
    btnAgent.disabled = false;
    btnAgent.textContent = 'Ask Agent (sanitized only)';
  }
});

btnExecute.addEventListener('click', async () => {
  if (!lastAction) return;
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const r: any = await chrome.tabs.sendMessage(tab.id, { type: 'EXECUTE_ACTION', action: lastAction });
  toast(r?.ok ? `Executed ${lastAction.type}` : `Failed: ${r?.error}`);
});

btnConfirm.addEventListener('click', async () => {
  confirmRow.classList.add('hidden');
  (btnExecute as HTMLButtonElement).click();
});

btnPreload.addEventListener('click', async () => {
  btnPreload.disabled = true;
  toast('Preloading models… ~30-60MB first time');
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PRELOAD' } as any).catch(() => chrome.runtime.sendMessage({ type: 'ENSURE_OFFSCREEN' }));
    // Also trigger offscreen directly
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PRELOAD' });
    toast('Models ready');
  } catch (e: any) {
    toast(`Preload: ${e?.message || 'check console'}`);
  } finally {
    btnPreload.disabled = false;
  }
});

btnDispose.addEventListener('click', async () => {
  btnDispose.disabled = true;
  try {
    const r: any = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_DISPOSE' } as any);
    toast(r?.freed ? 'Memory freed (pipes disposed)' : 'Memory freed');
  } catch { toast('Memory freed'); }
  btnDispose.disabled = false;
  refreshDeviceInfo();
});

btnTestPage.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('test-pii.html') });
});

$('#viewLast')?.addEventListener('click', async (e: Event) => {
  e.preventDefault();
  const { lastContext: lc } = (await chrome.storage.local.get('lastContext')) as any;
  agentOut.classList.remove('hidden');
  agentOut.textContent = JSON.stringify(lc || lastContext || {}, null, 2);
});

// Initial ping to content script to check injection
(async () => {
  const tab = await getActiveTab();
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    } catch {
      // auto-inject not yet; show hint
      toast('Reload page once after install to inject content script');
    }
  }
})();
