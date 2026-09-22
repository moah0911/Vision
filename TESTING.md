# Testing Real — Load Extension + Agent Tasks

## 1. Build (already done)
```bash
npm install --ignore-scripts
node node_modules/wxt/bin/wxt.mjs build        # -> .output/chrome-mv3 (22.48MB)
node node_modules/wxt/bin/wxt.mjs zip         # -> .output/vision-privacy-agent-0.1.0-chrome.zip 5.25MB
# Firefox optional:
node node_modules/wxt/bin/wxt.mjs build --browser firefox  # -> .output/firefox-mv2
```

## 2. Load in Chrome/Edge (MV3)
1. `chrome://extensions` → Developer mode ON (top-right toggle)
2. **Load unpacked** → select `Vision/.output/chrome-mv3` folder (not the zip)
3. Pin **Vision Privacy Agent** (puzzle icon → pin)
4. Verify: popup shows `on-device • WebGPU`, `storage: …`, Quant `q8/q4`

**Firefox (MV2):**
1. `about:debugging` → This Firefox → Load Temporary Add-on → pick `Vision/.output/firefox-mv2/manifest.json`
2. Temporary until restart; same popup.

**Brave/Opera:** same as Chrome.

## 3. Start Server (always-sanitized text-only)
```bash
# Heuristic baseline (1ms, deterministic — proves sanitized ax_tree suffices, no API cost):
python3 -m uvicorn server.app:app --port 8000 --reload
# Check:
curl http://localhost:8000/health
# → {"backend":"heuristic","model":"heuristic","sanitized_only":true,"vision_needed":false}

# Nvidia NIM 8B text-only (sanitized, not 70B — 70B overkill for click task):
# .env already has NVIDIA_API_KEY=nvapi-*** (gitignored)
VLM_BACKEND=nvidia NVIDIA_MODEL=nvidia/mistral-nemo-minitron-8b-8k-instruct python3 -m uvicorn server.app:app --port 8000
# Note: current key entitlement returns 404 → server fallbacks to heuristic with [fallback:...] tag (still correct click)
# If you have entitled key, it will hit Nvidia NIM at https://integrate.api.nvidia.com/v1

# In popup, set Server URL = http://localhost:8000 → Save
```

## 4. Test Real (test-pii.html + any site)
### A. Synthetic PII page (metrics 2/3 proof)
1. Popup → **Open PII test page** → shows 2 emails, 3 phones, Aadhaar/PAN/CC, password, 2 faces
2. Popup Task: `summarize page` → **1. Scan & Redact Locally** → observe 8+ black/blur masks with `[REDACTED:EMAIL]` labels, metrics `extraction ~12ms pii ~3ms vision ~45ms`
3. **Privacy proof:** DevTools (F12 → Network) → **no request yet**. Popup → `view lastContext` → verify `[REDACTED:EMAIL]` not raw `john.doe@example.com`. `screenshot_redacted_b64` has black boxes.
4. **Agent task (supported):**
   - Task `click Submit` → Scan → **Ask Agent (sanitized only)** → see `{"thought":"... | server 1ms | leak_check: ok","action":{"type":"click","target":{"name":"Submit","bbox":[100,200,80,30]}}}` → **Execute action** → Submit alert fires
   - Try: `scroll down` → Execute scrolls 500px; `click Add to Cart` not on this page → fallback click first button
   - Try: `click Bottom Target` → scroll test

### B. Any real site (e-commerce, form)
1. Go to `https://example.com` or your app → Popup Task: `click <visible button text>` / `scroll down`
2. Scan & Redact → masks appear over any detected PII (email/phone inputs blacked)
3. Ask Agent → Execute → action runs via `elementFromPoint` + `name` matching (`content/index.ts:229`)

### C. Supported agent actions (real)
- `click <name>` / `click the Submit button`
- `fill "hello" in input` (targets first non-sensitive input, shows **Confirm Fill**)
- `scroll down` / `scroll up`
- `press Enter`
- `summarize page` → `say` message
- Multi-step: **repeat** Scan→Ask→Execute per step (server is stateless; no auto-loop yet)

## 5. Multi-step Loop (manual)
For 5-8 task workflow (your major-project scope):
1. `click Submit` → Execute
2. `scroll down` → Execute
3. `fill "demo" in input` → Confirm Fill → Execute
4. `summarize page` → check `say`

For autonomous loop (future), wire `background` to iterate: call `/api/agent/step` repeatedly until `done`.

## 6. Troubleshooting
- **Masks not visible:** Check popup `show local masks` ON; reload page once after install (content script `document_idle`)
- **Screenshot null:** Needs `activeTab` — click extension icon on that tab (grants activeTab); fallback is DOM-only (still works, no image)
- **First Scan slow:** Models lazy-load via `Cache API` (~17MB q8 first time, `progress` bar 0-100%); use `Preload models` to warm
- **Server 404/410:** Nvidia key not entitled → fallback heuristic still correct; check `thought` starts with `[fallback:`; use heuristic for Viva
- **Firefox masks offset:** MV2 `allFrames:false` — test in Chrome for eval

## 7. Packaging for submission
```bash
node node_modules/wxt/bin/wxt.mjs zip
# → .output/vision-privacy-agent-0.1.0-chrome.zip (submit to reviewer)
```

## 8. Verification commands
```bash
node scripts/evaluate-full.mjs
curl -X POST http://localhost:8000/api/evaluate/redaction -H "Content-Type: application/json" -d '{"predicted":[{"bbox":[10,10,100,20],"type":"EMAIL","confidence":0.97}],"ground_truth":[{"bbox":[10,10,100,20],"type":"EMAIL","confidence":1}]}'
node scripts/test-server.mjs
```
