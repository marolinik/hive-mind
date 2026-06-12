import { createHash } from 'node:crypto';

/**
 * content-hash.ts — canonical frame content hash for dedup.
 *
 * Forward-ported from waggle-os monorepo (mono-parity 2026-06-12): the hash
 * covers `stripHmPrefix(content).trim()`, NOT bare `content.trim()` —
 * provenance-insensitive dedup is load-bearing (two same-body captures of one
 * turn from different sources must collapse regardless of their `[hm …]`
 * metadata prefix, which is emitted by this repo's own hooks/shim packages).
 *
 * SINGLE definition shared by insert, dedup lookup, update, compaction, and
 * the migration backfill so trim/strip semantics can never drift between
 * call sites.
 *
 * MIGRATION NOTE: content_hash values written before this change were
 * computed trim-only. MindDB.runMigrations() performs a one-time rehash of
 * every row (guarded by the meta flag `content_hash_semantics` =
 * 'hm-stripped') so stored hashes always match this function.
 */

/**
 * Strip the leading hive-mind metadata prefix `[hm session:… src:… event:…] `
 * so dedup compares the semantic turn BODY, not the provenance. The prefix is
 * emitted by shim-core's `buildPrefix` (`[hm <tokens>] `); two captures of the
 * same turn from different sources differ only in that prefix. Content without
 * the prefix (harvest / ingest / cognify) is returned unchanged — a no-op.
 * The regex anchors on `[hm ` and stops at the first `]`, so a body that
 * merely contains `[` brackets later is never over-stripped.
 */
export function stripHmPrefix(content: string): string {
  return content.replace(/^\[hm [^\]]*\]\s*/, '');
}

/** Canonical content hash: sha256 over the stripped, trimmed body. */
export function hashFrameContent(content: string): string {
  return createHash('sha256').update(stripHmPrefix(content).trim()).digest('hex');
}
