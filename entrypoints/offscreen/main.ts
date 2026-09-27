/**
 * Offscreen document — has DOM, runs Transformers.js.
 * NOT a service worker — full window context for WASM threads.
 */
import { env, pipeline } from '@huggingface/transformers';
import { onMessage, sendMessage } from '../../modules/messaging/protocol';

// Cache to avoid re-download. Weights are fetched from the HuggingFace CDN on first run and
// then held in the browser Cache API; page content is never sent anywhere.
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
// Retained so a waiter can be told why the load failed instead of receiving null.
let nerError: unknown = null;
let detError: unknown = null;

/**
 * Single-flight model loading.
 *
 * The previous version polled a boolean flag and then returned whatever the loader had stored.
 * If the first attempt rejected, the flag was cleared in `finally` while the pipe stayed null,
 * so the next caller received null and the request site called `pipe(text)` on it — a
 * TypeError that surfaced as a scan failure rather than a model error. On failure the error is
 * now retained and the next caller retries instead of latching the broken state.
 */
async function getNER(progress_callback?: ProgressCb) {
  if (nerPipe) return nerPipe;
  if (nerLoading) {
    while (nerLoading) await new Promise((r) => setTimeout(r, 50));
    if (nerPipe) return nerPipe;
    if (nerError) {
      console.warn('[Offscreen] NER load previously failed, retrying', nerError);
      nerError = null;
    }
  }
  nerLoading = true;
  try {
    const device = await pickDevice();
    const dtype = await resolveDtype(device);
    nerPipe = await pipeline('token-classification', 'Xenova/distilbert-base-cased-finetuned-conll03-english', {
      // @ts-ignore
      device,
      dtype,
      progress_callback,
    } as any);
    nerError = null;
    console.log('[Offscreen] NER ready', device, dtype);
  } catch (e) {
    nerError = e;
    nerPipe = null;
    throw e;
  } finally {
    nerLoading = false;
  }
  return nerPipe;
}

async function getDetector(progress_callback?: ProgressCb) {
  if (detectorPipe) return detectorPipe;
  if (detLoading) {
    while (detLoading) await new Promise((r) => setTimeout(r, 50));
    if (detectorPipe) return detectorPipe;
    if (detError) {
      console.warn('[Offscreen] Detector load previously failed, retrying', detError);
      detError = null;
    }
  }
  detLoading = true;
  try {
    const device = await pickDevice();
    const dtype = await resolveDtype(device);
    detectorPipe = await pipeline('object-detection', 'Xenova/yolos-tiny', {
      // @ts-ignore
      device,
      dtype,
      progress_callback,
    } as any);
    detError = null;
    console.log('[Offscreen] Detector ready', device, dtype);
  } catch (e) {
    detError = e;
    detectorPipe = null;
    throw e;
  } finally {
    detLoading = false;
  }
  return detectorPipe;
}

/**
 * Map the user's quantisation choice onto an actual dtype.
 *
 * The old expression collapsed every non-q4 choice to q8, so the popup's fp16 and fp32 options
 * did nothing on WASM, while on WebGPU it forced fp16 and ignored the choice entirely. The
 * user's selection is now honoured where the backend supports it, and the effective dtype is
 * reported back so the UI can say what actually loaded.
 */
async function resolveDtype(device: 'webgpu' | 'wasm'): Promise<string> {
  const pref = await getPreferredDtype();
  if (device === 'webgpu') {
    // WebGPU backends accept the wider float types; q4/q8 are not supported there.
    return pref === 'fp32' ? 'fp32' : 'fp16';
  }
  switch (pref) {
    case 'q4':
      return 'q4';
    case 'fp32':
      return 'fp32';
    case 'fp16':
      // fp16 has no WASM kernel in onnxruntime-web; q8 is the closest supported equivalent.
      return 'q8';
    case 'q8':
    default:
      return 'q8';
  }
}

/** The dtype a given preference would actually produce, for display in the popup. */
export async function effectiveDtypes(): Promise<{ webgpu: string; wasm: string; requested: QuantMode }> {
  const requested = await getPreferredDtype();
  return {
    requested,
    webgpu: await resolveDtype('webgpu'),
    wasm: await resolveDtype('wasm'),
  };
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

// Message handlers — the background forwards scan requests here.
// One handler per message name; this document can only claim its own messages.
onMessage('offscreenScanText', async ({ data }) => {
  const text = data.text || '';
  if (!text.trim()) return { ok: true, data: [] };
  const pipe = await getNER((info: any) => {
    // Forward download progress to the popup through a storage event.
    if (info.status === 'progress' || info.status === 'progress_total') {
      chrome.storage.local.set({ mlProgress: info }).catch(() => {});
    }
  });
  const raw = await pipe(text);
  const entities = (Array.isArray(raw) ? raw : []).map((e: any) => ({
    entity: e.entity || e.label,
    word: e.word,
    score: e.score,
    start: e.start ?? e.index ?? 0,
    end: e.end ?? (e.start ?? 0) + (e.word?.length ?? 0),
  }));
  return { ok: true, data: entities };
});

onMessage('offscreenScanImage', async ({ data }) => {
  const pipe = await getDetector();
  const out = await pipe(data.imageUrl, { threshold: 0.45, percentage: true } as any);
  // [{label, score, box:{xmin,ymin,xmax,ymax}}] in 0-1 when percentage is true
  return { ok: true, data: Array.isArray(out) ? out : [] };
});

onMessage('offscreenPreload', async () => {
  await Promise.all([getNER(), getDetector()]);
  return { ok: true };
});

onMessage('offscreenDispose', async () => {
  try {
    if (nerPipe?.dispose) await nerPipe.dispose();
    if (detectorPipe?.dispose) await detectorPipe.dispose();
  } catch {}
  nerPipe = null;
  detectorPipe = null;
  nerError = null;
  detError = null;
  await chrome.storage.local.remove('mlProgress').catch(() => {});
  return { ok: true, freed: true };
});

onMessage('offscreenStorageEstimate', async () => {
  try {
    const est: any = await (navigator as any).storage?.estimate?.();
    return { ok: true, data: { quota: est?.quota, usage: est?.usage, usageDetails: est?.usageDetails } };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});

onMessage('offscreenSetQuant', async ({ data }) => {
  await chrome.storage.local.set({ quantMode: data.mode });
  // Dispose so the next load picks up the new dtype.
  try {
    if (nerPipe?.dispose) await nerPipe.dispose();
    if (detectorPipe?.dispose) await detectorPipe.dispose();
  } catch {}
  nerPipe = null;
  detectorPipe = null;
  nerError = null;
  detError = null;
  return { ok: true, mode: data.mode, effective: await effectiveDtypes() };
});

// Self-test on load: warm device detection
pickDevice().then((d) => console.log('[Offscreen] device', d));

// Notify background ready. Failures here are expected when no listener is up yet.
sendMessage('offscreenReady', undefined).catch(() => {});
