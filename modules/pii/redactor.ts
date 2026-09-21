/**
 * Privacy filter — applies local redaction before any network request.
 * Supports text placeholder replacement + visual overlay (Shadow DOM + canvas).
 */
import type { PiiSpan, PiiType } from './regex';

export type RedactionMode = 'placeholder' | 'blackout' | 'blur';

export interface RedactedRegion {
  bbox: [number, number, number, number]; // [x, y, w, h] viewport coords
  type: PiiType | 'FACE' | 'PERSON' | 'DOCUMENT';
  mode: RedactionMode;
  confidence: number;
}

// Typed placeholder keeps semantics for server reasoning
export function placeholderFor(type: string): string {
  return `[REDACTED:${type}]`;
}

export function redactText(text: string, spans: PiiSpan[]): { redacted: string; placeholders: string[] } {
  if (spans.length === 0) return { redacted: text, placeholders: [] };
  // Sort descending so indices remain valid
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  const placeholders: string[] = [];
  for (const s of sorted) {
    const ph = placeholderFor(s.type);
    placeholders.push(ph);
    out = out.slice(0, s.start) + ph + out.slice(s.end);
  }
  return { redacted: out, placeholders };
}

// For DOM text nodes: replace in-place and record regions for screenshot masking
export function redactDomTextNodes(spansByNode: Map<Text, PiiSpan[]>) {
  for (const [node, spans] of spansByNode) {
    const { redacted } = redactText(node.textContent || '', spans);
    node.textContent = redacted;
  }
}

/**
 * Canvas-based screenshot redaction.
 * Input: original dataUrl, regions in viewport coords -> outputs redacted blob URL
 */
export async function redactScreenshot(
  imageSrc: string,
  regions: RedactedRegion[],
  viewport: { width: number; height: number },
): Promise<string> {
  const img = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const r of regions) {
    const [x, y, w, h] = r.bbox;
    if (r.mode === 'blackout') {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
    } else if (r.mode === 'blur') {
      // Simple blur via downscale trick
      const pad = 6;
      ctx.save();
      ctx.filter = 'blur(16px)';
      ctx.drawImage(canvas, x - pad, y - pad, w + pad * 2, h + pad * 2, x - pad, y - pad, w + pad * 2, h + pad * 2);
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = '11px monospace';
      ctx.fillText(placeholderFor(r.type), x + 4, y + 14);
    }
  }
  return canvas.toDataURL('image/jpeg', 0.7);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

// Lightweight measurement for metrics panel
export function measureRedactionPrecision(
  predicted: RedactedRegion[],
  groundTruth: RedactedRegion[],
  iouThreshold = 0.5,
): { precision: number; recall: number; f1: number } {
  if (predicted.length === 0 && groundTruth.length === 0) return { precision: 1, recall: 1, f1: 1 };
  if (predicted.length === 0) return { precision: 0, recall: 0, f1: 0 };
  let tp = 0;
  for (const p of predicted) {
    if (groundTruth.some((g) => g.type === p.type && iou(p.bbox, g.bbox) >= iouThreshold)) tp++;
  }
  const precision = tp / predicted.length;
  const recall = groundTruth.length ? tp / groundTruth.length : 1;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  const w = Math.max(0, x2 - x1), h = Math.max(0, y2 - y1);
  const inter = w * h;
  const union = aw * ah + bw * bh - inter;
  return union === 0 ? 0 : inter / union;
}
