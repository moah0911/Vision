/**
 * Offscreen document — has DOM, runs Transformers.js.
 * NOT a service worker — full window context for WASM threads.
 */
import { env, pipeline } from '@huggingface/transformers';

// Cache to avoid re-download; allow remote in dev, local in prod if bundled
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;

type ProgressCb = (info: any) => void;

let nerPipe: any = null;
let detectorPipe: any = null;
let nerLoading = false;
let detLoading = false;

async function getNER(progress_callback?: ProgressCb) {
  if (nerPipe) return nerPipe;
  if (nerLoading) {
    // wait for concurrent load
    while (nerLoading) await new Promise((r) => setTimeout(r, 100));
    return nerPipe;
  }
  nerLoading = true;
  try {
    const device = await pickDevice();
    // DistilBERT NER quantized — <30MB q8, fast
    nerPipe = await pipeline('token-classification', 'Xenova/distilbert-base-cased-finetuned-conll03-english', {
      // @ts-ignore
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback,
    } as any);
    console.log('[Offscreen] NER ready', device);
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
    detectorPipe = await pipeline('object-detection', 'Xenova/yolos-tiny', {
      // @ts-ignore
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback,
    } as any);
    console.log('[Offscreen] Detector ready', device);
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
        // Eager preload for popup button
        await Promise.all([getNER(), getDetector()]);
        sendResponse({ ok: true });
      } else if (msg.type === 'OFFSCREEN_DISPOSE') {
        if (nerPipe?.dispose) await nerPipe.dispose();
        if (detectorPipe?.dispose) await detectorPipe.dispose();
        nerPipe = null;
        detectorPipe = null;
        sendResponse({ ok: true });
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
