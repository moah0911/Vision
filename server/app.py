"""
Server side — receives ONLY sanitized context, never raw PII.
Aware of redaction scheme: placeholders [REDACTED:TYPE] + black/blur boxes.
Returns actionable commands for client executor.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Any
import re
import time
import os

app = FastAPI(title="Vision Privacy Agent Server", version="0.1.0")

# This is a localhost development server. It was mounted with allow_origins=["*"] together with
# allow_credentials=True, which browsers reject (a credentialed response cannot carry a wildcard
# origin) and which would expose the agent endpoint to any site in the browser if it ever bound
# beyond loopback.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Serve test-pii.html and ground-truth via http (so content script injects — extension pages don't match <all_urls>)
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
if PUBLIC_DIR.exists():
    # Mount /static for whole public dir
    app.mount("/static", StaticFiles(directory=str(PUBLIC_DIR)), name="static")
    @app.get("/test-pii.html", include_in_schema=False)
    def serve_test_pii():
        return FileResponse(str(PUBLIC_DIR / "test-pii.html"), media_type="text/html")
    @app.get("/ground-truth.json", include_in_schema=False)
    def serve_ground_truth():
        return FileResponse(str(PUBLIC_DIR / "ground-truth.json"), media_type="application/json")

# ---- Models ---- (bbox floats from getBoundingClientRect sub-pixel; accept float, coerce to int on store)
class Viewport(BaseModel):
    width: int
    height: int

class AxNode(BaseModel):
    role: str
    name: str
    tag: str
    bbox: List[float]
    value: Optional[str] = None
    inputType: Optional[str] = None
    isSensitive: Optional[bool] = None
    placeholder: Optional[str] = None

class RedactedRegion(BaseModel):
    bbox: List[float]
    type: str
    confidence: float

class SanitizedContext(BaseModel):
    url: str
    title: str
    viewport: Viewport
    ax_tree: List[AxNode]
    redacted_regions: List[RedactedRegion] = []
    screenshot_redacted_b64: Optional[str] = None
    redaction_scheme: str
    task: Optional[str] = None
    timestamp: int
    metrics: Optional[dict] = None
    # False when the client's on-device NER pass did not finish, so entity names could not be
    # confirmed stripped from node text. Surfaces in /health and in the step response.
    pii_text_scan_complete: Optional[bool] = None

    def has_region_type(self, *types: str) -> bool:
        wanted = {t.upper() for t in types}
        return any(r.type.upper() in wanted for r in self.redacted_regions)

class AgentAction(BaseModel):
    type: str  # click | fill | scroll | hover | press | wait | done | say
    target: Optional[dict] = None
    value: Optional[str] = None
    direction: Optional[str] = None
    amount: Optional[int] = None
    key: Optional[str] = None
    message: Optional[str] = None

class AgentResponse(BaseModel):
    thought: str
    action: AgentAction
    alternatives: Optional[List[AgentAction]] = None
    requiresConfirmation: bool = False

# ---- Redaction-aware prompt builder ----
SYSTEM_PROMPT = """You are a browser automation agent. You receive SANITIZED UI context where all PII is already redacted locally:
- Placeholders like [REDACTED:EMAIL], [REDACTED:PHONE], [REDACTED:CREDIT_CARD], [REDACTED:PERSON_NAME] replace sensitive values. Every form field's value arrives as a placeholder; a field you did not classify is [REDACTED:VALUE]. You must NOT ask for raw PII.
- Black boxes / blurred regions in screenshot_redacted_b64 are sensitive fields/faces.
- Node `name` may be [REDACTED:TEXT] when the client's on-device NER pass did not finish. Match elements by `role` and `bbox` in that case, not by name.
- You MUST reason over structure (ax_tree roles/names/bboxes) and return ONE JSON action.
- Available actions: click {target:{name|bbox|role}}, fill {target, value}, scroll {direction:up|down, amount}, say {message}, done {message}.
- There is no `press` or `hover`: synthetic key events are not trusted by the page, so they cannot submit or hover reliably.
- Prefer bbox or name matching over selector if selector missing.
- Never hallucinate PII. Never request PII.
- Output strictly: {"thought":"...","action":{"type":"...","target":{...}}}
"""

# ---- Heuristic agent (no GPU) — deterministic for demo ----
# For full VLM, swap with HF pipeline below.

def heuristic_agent(ctx: SanitizedContext) -> AgentResponse:
    task = (ctx.task or "").lower().strip()
    nodes = ctx.ax_tree

    # Normalize task
    def find_node(pred):
        for n in nodes:
            if pred(n):
                return n
        return None

    # Task routing
    if not task:
        return AgentResponse(
            thought="No task provided. Summarize page without exposing PII.",
            action=AgentAction(type="say", message=f"Page '{ctx.title}' has {len(nodes)} interactive elements. {len(ctx.redacted_regions)} regions redacted locally. Ready for task."),
        )

    if "click" in task:
        m = re.search(r"click\s+(?:the\s+)?(.+)", task)
        target_name = (m.group(1) if m else "").strip().strip("'\"").lower()
        # Score candidates: prefer button role/tag, exact name, small bbox (avoids generic 780x818 container)
        candidates = []
        for n in nodes:
            nl = n.name.lower()
            if target_name and target_name not in nl and nl not in target_name:
                # For submit, also match if task says submit and node name contains submit
                if not (target_name and any(w in nl for w in target_name.split())):
                    continue
            # Filter to plausible clickable
            if not target_name and n.role not in ("button", "link") and n.tag not in ("button", "a"):
                continue
            candidates.append(n)
        # If no filtered candidates, consider all containing target
        if not candidates and target_name:
            candidates = [n for n in nodes if target_name in n.name.lower() or any(w in n.name.lower() for w in target_name.split())]
        if not candidates:
            candidates = [n for n in nodes if n.role in ("button", "link") or n.tag in ("button", "a")]
        # Sort by: button first, then tag button, then small area, then short name (exact match)
        def score(n):
            is_btn = 0 if n.role == "button" else (1 if n.tag == "button" else (2 if n.role == "link" else 3))
            area = n.bbox[2] * n.bbox[3] if len(n.bbox) >= 4 else 1e9
            exact = 0 if n.name.lower().strip() == target_name else 1
            return (is_btn, exact, area, len(n.name))
        candidates.sort(key=score)
        if candidates:
            n = candidates[0]
            return AgentResponse(
                thought=f"Task asks to click '{target_name}'. Chose node '{n.name.strip()}' role={n.role} tag={n.tag} area={int(n.bbox[2]*n.bbox[3])} at {n.bbox} (scored {len(candidates)} candidates). Click via name/bbox.",
                action=AgentAction(type="click", target={"name": n.name.strip(), "bbox": n.bbox, "role": n.role}),
            )
        return AgentResponse(thought="No clickable target found", action=AgentAction(type="say", message="No clickable element matching task"))

    if "scroll" in task:
        direction = "down" if "down" in task else "up"
        return AgentResponse(thought=f"Scroll {direction} requested", action=AgentAction(type="scroll", direction=direction, amount=500))

    if "submit" in task:
        n = find_node(lambda x: "submit" in x.name.lower() or (x.tag == "button" and "submit" in x.name.lower()))
        if not n:
            n = find_node(lambda x: x.tag == "button")
        if n:
            return AgentResponse(thought="Submit task -> click submit button", action=AgentAction(type="click", target={"name": n.name, "bbox": n.bbox}))
        return AgentResponse(thought="No submit", action=AgentAction(type="say", message="No submit button found"))

    if "fill" in task or "type" in task:
        # Only fields with no typed value are offered. The client redacts every form value to
        # a placeholder, so a pre-filled field looks identical to an empty one here and must
        # not be overwritten with a guess.
        n = find_node(lambda x: x.tag == "input" and not x.isSensitive and not x.value)
        if n:
            m2 = re.search(r"fill.*?['\"](.+?)['\"]", task)
            val = m2.group(1) if m2 else "demo-value"
            return AgentResponse(
                thought=f"Fill task -> targeting empty input '{n.name}'",
                action=AgentAction(type="fill", target={"name": n.name, "bbox": n.bbox}, value=val),
                requiresConfirmation=True,
            )
        # Previously fell through to the default branch below, so a fill request with no
        # eligible field silently became a click on the primary button.
        return AgentResponse(
            thought="No empty non-sensitive input to fill",
            action=AgentAction(type="say", message="No empty input field available to fill"),
        )

    if "summarize" in task:
        return AgentResponse(
            thought="Summarize sanitized context",
            action=AgentAction(type="say", message=f"Sanitized page '{ctx.title}' — {len(nodes)} elements, {len(ctx.redacted_regions)} PII regions redacted. URL: {ctx.url}. Ready for next step."),
        )

    # Default: propose most salient action
    btn = find_node(lambda x: x.role == "button")
    if btn:
        return AgentResponse(thought=f"Default: click primary button '{btn.name}'", action=AgentAction(type="click", target={"name": btn.name, "bbox": btn.bbox}))
    return AgentResponse(thought="No button, scroll to explore", action=AgentAction(type="scroll", direction="down", amount=400))

# ---- Optional VLM path ----
# Set VLM_BACKEND=hf or openai/gemini to enable. Default: heuristic (zero GPU, deterministic for evaluation).

# Load .env if present
try:
    from dotenv import load_dotenv
    load_dotenv()
except: pass

VLM_BACKEND = os.getenv("VLM_BACKEND", "heuristic")  # heuristic | hf | openai | gemini | nvidia
HF_MODEL = os.getenv("HF_MODEL", "Qwen/Qwen2-VL-2B-Instruct")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
# Nvidia NIM — OpenAI-compatible, always-sanitized text-only (no vision needed)
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_MODEL = os.getenv("NVIDIA_MODEL", "nvidia/mistral-nemo-minitron-8b-8k-instruct")  # 8B text-only, not 70B — sanitized ax_tree doesn't need vision (70B would be waste for structured click task)
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")

hf_processor = None
hf_model = None

def ensure_hf():
    global hf_processor, hf_model
    if hf_processor is not None:
        return
    from transformers import AutoProcessor, AutoModelForVision2Seq
    import torch
    hf_processor = AutoProcessor.from_pretrained(HF_MODEL, trust_remote_code=True)
    hf_model = AutoModelForVision2Seq.from_pretrained(HF_MODEL, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
    hf_model.eval()

async def call_openai(ctx: SanitizedContext) -> AgentResponse:
    """OpenAI-compatible (OpenAI, Groq, Together) — redaction-aware."""
    import httpx, json as _json
    base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    # Build minimal ax_tree text
    ax_text = "\n".join(f"- {n.role} '{n.name}' {n.bbox} tag={n.tag}" + (f" value={n.value}" if n.value else "") for n in ctx.ax_tree[:30])
    user_msg = f"Task: {ctx.task or 'summarize'}\nURL: {ctx.url}\nTitle: {ctx.title}\nAX Tree:\n{ax_text}\nRedacted regions: {len(ctx.redacted_regions)}\nRedaction scheme: {ctx.redaction_scheme}\nReturn JSON only: {{\"thought\":\"...\",\"action\":{{\"type\":\"click|fill|scroll|say\",\"target\":{{}},\"value\":\"\"}}}}"
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{base}/chat/completions", headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"}, json={
            "model": OPENAI_MODEL, "messages": [{"role":"system","content": SYSTEM_PROMPT},{"role":"user","content": user_msg}], "temperature": 0.2, "max_tokens": 400,
        })
        r.raise_for_status()
        txt = r.json()["choices"][0]["message"]["content"]
        # Extract JSON
        m = re.search(r"\{[\s\S]*\}", txt)
        j = _json.loads(m.group(0) if m else txt)
        act = j.get("action") or j
        return AgentResponse(thought=j.get("thought","openai"), action=AgentAction(**act) if isinstance(act, dict) else AgentAction(type="say", message=txt[:300]))

async def call_gemini(ctx: SanitizedContext) -> AgentResponse:
    import httpx, json as _json
    ax_text = "\n".join(f"- {n.role} '{n.name}' {n.bbox}" for n in ctx.ax_tree[:30])
    prompt = SYSTEM_PROMPT + f"\nTask: {ctx.task}\nAX:\n{ax_text}"
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}", json={"contents":[{"parts":[{"text":prompt}]}], "generationConfig":{"temperature":0.2}})
        r.raise_for_status()
        txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        m = re.search(r"\{[\s\S]*\}", txt)
        j = _json.loads(m.group(0) if m else "{}")
        act = j.get("action") or {"type":"say","message":txt[:300]}
        return AgentResponse(thought=j.get("thought","gemini"), action=AgentAction(**act))

async def call_nvidia(ctx: SanitizedContext) -> AgentResponse:
    """Nvidia NIM — text-only, always-sanitized. No vision model needed: ax_tree is already sanitized."""
    import httpx, json as _json
    # Always-sanitized: send ax_tree + redaction_scheme + task, ignore screenshot (saves tokens/latency)
    ax_text = "\n".join(
        f"- {n.role} '{n.name}' {n.bbox} tag={n.tag}" + (f" value={n.value}" if n.value else "") + (f" isSensitive={n.isSensitive}" if n.isSensitive else "")
        for n in ctx.ax_tree[:40]
    )
    redacted_info = f"Redacted regions: {len(ctx.redacted_regions)} ({', '.join(r.type for r in ctx.redacted_regions[:8])})"
    user_msg = (
        f"Task: {ctx.task or 'summarize'}\nURL: {ctx.url}\nTitle: {ctx.title}\n"
        f"AX Tree (already sanitized, [REDACTED:TYPE] placeholders):\n{ax_text}\n"
        f"{redacted_info}\nRedaction scheme: {ctx.redaction_scheme}\n"
        f"Instruction: Return JSON only: {{\"thought\":\"brief reasoning\",\"action\":{{\"type\":\"click|fill|scroll|say\",\"target\":{{\"name\":\"exact name from ax_tree\",\"bbox\":[x,y,w,h],\"role\":\"role\"}},\"value\":\"fill value if fill\",\"direction\":\"up|down\",\"amount\":400,\"message\":\"say text\"}}}}"
        f" Rules: Use exact name/bbox from ax_tree. Never ask for PII. For fill, requiresConfirmation=true."
    )
    async with httpx.AsyncClient(timeout=25) as c:
        r = await c.post(
            f"{NVIDIA_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {NVIDIA_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": NVIDIA_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT + "\nYou must output valid JSON only. No markdown."},
                    {"role": "user", "content": user_msg},
                ],
                "temperature": 0.2,
                "top_p": 0.9,
                "max_tokens": 500,
            },
        )
        r.raise_for_status()
        data = r.json()
        txt = data["choices"][0]["message"]["content"] or ""
        # Robust JSON extract (handle ```json fences)
        txt = re.sub(r"```(?:json)?", "", txt).strip()
        m = re.search(r"\{[\s\S]*\}", txt)
        j = _json.loads(m.group(0) if m else txt)
        # Normalize: some models wrap in {thought, action} or just action
        thought = j.get("thought") or j.get("reasoning") or "nvidia"
        act = j.get("action") or j
        # If act is nested weirdly, flatten
        if isinstance(act, dict) and "action" in act and isinstance(act["action"], dict):
            act = act["action"]
        # Validate type
        if not isinstance(act, dict) or "type" not in act:
            # Try to infer from task
            if ctx.task and "click" in ctx.task.lower():
                act = {"type": "click", "target": {"name": ctx.ax_tree[0].name if ctx.ax_tree else "", "bbox": ctx.ax_tree[0].bbox if ctx.ax_tree else [0,0,10,10]}}
            else:
                act = {"type": "say", "message": txt[:400]}
        return AgentResponse(thought=thought, action=AgentAction(**act), requiresConfirmation=act.get("type")=="fill")

# Leak patterns the client is expected to have neutralised. Checked against BOTH `name` and
# `value`: the original guard only looked at `name` for email, which is the one field the
# client was actually leaking (form values are carried in `value`).
LEAK_PATTERNS: List[tuple[str, "re.Pattern[str]"]] = [
    ("email", re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)),
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("credit_card", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
    ("aadhaar", re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")),
    ("pan", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    ("ip_address", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    # A bare 10-15 digit run is a phone number. Credit cards and Aadhaar numbers also match, so
    # only report this when the field is not already explained by a stronger pattern.
    ("phone", re.compile(r"\+?\d[\d\s().-]{7,18}\d")),
]

# A name is not machine-detectable, so this cannot be a regex check. Instead the client
# reports whether its NER pass completed, and we surface that state rather than assert
# entity-level completeness we cannot verify from here.
def scan_for_raw_pii(ctx: SanitizedContext) -> List[str]:
    findings: List[str] = []
    for node in ctx.ax_tree:
        for field in ("name", "value"):
            text = getattr(node, field, None)
            if not isinstance(text, str) or not text:
                continue
            matched = {label for label, pattern in LEAK_PATTERNS if pattern.search(text)}
            # A 16-digit card and a 12-digit Aadhaar number both satisfy the broad phone
            # pattern. Report only the most specific explanation, not all three.
            if matched & {"credit_card", "aadhaar"}:
                matched.discard("phone")
            for label in sorted(matched):
                findings.append(f"{label} in ax_tree.{field}")
    if ctx.pii_text_scan_complete is False:
        findings.append("client NER pass incomplete - entity names unverified")
    # Deduplicate while preserving order so the message is stable.
    return list(dict.fromkeys(findings))

@app.get("/health")
def health():
    model = {"heuristic": "heuristic", "hf": HF_MODEL, "openai": OPENAI_MODEL, "gemini": "gemini-1.5-flash", "nvidia": NVIDIA_MODEL}.get(VLM_BACKEND, VLM_BACKEND)
    return {
        "ok": True,
        "backend": VLM_BACKEND,
        "model": model,
        # The server verifies structured PII is absent, but cannot verify that person names are
        # gone — that depends on the client's NER pass. Callers should read
        # pii_text_scan_complete on each context rather than trusting this flag alone.
        "sanitized_only": "structured-verified",
        "vision_needed": False,
    }

@app.get("/")
def root():
    return {"name": "Vision Privacy Agent Server", "docs": "/docs", "health": "/health", "redaction_scheme": SYSTEM_PROMPT[:200] + "..."}

@app.post("/api/agent/step", response_model=AgentResponse)
async def agent_step(ctx: SanitizedContext):
    t0 = time.time()
    leaks = scan_for_raw_pii(ctx)
    try:
        if VLM_BACKEND == "heuristic":
            resp = heuristic_agent(ctx)
        elif VLM_BACKEND == "hf":
            ensure_hf()
            # For 2B model, wire generation if screenshot present else fallback
            # Quick path: still heuristic + tag so demo runs on CPU
            resp = heuristic_agent(ctx)
            resp.thought = "[HF " + HF_MODEL + "] " + resp.thought
        elif VLM_BACKEND == "openai":
            if not OPENAI_API_KEY:
                resp = heuristic_agent(ctx)
                resp.thought = "[openai-no-key-fallback] " + resp.thought
            else:
                resp = await call_openai(ctx)
        elif VLM_BACKEND == "gemini":
            if not GEMINI_API_KEY:
                resp = heuristic_agent(ctx)
                resp.thought = "[gemini-no-key-fallback] " + resp.thought
            else:
                resp = await call_gemini(ctx)
        elif VLM_BACKEND == "nvidia":
            if not NVIDIA_API_KEY:
                resp = heuristic_agent(ctx)
                resp.thought = "[nvidia-no-key-fallback] " + resp.thought
            else:
                resp = await call_nvidia(ctx)
                resp.thought = f"[nvidia:{NVIDIA_MODEL}] {resp.thought}"
        else:
            resp = heuristic_agent(ctx)
            resp.thought = f"[{VLM_BACKEND}] " + resp.thought
    except Exception as e:
        # Fallback never break demo
        resp = heuristic_agent(ctx)
        resp.thought = f"[fallback:{type(e).__name__}:{str(e)[:80]}] " + resp.thought
    elapsed = int((time.time() - t0) * 1000)
    if leaks:
        resp.thought += f" | server {elapsed}ms | LEAK WARNING: {'; '.join(leaks)}"
    else:
        resp.thought += f" | server {elapsed}ms | leak_check: ok"
    return resp

# Optional: evaluation helper endpoint
#
# Greedy 1:1 matching, mirroring measureRedactionPrecision() in modules/pii/redactor.ts. The
# previous version let every prediction claim the same ground-truth box, so three predictions
# over one label counted as three true positives and inflated recall.
@app.post("/api/evaluate/redaction")
def evaluate_redaction(predicted: List[RedactedRegion], ground_truth: List[RedactedRegion], iou_thresh: float = 0.5):
    def iou(a, b):
        ax, ay, aw, ah = a.bbox
        bx, by, bw, bh = b.bbox
        x1, y1 = max(ax, bx), max(ay, by)
        x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
        w, h = max(0, x2 - x1), max(0, y2 - y1)
        inter = w * h
        union = aw * ah + bw * bh - inter
        return inter / union if union else 0

    if not predicted and not ground_truth:
        return {"precision": 1, "recall": 1, "f1": 1, "tp": 0, "fp": 0, "fn": 0}
    if not predicted:
        return {"precision": 0, "recall": 0, "f1": 0, "tp": 0, "fp": 0, "fn": len(ground_truth)}
    if not ground_truth:
        return {"precision": 0, "recall": 0, "f1": 0, "tp": 0, "fp": len(predicted), "fn": 0}

    pairs = []
    for pi, p in enumerate(predicted):
        for gi, g in enumerate(ground_truth):
            if g.type.upper() != p.type.upper():
                continue
            score = iou(p, g)
            if score >= iou_thresh:
                pairs.append((score, pi, gi))
    pairs.sort(key=lambda t: -t[0])

    used_p, used_g = set(), set()
    for _score, pi, gi in pairs:
        if pi in used_p or gi in used_g:
            continue
        used_p.add(pi)
        used_g.add(gi)

    tp = len(used_p)
    fp, fn = len(predicted) - tp, len(ground_truth) - tp
    precision = tp / len(predicted)
    recall = tp / len(ground_truth)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}
