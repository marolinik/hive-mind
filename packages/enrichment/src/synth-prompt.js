/**
 * Build the prompt sent to a synthesizer (Claude API or `claude -p` subprocess)
 * for a single queue task. Pure function, no I/O.
 *
 * Output is markdown so it can also be printed to stdout for manual paste.
 */
const PER_FRAME_BUDGET = 600;

function trimContent(content, budget = PER_FRAME_BUDGET) {
  const s = String(content || '');
  return s.length > budget ? s.slice(0, budget) + '…' : s;
}

export function buildSynthPrompt({ task, frames }) {
  const subject = task.subject || 'unknown';
  const kind = task.kind || 'session-summary';
  const ws = task.ws_id || 'personal';
  const safeFrames = Array.isArray(frames) ? frames : [];

  const head = [
    '# Wiki synthesis task',
    '',
    `- **Task ID:** ${task.id}`,
    `- **Kind:** ${kind}`,
    `- **Subject:** ${subject}`,
    `- **Workspace:** ${ws}`,
    `- **Source frames:** ${safeFrames.length}`,
  ].join('\n');

  const frameLines = safeFrames.map((f) => {
    const ts = String(f.created_at || '').slice(0, 19).replace('T', ' ');
    const imp = f.importance || 'normal';
    return `### Frame #${f.id} (${imp}, ${ts})\n${trimContent(f.content)}`;
  }).join('\n\n');

  const body = safeFrames.length === 0
    ? '_No source frames found. Reply with the single line: NO-CONTEXT._'
    : `## Source frames\n\n${frameLines}`;

  const ask = [
    '## Your task',
    '',
    'Produce a 1-2 paragraph synthesis (≤300 words) capturing the key facts,',
    'decisions, and open questions from the source frames above. Reference',
    'frames inline by #id when they support a specific claim.',
    '',
    'Format your response as markdown. No preamble, sign-off, or meta-commentary —',
    'just the synthesis.',
    '',
    `Begin your response with: # Synthesis: ${subject}`,
  ].join('\n');

  return `${head}\n\n${body}\n\n${ask}\n`;
}
