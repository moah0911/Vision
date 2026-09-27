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

/**
 * Classification of a form field's value. Superset of PiiType: PERSON_NAME is inferred from
 * the shape of a name, which no regex pattern can express.
 */
export type FieldPiiType = PiiType | 'PERSON_NAME';

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
  // Phone: a run of digits with optional separators, accepted on total digit count (10-15).
  // Deliberately broad — the digit-count window is the only filter, so 16-digit card numbers
  // fall out on the upper bound. Shape-agnostic because 3-3-4 fails on 5+5 ("99988 77766").
  PHONE: /\+?\d[\d\s().-]{7,18}\d/g,
  // Credit card with Luhn validation after match
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  // Only flag a password when a value follows the label. Matching the bare word "password"
  // redacted every "Password:" field label, which is not PII and wrecks the AX tree the
  // agent reasons over. input[type=password] is handled by detectSensitiveInputs.
  PASSWORD: /\b(?:password|passwd|pwd)\b\s*[:=]\s*(\S+)/gi,
  IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

/** Phone numbers carry 10-15 digits (ITU E.164). Outside that they are something else. */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

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
      // PASSWORD matches "password: hunter2" — the secret is the capture, not the label.
      const value = type === 'PASSWORD' ? (m[1] ?? m[0]) : m[0];
      const start = type === 'PASSWORD' ? m.index + m[0].indexOf(value) : m.index;
      // Guard credit card with Luhn
      if (type === 'CREDIT_CARD' && !luhnCheck(value)) {
        advance(re, m);
        continue;
      }
      // Guard phone on total digit count so 16-digit cards and short numbers are excluded
      if (type === 'PHONE') {
        const digits = value.replace(/\D/g, '').length;
        if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) {
          advance(re, m);
          continue;
        }
      }
      // Avoid zero-length loops
      if (value.length === 0) {
        re.lastIndex++;
        continue;
      }
      hits.push({
        type,
        value,
        start,
        end: start + value.length,
        confidence: 0.97,
        source: 'regex',
      });
    }
  }
  return hits;
}

/** Guarantee forward progress so a rejected match cannot spin the loop. */
function advance(re: RegExp, m: RegExpExecArray) {
  if (m.index === re.lastIndex) re.lastIndex++;
}

/** A token made only of letters that starts uppercase — the shape of a name or place. */
const NAME_TOKEN = /^[A-Z][a-z]+(?:['’-][A-Za-z]+)?$/;

/** Small function words that follow a capitalised token without being a name. */
const NAME_STOPWORDS = new Set([
  'The', 'A', 'An', 'And', 'Or', 'But', 'If', 'Then', 'This', 'That', 'These', 'Those',
  'My', 'Your', 'Our', 'Their', 'His', 'Her', 'Its', 'Please', 'Thank', 'Hello', 'Hi',
  'Sign', 'Log', 'Enter', 'Search', 'Submit', 'Cancel', 'Save', 'Delete', 'Next', 'Back',
  'Home', 'About', 'Contact', 'Terms', 'Privacy', 'Policy', 'Help', 'Support', 'Account',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
]);

/**
 * Classify a form field's current value.
 *
 * Returns null when the value is empty or is not recognised PII. Callers must still redact
 * unrecognised values — see `redactFormValue`.
 */
export function classifyFieldValue(value: string | undefined | null): FieldPiiType | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const structured = detectRegexPii(trimmed);
  if (structured.length > 0) {
    // Most specific type wins, so a card number is not reported as a phone number.
    let best = structured[0]!;
    for (const s of structured) if ((TYPE_RANK[s.type] ?? 0) > (TYPE_RANK[best.type] ?? 0)) best = s;
    // A lone 10-15 digit run is a phone only if it is not part of a longer structured field.
    if (best.type === 'PHONE' && /\d/.test(trimmed.replace(/\D/g, '')) === false) return null;
    return best.type;
  }

  // Person-name shape: two or more capitalised, alphabetic tokens and nothing else.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 4) {
    const allNames = tokens.every(
      (t) => NAME_TOKEN.test(t) && !NAME_STOPWORDS.has(t),
    );
    if (allNames) return 'PERSON_NAME';
  }
  return null;
}

const TYPE_RANK: Record<string, number> = {
  CREDIT_CARD: 100,
  SSN: 95,
  AADHAAR: 90,
  PAN: 85,
  EMAIL: 80,
  IP_ADDRESS: 70,
  PHONE: 60,
  PASSWORD: 50,
  PERSON_NAME: 40,
};

/**
 * The value to put in the outbound context in place of a field's real value.
 *
 * The default is `[REDACTED:VALUE]`, not the original. A form field we failed to classify is
 * exactly the case that must not leak: name, address and free-text fields carry PII that no
 * pattern here recognises, and `type="text"` covers nearly every name field on the web.
 */
export function redactFormValue(
  value: string | undefined | null,
  isSensitive: boolean,
  inputType?: string,
): string | undefined {
  if (typeof value !== 'string' || value === '') return value ?? undefined;
  const classified = classifyFieldValue(value);
  if (classified) return `[REDACTED:${classified}]`;
  if (isSensitive) {
    if (inputType === 'password') return '[REDACTED:PASSWORD]';
    return '[REDACTED:VALUE]';
  }
  // Unclassified text input: still a form value, still not safe to transmit verbatim.
  return '[REDACTED:VALUE]';
}

/**
 * Attribute-level classification of sensitive form fields.
 *
 * Every selector in `selectors` must have a branch below, otherwise the field silently
 * inherits the PASSWORD default and is reported as the wrong type.
 */
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
  const seen = new Set<Element>();
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) {
      // One element can match several selectors; classify it once, by most specific rule.
      if (seen.has(el)) continue;
      seen.add(el);
      let t: PiiType = 'PASSWORD';
      if (el.matches('input[type="tel"]')) t = 'PHONE';
      else if (el.matches('input[type="email"]')) t = 'EMAIL';
      else if (el.matches('input[autocomplete*="cc-"]')) t = 'CREDIT_CARD';
      else if ((el as HTMLInputElement).name?.toLowerCase().includes('aadhaar')) t = 'AADHAAR';
      else if ((el as HTMLInputElement).name?.toLowerCase().includes('pan')) t = 'PAN';
      else if ((el as HTMLInputElement).name?.toLowerCase().includes('ssn')) t = 'SSN';
      out.push({ el, type: t });
    }
  }
  return out;
}
