/**
 * LLM prompts for wiki page compilation.
 */

export function entityPagePrompt(
  entityName: string,
  entityType: string,
  frames: { id: number; content: string; created_at: string }[],
  relations: { target: string; relationType: string; confidence: number }[],
): string {
  const frameList = frames
    .map(f => `[Frame #${f.id}, ${f.created_at}]: ${f.content}`)
    .join('\n\n');

  const relationList = relations.length > 0
    ? relations.map(r => `- ${r.target} (${r.relationType}, confidence: ${r.confidence})`).join('\n')
    : 'No relations found.';

  return `You are a wiki compiler. Synthesize the following memory frames about "${entityName}" (${entityType}) into a wiki page.

## Source Frames (${frames.length} total)
${frameList}

## Known Relations
${relationList}

## Instructions
1. Write a **Summary** section (2-3 sentences synthesizing all knowledge)
2. Write a **Key Facts** section with bullet points citing frame IDs (e.g., "from frame #42")
3. Write a **Timeline** section if temporal events are present (table: Date | Event | Source)
4. Write a **Relations** section listing connected entities with [[wiki links]]
5. Write an **Open Questions** section noting gaps or unresolved contradictions
6. If frames contradict each other, note it in a **Contradictions** section with confidence assessment

Be concise. Cite frame IDs for every claim. Use markdown formatting.
Output ONLY the page body (no frontmatter — that's added automatically).`;
}

export function conceptPagePrompt(
  conceptName: string,
  frames: { id: number; content: string; created_at: string }[],
  relatedEntities: string[],
): string {
  const frameList = frames
    .map(f => `[Frame #${f.id}, ${f.created_at}]: ${f.content}`)
    .join('\n\n');

  const entityList = relatedEntities.length > 0
    ? relatedEntities.map(e => `- [[${e}]]`).join('\n')
    : 'None identified.';

  return `You are a wiki compiler. Synthesize the following memory frames about the concept "${conceptName}" into a wiki page.

## Source Frames (${frames.length} total)
${frameList}

## Related Entities
${entityList}

## Instructions
1. Write a **TL;DR** (2 sentences max)
2. Write a **What We Know** section synthesizing all frames
3. Write a **Sources & Evolution** section showing how understanding evolved over time
4. Write a **Related Topics** section with [[wiki links]]
5. Note any gaps or areas needing more data

Be concise. Cite frame IDs. Use markdown formatting.
Output ONLY the page body (no frontmatter).`;
}

export function synthesisPagePrompt(
  topic: string,
  crossSourceFrames: { id: number; content: string; source: string; created_at: string }[],
): string {
  const frameList = crossSourceFrames
    .map(f => `[Frame #${f.id}, source: ${f.source}, ${f.created_at}]: ${f.content}`)
    .join('\n\n');

  return `You are a wiki compiler performing cross-source synthesis. Multiple independent sources discuss "${topic}". Find patterns, agreements, and contradictions.

## Frames from Multiple Sources (${crossSourceFrames.length} total)
${frameList}

## Instructions
1. Write a **Cross-Source Summary** — what do multiple sources agree on?
2. Write a **Patterns** section — recurring themes across sources
3. Write a **Contradictions** section — where sources disagree (with frame IDs)
4. Write an **Insights** section — what can we conclude that no single source stated?
5. Write a **Confidence Assessment** — how reliable is this synthesis?

This is the most valuable page type. Focus on insights that emerge from combining sources.
Be concise. Cite frame IDs. Use markdown formatting.
Output ONLY the page body (no frontmatter).`;
}
