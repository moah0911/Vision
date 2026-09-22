# Demo Script (2 min for evaluators)

**Setup:** `npm run build && python3 -m uvicorn server.app:app --port 8000` (or `VLM_BACKEND=openai OPENAI_API_KEY=...`)

1. **Load:** `chrome://extensions` → Developer ON → Load unpacked `.output/chrome-mv3`
2. **Test page:** Popup → **Open PII test page** (shows 2 emails, 3 phones, Aadhaar/PAN/CC, password, 2 faces)
3. **Metric 2/3 prove local:** Popup → Task `summarize page` → **Scan & Redact** → see 8+ black/blur masks with `[REDACTED:EMAIL]` labels. Open DevTools → Network: **no request yet** (proves zero-leak). Click `view lastContext` → verify placeholders, not raw emails.
4. **Server step:** **Ask Agent (sanitized only)** → see `{"thought":"... | server 1ms | leak_check: ok","action":{"type":"say"}}` — server only saw sanitized.
5. **Action:** Task `click Submit` → Scan → Ask Agent → **Execute action** → Submit button clicks (or scroll test: Task `scroll down`).
6. **Metrics panel:** Show `metrics: extraction 12ms pii 3ms vision 45ms redact 8ms` + `storage 12MB/..." +`heap 45MB` + q8/q4 switch.
7. **Network proof:** DevTools → Payload tab → `ax_tree` contains `[REDACTED:EMAIL]`, `screenshot_redacted_b64` has black boxes.

**Fallback if screenshot blocked:** Popup unchecked `include screenshot` still works (DOM-only).

**Record:** Use Chrome screen record; narrate 5 metrics mapping.
