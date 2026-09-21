#!/usr/bin/env node
/**
 * Quick offline evaluation of regex PII + redaction without browser.
 * Run: node scripts/evaluate.mjs
 */
import { readFileSync } from 'fs';

const patterns = {
  EMAIL: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  PHONE: /(?:\+91[\s-]?)?(?:\(?\d{3}\)?[\s-]?)?\d{3}[\s-]?\d{4}|\b\d{10}\b/g,
  AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
};

function detect(text) {
  const hits = [];
  for (const [t, re] of Object.entries(patterns)) {
    re.lastIndex = 0;
    let m; while ((m = re.exec(text)) !== null) hits.push({ type: t, value: m[0] });
  }
  return hits;
}

const html = readFileSync('public/test-pii.html', 'utf8');
const text = html.replace(/<[^>]*>/g, ' ');

const truth = {
  EMAIL: 2, PHONE: 2, AADHAAR: 1, PAN: 2, CREDIT_CARD: 1, SSN: 0,
};

console.log('=== Regex PII quick eval on test-pii.html ===');
for (const [k, expected] of Object.entries(truth)) {
  const found = detect(text).filter(h => h.type === k).length;
  console.log(`${k}: found ${found} / expected ${expected} ${found >= expected ? '✓' : '✗'}`);
}
console.log('\nAll hits:', detect(text));
console.log('\nTip: Full metric 2/3 requires browser run: popup Scan & Redact then POST to /api/evaluate/redaction');
