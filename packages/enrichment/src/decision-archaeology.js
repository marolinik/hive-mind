/**
 * Phase 3e-3 — Decision archaeology.
 *
 * When the user asks "why did I X?" / "what was the reason for Y?" / "why
 * are we Y?", surface the **Why:** lines from feedback memories that look
 * relevant to the question.
 *
 * Feedback memories live in the auto-memory store at
 * `~/.claude/projects/<encoded-cwd>/memory/feedback_*.md`. They are NOT in
 * the hive-mind frame database — they are CC-harness artifacts. We read
 * them off disk when the prompt's intent is "why" and the file frontmatter
 * declares `type: feedback`.
 *
 * Why a separate module instead of harvesting feedback memories into the
 * mind: the auto-memory store is the source of truth for these files; the
 * harness writes them, our hooks just read them. Mirroring would create
 * a sync problem we don't need.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Detect "why" intent. Conservative — single-pattern false-positive check
// would block too much; we want this to fire whenever the prompt is asking
// about a past decision or rationale. Checks both single-word indicators
// ("why", "reason") and phrases ("what was the reason", "decided to").
const WHY_INTENT_PATTERNS = [
  /\bwhy(?:\s+(?:did|do|does|are|is|am|were|was|would|should|don't|didn't))/i,
  /\bwhat\s+(?:was|is)\s+the\s+reason\b/i,
  /\bhow\s+come\b/i,
  /\bwhat\s+made\s+(?:me|us|you)\b/i,
  /\bwhat\s+drove\s+(?:me|us|the)\s+decision/i,
  /\b(?:reason|rationale|motivation)\s+(?:for|behind)\b/i,
  /\bdecided\s+to\b/i,
  /\bwhy(?:\?|$)/i,  // bare "why?" or "...why" at end-of-line
];

/**
 * Returns true if the prompt is asking about a past decision/rationale.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function isWhyIntent(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return false;
  return WHY_INTENT_PATTERNS.some((p) => p.test(prompt));
}

/**
 * Encode an absolute CWD to the auto-memory project dir name.
 *
 * Convention observed from `~/.claude/projects/`:
 *   D:\Projects                   → D--Projects
 *   D:\Projects\waggle-os         → D--Projects-waggle-os
 *   C:\Users\Foo\.claude\commands → C--Users-Foo--claude-commands
 *
 * Rule: replace each of `:`, `\`, `/`, `.` with `-`. The double-dash for
 * `:\\` and `\.` falls out naturally from replacing each character.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function encodeCwdToProjectDir(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  return cwd.replace(/[\\/:.]/g, '-');
}

/**
 * Resolve the auto-memory dir for a given CWD.
 *
 * @param {string} cwd
 * @returns {string}
 */
function autoMemoryDirFor(cwd) {
  const encoded = encodeCwdToProjectDir(cwd);
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
}

/**
 * Parse a feedback_*.md file into its structured parts.
 * Returns null when the file is unreadable or doesn't look like a feedback
 * memory (missing frontmatter or wrong type).
 *
 * @param {string} filePath
 * @returns {{ name?:string, description?:string, rule?:string, why?:string, howToApply?:string, raw:string } | null}
 */
function parseFeedbackFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  // Trim a leading <system-reminder> block if present (older harness output).
  const cleaned = raw.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, '');

  // Frontmatter parse — use a tolerant line-by-line approach. yaml is
  // overkill for the few keys we read.
  const fmMatch = cleaned.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  const fmField = (key) => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const type = fmField('type');
  if (type !== 'feedback') return null;

  const name = fmField('name');
  const description = fmField('description');

  // Body extraction:
  //   - Rule = the leading paragraphs before any **Why:** marker.
  //   - Why = first paragraph after **Why:**.
  //   - How to apply = first paragraph after **How to apply:**.
  const splitWhy = body.split(/\n\*\*Why:\*\*\s*/);
  const rule = (splitWhy[0] || '').trim();
  let why = '';
  let howToApply = '';
  if (splitWhy.length > 1) {
    const afterWhy = splitWhy[1];
    const splitHow = afterWhy.split(/\n\*\*How to apply:\*\*\s*/);
    why = (splitHow[0] || '').trim();
    if (splitHow.length > 1) howToApply = (splitHow[1] || '').trim();
  }
  return { name, description, rule, why, howToApply, raw };
}

/**
 * Score a feedback memory against a prompt by simple keyword overlap.
 *
 * Tokenizes both into word sets (lowercased, length >= 4 to skip stop
 * words), counts intersection size. Cheap, fail-safe, no embeddings.
 *
 * @param {string} prompt
 * @param {{name?:string, description?:string, rule?:string}} memory
 * @returns {number}
 */
function scoreOverlap(prompt, memory) {
  const tokenize = (s) => {
    const tokens = String(s || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
    return new Set(tokens);
  };
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0) return 0;
  const memoryText = `${memory.name || ''} ${memory.description || ''} ${memory.rule || ''}`;
  const memoryTokens = tokenize(memoryText);
  let overlap = 0;
  for (const t of memoryTokens) {
    if (promptTokens.has(t)) overlap++;
  }
  return overlap;
}

/**
 * Find the top feedback memories for a "why" prompt, scanning the
 * auto-memory dir for the given CWD.
 *
 * Fail-open: returns [] on any error (unreadable dir, no feedback files,
 * etc.). Caller should not rely on this throwing — they should treat
 * empty as "no decision archaeology this turn."
 *
 * @param {{prompt:string, cwd:string, maxMatches?:number, minOverlap?:number}} input
 * @returns {Array<{name:string, description:string, why:string, howToApply:string, score:number}>}
 */
export function findDecisionMatches({ prompt, cwd, maxMatches = 2, minOverlap = 1 } = {}) {
  if (!isWhyIntent(prompt)) return [];
  const dir = autoMemoryDirFor(cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith('feedback_') || !name.endsWith('.md')) continue;
    const parsed = parseFeedbackFile(path.join(dir, name));
    if (!parsed) continue;
    const score = scoreOverlap(prompt, parsed);
    if (score >= minOverlap) {
      candidates.push({
        name: parsed.name || name,
        description: parsed.description || '',
        why: parsed.why || '',
        howToApply: parsed.howToApply || '',
        score,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxMatches);
}
