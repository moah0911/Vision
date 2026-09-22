# Vision Privacy Agent — On-device Visual Perception for Light-weight Browser Agents

> **SIH / Final Year Project** — Privacy-preserving browser agent that runs a local Vision Transformer (via WebGPU/WASM + Transformers.js) to read screen state, dynamically redacts PII (faces/passwords/emails/phones/cards/Aadhaar/PAN), and sends **only sanitized** context to server. Server (FastAPI + VLM/heuristic) returns actionable commands (`click`/`fill`/`scroll`/`say`) that the client executes.

## Demo (2 min flow)
1. Open `chrome://extensions` → Load unpacked `.output/chrome-mv3` (or `npm run dev`)
2. Open test page: popup → **Open PII test page** (or `chrome-extension://<id>/test-pii.html`)
3. Popup: type task `Click Submit` → **1. Scan & Redact Locally** → see black/blur masks over PII + metrics (extraction/pii/vision/redact ms + region count)
4. Start server: `npm run server:dev` (or `python3 -m uvicorn server.app:app --port 8000`)
5. Popup: **Ask Agent (sanitized only)** → server replies with `{"thought":...,"action":{"type":"click",...}}` (never sees raw PII)
6. Popup: **Execute action** → page clicks/scrolls. Check `view lastContext` to prove placeholders `[REDACTED:EMAIL]` not raw values.

## Architecture
```
Content Script (ISOLATED, document_idle)  → extracts AXTree + bbox, regex PII sync
Background (MV3 SW)                       → offscreen lifecycle + server fetch (sanitized only)
Offscreen Document (DOM)                  → Transformers.js: distilbert-NER (q8) + yolos-tiny (q8) via WebGPU/WASM fallback
Popup (Shadow DOM overlay demo)           → progress, metrics, latency
Server (FastAPI)                          → /api/agent/step — redaction-aware prompt, heuristic or VLM (Qwen2-VL-2B via VLM_BACKEND=hf)
```

**Privacy guarantee:** Regex + NER + detection all local. Visual overlay (blackout/blur) proves redaction. `redaction_scheme` sent to server explains `[REDACTED:TYPE]` tokens. No raw PII in `ax_tree`/`screenshot_redacted_b64`.

## Project Structure
```
wxt.config.ts              # MV3 manifest, CSP wasm-unsafe-eval, web_accessible_resources
entrypoints/
  background.ts            # sync listeners, ensureOffscreen, AGENT_STEP fetch
  offscreen/main.ts        # pipeline('token-classification'/'object-detection') q8, device pick webgpu→wasm
  content/index.ts         # DOM walker (500 nodes), redaction overlay (Shadow DOM), buildSanitizedContext, executeAction
  popup/{main.ts,style.css,index.html}
modules/
  pii/{regex.ts,redactor.ts}   # patterns + Luhn, placeholderFor, redactScreenshot, iou metrics
  vision/types.ts
  messaging/protocol.ts
server/app.py              # FastAPI, heuristic agent, optional HF VLM, /api/evaluate/redaction
public/test-pii.html       # synthetic PII corpus for metric 2/3 evaluation
```

## Setup
```bash
# Extension
npm install --ignore-scripts   # onnxruntime-node postinstall needs ignore on CI without CUDA
npm run dev                # or npm run build && load .output/chrome-mv3

# Server — always-sanitized text-only (no vision model needed)
pip install fastapi uvicorn starlette anyio pydantic python-multipart httpx python-dotenv
# Heuristic (default, 1ms, deterministic — proves sanitized ax_tree suffices):
python3 -m uvicorn server.app:app --port 8000 --reload
# Nvidia NIM 8B text-only (sanitized, not 70B — 70B is overkill for structured click task):
# .env already has NVIDIA_API_KEY=nvapi-*** ; model 8B text-only because vision already done locally (yolos/ner)
VLM_BACKEND=nvidia NVIDIA_MODEL=nvidia/mistral-nemo-minitron-8b-8k-instruct python3 -m uvicorn server.app:app --port 8000
# Vision model only needed if you send screenshot: meta/llama-3.2-11b-vision-instruct (11B) — not needed for ax_tree-only
# Local HF VLM (needs GPU 8GB): VLM_BACKEND=hf HF_MODEL=Qwen/Qwen2-VL-2B-Instruct python3 -m uvicorn server.app:app --port 8000
# OpenAI/Gemini passthrough: VLM_BACKEND=openai OPENAI_API_KEY=... or VLM_BACKEND=gemini GEMINI_API_KEY=...

# Health check
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/agent/step -H "Content-Type: application/json" \
  -d '{"url":"https://a.com","title":"T","viewport":{"width":1280,"height":800},"ax_tree":[{"role":"button","name":"Submit","tag":"button","bbox":[0,0,10,10]}],"redacted_regions":[],"redaction_scheme":"...","timestamp":1,"task":"click Submit"}'
```

## Models (local, quantized)
| Task | Model | q8 size | Device |
|---|---|---|---|
| NER | `Xenova/distilbert-base-cased-finetuned-conll03-english` | ~66MB → 17MB q8 | webgpu fp16 / wasm q8 |
| Detection | `Xenova/yolos-tiny` | 30MB → 16MB q4 | webgpu/wasm |
| Face (optional) | `ultraface-320` 1.2MB | — | wasm |

All via `@huggingface/transformers@3.x`, `env.useBrowserCache=true`, lazy load, `pipe.dispose()` on demand. Progress via `progress_callback` → `chrome.storage.local.mlProgress`.

## Evaluation (maps to 5 metrics)
- **Metric 1 (25%) visual context:** AXTree extraction vs ground truth (node count, bbox IoU). Measured in `metrics.extractionMs`.
- **Metric 2 (20%) PII recall/precision:** Run `public/test-pii.html` corpus (8 PII types + 4 sensitive inputs + 2 faces). Check `redacted_regions` vs `groundTruth` in `server/app.py:POST /api/evaluate/redaction`.
- **Metric 3 (20%) redaction precision:** Typed placeholders not over-redaction; IoU≥0.5 per region type.
- **Metric 4 (20%) client resource:** q8/q4, lazy, offscreen, dispose. Monitor `chrome.storage.estimate`, Task Manager heap. Budget JS heap <300MB.
- **Metric 5 (15%) E2E latency:** `popup` metrics + `server thought | server XmS`. Target local <400ms (wasm) / <150ms (webgpu), total <2s.

Quick local eval:
```bash
node --loader tsx modules/pii/regex.test.ts  # or run content script's __visionBuildContext in console
curl -X POST http://localhost:8000/api/evaluate/redaction -H "Content-Type: application/json" \
  -d '{"predicted":[{"bbox":[10,10,100,20],"type":"EMAIL","confidence":0.97}],"ground_truth":[{"bbox":[10,10,100,20],"type":"EMAIL","confidence":1}]}'
```

## WXT Notes (from skills)
- Service worker listeners registered synchronously (`svc-register-listeners-synchronously`) — `entrypoints/background.ts:6`
- Offscreen for DOM/WASM (`svc-offscreen-documents`) — required MV3
- CSP `wasm-unsafe-eval`, `web_accessible_resources` for wasm
- Bundle: externalize wasm intent, but current build bundles ort-wasm ~21MB (22.48MB total) — acceptable under 100MB limit; optimize with `q4` + CDN caching for production
- SPA handling via `wxt:locationchange`

## Limitations & Next
- Screenshot capture needs `activeTab` + user gesture; fallback to DOM-only sanitized context if denied
- Vision NER timeout 800ms to keep E2E <2s
- HF VLM path is scaffold — wire `AutoProcessor` generation for full VLM demo on GPU machine

## Mentors
Gulshan Gupta (gulshang@sac.isro.gov.in), Navita Jayesh Thakkar (navitat@sac.isro.gov.in) — ISRO SAC
