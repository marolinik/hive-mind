/**
 * Harvest pipeline prompts — LLM prompt templates for each distillation pass.
 *
 * Three-pass pipeline:
 *   1. CLASSIFY_PROMPT — triage each input item into {skip, low, medium, high}
 *      value and {work, personal, technical, mixed} domain.
 *   2. EXTRACT_PROMPT — structured extraction of decisions / preferences /
 *      facts / knowledge / entities / relations from high-value items.
 *   3. SYNTHESIZE_PROMPT — convert extractions into memory frames
 *      (identity / frame / kg_entity / kg_relation) with importance tiers.
 *
 * Example org/person names in each prompt are illustrative only.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/prompts.ts`.
 * Scrub: genericized Waggle-specific example values ("Egzakta Group",
 * "Marko") in EXTRACT_PROMPT to neutral placeholders ("Acme Corp", "Alice")
 * so downstream OSS consumers don't encounter project-specific illustrative
 * data.
 */

export const CLASSIFY_PROMPT = `You are a knowledge classifier. For each conversation/item below, classify it.

Return a JSON array with one entry per item:
[{
  "itemId": "...",
  "domain": "work" | "personal" | "technical" | "mixed",
  "value": "high" | "medium" | "low" | "skip",
  "categories": ["decision", "preference", "fact", "knowledge", "project", "identity", "trivial"]
}]

Rules:
- "skip" = greetings, trivial exchanges, "hello", "thanks", debugging loops with no insight
- "high" = decisions, preferences, personal facts, project context, technical architecture
- "medium" = general knowledge, research, learning
- "low" = routine questions with generic answers

Items:
`;

export const EXTRACT_PROMPT = `You are a knowledge extractor. For each classified conversation, extract structured knowledge.

Return a JSON array:
[{
  "itemId": "...",
  "decisions": ["chose X over Y because Z"],
  "preferences": ["prefers dark mode", "likes concise responses"],
  "facts": ["works at Acme Corp", "role is CEO"],
  "knowledge": ["React 18 concurrent features improve perceived performance"],
  "entities": [{"name": "Acme Corp", "type": "organization"}],
  "relations": [{"source": "Alice", "target": "Acme Corp", "relation": "works_at"}]
}]

Rules:
- Only extract what the USER stated or decided, not what the AI suggested
- Decisions must include the reason if one was given
- Preferences must be actionable (not "I like good code" — too vague)
- Facts must be verifiable or specific (names, roles, companies, tech stack)
- Entities: types are person, organization, project, technology, concept, location, event
- Relations: use lowercase_snake_case for relation types

Conversations:
`;

export const SYNTHESIZE_PROMPT = `You are a memory synthesizer. Convert extracted knowledge into structured memory frames.

For each extraction, produce frames suitable for a persistent memory system:

Return a JSON array:
[{
  "targetLayer": "identity" | "frame" | "kg_entity" | "kg_relation",
  "frameType": "I",
  "importance": "critical" | "important" | "normal",
  "content": "The actual memory content, written as a clear statement",
  "confidence": 0.0-1.0
}]

Rules:
- "identity" = personal facts (name, role, company, capabilities, personality traits)
- "frame" with importance "important" = decisions and preferences
- "frame" with importance "normal" = general knowledge and facts
- "kg_entity" = entities to add to the knowledge graph
- "kg_relation" = relationships between entities
- Content should be self-contained — readable without the original conversation
- Deduplicate: if two items say the same thing, pick the most complete version
- confidence: 1.0 = user explicitly stated, 0.7 = strongly implied, 0.5 = inferred

Extractions:
`;
