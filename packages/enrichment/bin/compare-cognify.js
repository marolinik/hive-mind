#!/usr/bin/env node
/**
 * One-shot smoke: run the OLD cognify extractor and the NEW cognify extractor
 * against the same set of frames pulled via MCP recall_memory, then print a
 * before/after delta.
 *
 * Both extractors are inlined here (no module imports) so the script can be
 * removed cleanly after we're satisfied with the new heuristic. Frames come
 * from MCP, never directly from the DB.
 */
import { callMcp } from '../src/cli-bridge.js';

const ENTITY_PATTERN = /\b([A-Z][a-zA-Z]+(?:\s+(?:de|of|&)\s+|\s+)[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g;
const SIMPLE_ENTITY_PATTERN = /\b([A-Z][a-zA-Z]{2,})\b/g;

const OLD_STOP = new Set([
  'The', 'This', 'That', 'These', 'Those', 'When', 'Where', 'Why', 'How',
  'What', 'Who', 'Which', 'If', 'And', 'But', 'Or', 'So', 'For', 'Nor',
  'Yet', 'As', 'At', 'By', 'On', 'In', 'To', 'From', 'With', 'Without',
  'Into', 'Onto', 'Upon', 'Over', 'Under', 'Between', 'Among',
]);

const NEW_STOP = new Set([
  ...OLD_STOP,
  'Add', 'Remove', 'Set', 'Get', 'Update', 'Delete', 'Create', 'List',
  'Search', 'Find', 'Run', 'Build', 'Use', 'Make', 'Test', 'Check',
  'Read', 'Write', 'Edit', 'Save', 'Load', 'Open', 'Close', 'Start',
  'Stop', 'Show', 'Hide', 'Push', 'Pull', 'Fix', 'Done', 'Skip',
  'Wait', 'Try', 'Note', 'Warn', 'Info', 'Debug', 'Trace',
  'Todo', 'Fixme', 'Should', 'Could', 'Would', 'Must', 'Will', 'Shall',
  'Can', 'May', 'Might',
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
  'Nov', 'Dec',
  'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]);

function isLikelyAcronym(s) {
  return /^[A-Z]+$/.test(s) && s.length <= 6;
}

function oldExtract(text) {
  const seen = new Set();
  for (const m of text.matchAll(ENTITY_PATTERN)) {
    const c = m[1].trim();
    if (c.length >= 4) seen.add(c);
  }
  for (const m of text.matchAll(SIMPLE_ENTITY_PATTERN)) {
    const c = m[1].trim();
    if (OLD_STOP.has(c)) continue;
    if (c.length < 3) continue;
    seen.add(c);
  }
  return [...seen];
}

function newExtract(text) {
  const seen = new Set();
  for (const m of text.matchAll(ENTITY_PATTERN)) {
    const c = m[1].trim();
    if (c.length >= 4) seen.add(c);
  }
  for (const m of text.matchAll(SIMPLE_ENTITY_PATTERN)) {
    const c = m[1].trim();
    if (c.length < 4) continue;
    if (NEW_STOP.has(c)) continue;
    if (isLikelyAcronym(c)) continue;
    seen.add(c);
  }
  return [...seen];
}

const queries = [
  'session checkpoint',
  'enrichment validation',
  'cognify entity',
  'synth-queue',
  'workspace deriver',
];

const allFrames = new Map();
for (const q of queries) {
  const r = await callMcp('recall_memory', { query: q, limit: 6, scope: 'personal', profile: 'recent' }, { timeoutMs: 4000 });
  if (!r.ok || !Array.isArray(r.data)) continue;
  for (const f of r.data) {
    if (!allFrames.has(f.id)) allFrames.set(f.id, f);
  }
}
const frames = [...allFrames.values()].slice(0, 20);

let oldTotal = 0;
let newTotal = 0;
const droppedCounts = new Map();
console.log('frame_id  len    old   new   delta  dropped_examples');
console.log('-'.repeat(80));
for (const f of frames) {
  const text = String(f.content || '');
  const oldEnts = new Set(oldExtract(text));
  const newEnts = new Set(newExtract(text));
  const dropped = [...oldEnts].filter((e) => !newEnts.has(e));
  for (const d of dropped) droppedCounts.set(d, (droppedCounts.get(d) || 0) + 1);
  oldTotal += oldEnts.size;
  newTotal += newEnts.size;
  const sample = dropped.slice(0, 4).join(', ');
  console.log(`#${String(f.id).padStart(4)}    ${String(text.length).padStart(5)}  ${String(oldEnts.size).padStart(4)}  ${String(newEnts.size).padStart(4)}  ${String(oldEnts.size - newEnts.size).padStart(5)}  ${sample}`);
}
console.log('-'.repeat(80));
console.log(`TOTALS  frames=${frames.length}  old=${oldTotal} (${(oldTotal / frames.length).toFixed(1)}/frame)  new=${newTotal} (${(newTotal / frames.length).toFixed(1)}/frame)  reduction=${(100 * (oldTotal - newTotal) / oldTotal).toFixed(1)}%`);

// Top 15 most-frequently-dropped tokens (signal vs noise check)
const top = [...droppedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('\nTop dropped tokens (count):');
for (const [tok, n] of top) console.log(`  ${String(n).padStart(3)}  ${tok}`);
