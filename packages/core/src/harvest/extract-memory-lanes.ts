/**
 * extract-memory-lanes.ts — LLM extraction passes for the benchmark-proven
 * recall lanes.
 *
 * Three single-call LLM passes over conversation text, production
 * generalizations of LoCoMo-validated extraction scripts:
 *
 *  - DENSE FACTS  → `[mind-fact]`              cross-session syntheses
 *  - EPISODIC     → `[mind-event]`             datable events, created_at =
 *                                              LLM-resolved EVENT date
 *  - PROFILES     → `[mind-profile <name>]`    per-person persona cards,
 *                                              importance DELIBERATELY 'normal'
 *                                              (stays out of the importance lane)
 *
 * Frames are prefix-tagged on their first line so recall lanes fetch them by
 * `content LIKE '[mind-… %'` — the same convention the benchmark proved.
 * All LLM output is injection-scanned before any frame write (LLM passes run
 * over possibly-tainted harvested content).
 *
 * Model: LLMCallFn 'fast' tier (benchmark used a fast mini model, temp 0).
 *
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12).
 */

import type { LLMCallFn } from './pipeline.js';
import { scanForInjection } from '../injection-scanner.js';
import { createCoreLogger } from '../logger.js';
import type { FrameStore } from '../mind/frames.js';

const log = createCoreLogger('extract-memory-lanes');

/** First-line content prefixes for the three lanes (recall fetches by these). */
export const MIND_FACT_PREFIX = '[mind-fact]';
export const MIND_EVENT_PREFIX = '[mind-event]';
export const MIND_PROFILE_PREFIX = '[mind-profile';

export interface ExtractedEvent {
  /** ISO date of the session/source the event was narrated in. */
  session_date: string;
  /** Relative cue found in the utterance ("yesterday"…), or "none". */
  cue: string;
  /** LLM-resolved date the event actually happened (YYYY-MM-DD). */
  event_date: string;
  text: string;
}

export interface ExtractedFact {
  category: 'preference' | 'decision' | 'trait' | 'theme';
  speaker: string;
  text: string;
}

export interface ExtractedProfile {
  speaker: string;
  card: string;
}

export interface MemoryLaneExtraction {
  facts: ExtractedFact[];
  events: ExtractedEvent[];
  profiles: ExtractedProfile[];
  errors: string[];
}

// ── Prompts (benchmark extraction scripts, generalized off the speaker pair) ──

const FACTS_SYSTEM =
  'You extract many synthesis-level memory facts from long-term conversations. ' +
  'Be exhaustive — cover preferences, decisions, traits, life-stances, beliefs, ' +
  'progressions, themes, hobbies, fears, joys, opinions, family relationships, ' +
  'professional details. Output ONLY the JSON, no preamble.';

function factsPrompt(text: string): string {
  return `${FACTS_SYSTEM}

Conversation/source material:

${text}

---

Extract a DENSE set of synthesis-level memory facts (scale the count to the material; up to ~60 for long conversations). Aim for HIGH COVERAGE — include facts relevant to inference questions like "would X be considered Y?" or "how does X feel about Y?".

Categories:
1. preference — "User preference: <Name> [values/likes/dislikes/prefers/believes] <thing>[ because <reason>]"
2. decision — "Decision: <Name> decided to/plans to <action>[, because <reason>]"
3. trait — "Trait: <Name> is <trait/orientation>[, as shown by <pattern>]"
4. theme — "Theme: <topic/arc> — <insight or progression across sessions>"

Be SPECIFIC and CONCRETE. Each fact stands alone. Cover all participants.

Output STRICT JSON:
{"facts": [{"category": "preference|decision|trait|theme", "speaker": "Name|both", "text": "<full prefix-tagged sentence>"}, ...]}`;
}

const EVENTS_SYSTEM =
  'You extract specific datable events from long-term conversations AND resolve WHEN each ' +
  'event actually happened. Source material carries dates (session headers, timestamps). ' +
  'Events are often recounted in PAST tense with relative time cues ("yesterday", "last ' +
  'week", "two months ago", "last year"). You MUST compute the ACTUAL event date by applying ' +
  'the cue to that passage\'s date — do NOT just copy the source date. If an event has no ' +
  'relative cue (happening now / present tense / planned for the future), use the source date. ' +
  'Focus on concrete things that HAPPENED: activities, places visited, milestones, purchases, ' +
  'meetings, projects, health events, travel. Do NOT include timeless preferences or ' +
  'personality traits — only events. Output ONLY the JSON.';

function eventsPrompt(text: string): string {
  return `${EVENTS_SYSTEM}

Source material (dated):

${text}

---

Extract the specific datable events (scale the count to the material). For EACH event output:
- session_date: the ISO date of the passage the event was narrated in (YYYY-MM-DD)
- cue: the exact relative time phrase ("yesterday", "last week", "two months ago"), or "none"
- event_date: the RESOLVED actual date the event happened (YYYY-MM-DD)
- text: a concise sentence about what happened (names, titles, exact activities)

Resolution rules (apply cue to session_date):
- "yesterday" -> session_date − 1 day
- "the day before yesterday" -> session_date − 2 days
- "last week" / "a week ago" -> session_date − 7 days
- "N days/weeks ago" -> subtract that many days/weeks
- "last month" / "a month ago" -> session_date − 1 month
- "N months ago" -> subtract N months
- "last year" -> same month/day, year − 1
- "none" (present tense/now) -> event_date = session_date

Worked example: passage dated 2023-05-08, "I went to the book club yesterday"
  -> {"session_date":"2023-05-08","cue":"yesterday","event_date":"2023-05-07","text":"Alice attended the neighborhood book club"}

Output STRICT JSON:
{"events": [{"session_date":"YYYY-MM-DD","cue":"...","event_date":"YYYY-MM-DD","text":"..."}, ...]}`;
}

const PROFILES_SYSTEM =
  'You build dense persona profile cards from long-term conversations, aggregating ' +
  'dispersed weak signals (activities, choices, stated values, recurring themes) into a ' +
  'coherent portrait. The card must support INFERENCE questions like "would X be ' +
  'considered religious?" or "what would X\'s likely preference be?". Aggregate signals; ' +
  'include world-knowledge hooks (specific titles, brand names, place names — verbatim, ' +
  'never generalized). Output ONLY the JSON.';

function profilesPrompt(text: string): string {
  return `${PROFILES_SYSTEM}

Source material:

${text}

---

Build one profile card per main participant (120-180 words each). Each card MUST cover, compactly:
- Identity & life situation (job/role, family, relationships, location if stated)
- Interests & habits with SPECIFIC named items (exact titles, brands, activities)
- Values, beliefs, personality leanings AS EVIDENCED
- Major life arc events with rough dates
- People mentioned around them and who those people likely are
- Current state at the end of the material (latest job, plans, status)

Write declarative, signal-dense prose. No hedging filler. Keep verbatim named entities.

Output STRICT JSON:
{"profiles": [{"speaker": "<Name>", "card": "..."}, ...]}`;
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Run the three lane-extraction passes over one body of conversation text.
 * Each pass fails independently — a parse failure on one lane never blocks
 * the others (errors are collected, not thrown).
 */
export async function extractMemoryLanes(
  text: string,
  llmCall: LLMCallFn,
): Promise<MemoryLaneExtraction> {
  const out: MemoryLaneExtraction = { facts: [], events: [], profiles: [], errors: [] };

  const passes: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'facts',
      run: async () => {
        const obj = parseJsonObject(await llmCall(factsPrompt(text), 'fast'));
        const facts = Array.isArray(obj?.facts) ? obj.facts : [];
        for (const f of facts as Array<Record<string, unknown>>) {
          if (typeof f?.text === 'string' && f.text.trim().length > 0) {
            out.facts.push({
              category: (['preference', 'decision', 'trait', 'theme'].includes(String(f.category))
                ? String(f.category)
                : 'preference') as ExtractedFact['category'],
              speaker: typeof f.speaker === 'string' ? f.speaker : 'unknown',
              text: f.text.trim(),
            });
          }
        }
      },
    },
    {
      name: 'events',
      run: async () => {
        const obj = parseJsonObject(await llmCall(eventsPrompt(text), 'fast'));
        const events = Array.isArray(obj?.events) ? obj.events : [];
        for (const e of events as Array<Record<string, unknown>>) {
          const eventDate = typeof e?.event_date === 'string' ? e.event_date : '';
          if (typeof e?.text === 'string' && e.text.trim().length > 0 && ISO_DATE_RE.test(eventDate)) {
            out.events.push({
              session_date: typeof e.session_date === 'string' ? e.session_date : eventDate,
              cue: typeof e.cue === 'string' ? e.cue : 'none',
              event_date: eventDate,
              text: e.text.trim(),
            });
          }
        }
      },
    },
    {
      name: 'profiles',
      run: async () => {
        const obj = parseJsonObject(await llmCall(profilesPrompt(text), 'fast'));
        const profiles = Array.isArray(obj?.profiles) ? obj.profiles : [];
        for (const p of profiles as Array<Record<string, unknown>>) {
          if (typeof p?.speaker === 'string' && typeof p?.card === 'string' && p.card.trim().length > 0) {
            out.profiles.push({ speaker: p.speaker.trim(), card: p.card.trim() });
          }
        }
      },
    },
  ];

  for (const pass of passes) {
    try {
      await pass.run();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      out.errors.push(`${pass.name}: ${msg}`);
      log.warn(`memory-lane extraction pass failed`, { pass: pass.name, error: msg });
    }
  }
  return out;
}

// ── Frame writing ────────────────────────────────────────────────────────────

export interface WriteLaneFramesResult {
  factsWritten: number;
  eventsWritten: number;
  profilesWritten: number;
  injectionDropped: number;
}

/**
 * Persist an extraction as prefix-tagged frames.
 *
 * - facts:    `[mind-fact]\n<text>` importance 'normal'
 * - events:   `[mind-event]\n[YYYY-MM-DD] <text>` importance 'normal',
 *             created_at = the RESOLVED event date (write-time temporal
 *             anchoring)
 * - profiles: `[mind-profile <name>]\n<card>` importance 'normal' —
 *             DELIBERATELY normal so cards stay out of the importance
 *             lane (benchmark design decision); prior card for the same
 *             person is replaced (profiles evolve, facts accumulate).
 *
 * createIFrame's content dedup makes fact/event writes idempotent across
 * re-runs. Every item is injection-scanned before write — extraction output
 * derives from possibly-tainted harvested content.
 */
export function writeMemoryLaneFrames(
  frames: FrameStore,
  gopId: string,
  extraction: MemoryLaneExtraction,
): WriteLaneFramesResult {
  const result: WriteLaneFramesResult = {
    factsWritten: 0, eventsWritten: 0, profilesWritten: 0, injectionDropped: 0,
  };

  const safe = (text: string): boolean => {
    const scan = scanForInjection(text, 'tool_output');
    if (!scan.safe) {
      result.injectionDropped++;
      log.warn('dropping extracted item with injection payload', { flags: scan.flags.join(',') });
      return false;
    }
    return true;
  };

  for (const f of extraction.facts) {
    if (!safe(f.text)) continue;
    frames.createIFrame(gopId, `${MIND_FACT_PREFIX}\n${f.text}`, 'normal', 'system');
    result.factsWritten++;
  }

  for (const e of extraction.events) {
    if (!safe(e.text)) continue;
    frames.createIFrame(
      gopId,
      `${MIND_EVENT_PREFIX}\n[${e.event_date}] ${e.text}`,
      'normal',
      'system',
      `${e.event_date}T00:00:00.000Z`,
    );
    result.eventsWritten++;
  }

  for (const p of extraction.profiles) {
    if (!safe(p.card)) continue;
    const header = `${MIND_PROFILE_PREFIX} ${p.speaker}]`;
    // Replace-on-update: a person's card supersedes the previous one.
    frames.deleteByContentPrefix(header);
    frames.createIFrame(gopId, `${header}\n${p.card}`, 'normal', 'system');
    result.profilesWritten++;
  }

  return result;
}
