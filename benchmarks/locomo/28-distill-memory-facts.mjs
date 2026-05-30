#!/usr/bin/env node
// Track A v3 — LLM-distilled memory facts (true Mem0-style harvest)
//
// Per conversation, asks gpt-4o-mini to extract synthesis-level memory facts
// in 4 categories with production-Waggle prefixes:
//   • User preference: <Name> values/prefers/dislikes <thing> [because <reason>]
//   • Decision: <Name> decided to <action>
//   • Trait: <Name> is <trait> as evidenced by <pattern>
//   • Theme: <topic> — <insight across sessions>
//
// These are the kind of inference-friendly facts that answer "would X be
// considered Y?" or "what kind of person is X?" — exactly the open-ended
// shape where v2 still loses 41.7pp to Mem0 paper.
//
// Saves frames with explicit category prefixes (importance: important) into
// existing per-conv workspaces. After this, re-cognify + re-run retrieval.

process.env.HIVE_MIND_NO_SYNTH = '1';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_ALL_FILE = resolve(__dirname, 'data', 'RUN-all.json');
const DATASET = resolve(__dirname, 'data', 'locomo10.json');
const OUT_LOG = resolve(__dirname, 'data', 'distilled-facts.jsonl');

const HIVE_MIND_ROOT = process.env.HIVE_MIND_ROOT ?? resolve(__dirname, '..', '..');
const FRAMES_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/frames.js`).href;
const DB_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/mind/db.js`).href;

const MODEL = 'gpt-4o-mini';

function loadEnv() {
  const envFile = resolve(__dirname, '..', '..', '.env.locomo-trio');
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

function buildConvText(conv) {
  const sks = Object.keys(conv.conversation)
    .filter(k => /^session_\d+$/.test(k) && Array.isArray(conv.conversation[k]))
    .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10));
  return sks.map(sk => {
    const sn = parseInt(sk.split('_')[1], 10);
    const date = conv.conversation[`${sk}_date_time`] || '';
    const header = date ? `Session ${sn} (${date}):` : `Session ${sn}:`;
    return [header, ...conv.conversation[sk].map(t => `${t.speaker}: ${t.text}`)].join('\n');
  }).join('\n\n');
}

const SYSTEM_PROMPT =
  'You extract synthesis-level memory facts from long-term conversations. ' +
  'Your output will be stored as memory frames and retrieved when answering questions. ' +
  'Focus on facts that synthesize across multiple sessions and answer inference-style ' +
  'questions like "would X be considered Y?" or "what kind of person is X?". Output ONLY ' +
  'the JSON array, no preamble.';

function buildPrompt(speakerA, speakerB, convText) {
  return `Conversation between ${speakerA} and ${speakerB}:

${convText}

---

Extract 20-30 synthesis-level memory facts in these 4 categories. Each fact must be a single short sentence. Focus on what would help answer inference / synthesis questions later.

1. **User preference** (~8-12 facts): values, preferences, dislikes
   Prefix: "User preference: <Name> values/prefers/dislikes <thing>[ because <reason>]"

2. **Decision** (~3-6 facts): explicit decisions or commitments
   Prefix: "Decision: <Name> decided to <action>[, because <reason>]"

3. **Trait** (~5-8 facts): personality, beliefs, lifestance, evidenced by patterns across sessions
   Prefix: "Trait: <Name> is <trait/orientation>[, as shown by <pattern>]"

4. **Theme** (~3-5 facts): recurring topics, arcs, progressions across sessions
   Prefix: "Theme: <topic/arc> — <insight>"

Output STRICT JSON:
{"facts": [{"category": "preference|decision|trait|theme", "speaker": "Name|both|null", "text": "<full prefix-tagged sentence>"}, ...]}`;
}

async function distillConv(conv) {
  const speakerA = conv.conversation?.speaker_a || 'Speaker A';
  const speakerB = conv.conversation?.speaker_b || 'Speaker B';
  const convText = buildConvText(conv);
  const prompt = buildPrompt(speakerA, speakerB, convText);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      temperature: 0,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  const content = j.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  return { facts: parsed.facts || [], usage: j.usage };
}

async function ingestFacts(convIdx, sampleId, mindPath, facts, modules) {
  const { MindDB, FrameStore } = modules;
  const db = new MindDB(mindPath);
  const frames = new FrameStore(db);
  const raw = db.getDatabase();
  const seed = raw.prepare(
    `INSERT OR IGNORE INTO sessions (gop_id, project_id, status, started_at, summary)
     VALUES (?, 'locomo-replay', 'closed', datetime('now'), ?)`,
  );
  const gopId = `locomo-${sampleId}-distilled-facts`;
  seed.run(gopId, `LoCoMo ${sampleId} LLM-distilled memory facts`);

  let ingested = 0, skipped = 0;
  try {
    for (const f of facts) {
      const text = String(f.text || '').trim();
      if (!text) { skipped++; continue; }
      const cat = String(f.category || 'theme').toLowerCase();
      const importance = (cat === 'decision' || cat === 'trait') ? 'important' : 'normal';
      // Frame already has its category prefix in `text` (per the prompt contract)
      const content = `[locomo distilled-fact conv:${sampleId} category:${cat}]\n${text}`;
      try {
        frames.createIFrame(gopId, content, importance, 'system', null);
        ingested++;
      } catch { skipped++; }
    }
  } finally { db.close(); }
  return { ingested, skipped };
}

async function main() {
  loadEnv();
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not loaded');
  const runAll = JSON.parse(readFileSync(RUN_ALL_FILE, 'utf8'));
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const { MindDB } = await import(DB_URL);
  const { FrameStore } = await import(FRAMES_URL);
  const modules = { MindDB, FrameStore };

  let totalFacts = 0, totalUsd = 0;
  const factLog = [];
  for (const c of runAll.convs) {
    const conv = dataset[c.conv_idx];
    const t0 = Date.now();
    process.stdout.write(`  c${c.conv_idx} ${c.sample_id} | `);
    try {
      const { facts, usage } = await distillConv(conv);
      const { ingested, skipped } = await ingestFacts(c.conv_idx, c.sample_id, c.mind_path, facts, modules);
      const cost = (usage?.prompt_tokens || 0) * 0.00000015 + (usage?.completion_tokens || 0) * 0.00000060;
      totalUsd += cost;
      totalFacts += ingested;
      const byCat = facts.reduce((acc, f) => { acc[f.category] = (acc[f.category] || 0) + 1; return acc; }, {});
      console.log(`${((Date.now() - t0)/1000).toFixed(1)}s | facts=${facts.length} (${JSON.stringify(byCat)}) ingested=${ingested} skipped=${skipped} cost=$${cost.toFixed(4)}`);
      factLog.push({ conv_idx: c.conv_idx, sample_id: c.sample_id, facts });
    } catch (e) {
      console.log(`ERR: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  writeFileSync(OUT_LOG, factLog.map(o => JSON.stringify(o)).join('\n') + '\n');
  console.log(`[done] total facts ingested: ${totalFacts} | total cost: $${totalUsd.toFixed(4)} | log: ${OUT_LOG}`);
}

main().catch(e => { console.error('FAIL:', e.message); console.error(e.stack); process.exit(1); });
