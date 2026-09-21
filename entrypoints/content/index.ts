/**
 * Content script — runs in ISOLATED world, document_idle.
 * Extracts AX tree, detects PII (regex sync + ML async), applies redaction overlay,
 * builds SanitizedContext, and can execute server-returned actions.
 */
import { detectRegexPii, detectSensitiveInputs } from '../../modules/pii/regex';
import { redactScreenshot, type RedactedRegion, placeholderFor } from '../../modules/pii/redactor';
import type { AxNode, SanitizedContext } from '../../modules/vision/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  cssInjectionMode: 'ui',
  async main(ctx) {
    console.log('[Vision][Content] injected', location.href);

    // Shadow DOM overlay host for privacy visual proof (no layout thrash)
    const host = document.createElement('div');
    host.id = 'vision-privacy-overlay-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .vp-mask { position: fixed; background: #000; border-radius: 4px; pointer-events: none; z-index: 2147483646; }
      .vp-blur { backdrop-filter: blur(16px); background: rgba(0,0,0,0.45); border: 1px solid rgba(255,0,0,0.6); }
      .vp-label { position: fixed; font: 10px monospace; color: #fff; background: #b91c1c; padding: 2px 4px; border-radius: 3px; z-index: 2147483647; pointer-events: none; }
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
      for (const r of regions) {
        const [x, y, w, h] = r.bbox;
        const m = document.createElement('div');
        m.className = `vp-mask ${r.mode === 'blur' ? 'vp-blur' : ''}`;
        Object.assign(m.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${h}px`,
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

    function isVisible(el: Element): boolean {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    }

    function extractAxTree(limit = 500): { nodes: AxNode[]; text: string } {
      const t0 = performance.now();
      const nodes: AxNode[] = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let n: Node | null;
      let count = 0;
      while ((n = walker.nextNode()) && count < limit) {
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
      // Fallback: at least capture inputs + buttons if tree too sparse
      if (nodes.length < 10) {
        for (const el of document.querySelectorAll('button, a, input, select, textarea')) {
          if (!isVisible(el)) continue;
          const rect = el.getBoundingClientRect();
          nodes.push({
            role: el.tagName.toLowerCase(),
            name: (el.textContent?.trim() || (el as HTMLInputElement).placeholder || el.getAttribute('aria-label') || '').slice(0, 80),
            tag: el.tagName.toLowerCase(),
            bbox: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
          });
        }
      }
      const text = document.body ? document.body.innerText.slice(0, 8000) : '';
      // @ts-ignore metrics side-channel
      (extractAxTree as any).__ms = performance.now() - t0;
      return { nodes, text };
    }

    async function buildSanitizedContext(opts: { task?: string; includeScreenshot?: boolean }): Promise<SanitizedContext> {
      const tExt0 = performance.now();
      const { nodes, text } = extractAxTree();
      const extractionMs = performance.now() - tExt0;

      const tPii0 = performance.now();
      const regexSpans = detectRegexPii(text);
      const sensitiveInputs = detectSensitiveInputs(document);
      const piiDetectionMs = performance.now() - tPii0;

      // Build text->bbox index for overlay: map each regex hit approx via range search
      const regions: RedactedRegion[] = [];
      // Inputs -> bbox regions (highest priority visual)
      for (const { el, type } of sensitiveInputs) {
        const r = el.getBoundingClientRect();
        if (r.width < 2) continue;
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
        if (r.width < 4) continue;
        regions.push({ bbox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], type: span.type, mode: 'blackout', confidence: span.confidence });
      }

      // Enhance with ML NER (async, offscreen) — best-effort, no block beyond 800ms
      let visionMs: number | undefined;
      let mlRegionsAdded = 0;
      try {
        const tV0 = performance.now();
        const mlPromise = chrome.runtime.sendMessage({ type: 'SCAN_TEXT', text: text.slice(0, 3000) }) as Promise<any>;
        const mlRes = await Promise.race([
          mlPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('ml-timeout')), 800)),
        ] as const).catch(() => null);
        const entities: Array<{ entity: string; word: string; score: number; start: number; end: number }> = mlRes?.entities || [];
        for (const e of entities) {
          if (e.score < 0.85) continue;
          const isPerson = /PER/i.test(e.entity);
          const isLoc = /LOC/i.test(e.entity);
          if (!isPerson && !isLoc) continue;
          const type = isPerson ? 'FACE' : 'PERSON';
          // Locate word bbox similarly
          const parent = textNodes.find((x) => (x.textContent || '').includes(e.word))?.parentElement;
          if (!parent) continue;
          const r = parent.getBoundingClientRect();
          if (r.width < 4) continue;
          // Avoid duplicate near same bbox
          if (regions.some((rr) => Math.abs(rr.bbox[0] - r.left) < 8 && Math.abs(rr.bbox[1] - r.top) < 8)) continue;
          regions.push({ bbox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], type: type as any, mode: 'blur', confidence: e.score });
          mlRegionsAdded++;
        }
        visionMs = performance.now() - tV0;
      } catch {}

      // Apply visual masks for demo proof
      renderMasks(regions);

      // Build redacted ax_tree: replace names containing PII values
      const redactedNodes: AxNode[] = nodes.map((n) => {
        let name = n.name;
        for (const s of regexSpans) {
          if (name.includes(s.value)) name = name.replace(s.value, placeholderFor(s.type));
        }
        // Also mask values of sensitive inputs
        let value = n.value;
        if (n.isSensitive && value) value = placeholderFor(n.inputType === 'password' ? 'PASSWORD' : n.inputType === 'tel' ? 'PHONE' : 'REDACTED');
        return { ...n, name, value, placeholder: n.isSensitive ? placeholderFor('REDACTED') : undefined };
      });

      let screenshot_redacted_b64: string | undefined;
      let redactionMs = 0;
      const tRed0 = performance.now();
      if (opts.includeScreenshot !== false) {
        try {
          const cap = (await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }) as any)?.dataUrl;
          if (cap) {
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
        redaction_scheme: 'PII replaced with [REDACTED:TYPE] placeholders (EMAIL/PHONE/CREDIT_CARD/AADHAAR/PAN/PASSWORD) and visual bbox blackout/blur. Black boxes are sensitive fields; blurred spans are ML-detected persons/locations. Server must reason over placeholders without requesting raw PII.',
        task: opts.task,
        timestamp: Date.now(),
        metrics: { extractionMs: Math.round(extractionMs), piiDetectionMs: Math.round(piiDetectionMs), visionMs: visionMs ? Math.round(visionMs) : undefined, redactionMs: Math.round(redactionMs) },
      };
      // Store for popup inspection
      chrome.storage.local.set({ lastContext: ctx2, lastRegions: regions, mlRegionsAdded }).catch(() => {});
      return ctx2;
    }

    function executeAction(action: any): { ok: boolean; error?: string } {
      try {
        if (action.type === 'click') {
          const sel = action.target?.selector;
          let el: Element | null = null;
          if (sel) el = document.querySelector(sel);
          if (!el && action.target?.bbox) {
            const [x, y] = action.target.bbox;
            el = document.elementFromPoint(x + 10, y + 10);
          }
          if (!el && action.target?.name) {
            el = [...document.querySelectorAll('button, a, [role="button"]')].find((e) => (e.textContent || '').trim().includes(action.target!.name!)) || null;
          }
          if (!el) return { ok: false, error: 'Target not found' };
          (el as HTMLElement).click();
          return { ok: true };
        } else if (action.type === 'fill') {
          const sel = action.target?.selector;
          let el: Element | null = sel ? document.querySelector(sel) : null;
          if (!el && action.target?.bbox) el = document.elementFromPoint(action.target.bbox[0] + 5, action.target.bbox[1] + 5);
          if (!el) return { ok: false, error: 'Fill target not found' };
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.focus();
            el.value = action.value || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { ok: true };
        } else if (action.type === 'scroll') {
          const amt = action.amount ?? 400;
          window.scrollBy({ top: action.direction === 'up' ? -amt : amt, behavior: 'smooth' });
          return { ok: true };
        } else if (action.type === 'press') {
          const key = action.key || 'Enter';
          document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
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

    function showToast(msg: string) {
      const t = document.createElement('div');
      t.className = 'vp-toast';
      t.textContent = msg;
      shadow.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    }

    // Listen for popup/background requests
    chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
      (async () => {
        if (msg.type === 'GET_SANITIZED_CONTEXT') {
          const c = await buildSanitizedContext({ task: msg.task, includeScreenshot: msg.includeScreenshot });
          sendResponse(c);
        } else if (msg.type === 'EXECUTE_ACTION') {
          const r = executeAction(msg.action);
          sendResponse(r);
        } else if (msg.type === 'CLEAR_MASKS') {
          clearMasks();
          sendResponse({ ok: true });
        } else if (msg.type === 'PING') {
          sendResponse({ ok: true, url: location.href });
        }
      })();
      return true;
    });

    // SPA navigation: clear masks on route change
    ctx.addEventListener('wxt:locationchange', () => {
      clearMasks();
      console.log('[Vision] locationchange', location.href);
    });

    // Invalidate on extension update
    if (ctx.isInvalid) {
      clearMasks();
    }

    // Expose for manual testing in console
    (window as any).__visionBuildContext = buildSanitizedContext;
    (window as any).__visionClearMasks = clearMasks;
  },
});
