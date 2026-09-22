# PERF — Performance Ledger (one change at a time)

| Idea | Baseline → Result | Verdict | Why | Metric |
|---|---|---|---|---|
| Initial build (wxt 0.20, transformers 3.8) | 22.48 MB total (21.6 MB ort-wasm) | keep | Acceptable <100MB extension limit; wasm CDN fallback next | bundle |
| Chunk manualChunks (transformers) | Build failed: codeSplitting false | reverted | WXT Vite forbids manualChunks with its splitting off | bundle |
| Optimize vite: exclude onnxruntime-web | 22.48 → 22.48 MB no change | reverted | Wasm still bundled; need CDN load via `env.backends.onnx.wasm.wasmPaths` — keep for now | bundle |
| q4 quant toggle (popup select) | q8 17 MB vs q4 9 MB per model download | kept | Saves ~50% storage, critical for 4GB deviceMemory, tradeoff ~1-2% accuracy | mem 20% |
| NER timeout 800ms → 900ms + parallel yolo | +100ms but adds person/phone blur | kept | Metric 2 recall improves (FACE via yolo), still within 2s E2E budget | latency 15% |
| Offscreen dispose + storage.estimate in popup | heap freed, quota visible | kept | Prevents leak (`pipe.dispose()` per transformers docs), guards metric 4 | mem |
| Capture screenshot fallback (null on fail) | Crash → graceful DOM-only | kept | `captureVisibleTab` needs activeTab grant; fallback keeps system usable | reliability |
| Heuristic agent only | server 1ms deterministic | kept baseline | VLM optional via `VLM_BACKEND=openai|gemini|hf`; heuristic guarantees demo without GPU | latency |

**Budgets:** JS bundle <200KB (popup), extension <30MB (actual 22.48MB), heap <300MB, E2E <2s, local vision <400ms wasm / <150ms webgpu.

**Re-measure command:** `node node_modules/wxt/bin/wxt.mjs build && ls -lh .output/chrome-mv3/assets/*wasm && node scripts/evaluate-full.mjs`
