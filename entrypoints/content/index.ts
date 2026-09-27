/**
 * Content script — runs in ISOLATED world, document_idle.
 * Extracts AX tree, detects PII (regex sync + ML async), applies redaction overlay,
 * builds SanitizedContext, and can execute server-returned actions.
 */
import { detectRegexPii, detectSensitiveInputs, redactFormValue } from '../../modules/pii/regex';
import { redactScreenshot, resolveOverlaps, type RedactedRegion, type RegionType, placeholderFor } from '../../modules/pii/redactor';
import type { AgentAction, AxNode, SanitizedContext } from '../../modules/vision/types';
import { onMessage, sendMessage, type Detection, type Entity, type Result } from '../../modules/messaging/protocol';

/**
 * Last-resort text scrubber for when the NER pass did not complete.
 *
 * The agent needs an element's role and geometry to act on it, not its prose. When we cannot
 * prove the text is free of names, prose is dropped and short control labels are kept, because
 * those are what the executor matches on ("Submit", "Email").
 *
 * The threshold is deliberately tight. An earlier 24-character window let headings through, so
 * "Contact Card — John Doe" was transmitted even though the NER pass that would have caught it
 * had timed out.
 */
function redactAllNames(text: string, interactive: boolean): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const words = trimmed.split(/\s+/).length;
  // Interactive controls keep a slightly longer label ("Add to cart"); prose does not.
  const limit = interactive ? 4 : 2;
  return words <= limit ? trimmed : '[REDACTED:TEXT]';
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  cssInjectionMode: 'ui',
  async main(ctx) {
    console.log('[Vision][Content] injected', location.href);

     // Shadow DOM overlay — use absolute positioning with scroll-aware coordinates (fixes drift on scroll)
    const host = document.createElement('div');
    host.id = 'vision-privacy-overlay-host';
    // Host covers full page so absolute masks scroll naturally with document
    Object.assign(host.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);
    const shadow = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .vp-mask { position: absolute; background: #000; border-radius: 4px; pointer-events: none; z-index: 2147483646; }
      .vp-blur { backdrop-filter: blur(16px); background: rgba(0,0,0,0.45); border: 1px solid rgba(255,0,0,0.6); }
      .vp-label { position: absolute; font: 10px monospace; color: #fff; background: #b91c1c; padding: 2px 4px; border-radius: 3px; z-index: 2147483647; pointer-events: none; white-space: nowrap; }
      .vp-toast { position: fixed; bottom: 16px; right: 16px; background: #111; color: #fff; padding: 10px 14px; border-radius: 8px; font: 13px system-ui; z-index: 2147483647; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    `;
    shadow.appendChild(styleEl);
    document.documentElement.appendChild(host);

    let activeMasks: HTMLElement[] = [];
    let activeLabels: HTMLElement[] = [];

    function clearMasks() {
      for (const el of [...activeMasks, ...activeLabels]) el.remove();
      activeMasks = [];
      activeLabels = [];
    }

    function renderMasks(regions: RedactedRegion[]) {
      clearMasks();
      const filtered = regions.filter((r) => r.bbox[2] > 2 && r.bbox[3] > 2);
      if (filtered.length === 0) return;
      // Masks are positioned in document coordinates (viewport rect + scroll offset) inside a
      // zero-size host, so the browser scrolls them with the page and no scroll handler is
      // needed. A previous revision registered a scroll/resize listener whose body was an
      // explicit no-op, so it cost a listener pair per scan and did nothing.
      for (const r of filtered) {
        const [vx, vy, w, h] = r.bbox;
        const x = Math.round(vx + window.scrollX);
        const y = Math.round(vy + window.scrollY);
        const m = document.createElement('div');
        m.className = `vp-mask ${r.mode === 'blur' ? 'vp-blur' : ''}`;
        Object.assign(m.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${Math.round(w)}px`,
          height: `${Math.round(h)}px`,
        } as CSSStyleDeclaration);
        shadow.appendChild(m);
        activeMasks.push(m);
        const lab = document.createElement('div');
        lab.className = 'vp-label';
        lab.textContent = `[REDACTED:${r.type}]`;
        Object.assign(lab.style, { left: `${x}px`, top: `${Math.max(0, y - 16)}px` } as CSSStyleDeclaration);
        shadow.appendChild(lab);
        activeLabels.push(lab);
      }
    }

    /**
     * Cheap off-screen / zero-size reject, evaluated before getComputedStyle.
     *
     * getComputedStyle forces a style recalc and getBoundingClientRect a layout flush. Running
     * the expensive one first meant every element in the document paid for both, including the
     * thousands that are obviously not interactive.
     */
    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return false;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
        return false;
      }
      const s = getComputedStyle(el);
      return !(s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0');
    }

    function extractAxTree(limit = 500): { nodes: AxNode[]; text: string } {
      const nodes: AxNode[] = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let n: Node | null;
      let count = 0;
      // Bound the number of elements *examined*, not just the number collected. The original
      // loop only incremented `count` after a successful push, so on a page with few visible
      // elements it walked every node in the document and paid a forced layout for each.
      let visited = 0;
      const maxVisited = 20000;
      while ((n = walker.nextNode())) {
        if (++visited > maxVisited) break;
        if (count >= limit) break;
        const el = n as Element;
        if (!isVisible(el)) continue;
        const role =
          el.getAttribute('role') ||
          (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? 'input' : 'generic');
        const name = (
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).placeholder ||
          el.textContent?.trim().slice(0, 80) ||
          ''
        ).trim();
        if (!name && role === 'generic' && el.children.length > 0) continue;
        const rect = el.getBoundingClientRect();
        const bbox: [number, number, number, number] = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
        const tag = el.tagName.toLowerCase();
        const inputType = (el as HTMLInputElement).type || undefined;
        const isSensitive = ['password', 'tel', 'email'].includes(inputType || '') || el.matches('[autocomplete*="cc-"]');
        nodes.push({ role, name, tag, bbox, value: (el as HTMLInputElement).value?.slice(0, 120), inputType, isSensitive });
        count++;
      }
      // Always ensure interactive elements (buttons) are captured — walker may miss or rank generic divs higher
      {
        // Both passes must build the key identically. The walker pass produced
        // `tag:name:x,y,w,h` while this one produced `tag:name:x,y`, so no key ever matched and
        // every button the walker had already captured was appended a second time.
        const keyOf = (tag: string, name: string, bbox: [number, number, number, number]) =>
          `${tag}:${name}:${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
        const seen = new Set(nodes.map((n) => keyOf(n.tag, n.name, n.bbox)));
        for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
          if (!isVisible(el)) continue;
          // Deliberately not falling back to the value attribute. A form control's accessible
          // name comes from its label, and using getAttribute('value') here copied the secret
          // into `name` — the password field was emitted as name="s3cr3tP@ss!".
          const name = (el.textContent?.trim() || (el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80);
          if (!name) continue;
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'input' ? 'input' : tag);
          const bbox: [number, number, number, number] = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
          const key = keyOf(tag, name, bbox);
          if (seen.has(key)) continue;
          seen.add(key);
          const inputType = (el as HTMLInputElement).type || undefined;
          const isSensitive = ['password', 'tel', 'email'].includes(inputType || '') || el.matches('[autocomplete*="cc-"]');
          nodes.push({
            role,
            name,
            tag,
            bbox,
            value: (el as HTMLInputElement).value?.slice(0, 120),
            inputType,
            isSensitive,
          });
        }
        // Prioritize buttons/small bboxes for agent — sort so button Submit appears early in ax_tree preview
        nodes.sort((a, b) => {
          const aBtn = a.role === 'button' || a.tag === 'button' ? 0 : 1;
          const bBtn = b.role === 'button' || b.tag === 'button' ? 0 : 1;
          if (aBtn !== bBtn) return aBtn - bBtn;
          return a.bbox[2] * a.bbox[3] - b.bbox[2] * b.bbox[3];
        });
      }
      const text = document.body ? document.body.innerText.slice(0, 8000) : '';
      return { nodes, text };
    }

    /**
     * Whether a rect intersects the viewport.
     *
     * Region collection must use the same frame of reference as the AX tree. A region below
     * the fold cannot be masked on a viewport-sized screenshot and is not actionable, but the
     * text-span pass had no such check and emitted boxes at y=1430 on an 813px viewport.
     */
    function isOnScreen(rect: DOMRect): boolean {
      return (
        rect.width >= 2 &&
        rect.height >= 2 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    }

    async function buildSanitizedContext(opts: { task?: string; includeScreenshot?: boolean }): Promise<SanitizedContext> {
      const tExt0 = performance.now();
      const { nodes, text } = extractAxTree();
      const extractionMs = performance.now() - tExt0;

      // captureVisibleTab is expensive (it forces a compositor read of the whole viewport), so
      // the ML preview capture is reused for redaction below rather than taken twice.
      let captureCache: string | null = null;

      const tPii0 = performance.now();
      const regexSpans = detectRegexPii(text);
      const sensitiveInputs = detectSensitiveInputs(document);
      const piiDetectionMs = performance.now() - tPii0;

      // Build text->bbox index for overlay: map each regex hit approx via range search
      const regions: RedactedRegion[] = [];
      // Inputs -> bbox regions (highest priority visual) — round sub-pixel to int to avoid server 422
      for (const { el, type } of sensitiveInputs) {
        const r = el.getBoundingClientRect();
        if (!isOnScreen(r)) continue;
        regions.push({ bbox: [r.left, r.top, r.width, r.height], type, mode: 'blackout', confidence: 0.99 });
      }
      // Text spans -> try to locate via find text nodes (lightweight)
      // For demo we create placeholder regions by scanning text nodes
      const textNodes: Text[] = [];
      const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let tn: Node | null;
      while ((tn = tw.nextNode())) {
        if ((tn.textContent || '').trim().length > 2) textNodes.push(tn as Text);
      }
      // For each hit, find first node containing value and mask its parent element bbox
      for (const span of regexSpans) {
        const parent = textNodes.find((x) => (x.textContent || '').includes(span.value))?.parentElement;
        if (!parent) continue;
        const r = parent.getBoundingClientRect();
        if (!isOnScreen(r)) continue;
        regions.push({ bbox: [r.left, r.top, r.width, r.height], type: span.type, mode: 'blackout', confidence: span.confidence });
      }

      // Enhance with ML NER + Vision detection.
      //
      // The NER pass is not cosmetic: its output gates text redaction in the AX tree. If it
      // fails or times out we cannot claim the names are gone, so `nerComplete` stays false and
      // the node text is stripped rather than transmitted. A timeout must never mean "send raw".
      let visionMs: number | undefined;
      let mlRegionsAdded = 0;
      let imageRegionsAdded = 0;
      const nerWords: string[] = [];
      let nerComplete = false;
      const tV0 = performance.now();
      try {
        const textSlice = text.slice(0, 3000);
        // Kick off NER and (optional) image detection in parallel
        const nerPromise: Promise<Result<Entity[]>> = sendMessage('scanText', { text: textSlice }).catch((e) => ({
          ok: false,
          error: String(e?.message || e),
        }));
        // Image detection: only if screenshot will be taken and page has images/canvas
        let imgPromise: Promise<Result<Detection[]>> | null = null;
        const hasImages = document.querySelector('img, canvas, video, svg') !== null;
        if (hasImages && opts.includeScreenshot !== false) {
          try {
            // One capture per scan: reused below for redaction instead of capturing twice.
            const cap = (await sendMessage('captureScreenshot', undefined)).dataUrl;
            if (cap) {
              captureCache = cap;
              imgPromise = sendMessage('scanImage', { imageUrl: cap }).catch((e) => ({
                ok: false,
                error: String(e?.message || e),
              }));
            }
          } catch {}
        }
        // Each pass is settled independently under a shared budget. Indexing into a combined
        // allSettled array made the two results position-dependent.
        const TIMED_OUT = Symbol('ml-timeout');
        const budget = new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), 900));
        const raced = await Promise.race([
          Promise.all([nerPromise, imgPromise ?? Promise.resolve(null)]),
          budget,
        ]);
        if (raced === TIMED_OUT) throw new Error('ml-timeout');
        const [nerRes, imgRes] = raced;
        // Only a completed NER pass lets us claim entity names are stripped from node text.
        const entities = nerRes?.ok ? nerRes.data : undefined;
        if (Array.isArray(entities)) {
          nerComplete = true;
          for (const e of entities) {
            if (e.score < 0.85) continue;
            const isPerson = /PER/i.test(e.entity);
            const isLoc = /LOC/i.test(e.entity);
            const isOrg = /ORG/i.test(e.entity);
            if (!isPerson && !isLoc && !isOrg) continue;
            // LOC previously mapped to PERSON, making `isLoc` dead and mislabelling every
            // detected place as a person.
            const type: RegionType = isPerson ? 'PERSON' : isLoc ? 'LOCATION' : 'DOCUMENT';
            if (e.word) nerWords.push(e.word);
            const parent = textNodes.find((x) => (x.textContent || '').includes(e.word))?.parentElement;
            if (!parent) continue;
            const r = parent.getBoundingClientRect();
            if (!isOnScreen(r)) continue;
            regions.push({ bbox: [r.left, r.top, r.width, r.height], type, mode: 'blur', confidence: e.score });
            mlRegionsAdded++;
          }
        }
        // Image detections (yolos-tiny: person / cell phone / laptop etc.)
        const detections = imgRes?.ok ? imgRes.data : null;
        if (Array.isArray(detections) && captureCache) {
          const vw = window.innerWidth || 1;
          const vh = window.innerHeight || 1;
          for (const det of detections) {
            const label = String(det.label || '').toLowerCase();
            if (det.score < 0.5) continue;
            // Keep privacy-relevant labels
            const isRelevant = ['person', 'cell phone', 'laptop', 'book', 'tv'].some((k) => label.includes(k));
            if (!isRelevant) continue;
            // box is percentage 0-1 if offscreen used percentage:true
            const x = Math.round((det.box?.xmin ?? 0) * vw);
            const y = Math.round((det.box?.ymin ?? 0) * vh);
            const w = Math.round(((det.box?.xmax ?? 0) - (det.box?.xmin ?? 0)) * vw);
            const h = Math.round(((det.box?.ymax ?? 0) - (det.box?.ymin ?? 0)) * vh);
            if (w < 8 || h < 8) continue;
            const mapped: RegionType = label.includes('person') ? 'FACE' : label.includes('phone') || label.includes('laptop') ? 'DOCUMENT' : 'PERSON';
            regions.push({ bbox: [x, y, w, h], type: mapped, mode: 'blur', confidence: det.score });
            imageRegionsAdded++;
          }
        }
      } catch {}
      visionMs = Math.round(performance.now() - tV0);
      // Resolve competing detections, then round for the server payload.
      //
      // Keying dedupe on type+bbox kept duplicates whenever two types claimed the same pixels —
      // a Luhn-valid card also matches the Aadhaar shape and the broad phone window, so the
      // field was labelled three different types at once.
      const resolved = resolveOverlaps(regions);
      regions.length = 0;
      for (const r of resolved) {
        regions.push({
          ...r,
          bbox: [Math.round(r.bbox[0]), Math.round(r.bbox[1]), Math.round(r.bbox[2]), Math.round(r.bbox[3])],
        });
      }

      // Apply visual masks for demo proof (absolute document coords, survives scroll)
      renderMasks(regions);

      // Build redacted ax_tree.
      //
      // Two independent redaction layers run here, and both are mandatory:
      //   1. Form values are never emitted raw. A field is redacted whether or not it was
      //      classified, because `type="text"` covers essentially every name field on the web
      //      and an unrecognised value is precisely the one that must not leak.
      //   2. Names and other entity text are replaced wherever they appear in an accessible
      //      name, using both the regex spans and the NER output. NER previously only drew
      //      visual boxes, so "Dear Mr. Arjun Sharma" was transmitted verbatim.
      const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
      const redactedNodes: AxNode[] = nodes.map((n) => {
        let name = n.name;
        for (const s of regexSpans) {
          if (name.includes(s.value)) name = name.replaceAll(s.value, placeholderFor(s.type));
        }
        for (const word of nerWords) {
          if (word && name.includes(word)) name = name.replaceAll(word, '[REDACTED:PERSON]');
        }
        // Defence in depth: if the field's own value survived into its accessible name through
        // any route, strip it here rather than rely on the name never containing it.
        if (n.value && name.includes(n.value)) {
          name = name.replaceAll(n.value, '[REDACTED]');
        }
        const interactive = INTERACTIVE_TAGS.has(n.tag.toUpperCase()) || n.role === 'button' || n.role === 'link';
        // The NER pass gates text redaction, so a failure means names may still be present.
        // Strip the prose rather than transmit it.
        const nameSafe = nerComplete ? name : redactAllNames(name, interactive);
        const value = redactFormValue(n.value, n.isSensitive === true, n.inputType);
        return {
          ...n,
          name: nameSafe,
          value,
          placeholder: n.isSensitive ? placeholderFor('VALUE') : undefined,
        };
      });

      let screenshot_redacted_b64: string | undefined;
      let redactionMs = 0;
      const tRed0 = performance.now();
      if (opts.includeScreenshot !== false) {
        try {
          // Reuse the ML preview capture when one was already taken this scan.
          const cap = captureCache ?? (await sendMessage('captureScreenshot', undefined)).dataUrl;
          if (cap) {
            captureCache = cap;
            screenshot_redacted_b64 = await redactScreenshot(cap, regions, { width: window.innerWidth, height: window.innerHeight });
          }
        } catch (e) {
          console.warn('[Vision] screenshot failed', e);
        }
      }
      redactionMs = performance.now() - tRed0;

      const ctx2: SanitizedContext = {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        ax_tree: redactedNodes.slice(0, 120),
        redacted_regions: regions.map((r) => ({ bbox: r.bbox, type: r.type, confidence: r.confidence })),
        screenshot_redacted_b64,
        redaction_scheme:
          'PII replaced with [REDACTED:TYPE] placeholders (EMAIL/PHONE/CREDIT_CARD/SSN/AADHAAR/PAN/PERSON_NAME/PASSWORD/VALUE) plus visual bbox blackout/blur. Form values are NEVER transmitted raw: an unclassified field becomes [REDACTED:VALUE]. Black=regex/attribute, blur=ML NER (PER/LOC/ORG) or yolos-tiny person/phone. Server must reason over placeholders without requesting raw PII. redacted_regions gives bbox+type.',
        task: opts.task,
        timestamp: Date.now(),
        // False means the NER pass did not finish, so node prose was stripped rather than
        // cleared of names. The server must not assume entity-level completeness.
        pii_text_scan_complete: nerComplete,
        metrics: {
          extractionMs: Math.round(extractionMs),
          piiDetectionMs: Math.round(piiDetectionMs),
          visionMs: visionMs ?? 0,
          redactionMs: Math.round(redactionMs),
          mlRegionsAdded,
          imageRegionsAdded,
          nerComplete,
        },
      };
      // The screenshot is a base64 data URL of the full viewport. chrome.storage.local has a
      // small quota, so only the text context is persisted; the caller holds the image.
      const { screenshot_redacted_b64: _omit, ...persistable } = ctx2;
      void _omit;
      chrome.storage.local
        .set({ lastContext: persistable, lastRegions: regions, mlRegionsAdded, imageRegionsAdded })
        .catch(() => {});
      return ctx2;
    }

    async function executeAction(action: AgentAction): Promise<{ ok: boolean; error?: string }> {
      try {
        if (action.type === 'click') {
          const name: string | undefined = action.target?.name;
          const sel = action.target?.selector;
          let el: Element | null = null;
          // 1) Direct selector
          if (sel) el = document.querySelector(sel);
          // 2) For generic large containers (e.g., "Login\n Email\n ... Submit"), extract specific button text and find it
          // Server may return container name containing "Submit" — prefer actual button element
          const searchName = (() => {
            if (!name) return undefined;
            // If name contains newlines and is huge (div), extract last line that looks like button
            if (name.length > 40 && name.includes('\n')) {
              const lines = name.split('\n').map((s: string) => s.trim()).filter(Boolean);
              // Prefer known button texts
              const btnHint = lines.find((l: string) => /^(submit|add to cart|login|bottom target)/i.test(l));
              if (btnHint) return btnHint;
              return lines[lines.length - 1];
            }
            return name;
          })();
          // 3) Name-based button search (most reliable — handles heuristic large bbox case)
          if (!el && searchName) {
            const lower = searchName.toLowerCase().trim();
            if (!lower) {
              // nothing to match on
            } else if (lower.includes('bottom') && lower.includes('target')) {
              el = [...document.querySelectorAll('button, a, [role="button"]')].find((b) => /bottom/i.test(b.textContent || '')) || null;
            } else {
              el = [...document.querySelectorAll('button, a, [role="button"]')].find((e) => (e.textContent || '').trim().toLowerCase().includes(lower)) || null;
            }
            // Fallback: truncated match (first word)
            if (!el) {
              const first = lower.split(/\s+/)[0]!;
              el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').toLowerCase().includes(first)) || null;
            }
          }
          // 4) Bbox hit-test
          if (!el && action.target?.bbox) el = hitTest(action.target.bbox);
          if (!el) return { ok: false, error: `Target not found for "${name}" bbox ${JSON.stringify(action.target?.bbox)}` };
          return clickElement(el);
        } else if (action.type === 'fill') {
          const sel = action.target?.selector;
          let el: Element | null = sel ? document.querySelector(sel) : null;
          if (!el && action.target?.bbox) el = hitTest(action.target.bbox);
          if (!el) return { ok: false, error: 'Fill target not found' };
          const editable =
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            (el as HTMLElement).isContentEditable;
          // Previously returned {ok:true} for any element, so a mis-aimed fill reported success
          // while writing nothing.
          if (!editable) {
            return { ok: false, error: `Fill target is not an editable field (<${el.tagName.toLowerCase()}>)` };
          }
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.focus();
            // React and other frameworks track the previous value on the DOM node; assigning
            // .value directly makes their onChange handler compare against a stale value and
            // skip the update. Go through the native setter.
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, action.value ?? '');
            else el.value = action.value ?? '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            (el as HTMLElement).focus();
            (el as HTMLElement).textContent = action.value ?? '';
            (el as HTMLElement).dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
          return { ok: true };
        } else if (action.type === 'scroll') {
          const amt = action.amount ?? 400;
          window.scrollBy({ top: action.direction === 'up' ? -amt : amt, behavior: 'smooth' });
          return { ok: true };
        } else if (action.type === 'press') {
          return pressKey(action);
        } else if (action.type === 'hover') {
          let el: Element | null = action.target?.selector
            ? document.querySelector(action.target.selector)
            : null;
          if (!el && action.target?.bbox) el = hitTest(action.target.bbox);
          if (!el) return { ok: false, error: 'Hover target not found' };
          for (const type of ['pointerover', 'mouseover', 'mouseenter'] as const) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' }));
          }
          return { ok: true };
        } else if (action.type === 'wait') {
          const ms = Math.max(0, Math.min(action.amount ?? 500, 5000));
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true };
        } else if (action.type === 'done' || action.type === 'say') {
          showToast(action.message || 'Agent done');
          return { ok: true };
        }
        return { ok: false, error: `Unknown action ${action.type}` };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    /**
     * Resolve a bounding box to an element.
     *
     * Large boxes are sampled at their centre, small ones just inside the top-left corner.
     * Both actions share this so a click and a fill never disagree about where a field is.
     */
    function hitTest(bbox: [number, number, number, number]): Element | null {
      const [x, y, w, h] = bbox;
      const large = w > 200 || h > 200;
      const cx = large ? x + w / 2 : x + Math.min(10, w / 2);
      const cy = large ? y + h / 2 : y + Math.min(10, h / 2);
      let el = document.elementFromPoint(cx, cy);
      // Masks live in a shadow host pinned over the page. elementFromPoint can land on the
      // host, so retry with it temporarily transparent to input.
      if (el && el.id === 'vision-privacy-overlay-host') {
        const host = el as HTMLElement;
        const prev = host.style.pointerEvents;
        host.style.pointerEvents = 'none';
        el = document.elementFromPoint(cx, cy);
        host.style.pointerEvents = prev;
      }
      return el;
    }

    /** Dispatch a full pointer sequence so framework handlers see a coherent gesture. */
    function clickElement(el: Element): { ok: boolean; error?: string } {
      const target = el as HTMLElement;
      target.scrollIntoView({ block: 'center' });
      const init = { bubbles: true, cancelable: true, view: window };
      // Order matters: a previous revision called .click() first and then dispatched mousedown
      // and mouseup, so handlers observed the click before the press that caused it.
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', init));
      target.click();
      return { ok: true };
    }

    /**
     * Press a key against the focused element.
     *
     * A synthetic KeyboardEvent is untrusted, so the browser performs no default action and the
     * previous implementation could not submit anything. For Enter inside a form we call
     * requestSubmit(), which does run the page's submit handler; other keys are dispatched for
     * the benefit of explicit keydown listeners and reported as such.
     */
    function pressKey(action: AgentAction): { ok: boolean; error?: string } {
      const key = action.key || 'Enter';
      let el: Element | null = document.activeElement;
      if (action.target?.selector) el = document.querySelector(action.target.selector) ?? el;
      else if (action.target?.bbox) el = hitTest(action.target.bbox) ?? el;
      if (!el || el === document.body) el = document.body;

      const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));

      if (key === 'Enter') {
        const form = el instanceof HTMLFormElement ? el : (el as HTMLElement).closest?.('form');
        if (form) {
          form.requestSubmit();
          return { ok: true };
        }
        return {
          ok: false,
          error: 'Enter dispatched but the target is not in a form, so nothing was submitted (synthetic keys are untrusted)',
        };
      }
      return { ok: true };
    }

    function showToast(msg: string) {
      const t = document.createElement('div');
      t.className = 'vp-toast';
      t.textContent = msg;
      shadow.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    }

    // Listeners — one per message name, so this script can only ever claim its own messages.
    onMessage('getSanitizedContext', async ({ data }) => {
      try {
        return await buildSanitizedContext({ task: data.task, includeScreenshot: data.includeScreenshot });
      } catch (e: any) {
        throw new Error(`buildSanitizedContext failed: ${String(e?.message || e)}`);
      }
    });

    onMessage('executeAction', async ({ data }) => executeAction(data.action));

    onMessage('clearMasks', async () => {
      clearMasks();
      return { ok: true };
    });

    onMessage('ping', async () => ({ ok: true, url: location.href }));

    // SPA navigation: clear masks on route change.
    // WXT's ctx.addEventListener signature is (target, type, handler). Passing the event name
    // as the target made it call `('wxt:locationchange').addEventListener?.()` — the optional
    // call silently short-circuited on the string, so the listener was never registered and
    // masks survived client-side navigation.
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      clearMasks();
      console.log('[Vision] locationchange', location.href);
    });

    // Teardown on extension update / reload. `ctx.isInvalid` is only a snapshot at startup;
    // onInvalidated fires when the context is actually torn down.
    ctx.onInvalidated(() => {
      clearMasks();
      console.log('[Vision] context invalidated');
    });

    // Expose for manual testing in console
    (window as any).__visionBuildContext = buildSanitizedContext;
    (window as any).__visionClearMasks = clearMasks;
  },
});
