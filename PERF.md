# PERF — Performance Ledger (one change at a time)

| Idea | Baseline → Result | Verdict | Why | Metric |
|---|---|---|---|---|
| Initial build (wxt 0.20, transformers 3.8) | 22.48 MB total (21.6 MB ort-wasm) | keep | Acceptable <100MB extension limit; wasm CDN fallback next | bundle |
| Chunk manualChunks (transformers) | Build failed: codeSplitting false | reverted | WXT Vite forbids manualChunks with its splitting off | bundle |
| Optimize vite: exclude onnxruntime-web | 22.48 → 22.48 MB no change | reverted | Wasm still bundled; need CDN load via `env.backends.onnx.wasm.wasmPaths` — keep for now | bundle |
| q4 quant toggle (popup select) | q8 17 MB vs q4 9 MB per model download | kept | Saves ~50% storage, critical for 4GB deviceMemory, tradeoff ~1-2% accuracy | mem 20% |
| Honour the selected quant (was: collapsed to q8) | fp16/fp32 options were dead on WASM | fixed | `resolveDtype()` now maps the request per backend and the popup shows the *effective* dtype | — |
| NER+detection under one 900ms budget | +100ms but adds person/phone blur | kept | Metric 2 recall improves (FACE via yolo), still within 2s E2E budget | latency 15% |
| Fail closed when NER times out (was: send anyway) | prose stripped, `pii_text_scan_complete:false` | kept | A timeout must not mean "transmit raw names" | correctness |
| Single `captureVisibleTab` per scan (was: twice) | −1 full-viewport JPEG encode + compositor read | kept | The ML preview capture is reused for redaction | latency |
| Cap *visited* nodes at 20k (was: uncapped walk) | bounded on sparse pages | kept | `count` only incremented on collected nodes, so a page with few visible elements walked the whole DOM paying forced layout per element | extraction |
| `isVisible` checks rect before `getComputedStyle` | fewer style recalcs | kept | The expensive call ran first for every element including obviously off-screen ones | extraction |
| Drop no-op scroll/resize listeners + dedupe key fix | −1 listener pair per scan, no duplicate nodes | kept | The two dedup key formats could never match, so buttons were appended twice | correctness |
| Offscreen dispose + storage.estimate in popup | heap freed, quota visible | kept | Prevents leak (`pipe.dispose()` per transformers docs), guards metric 4 | mem |
| Capture screenshot fallback (null on fail) | Crash → graceful DOM-only | kept | `captureVisibleTab` needs activeTab grant; fallback keeps system usable | reliability |
| Heuristic agent only | server 1ms deterministic | kept baseline | VLM optional via `VLM_BACKEND`; heuristic guarantees demo without GPU | latency |
| Screenshot kept out of `storage.local` | avoids quota pressure | kept | A base64 full-viewport JPEG in a ~5MB quota, never cleaned | mem |

**Budgets:** JS bundle <200KB (popup), extension <30MB (actual 22.5MB), heap <300MB, E2E <2s, local vision <400ms wasm / <150ms webgpu.

**Re-measure:**
```bash
npm run typecheck && npm run build && npm run eval && npm run test:e2e
```

