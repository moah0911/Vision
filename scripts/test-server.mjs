const ctx = {
  url: "https://example.com",
  title: "Test Page",
  viewport: { width: 1280, height: 800 },
  ax_tree: [
    { role: "button", name: "Submit", tag: "button", bbox: [100,200,80,30] },
    { role: "input", name: "[REDACTED:EMAIL] field", tag: "input", bbox: [10,10,200,30], isSensitive: true }
  ],
  redacted_regions: [{ bbox: [10,10,200,30], type: "EMAIL", confidence: 0.97 }],
  redaction_scheme: "Placeholders [REDACTED:TYPE]",
  timestamp: Date.now(),
  task: "click Submit"
};
const url = process.env.SERVER_URL || "http://localhost:8000";
try {
  const r = await fetch(`${url}/api/agent/step`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ctx) });
  console.log("status", r.status);
  console.log(await r.json());
} catch(e) { console.error(e.message); console.log("Start server: python3 -m uvicorn server.app:app --port 8000"); }
