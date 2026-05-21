/**
 * Phase 3e-4 — Proactive contradiction detection.
 *
 * Goal: when a saved feedback memory says "don't X" and the user's prompt
 * asks for X, surface a soft warning before the LLM acts.
 *
 * Design constraint: the hook has a 4 s budget and Marko set "no API spend"
 * for synthesis. A real LLM classifier per turn would blow both. This
 * module uses a heuristic that ships TODAY:
 *
 *   1. Treat any feedback memory whose RULE contains negation markers
 *      (don't / never / avoid / no / stop / refuse / etc.) as a
 *      candidate "do not X" rule.
 *   2. Tokenize the rule's "forbidden zone" — text within ~12 tokens of
 *      the negation marker.
 *   3. Tokenize the prompt.
 *   4. If the overlap between forbidden-zone tokens and prompt tokens is
 *      at least the threshold AND the prompt does NOT itself contain a
 *      negation, flag as a potential contradiction.
 *
 * Acknowledged false positives: this is intentionally tunable. Marko's
 * 2026-05-06 decision was "default-on with weekly review" — set
 * HIVE_MIND_CONTRADICTION_OFF=1 to disable globally; per-memory denylist
 * is a future polish (not in scope this session).
 *
 * The wording in the surfaced warning is FRAMED as a check, not a block:
 * "You previously said X. Your prompt looks like it's asking for the
 * opposite. Continue, or revisit?"
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encodeCwdToProjectDir } from './decision-archaeology.js';

// Apostrophe variants — ASCII ' (U+0027), curly ' ' (U+2018/U+2019),
// modifier ʼ (U+02BC), backtick `. Many feedback memories use whichever
// the editor produced; we accept all of them.
const APO = "(?:['‘’ʼ`])?";

const NEGATION_MARKERS = [
  new RegExp(`\\bdon${APO}t\\b`, 'i'),
  /\bdo not\b/i,
  /\bnever\b/i,
  /\bavoid\b/i,
  /\bno\s+(?:more\s+)?\b/i,
  /\bstop(?:\s+(?:doing|using))?\b/i,
  /\brefuse(?:s|d)?\s+to\b/i,
  new RegExp(`\\bwon${APO}t\\b`, 'i'),
  new RegExp(`\\bshouldn${APO}t\\b`, 'i'),
  /\bmust not\b/i,
  new RegExp(`\\bmustn${APO}t\\b`, 'i'),
];

const NEGATION_RX_GLOBAL = new RegExp(
  `\\b(?:don${APO}t|do not|never|avoid|no\\s+(?:more\\s+)?|stop|refuse[sd]?\\s+to|won${APO}t|shouldn${APO}t|must not|mustn${APO}t)\\b`,
  'gi'
);

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','if','then','of','for','to','in','on','at','by','with','from','this','that','these','those','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','should','could','can','may','might','must','i','you','we','they','it','my','your','our','their','its','about','as','so','not','no','any','some','all','one','two','three',
]);

/**
 * Quick check for whether contradiction detection is enabled. Honors
 * HIVE_MIND_CONTRADICTION_OFF=1 as the global kill switch.
 *
 * @returns {boolean}
 */
export function isContradictionDetectionEnabled() {
  return process.env.HIVE_MIND_CONTRADICTION_OFF !== '1';
}

/**
 * Check if a string contains any negation marker.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasNegation(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return NEGATION_MARKERS.some((p) => p.test(text));
}

/**
 * Extract the "forbidden zone" — content tokens that appear close to a
 * negation marker, normalized for keyword comparison.
 *
 * Why proximity: the rule "don't mock the database" puts "mock" and
 * "database" near "don't"; tokens far away (e.g. "Reason: prior incident
 * where mock/prod divergence...") are explanatory text that shouldn't
 * count as forbidden.
 *
 * @param {string} ruleText
 * @returns {Set<string>}
 */
/**
 * Crude stemmer for plural/verb-form normalization. The full Porter stemmer
 * is overkill; we just want "mocks"/"mock" to land on the same token. Conservative:
 * only strip suffixes when length stays >= 4 to avoid demolishing short words
 * like "is" → "i".
 *
 * @param {string} t
 * @returns {string}
 */
function normalizeToken(t) {
  if (typeof t !== 'string' || t.length < 5) return t;
  // -ies → -y (e.g. "queries" → "query")
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  // -es / -ed / -ing — strip when the result is at least 4 chars
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('es') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('s') && t.length > 4 && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function extractForbiddenTokens(ruleText) {
  const out = new Set();
  if (typeof ruleText !== 'string' || ruleText.length === 0) return out;
  const text = ruleText.toLowerCase();
  const markerPositions = [];
  let m;
  NEGATION_RX_GLOBAL.lastIndex = 0;
  while ((m = NEGATION_RX_GLOBAL.exec(text)) !== null) {
    markerPositions.push(m.index);
  }
  if (markerPositions.length === 0) return out;

  const tokenize = (s) => (s.match(/[a-z][a-z-]{3,}/g) || []);
  for (const pos of markerPositions) {
    const zone = text.slice(pos, pos + 120);
    for (const tok of tokenize(zone)) {
      if (!STOP_WORDS.has(tok)) out.add(normalizeToken(tok));
    }
  }
  return out;
}

/**
 * Tokenize a prompt for keyword comparison. Lowercased, length >= 4,
 * minus stop words. Intentionally simple — same heuristic as the
 * decision-archaeology module so behavior is consistent.
 *
 * @param {string} prompt
 * @returns {Set<string>}
 */
function promptTokens(prompt) {
  const out = new Set();
  if (typeof prompt !== 'string' || prompt.length === 0) return out;
  const tokens = prompt.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  for (const t of tokens) {
    if (!STOP_WORDS.has(t)) out.add(normalizeToken(t));
  }
  return out;
}

function parseFeedbackForContradiction(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const cleaned = raw.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '');
  const fmMatch = cleaned.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  const fmField = (key) => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  if (fmField('type') !== 'feedback') return null;

  // Per-memory opt-out (B4, 2026-05-08): a feedback memory can disable
  // contradiction detection on itself by adding `contradiction: false` to
  // its frontmatter. Useful for rules that cause too many false positives
  // (e.g. broad lifestyle preferences with common keywords) — keeps the
  // memory active for other purposes (decision-archaeology, recall) while
  // suppressing contradiction warnings specifically.
  const optOut = fmField('contradiction').toLowerCase();
  if (optOut === 'false' || optOut === 'off' || optOut === 'no') return null;

  return {
    name: fmField('name'),
    description: fmField('description'),
    body,
  };
}

/**
 * Find feedback memories whose rule contradicts the user's prompt.
 *
 * Returns an array of contradiction candidates. Caller should treat each
 * as a SOFT warning, not a hard block — heuristic has known false
 * positives, and the design (Marko 2026-05-06) is "default-on with
 * weekly review."
 *
 * @param {{prompt:string, cwd:string, maxMatches?:number, minOverlap?:number}} input
 * @returns {Array<{name:string, description:string, rule:string, overlapTokens:string[]}>}
 */
export function findContradictions({ prompt, cwd, maxMatches = 2, minOverlap = 2 } = {}) {
  if (!isContradictionDetectionEnabled()) return [];
  if (typeof prompt !== 'string' || prompt.length === 0) return [];
  // If the prompt itself uses negation, the user is likely ASKING about
  // the rule (e.g. "why don't we mock?") rather than asking to violate
  // it. Suppress contradiction warnings in that case.
  if (hasNegation(prompt)) return [];

  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdToProjectDir(cwd), 'memory');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const pTokens = promptTokens(prompt);
  if (pTokens.size === 0) return [];

  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith('feedback_') || !name.endsWith('.md')) continue;
    const parsed = parseFeedbackForContradiction(path.join(dir, name));
    if (!parsed) continue;
    if (!hasNegation(parsed.body)) continue;
    const forbidden = extractForbiddenTokens(parsed.body);
    if (forbidden.size === 0) continue;
    const overlap = [];
    for (const t of forbidden) {
      if (pTokens.has(t)) overlap.push(t);
    }
    if (overlap.length >= minOverlap) {
      const ruleSnippet = parsed.body.replace(/^\s+/, '').slice(0, 240);
      candidates.push({
        name: parsed.name || name,
        description: parsed.description || '',
        rule: ruleSnippet,
        overlapTokens: overlap,
      });
    }
  }
  candidates.sort((a, b) => b.overlapTokens.length - a.overlapTokens.length);
  return candidates.slice(0, maxMatches);
}
