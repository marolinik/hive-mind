/**
 * Shared text chunking utility for harvest adapters.
 *
 * Splits text into chunks by paragraph boundaries (double-newline),
 * respecting a configurable maximum character length per chunk. When a
 * chunk would exceed the max by absorbing the next paragraph, the current
 * chunk is flushed and the paragraph starts a new chunk.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/chunk-utils.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

const DEFAULT_MAX_LENGTH = 2000;

export function chunkByParagraphs(text: string, maxLen: number = DEFAULT_MAX_LENGTH): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (current.length + trimmed.length + 2 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}
