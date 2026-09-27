/**
 * Privacy filter — applies local redaction before any network request.
 * Supports text placeholder replacement + visual overlay (Shadow DOM + canvas).
 */
import type { PiiSpan, PiiType } from './regex';

export type RedactionMode = 'placeholder' | 'blackout' | 'blur';

export type RegionType = PiiType | 'FACE' | 'PERSON' | 'PERSON_NAME' | 'LOCATION' | 'DOCUMENT';

export interface RedactedRegion {
  bbox: [number, number, number, number]; // [x, y, w, h] viewport coords
  type: RegionType;
  mode: RedactionMode;
  confidence: number;
}

/**
 * Higher wins when two detectors claim the same pixels.
 *
 * Text spans resolve to their parent element's bbox, so an Aadhaar number and a credit card
 * in the same paragraph produce identical boxes under different types. Without an ordering
 * rule the field gets labelled two contradictory types, which breaks the typed-placeholder
 * contract the server prompt depends on.
 */
export const REGION_PRIORITY: Record<string, number> = {
  CREDIT_CARD: 100, // Luhn-validated, the most specific claim
  SSN: 95,
  AADHAAR: 90,
  PAN: 85,
  EMAIL: 80,
  IP_ADDRESS: 70,
  PHONE: 60, // deliberately broad, so it collides and must lose
  PERSON_NAME: 55,
  LOCATION: 50,
  PERSON: 45,
  FACE: 40,
  DOCUMENT: 30,
  PASSWORD: 20, // attribute-derived, the coarsest claim
};

/**
 * Drop lower-priority regions that collide with a higher-priority one.
 *
 * Two distinct PII strings inside the same paragraph collapse to one box here, which is
 * correct: there is only one rectangle to mask. Per-value placeholders are applied to the
 * text separately, so no redaction is lost.
 */
export function resolveOverlaps(regions: RedactedRegion[], iouThreshold = 0.3): RedactedRegion[] {
  const ordered = [...regions].sort(
    (a, b) => (REGION_PRIORITY[b.type] ?? 0) - (REGION_PRIORITY[a.type] ?? 0) || b.confidence - a.confidence,
  );
  const kept: RedactedRegion[] = [];
  for (const r of ordered) {
    if (!kept.some((k) => iou(k.bbox, r.bbox) >= iouThreshold)) kept.push(r);
  }
  return kept;
}


// Typed placeholder keeps semantics for server reasoning
export function placeholderFor(type: string): string {
  return `[REDACTED:${type}]`;
}

/**
 * Replace PII with typed placeholders.
 *
 * Overlapping spans are merged first. Substituting in descending index order without merging
 * corrupts the result: once a wide span (CREDIT_CARD) is replaced by a longer placeholder, the
 * original end offset of a narrower span still inside it (AADHAAR) no longer lines up, and the
 * output is left with a half-written placeholder.
 */
export function redactText(text: string, spans: PiiSpan[]): { redacted: string; placeholders: string[] } {
  if (spans.length === 0) return { redacted: text, placeholders: [] };
  const merged = mergeOverlappingSpans(spans);
  // Sort descending so earlier indices stay valid as we splice.
  const sorted = [...merged].sort((a, b) => b.start - a.start);
  let out = text;
  const placeholders: string[] = [];
  for (const s of sorted) {
    const ph = placeholderFor(s.type);
    placeholders.push(ph);
    out = out.slice(0, s.start) + ph + out.slice(s.end);
  }
  return { redacted: out, placeholders };
}

/** Collapse spans that overlap in the source text, keeping the highest-priority type. */
function mergeOverlappingSpans(spans: PiiSpan[]): PiiSpan[] {
  const ordered = [...spans].sort(
    (a, b) => a.start - b.start || (REGION_PRIORITY[b.type] ?? 0) - (REGION_PRIORITY[a.type] ?? 0),
  );
  const out: PiiSpan[] = [];
  for (const s of ordered) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      last.value = '';
      continue;
    }
    out.push({ ...s });
  }
  // `value` is only used by callers that re-locate spans in the DOM; the merged ones no
  // longer correspond to a literal substring, so clear it rather than report a wrong one.
  return out;
}


/**
 * Canvas-based screenshot redaction.
 * Input: original dataUrl, regions in viewport coords -> outputs redacted data URL
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

/**
 * Bounding-box precision/recall against a labelled set.
 *
 * Matching is greedy and 1:1. Letting every prediction claim the same ground-truth box would
 * let one label mask three false positives and report them all as true, inflating recall.
 * Mirrored by /api/evaluate/redaction in server/app.py — keep the two in step.
 */
export function measureRedactionPrecision(
  predicted: RedactedRegion[],
  groundTruth: RedactedRegion[],
  iouThreshold = 0.5,
): { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number } {
  if (predicted.length === 0 && groundTruth.length === 0) return { precision: 1, recall: 1, f1: 1, tp: 0, fp: 0, fn: 0 };
  if (predicted.length === 0) return { precision: 0, recall: 0, f1: 0, tp: 0, fp: 0, fn: groundTruth.length };
  if (groundTruth.length === 0) return { precision: 0, recall: 0, f1: 0, tp: 0, fp: predicted.length, fn: 0 };

  // Candidate pairs, best IoU first, so each ground-truth box is consumed by its closest match.
  const pairs: Array<{ p: number; g: number; score: number }> = [];
  predicted.forEach((p, pi) =>
    groundTruth.forEach((g, gi) => {
      if (g.type !== p.type) return;
      const score = iou(p.bbox, g.bbox);
      if (score >= iouThreshold) pairs.push({ p: pi, g: gi, score });
    }),
  );
  pairs.sort((a, b) => b.score - a.score);

  const usedP = new Set<number>();
  const usedG = new Set<number>();
  for (const pair of pairs) {
    if (usedP.has(pair.p) || usedG.has(pair.g)) continue;
    usedP.add(pair.p);
    usedG.add(pair.g);
  }

  const tp = usedP.size;
  const fp = predicted.length - tp;
  const fn = groundTruth.length - tp;
  const precision = tp / predicted.length;
  const recall = tp / groundTruth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
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
