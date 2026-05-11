/**
 * Semantic chunker for memory frames.
 *
 * Splits a frame's text content into coherent chunks suitable for embedding,
 * then mapping back to the parent frame at recall time.
 *
 * Strategy (paragraph-first, sentence-fallback):
 *   1. Split on blank lines to get paragraphs.
 *   2. Greedily aggregate paragraphs up to maxChars.
 *   3. If a single paragraph exceeds maxChars, sub-split it on sentence
 *      boundaries (., !, ?, newline within the paragraph), aggregate those
 *      up to maxChars.
 *   4. Optionally prepend an overlap window from the previous chunk's tail
 *      so that a sentence straddling a chunk boundary still appears in both.
 *
 * Why these knobs:
 *   - maxChars=2000 ≈ 500 tokens for dense English. Fits comfortably in
 *     nomic-embed-text's 2048-token default context with headroom for the
 *     model's special tokens.
 *   - overlapChars=200 ≈ 50 tokens. Cheap recall safety net for queries
 *     whose answer phrase straddles a chunk boundary; doubles as redundancy
 *     for embedder noise.
 *
 * Char positions returned are RELATIVE to the input text (start inclusive,
 * end exclusive — matching JS slice semantics). Useful for highlighting the
 * chunk inside its parent frame at recall time.
 *
 * Pure function: no I/O, no side effects, no embedder dependency.
 */

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  /**
   * Below this length, the input is returned as a single chunk regardless
   * of internal structure. Avoids fragmenting short frames into noisy
   * 1-sentence chunks that hurt search quality.
   */
  minChunkChars?: number;
}

export interface FrameChunk {
  text: string;
  charStart: number;
  charEnd: number;
}

const DEFAULTS = {
  maxChars: 2000,
  overlapChars: 200,
  minChunkChars: 1500,
};

/**
 * Split text into chunks. Returns at least one chunk for non-empty input.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): FrameChunk[] {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const overlapChars = Math.max(0, opts.overlapChars ?? DEFAULTS.overlapChars);
  const minChunkChars = opts.minChunkChars ?? DEFAULTS.minChunkChars;

  if (!text || text.length === 0) return [];
  if (text.length <= minChunkChars) {
    return [{ text, charStart: 0, charEnd: text.length }];
  }

  // Stage 1: split into paragraphs with their absolute char offsets.
  // Treat any run of \n followed by another newline as a separator.
  const paragraphs: Array<{ text: string; start: number; end: number }> = [];
  const paragraphRe = /\n\s*\n/g;
  let lastIdx = 0;
  for (const m of text.matchAll(paragraphRe)) {
    const matchStart = m.index ?? 0;
    const slice = text.slice(lastIdx, matchStart);
    if (slice.trim().length > 0) {
      paragraphs.push({ text: slice, start: lastIdx, end: matchStart });
    }
    lastIdx = matchStart + m[0].length;
  }
  if (lastIdx < text.length) {
    const slice = text.slice(lastIdx);
    if (slice.trim().length > 0) {
      paragraphs.push({ text: slice, start: lastIdx, end: text.length });
    }
  }

  // Pathological input with no paragraph breaks: treat the whole text as one
  // paragraph so the sentence-split path can still subdivide it.
  if (paragraphs.length === 0) {
    paragraphs.push({ text, start: 0, end: text.length });
  }

  // Stage 2: aggregate paragraphs into chunks. Sub-split any oversize paragraph.
  type Span = { text: string; start: number; end: number };
  const spans: Span[] = [];
  for (const p of paragraphs) {
    if (p.text.length <= maxChars) {
      spans.push({ text: p.text, start: p.start, end: p.end });
    } else {
      const sentences = splitSentencesWithOffsets(p.text, p.start);
      for (const s of sentences) {
        if (s.text.length <= maxChars) {
          spans.push(s);
        } else {
          for (let off = 0; off < s.text.length; off += maxChars) {
            const sub = s.text.slice(off, off + maxChars);
            spans.push({ text: sub, start: s.start + off, end: s.start + off + sub.length });
          }
        }
      }
    }
  }

  // Stage 3: greedy pack spans into chunks of <= maxChars, joining with '\n\n'
  // so the embedder sees coherent paragraph boundaries.
  const chunks: FrameChunk[] = [];
  let current: { parts: string[]; start: number; end: number; len: number } | null = null;
  const SEP = '\n\n';

  for (const span of spans) {
    const candidateLen = current ? current.len + SEP.length + span.text.length : span.text.length;
    if (current && candidateLen > maxChars) {
      chunks.push({
        text: current.parts.join(SEP),
        charStart: current.start,
        charEnd: current.end,
      });
      current = null;
    }
    if (!current) {
      current = { parts: [span.text], start: span.start, end: span.end, len: span.text.length };
    } else {
      current.parts.push(span.text);
      current.end = span.end;
      current.len = candidateLen;
    }
  }
  if (current) {
    chunks.push({
      text: current.parts.join(SEP),
      charStart: current.start,
      charEnd: current.end,
    });
  }

  // Stage 4: apply overlap by prepending the tail of the previous chunk.
  // We never touch char_start/char_end here — those still describe the
  // chunk's "primary" span in the source text. Overlap text is purely an
  // embedding-quality boost, not a position claim.
  if (overlapChars > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-overlapChars);
      chunks[i] = {
        ...chunks[i],
        text: prevTail + (prevTail.endsWith('\n') ? '' : '\n') + chunks[i].text,
      };
    }
  }

  return chunks;
}

/**
 * Sentence-split that preserves absolute char offsets relative to a base.
 * Conservative — when in doubt, splits, since an over-split is harmless
 * (more chunks) but an under-split bloats a chunk past maxChars and forces
 * the hard-cut path.
 */
function splitSentencesWithOffsets(
  text: string,
  baseOffset: number,
): Array<{ text: string; start: number; end: number }> {
  const results: Array<{ text: string; start: number; end: number }> = [];
  // Match sentence-end punctuation followed by whitespace or end-of-string.
  const re = /[.!?](?:\s+|$)/g;
  let lastEnd = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const cut = idx + m[0].length;
    const piece = text.slice(lastEnd, cut);
    if (piece.trim().length > 0) {
      results.push({ text: piece, start: baseOffset + lastEnd, end: baseOffset + cut });
    }
    lastEnd = cut;
  }
  if (lastEnd < text.length) {
    const piece = text.slice(lastEnd);
    if (piece.trim().length > 0) {
      results.push({ text: piece, start: baseOffset + lastEnd, end: baseOffset + text.length });
    }
  }
  return results.length > 0 ? results : [{ text, start: baseOffset, end: baseOffset + text.length }];
}
