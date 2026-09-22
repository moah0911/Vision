/**
 * Offscreen document — has DOM, runs Transformers.js.
 * NOT a service worker — full window context for WASM threads.
 */
import { env, pipeline } from '@huggingface/transformers';

// Cache to avoid re-download; allow remote in dev, local in prod if bundled
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
// Quantization preference: q4 on low-memory, q8 default, fp16 on webgpu
export type QuantMode = 'q4' | 'q8' | 'fp16' | 'fp32';
export async function getPreferredDtype(): Promise<QuantMode> {
  const { quantMode } = (await chrome.storage.local.get('quantMode')) as any;
  if (quantMode) return quantMode as QuantMode;
  // Auto: if deviceMemory low, use q4
  const mem = (navigator as any).deviceMemory;
  if (mem && mem <= 4) return 'q4';
  return 'q8';
}

type ProgressCb = (info: any) => void;

let nerPipe: any = null;
let detectorPipe: any = null;
let nerLoading = false;
let detLoading = false;

async function getNER(progress_callback?: ProgressCb) {
  if (nerPipe) return nerPipe;
  if (nerLoading) {
    while (nerLoading) await new Promise((r) => setTimeout(r, 100));
    return nerPipe;
  }
  nerLoading = true;
  try {
    const device = await pickDevice();
    const pref = await getPreferredDtype();
    const dtype = device === 'webgpu' ? 'fp16' : pref === 'q4' ? 'q4' : 'q8';
    nerPipe = await pipeline('token-classification', 'Xenova/distilbert-base-cased-finetuned-conll03-english', {
      // @ts-ignore
      device,
      dtype,
      progress_callback,
    } as any);
    console.log('[Offscreen] NER ready', device, dtype);
  } finally {
    nerLoading = false;
  }
  return nerPipe;
}

async function getDetector(progress_callback?: ProgressCb) {
  if (detectorPipe) return detectorPipe;
  if (detLoading) {
    while (detLoading) await new Promise((r) => setTimeout(r, 100));
    return detectorPipe;
  }
  detLoading = true;
  try {
    const device = await pickDevice();
    const pref = await getPreferredDtype();
    const dtype = device === 'webgpu' ? 'fp16' : pref === 'q4' ? 'q4' : 'q8';
    detectorPipe = await pipeline('object-detection', 'Xenova/yolos-tiny', {
      // @ts-ignore
      device,
      dtype,
      progress_callback,
    } as any);
    console.log('[Offscreen] Detector ready', device, dtype);
  } finally {
    detLoading = false;
  }
  return detectorPipe;
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    // @ts-ignore
    if (navigator.gpu) {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {}
  return 'wasm';
}

// Message handlers — background forwards SCAN_TEXT / SCAN_IMAGE here
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'OFFSCREEN_SCAN_TEXT') {
        const text: string = msg.text || '';
        if (!text.trim()) return sendResponse({ entities: [] });
        const pipe = await getNER((info: any) => {
          // forward progress to popup via storage event
          if (info.status === 'progress' || info.status === 'progress_total') {
            chrome.storage.local.set({ mlProgress: info }).catch(() => {});
          }
        });
        const raw = await pipe(text);
        // Normalize to simple entities
        const entities = (Array.isArray(raw) ? raw : []).map((e: any) => ({
          entity: e.entity || e.label,
          word: e.word,
          score: e.score,
          start: e.start ?? e.index ?? 0,
          end: e.end ?? (e.start ?? 0) + (e.word?.length ?? 0),
        }));
        sendResponse({ entities });
      } else if (msg.type === 'OFFSCREEN_SCAN_IMAGE') {
        const imageUrl: string = msg.imageUrl;
        const pipe = await getDetector();
        const threshold = 0.45;
        const out = await pipe(imageUrl, { threshold, percentage: true } as any);
        // out: [{label, score, box:{xmin,ymin,xmax,ymax}}] in 0-1 if percentage true
        sendResponse(Array.isArray(out) ? out : []);
      } else if (msg.type === 'OFFSCREEN_PRELOAD') {
        await Promise.all([getNER(), getDetector()]);
        sendResponse({ ok: true });
      } else if (msg.type === 'OFFSCREEN_DISPOSE') {
        try {
          if (nerPipe?.dispose) await nerPipe.dispose();
          if (detectorPipe?.dispose) await detectorPipe.dispose();
        } catch {}
        nerPipe = null;
        detectorPipe = null;
        await chrome.storage.local.remove('mlProgress').catch(() => {});
        sendResponse({ ok: true, freed: true });
      } else if (msg.type === 'OFFSCREEN_STORAGE_ESTIMATE') {
        try {
          const est: any = await (navigator as any).storage?.estimate?.();
          sendResponse({ quota: est?.quota, usage: est?.usage, usageDetails: est?.usageDetails });
        } catch (e: any) {
          sendResponse({ error: String(e?.message || e) });
        }
      } else if (msg.type === 'OFFSCREEN_SET_QUANT') {
        await chrome.storage.local.set({ quantMode: msg.mode });
        // dispose so next load uses new quant
        try {
          if (nerPipe?.dispose) await nerPipe.dispose();
          if (detectorPipe?.dispose) await detectorPipe.dispose();
        } catch {}
        nerPipe = null;
        detectorPipe = null;
        sendResponse({ ok: true, mode: msg.mode });
      }
    } catch (e: any) {
      console.error('[Offscreen] error', e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// Self-test on load: warm device detection
pickDevice().then((d) => console.log('[Offscreen] device', d));

// Notify background ready
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
