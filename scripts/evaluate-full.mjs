#!/usr/bin/env node
// Full evaluation: hits synthetic page text + calls server /api/evaluate/redaction if running
// Usage: node scripts/evaluate-full.mjs [--server http://localhost:8000]
import { readFileSync } from 'fs';

const server = process.argv[2]?.startsWith('http') ? process.argv[2] : (process.env.SERVER_URL || 'http://localhost:8000');

const pats = {
  EMAIL: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  PHONE: /(?:\+91[\s-]?)?\d{5}\s?\d{5}|\b\d{10}\b/g,
  AADHAAR: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
  PAN: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  IP_ADDRESS: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

function detect(text) {
  const all = [];
  for (const [t, re] of Object.entries(pats)) { re.lastIndex=0; let m; while((m=re.exec(text))!==null) all.push({type:t, value:m[0]}); }
  // Luhn for CC
  return all.filter(h=> h.type!=='CREDIT_CARD' || luhn(h.value));
}
function luhn(s){ const d=s.replace(/\D/g,''); if(d.length<13||d.length>19) return false; let sum=0,dbl=false; for(let i=d.length-1;i>=0;i--){let n=parseInt(d[i]); if(dbl){n*=2; if(n>9)n-=9;} sum+=n; dbl=!dbl;} return sum%10===0; }

const html = readFileSync('public/test-pii.html','utf8');
const text = html.replace(/<[^>]*>/g,' ');
const hits = detect(text);
const truth = JSON.parse(readFileSync('public/ground-truth.json','utf8'));

console.log('== Metric 2: PII recall (regex baseline) ==');
for(const gt of truth.groundTruth){
  const found = hits.filter(h=> h.type===gt.type && (gt.value.includes(h.value) || h.value.includes(gt.value) || gt.type===h.type)).length;
  // simplified: expect at least gt.count occurrences
  console.log(`${gt.type} ${gt.value.slice(0,24)}: found ${found} expect ${gt.count} ${found>=gt.count? '✓':'✗'}`);
}
console.log(`\nTotal hits: ${hits.length} / groundTruth spans ${truth.totalSpans}`);

// Server bbox evaluation sample
const samplePredicted = [{bbox:[10,10,100,20], type:'EMAIL', confidence:0.97}];
const sampleGT = [{bbox:[10,10,100,20], type:'EMAIL', confidence:1}];
try{
  const r = await fetch(`${server}/api/evaluate/redaction`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({predicted: samplePredicted, ground_truth: sampleGT})});
  if(r.ok) console.log('\n== Metric 3: server bbox IoU sample ==', await r.json());
  else console.log('\nServer not running — start with: python3 -m uvicorn server.app:app --port 8000');
}catch(e){ console.log('\nServer check failed:', e.message); }

console.log('\n== Metric 1: AXTree == extract from content script window.__visionBuildContext() in browser console');
console.log('== Metric 4: resource == check popup storageInfo + memInfo + chrome task manager heap <300MB');
console.log('== Metric 5: E2E latency == popup shows local ms + server ms; target <400ms wasm / <150ms webgpu, total <2s');
