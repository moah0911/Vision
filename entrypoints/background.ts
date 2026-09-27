/**
 * Background service worker — MV3, no DOM.
 * Responsibilities: offscreen lifecycle, message routing, server call (only sanitized data).
 */
import { resolveServerUrl } from '../modules/config';
import { onMessage, sendMessage } from '../modules/messaging/protocol';
import type { ScanFailure } from '../modules/messaging/protocol';
import type { AgentResponse, SanitizedContext } from '../modules/vision/types';

export default defineBackground(() => {
  console.log('[Vision] Background loaded', new Date().toISOString());

  // Keep offscreen alive helpers
  const OFFSCREEN_URL = browser.runtime.getURL('/offscreen.html');
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
  browser.runtime.onStartup?.addListener(() => ensureOffscreen());
  // Also on startup (service worker wake)
  ensureOffscreen();

  // Keep-alive ping for long inference (avoid SW suspension)
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  // Set when the offscreen document reports it has loaded. Cleared when the document closes.
  let offscreenReady = false;
  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  }
  function stopKeepAlive() {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  }

  // Typed message router — delegates ML to offscreen, extraction to content.
  // One handler per message name, so a handler can only ever claim its own message.
  onMessage('ensureOffscreen', async () => {
    await ensureOffscreen();
    return { ok: true };
  });

  onMessage('offscreenReady', async () => {
    offscreenReady = true;
    return { ok: true };
  });

  onMessage('scanText', async ({ data }) => {
    await ensureOffscreen();
    startKeepAlive();
    try {
      return await sendMessage('offscreenScanText', { text: data.text });
    } finally {
      stopKeepAlive();
    }
  });

  onMessage('scanImage', async ({ data }) => {
    await ensureOffscreen();
    startKeepAlive();
    try {
      return await sendMessage('offscreenScanImage', { imageUrl: data.imageUrl });
    } finally {
      stopKeepAlive();
    }
  });

  onMessage('captureScreenshot', async () => {
    try {
      const dataUrl = await (browser.tabs as any).captureVisibleTab({ format: 'jpeg', quality: 70 });
      return { dataUrl };
    } catch (e: any) {
      // No activeTab grant, or the tab cannot be captured. The caller falls back to a
      // DOM-only sanitized context.
      console.warn('[Vision] captureVisibleTab failed', e?.message);
      return { dataUrl: null, error: String(e?.message || e) };
    }
  });

  onMessage('agentStep', async ({ data }) => {
    // Only sanitized context ever hits network.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const serverUrl = await resolveServerUrl();
      const resp = await fetch(`${serverUrl}/api/agent/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.context),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`Server ${resp.status}: ${await resp.text()}`);
      return (await resp.json()) as AgentResponse;
    } finally {
      clearTimeout(t);
    }
  });

  // Offscreen lifecycle passthroughs.
  onMessage('offscreenPreload', async () => {
    await ensureOffscreen();
    return sendMessage('offscreenPreload', undefined);
  });
  onMessage('offscreenDispose', async () => {
    await ensureOffscreen();
    return sendMessage('offscreenDispose', undefined);
  });
  onMessage('offscreenStorageEstimate', async () => {
    await ensureOffscreen();
    return sendMessage('offscreenStorageEstimate', undefined);
  });
  onMessage('offscreenSetQuant', async ({ data }) => {
    await ensureOffscreen();
    return sendMessage('offscreenSetQuant', { mode: data.mode });
  });

  onMessage('startScan', async ({ data }): Promise<SanitizedContext | ScanFailure> => {
    const { tabId, task, includeScreenshot } = data;
    // Background-orchestrated so the scan survives the popup closing on blur.
    await browser.storage.local.set({ scanState: 'running', scanError: null });
    try {
      let ctx: SanitizedContext;
      try {
        ctx = await sendMessage('getSanitizedContext', { task, includeScreenshot }, { tabId });
      } catch (e: any) {
        const err = String(e?.message || e);
        if (!err.includes('Receiving end does not exist')) throw e;
        // Not injected yet: an extension page, or a tab loaded before install. Inject and retry.
        try {
          await (browser.scripting as any).executeScript({
            target: { tabId },
            files: ['content-scripts/content.js'],
          });
          await new Promise((r) => setTimeout(r, 300));
          ctx = await sendMessage('getSanitizedContext', { task, includeScreenshot }, { tabId });
        } catch {
          throw new Error(
            `Content not injected. Reload page once after install. For the test page use ` +
              `http://localhost:8000/test-pii.html (extension pages have no content script). Details: ${err}`,
          );
        }
      }
      await browser.storage.local.set({ lastContext: ctx, scanState: 'done', scanError: null });
      return ctx;
    } catch (e: any) {
      const message = String(e?.message || e);
      await browser.storage.local.set({ scanState: 'error', scanError: message });
      return { ok: false, error: message };
    }
  });

  // Handle offscreen close
  // @ts-ignore
  if ((browser as any).offscreen?.onDocumentClose) {
    // @ts-ignore
    (browser as any).offscreen.onDocumentClose.addListener(() => {
      offscreenReady = false;
      console.log('[Vision] Offscreen closed');
    });
  }
});
