/**
 * Synchronous PII regex detection — zero-latency, deterministic.
 * Runs in content script before any ML. Covers structured PII.
 * Precision-optimized patterns to avoid false positives.
 */
export type PiiType =
  | 'EMAIL'
  | 'PHONE'
  | 'CREDIT_CARD'
  | 'SSN'
  | 'AADHAAR'
  | 'PAN'
  | 'PASSWORD'
  | 'IP_ADDRESS';

export interface PiiSpan {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  confidence: number;
  source: 'regex';
}

const PATTERNS: Record<PiiType, RegExp> = {
  EMAIL: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  // Indian + international phone: +91-xxx, (xxx) xxx-xxxx, 10-digit
  PHONE: /(?:\+91[\s-]?)?(?:\(?\d{3}\)?[\s-]?)?\d{3}[\s-]?\d{4}|\b\d{10}\b|\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  // Credit card with Luhn validation after match
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  PASSWORD: /\b(password|passwd|pwd)\b/gi, // flagged via input[type=password] separately
  IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i]!);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function detectRegexPii(text: string): PiiSpan[] {
  const hits: PiiSpan[] = [];
  for (const [type, re] of Object.entries(PATTERNS) as [PiiType, RegExp][]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      // Guard credit card with Luhn
      if (type === 'CREDIT_CARD' && !luhnCheck(value)) continue;
      // Guard phone: avoid matching years / short numbers
      if (type === 'PHONE' && value.replace(/\D/g, '').length < 10) continue;
      // Avoid zero-length loops
      if (value.length === 0) {
        re.lastIndex++;
        continue;
      }
      hits.push({
        type,
        value,
        start: m.index,
        end: m.index + value.length,
        confidence: 0.97,
        source: 'regex',
      });
    }
  }
  return hits;
}

/** Detect sensitive input elements via DOM attributes (no text needed) */
export function detectSensitiveInputs(root: Document | Element = document): Array<{ el: Element; type: PiiType }> {
  const selectors = [
    'input[type="password"]',
    'input[type="tel"]',
    'input[type="email"]',
    'input[autocomplete*="cc-"]',
    'input[name*="aadhaar" i]',
    'input[name*="pan" i]',
    'input[name*="ssn" i]',
  ];
  const out: Array<{ el: Element; type: PiiType }> = [];
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) {
      let t: PiiType = 'PASSWORD';
      if (el.matches('input[type="tel"]')) t = 'PHONE';
      else if (el.matches('input[type="email"]')) t = 'EMAIL';
      else if (el.matches('input[autocomplete*="cc-"]')) t = 'CREDIT_CARD';
      else if ((el as HTMLInputElement).name?.toLowerCase().includes('aadhaar')) t = 'AADHAAR';
      else if ((el as HTMLInputElement).name?.toLowerCase().includes('pan')) t = 'PAN';
      out.push({ el, type: t });
    }
  }
  return out;
}
