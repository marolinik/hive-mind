import { createHash } from 'node:crypto';

/**
 * Canonical content hash used for frame dedup.
 *
 * Hashes `content.trim()` — JS `trim()` strips all Unicode whitespace, so
 * `'foo'` and `'  foo\n'` produce the same hash and dedup identically. This is
 * the SINGLE definition shared by insert, dedup lookup, update, compaction, and
 * the migration backfill so the trim semantics can never drift between them.
 */
export function hashFrameContent(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}
