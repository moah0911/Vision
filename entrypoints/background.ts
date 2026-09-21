/**
 * Background service worker — MV3, no DOM.
 * Responsibilities: offscreen lifecycle, message routing, server call (only sanitized data).
 */
export default defineBackground(() => {
  console.log('[Vision] Background loaded', new Date().toISOString());

  // Keep offscreen alive helpers
  const OFFSCREEN_URL = browser.runtime.getURL('offscreen.html');
  const OFFSCREEN_REASON = 'DOM_PARSER' as unknown as chrome.offscreen.Reason;

  async function hasOffscreen(): Promise<boolean> {
    // @ts-ignore - MV3 offscreen API
    if (!(browser as any).offscreen?.hasDocument) return false;
    return await (browser as any).offscreen.hasDocument();
  }

  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    try {
      // @ts-ignore
      await (browser as any).offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [OFFSCREEN_REASON],
        justification: 'Run local Transformers.js vision + NER for PII redaction without network',
      });
      console.log('[Vision] Offscreen created');
    } catch (e: any) {
      if (!String(e?.message).includes('Only a single offscreen')) throw e;
    }
  }

  // Eager ensure on install/startup
  browser.runtime.onInstalled.addListener(() => {
    ensureOffscreen();
  });
  // Also on startup (service worker wake)
  ensureOffscreen();

  // Keep-alive ping for long inference (avoid SW suspension)
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  }
  function stopKeepAlive() {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  }

  // Generic message router — delegates ML to offscreen, extraction to content
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'ENSURE_OFFSCREEN') {
          await ensureOffscreen();
          sendResponse({ ok: true });
        } else if (msg.type === 'SCAN_TEXT') {
          await ensureOffscreen();
          startKeepAlive();
          const res = await browser.runtime.sendMessage({ type: 'OFFSCREEN_SCAN_TEXT', text: msg.text });
          stopKeepAlive();
          sendResponse(res);
        } else if (msg.type === 'SCAN_IMAGE') {
          await ensureOffscreen();
          startKeepAlive();
          const res = await browser.runtime.sendMessage({ type: 'OFFSCREEN_SCAN_IMAGE', imageUrl: msg.imageUrl });
          stopKeepAlive();
          sendResponse(res);
        } else if (msg.type === 'AGENT_STEP') {
          // Only sanitized context ever hits network
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 15000);
          const serverUrl = (await browser.storage.local.get('serverUrl'))?.serverUrl || 'http://localhost:8000';
          const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/agent/step`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(msg.context),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (!resp.ok) throw new Error(`Server ${resp.status}: ${await resp.text()}`);
          const data = await resp.json();
          sendResponse(data);
        } else if (msg.type === 'CAPTURE_SCREENSHOT') {
          const dataUrl = await browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 } as any);
          sendResponse({ dataUrl });
        }
      } catch (e: any) {
        console.error('[Vision][BG] handler error', e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async
  });

  // Handle offscreen close
  // @ts-ignore
  if ((browser as any).offscreen?.onDocumentClose) {
    // @ts-ignore
    (browser as any).offscreen.onDocumentClose.addListener(() => {
      console.log('[Vision] Offscreen closed');
    });
  }
});
