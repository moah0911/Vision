#!/usr/bin/env node
/**
 * PII detection + redaction evaluation.
 *
 * Imports the production detector from modules/pii/regex.ts — this file deliberately holds no
 * pattern of its own, because a second copy of the regexes silently drifts from the shipped
 * ones and reports recall for code that never runs.
 *
 * Run: npm run eval
 *      node --experimental-strip-types scripts/evaluate-full.mjs [--server http://localhost:8000]
 *
 * Exits non-zero if any ground-truth item is missed, so it can gate CI.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { detectRegexPii } from '../modules/pii/regex.ts';
import { measureRedactionPrecision, resolveOverlaps } from '../modules/pii/redactor.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const serverArg = argv.find((a) => a.startsWith('http'));
const server = serverArg || process.env.SERVER_URL || 'http://localhost:8000';

// Ground truth counts items per (type, value). Text matching ignores spacing and case so that
// "+91 98765 43210" and the detector's variant of the same number still line up.
const norm = (s) => s.replace(/[\s()-]/g, '').toUpperCase();
const sameItem = (a, b) => norm(a) === norm(b);

/** Text corpus with the answer key removed. */
function corpus() {
  const html = readFileSync(resolve(ROOT, 'public/test-pii.html'), 'utf8');
  const withoutKey = html.replace(/<pre id="groundTruth">[\s\S]*?<\/pre>/i, ' ');
  return withoutKey.replace(/<[^>]*>/g, ' ');
}

const truth = JSON.parse(readFileSync(resolve(ROOT, 'public/ground-truth.json'), 'utf8'));
const text = corpus();
const hits = detectRegexPii(text);

// Score only what a text detector can see. Form values live in attributes, selector-derived
// fields have no known value, and the ML items need a model — holding the regex to those
// produced phantom failures that hid a genuine one (the PHONE pattern matched nothing).
const scored = truth.groundTruth.filter((g) => g.source === 'text');
const deferred = truth.groundTruth.filter((g) => g.source !== 'text');

let totalExpected = 0;
let totalFound = 0;
const failures = [];

console.log('== Metric 2: PII text recall (production modules/pii/regex.ts) ==');
for (const gt of scored) {
  const ofType = hits.filter((h) => h.type === gt.type);
  // The previous version compared types only, so any hit of the right type satisfied the
  // check. Match on the value too.
  const found = ofType.filter((h) => sameItem(h.value, gt.value)).length;
  const expected = gt.count ?? 1;
  totalExpected += expected;
  totalFound += Math.min(found, expected);
  const ok = found >= expected;
  if (!ok) failures.push(`${gt.type} ${gt.value}: found ${found}, expected ${expected}`);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${gt.type.padEnd(12)} ${String(gt.value).slice(0, 26).padEnd(28)} ${found}/${expected}`,
  );
}

const recall = totalExpected === 0 ? 0 : totalFound / totalExpected;
console.log(`\n  recall ${totalFound}/${totalExpected} = ${(recall * 100).toFixed(1)}%`);

console.log(`\n  Not scored here (need a DOM or a model), ${deferred.length} item(s):`);
const bySource = {};
for (const d of deferred) (bySource[d.source] ??= []).push(`${d.type} ${d.value}`);
for (const [src, items] of Object.entries(bySource)) {
  console.log(`    ${src.padEnd(9)} ${items.join(', ')}`);
}

// Overlap resolution regression. A Luhn-valid 16-digit Visa also satisfies the AADHAAR shape
// (any 12-digit run) and the broad PHONE window, so all three claim overlapping pixels. Only
// one may survive or the field renders two contradictory type labels.
const visa = { bbox: [300, 200, 220, 18], type: 'CREDIT_CARD', mode: 'blackout', confidence: 0.97 };
const colliding = [
  visa,
  { bbox: [300, 200, 165, 18], type: 'AADHAAR', mode: 'blackout', confidence: 0.97 },
  { bbox: [300, 200, 165, 18], type: 'PHONE', mode: 'blackout', confidence: 0.97 },
  { bbox: [40, 60, 180, 18], type: 'EMAIL', mode: 'blackout', confidence: 0.97 },
  { bbox: [40, 96, 140, 18], type: 'PHONE', mode: 'blackout', confidence: 0.97 },
];
const resolvedOverlaps = resolveOverlaps(colliding);
const surviving = resolvedOverlaps.map((r) => r.type).sort();
const expectedSurviving = ['CREDIT_CARD', 'EMAIL', 'PHONE'];
const overlapOk = JSON.stringify(surviving) === JSON.stringify(expectedSurviving);
console.log(
  `\n== Overlap resolution ==  ${colliding.length} competing spans -> ${resolvedOverlaps.length} regions: ` +
    `${surviving.join(', ')} ${overlapOk ? 'PASS' : 'FAIL'}`,
);
if (!overlapOk) {
  failures.push(`overlap resolution kept ${surviving.join(',')}, expected ${expectedSurviving.join(',')}`);
}

// IoU metric self-check with a case the old implementation got wrong: three predictions
// matching a single ground-truth box must count as 1 true positive and 2 false positives.
const one = [{ bbox: [0, 0, 100, 100], type: 'EMAIL', mode: 'blackout', confidence: 1 }];
const three = [
  { bbox: [0, 0, 100, 100], type: 'EMAIL', mode: 'blackout', confidence: 1 },
  { bbox: [0, 0, 100, 100], type: 'EMAIL', mode: 'blackout', confidence: 0.9 },
  { bbox: [5, 5, 100, 100], type: 'EMAIL', mode: 'blackout', confidence: 0.8 },
];
const m = measureRedactionPrecision(three, one);
const metricOk = m.tp === 1 && m.fp === 2 && m.fn === 0;
console.log(
  `\n== Metric 3: IoU matcher ==  3 predictions vs 1 truth -> tp=${m.tp} fp=${m.fp} fn=${m.fn} ` +
    `P=${m.precision.toFixed(2)} R=${m.recall.toFixed(2)} ${metricOk ? 'PASS' : 'FAIL'}`,
);
if (!metricOk) failures.push(`IoU matcher not 1:1 — got tp=${m.tp} fp=${m.fp} (want tp=1 fp=2)`);

if (serverArg || process.env.SERVER_URL || process.argv.includes('--server')) {
  try {
    const r = await fetch(`${server}/api/evaluate/redaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ predicted: three, ground_truth: one }),
    });
    if (r.ok) {
      const j = await r.json();
      console.log(`\n== Server /api/evaluate/redaction ==  ${JSON.stringify(j)}`);
      if (j.tp !== 1) failures.push(`server IoU not 1:1 — got tp=${j.tp} (want 1)`);
    } else {
      console.log(`\n== Server returned ${r.status} (expected 200 with tp=1) ==`);
      failures.push(`server /api/evaluate/redaction returned ${r.status}`);
    }
  } catch (e) {
    console.log(`\n== Server not reachable: ${e.message} (skipped) ==`);
  }
} else {
  console.log('\nPass --server http://localhost:8000 to also check the server-side IoU matcher.');
}

// These need a real browser; the headless e2e (scripts/e2e-leak.test.mjs) covers them.
console.log('\nNot covered here (require a browser):');
console.log('  AXTree extraction quality   -> npm run test:e2e');
console.log('  raw-PII leak assertions      -> npm run test:e2e');
console.log('  client heap / latency        -> popup metrics panel (see TESTING.md)');

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
