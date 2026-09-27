# Vision Privacy Agent — On-device Visual Perception for Light-weight Browser Agents

> **SIH / Final Year Project** — Privacy-preserving browser agent that runs a local Vision Transformer (via WebGPU/WASM + Transformers.js) to read screen state, dynamically redacts PII (faces/passwords/emails/phones/cards/Aadhaar/PAN), and sends **only sanitized** context to server. Server (FastAPI + VLM/heuristic) returns actionable commands (`click`/`fill`/`scroll`/`say`) that the client executes.

## Demo (2 min flow) — see TESTING.md for full steps
1. `chrome://extensions` → Developer ON → Load unpacked `.output/chrome-mv3` (or `npm run dev`)
2. Popup → **Open PII test page** (must be the `http://localhost:8000/test-pii.html` URL — a `chrome-extension://` page has no content script and can never be scanned)
3. Task `Click Submit` → **1. Scan & Redact Locally** → black/blur masks + metrics (extraction/pii/vision/redact ms)
4. `python3 -m uvicorn server.app:app --port 8000` (or `npm run server:nvidia` with 8B text `nvidia/mistral-nemo-minitron-8b-8k-instruct` — 70B overkill, vision already done locally)
5. **Ask Agent (sanitized only)** → `{"thought":"... | server 1ms | leak_check: ok","action":{"type":"click",...}}`
6. **Execute action** → click/scroll. `view lastContext` proves `[REDACTED:EMAIL]` not raw.

Agent tasks real: `click <name>`, `fill "x" in input`, `scroll down/up`, `hover <name>`, `wait`, `summarize page`. Multi-step = repeat.

> `press Enter` is **not** supported. A synthetic `KeyboardEvent` is untrusted, so the browser
> performs no default action and nothing submits. `pressKey` calls `form.requestSubmit()` when the
> target is inside a form, which does run the page's submit handler; anything else is reported as
> a failure rather than a silent success.

> **Viewport-scoped.** The AX tree and `redacted_regions` cover the visible viewport only
> (`isVisible` / `isOnScreen`). Controls below the fold are not extracted, so a task naming one
> needs a `scroll` first. See *Limitations*.

## Architecture
```
Content Script (ISOLATED, document_idle)  → extracts AXTree + bbox, regex PII sync
Background (MV3 SW)                       → offscreen lifecycle + server fetch (sanitized only)
Offscreen Document (DOM)                  → Transformers.js: distilbert-NER (q8) + yolos-tiny (q8) via WebGPU/WASM fallback
Popup                                     → progress, metrics, latency
Server (FastAPI)                          → /api/agent/step — redaction-aware prompt, heuristic or VLM
Messaging (modules/messaging/protocol.ts) → typed, one handler per message name
```

**Privacy guarantee.** Structured PII (email, phone, credit card, SSN, Aadhaar, PAN, IP) is
verified absent from the outbound context by the server itself on every request, and by
`npm run test:e2e`. Specifically:

- **No form value is ever transmitted raw.** Every `input`/`textarea` value becomes
  `[REDACTED:<TYPE>]` when classified, or `[REDACTED:VALUE]` when not. This is deliberate:
  `type="text"` covers essentially every name field on the web, and a value we failed to
  classify is exactly the one that must not leak. A field's accessible name is never derived
  from its `value` attribute.
- **Entity names depend on the NER pass.** The on-device model replaces detected names in
  accessible names. If that pass does not complete, the context sets
  `pii_text_scan_complete: false` and node prose is *stripped* rather than transmitted. A
  timeout can never mean "send raw text".
- **What is not machine-verifiable:** a person or place name in prose is only detectable by the
  model, not by a regex, so the server cannot independently confirm it is gone. Read
  `pii_text_scan_complete` on the context rather than trusting `/health`'s `sanitized_only`
  (which reports `"structured-verified"` for exactly this reason).

Model weights are fetched from the HuggingFace CDN on first run and cached locally; page content
never leaves the device.

## Project Structure
```
wxt.config.ts              # MV3 manifest, CSP wasm-unsafe-eval, scoped web_accessible_resources
entrypoints/
  background.ts            # typed message router, offscreen lifecycle, AGENT_STEP fetch
  offscreen/main.ts        # pipeline('token-classification'/'object-detection'), device pick
  content/index.ts         # DOM walk, redaction, buildSanitizedContext, executeAction
  popup/{main.ts,style.css,index.html}
modules/
  config.ts                # server URL resolution (validated, single source)
  pii/{regex.ts,redactor.ts}   # patterns + Luhn, classifyFieldValue, redactFormValue,
                              # resolveOverlaps, redactScreenshot, measureRedactionPrecision
  vision/types.ts
  messaging/protocol.ts    # typed message map; one handler per message name
server/app.py              # FastAPI, heuristic agent, leak scan, /api/evaluate/redaction
public/test-pii.html       # synthetic PII corpus for evaluation
scripts/
  evaluate-full.mjs        # metric 2/3, imports the production detector
  e2e-leak.test.mjs        # headless Chrome, asserts no raw PII reaches the wire
  test-server.mjs          # smoke-test the agent endpoint
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
# put NVIDIA_API_KEY in .env (gitignored), then:
VLM_BACKEND=nvidia NVIDIA_MODEL=nvidia/mistral-nemo-minitron-8b-8k-instruct python3 -m uvicorn server.app:app --port 8000
# Vision model only needed if you send screenshot: meta/llama-3.2-11b-vision-instruct (11B) — not needed for ax_tree-only
# Local HF VLM (needs GPU 8GB): VLM_BACKEND=hf HF_MODEL=Qwen/Qwen2-VL-2B-Instruct python3 -m uvicorn server.app:app --port 8000
# OpenAI/Gemini passthrough: VLM_BACKEND=openai OPENAI_API_KEY=... or VLM_BACKEND=gemini GEMINI_API_KEY=...
# CORS is restricted to loopback by default; override for a non-local frontend:
#   ALLOWED_ORIGINS=https://your.host python3 -m uvicorn server.app:app --port 8000

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

Faces are covered by yolos-tiny's `person` class, not a dedicated face model. (An `ultraface-320`
row used to be listed here; nothing in the codebase loads it.)

All via `@huggingface/transformers@3.x`, `env.useBrowserCache=true`, lazy load, `pipe.dispose()` on
demand. Progress via `progress_callback` → `chrome.storage.local.mlProgress`. The popup's quant
selector is honoured where the backend supports it and the **effective** dtype is reported back:
WebGPU runs fp16/fp32 (q4/q8 are unavailable there) and WASM runs q4/q8 (fp16 has no WASM kernel).

## Evaluation (maps to 5 metrics)
- **Metric 1 (25%) visual context:** AXTree extraction vs ground truth (node count, bbox IoU). Timings in `metrics.extractionMs`. Verified structurally by `npm run test:e2e`.
- **Metric 2 (20%) PII recall:** split by detection source, because one detector cannot be scored against another's items. **Text** items (8) are scored by `npm run eval` against the production `modules/pii/regex.ts`; **form-value** (3), **selector** (1) and **ML** (4) items need a DOM or a model and are scored by `npm run test:e2e` / manual inspection. See `public/ground-truth.json` for which detector owns which item.
- **Metric 3 (20%) redaction precision:** typed placeholders, IoU≥0.5 with **greedy 1:1** matching (`measureRedactionPrecision` and `POST /api/evaluate/redaction`). Competing detections on the same pixels are resolved by type priority, so one field never carries two type labels.
- **Metric 4 (20%) client resource:** q8/q4, lazy load, offscreen, dispose. Monitor `chrome.storage.estimate` and Task Manager heap. Budget JS heap <300MB.
- **Metric 5 (15%) E2E latency:** popup metrics + `server thought | server Xms`. Target local <400ms (wasm) / <150ms (webgpu), total <2s.

```bash
npm run typecheck   # tsc --noEmit, clean
npm run eval        # metric 2 (text) + metric 3 matcher self-checks; exits non-zero on any miss
npm run build && npm run test:e2e   # 33 assertions incl. no-raw-PII, in real headless Chrome
```

`npm run eval` imports `modules/pii/regex.ts` directly rather than keeping its own copy of the
patterns. An earlier version duplicated the regexes, and the duplicate diverged enough to report
recall for a PHONE pattern that matched nothing in the shipped build.

The eval also strips `pre#groundTruth` from the fixture before scanning: the page prints its own
answer key, and counting those hits inflated apparent recall by roughly a third.

## WXT Notes (from skills)
- Service worker listeners registered synchronously (`svc-register-listeners-synchronously`) — `entrypoints/background.ts`
- Offscreen for DOM/WASM (`svc-offscreen-documents`) — required MV3
- CSP `wasm-unsafe-eval`; `web_accessible_resources` scoped to `chrome-extension://*/*` so
  `wasm/`, `models/` and `offscreen.html` are not fetchable by arbitrary sites
- `tsconfig.json` extends the generated `.wxt/tsconfig.json` and must keep `.wxt/wxt.d.ts` in
  `include` — it carries the `defineBackground` / `defineContentScript` / `browser` auto-import
  globals. Dropping it makes every entrypoint fail to resolve them.
- Bundle: 22.5MB total, ~21.6MB of it `ort-wasm`. Model weights load from the HF CDN at runtime.

## Limitations & Next
- **Viewport-scoped perception.** The AX tree and regions cover only the visible viewport. On a
  long page a task like "Click Submit" fails when the button is below the fold, because the
  element is never extracted. Re-scan after scrolling, or extend extraction to document
  coordinates (this needs care: `hitTest` and `redactScreenshot` are both viewport-based).
- **Person/place names in prose are not regex-verifiable.** They depend on the on-device NER
  model. When it does not run, the context is marked `pii_text_scan_complete: false` and prose
  is dropped. This is fail-closed but lossy: long node names become `[REDACTED:TEXT]`, so the
  agent must fall back to matching by `role` and `bbox`.
- `fill` only targets fields that are empty *and* not already sensitive, because every value
  arrives redacted and a pre-filled field is indistinguishable from an empty one.
- Screenshot capture needs `activeTab` + a user gesture; falls back to a DOM-only context.
- Vision budget is 900ms for NER + detection combined. On a cold model download the pass times
  out and the fail-closed path applies — preloading avoids this.
- HF VLM path is a scaffold — `ensure_hf()` loads the model but generation is not wired; the
  endpoint falls back to the heuristic agent.
- `redacted_regions` are single boxes per parent element, so two different PII values in one
  paragraph collapse to one region labelled with the higher-priority type. Per-value placeholders
  are still applied to the text, so no redaction is lost.

## Mentors
Gulshan Gupta (gulshang@sac.isro.gov.in), Navita Jayesh Thakkar (navitat@sac.isro.gov.in) — ISRO SAC
