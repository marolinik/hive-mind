/**
 * erasure.ts — GDPR Art.17 frame + index + KG erasure companion (2026-07-01).
 *
 * The #7 raw_archive erasure (RawArchive.erase / eraseByFrame) redacts ONLY the
 * verbatim provenance rows. This module completes a data-subject erasure by also
 * purging the DERIVED retrieval corpus that quotes the source PII:
 *   - memory_frames + memory_frames_fts + memory_frames_vec
 *   - memory_frame_chunks + memory_frame_chunks_vec (via FrameStore.delete)
 *   - orphaned knowledge_entities + knowledge_relations (name/props may hold PII)
 * while KEEPING the raw_archive identity skeleton as the audit record that an
 * item existed and was erased. See docs/plans/2026-07-01-art17-frame-index-kg-
 * erasure-companion.md for the full surface + decisions.
 *
 * Every multi-table erasure runs in ONE better-sqlite3 transaction — a partial
 * erasure is a compliance failure (all-or-nothing).
 *
 * archive_uid = sha256(source∥sourceRef∥content) is ROTATED to an opaque id on erase
 * (raw-archive.ts erase()), so the retained audit skeleton carries no content-derived
 * value — the low-entropy re-identification residual is closed. (source_ref, preserved
 * verbatim, is the one remaining retained-skeleton residual and MAY carry PII.)
 */

import type { MindDB } from './db.js';
import { FrameStore } from './frames.js';
import { RawArchive, readArchiveUids } from './raw-archive.js';
import { MIND_RAWTURN_PREFIX, rawTurnConvKey } from '../harvest/raw-turns.js';

export interface EraseResult {
  /** Derived frames physically deleted (frame + FTS + vec + chunks + chunk-vec). */
  framesDeleted: number;
  /** raw_archive provenance rows redacted (content → marker; skeleton frozen). */
  archiveRedacted: number;
  /** memory_frame_chunks_vec rows purged for the erased frame(s). */
  chunkVectorsPurged: number;
  /** Orphaned knowledge_entities hard-deleted (zero surviving frame links). */
  entitiesErased: number;
  /** knowledge_relations of those orphaned entities removed. */
  relationsErased: number;
}

function zeroResult(): EraseResult {
  return { framesDeleted: 0, archiveRedacted: 0, chunkVectorsPurged: 0, entitiesErased: 0, relationsErased: 0 };
}

export class MindErasure {
  private db: MindDB;
  private frames: FrameStore;
  private archive: RawArchive;

  constructor(db: MindDB) {
    this.db = db;
    this.frames = new FrameStore(db);
    this.archive = new RawArchive(db);
  }

  /**
   * Erase ONE derived frame under GDPR Art.17: redact its provenance rows, delete
   * the frame from every retrieval store, then hard-delete any KG entity that was
   * derived solely from this frame (zero surviving links) along with its relations.
   * Atomic. Returns all-zero for an unknown frame id (no throw).
   *
   * SCOPE — a single frame. For a full data-subject erasure use eraseBySourceRef,
   * which also sweeps the conversation's verbatim raw-turn frames + referencing
   * B-frames that this frame-scoped primitive intentionally does NOT touch.
   */
  eraseFrame(frameId: number, reason: string): EraseResult {
    return this.db.getDatabase().transaction((): EraseResult => this.eraseFrameInternal(frameId, reason))();
  }

  /**
   * Art.17-COMPLETE erase of ONE frame the user pointed at. Unlike eraseFrame
   * (single frame), this reaches the WHOLE subject footprint behind a harvested
   * summary — the verbatim [mind-rawturn] dialogue + referencing B-frames + KG —
   * which a frame-only delete would leave recall-able. It resolves the frame's
   * provenance subjects (the archive link; else a metadata.sourceId + content
   * platform-prefix fallback for a legacy / append-failed frame with no link),
   * sweeps each via eraseBySourceRef, then erases the frame itself. Atomic
   * (better-sqlite3 nests the inner erasures as savepoints). All-zero for an
   * unknown frame. This is the single primitive both the /api/memory/erase route
   * and the erase_memory MCP tool call, so the two entry points cannot drift.
   */
  eraseFrameComplete(frameId: number, reason: string): EraseResult {
    return this.db.getDatabase().transaction((): EraseResult => {
      const total = zeroResult();
      const add = (r: EraseResult): void => {
        total.framesDeleted += r.framesDeleted;
        total.archiveRedacted += r.archiveRedacted;
        total.chunkVectorsPurged += r.chunkVectorsPurged;
        total.entitiesErased += r.entitiesErased;
        total.relationsErased += r.relationsErased;
      };
      const frame = this.frames.getById(frameId);
      if (!frame) return total;

      // Dedup subjects with a JSON-array key (collision-proof: distinct
      // (source, sourceRef) pairs never serialize equal).
      const seen = new Set<string>();
      const sweep = (source: string, sourceRef: string): void => {
        const key = JSON.stringify([source, sourceRef]);
        if (seen.has(key)) return;
        seen.add(key);
        add(this.eraseBySourceRef(source, sourceRef, reason));
      };
      // Primary: subjects linked via the frame's archive provenance.
      for (const row of this.archive.reconstructSource(frameId)) {
        if (row.source_ref) sweep(row.source, row.source_ref);
      }
      // Fallback: a harvested summary with NO archive link (legacy pre-#7 frame,
      // or a raw_archive.append that failed while the raw-turns still wrote).
      // Recover the subject from metadata.sourceId + the platform token in the
      // content prefix ('[Harvest:<src>] ...' server harvest / '[<src>] ...' MCP
      // harvest) so eraseBySourceRef reaches the raw-turns. A wrong guess on a
      // non-harvest frame matches nothing (a no-op sweep).
      if (seen.size === 0) {
        let sourceRef: string | undefined;
        try {
          const meta = JSON.parse(frame.metadata ?? '{}') as Record<string, unknown>;
          if (meta && typeof meta.sourceId === 'string') sourceRef = meta.sourceId;
        } catch { /* malformed metadata — no fallback subject */ }
        const src = frame.content?.match(/^\[(?:Harvest:)?([^\]]+)\]/)?.[1];
        if (src && sourceRef) sweep(src, sourceRef);
      }
      const frameRes = this.eraseFrame(frameId, reason);   // idempotent if already swept
      add(frameRes);
      // A subject-less frame (connector / ingest_source single frame) resolved no
      // subject above, so the eraseBySourceRef B-frame sweep never ran for it.
      // Strip any B-frame that references it directly so synthesized PII cannot
      // survive. (For a subject frame this is a no-op — step 4 already swept them.)
      if (frameRes.framesDeleted > 0) add(this.sweepReferencingBFrames(new Set([frameId]), reason));
      return total;
    })();
  }

  /** Non-transactional core — call inside an ambient transaction only. */
  private eraseFrameInternal(frameId: number, reason: string): EraseResult {
    const raw = this.db.getDatabase();
    if (!this.frames.getById(frameId)) return zeroResult();

    // Capture the entities linked to this frame BEFORE the delete cascades the
    // kg_entity_frames bridge away (else we can't tell which became orphans).
    const linkedEntityIds = (raw
      .prepare('SELECT entity_id FROM kg_entity_frames WHERE frame_id = ?')
      .all(frameId) as Array<{ entity_id: number }>).map(r => r.entity_id);

    // Count chunk vectors that FrameStore.delete will purge (for the report).
    const chunkVectorsPurged = (raw
      .prepare('SELECT COUNT(*) c FROM memory_frame_chunks WHERE frame_id = ?')
      .get(frameId) as { c: number }).c;

    // 1. Redact the provenance rows this frame links to (audit skeleton kept).
    const archiveRedacted = this.archive.eraseByFrame(frameId, reason);

    // 2. Delete the frame + FTS + vec + chunks + chunk-vec + kg bridge.
    const framesDeleted = this.frames.delete(frameId) ? 1 : 0;

    // 3. Orphan sweep: a previously-linked entity now at zero frame links was
    //    derived solely from erased content → hard-delete it + its relations.
    //    knowledge_relations references knowledge_entities WITHOUT ON DELETE
    //    CASCADE (FK enforcement is ON), so relations MUST go first or the entity
    //    delete raises SQLITE_CONSTRAINT.
    let entitiesErased = 0;
    let relationsErased = 0;
    for (const eid of linkedEntityIds) {
      const remaining = (raw
        .prepare('SELECT COUNT(*) c FROM kg_entity_frames WHERE entity_id = ?')
        .get(eid) as { c: number }).c;
      if (remaining > 0) continue;   // still referenced by a surviving frame — shared, keep
      relationsErased += raw
        .prepare('DELETE FROM knowledge_relations WHERE source_id = ? OR target_id = ?')
        .run(eid, eid).changes;
      entitiesErased += raw
        .prepare('DELETE FROM knowledge_entities WHERE id = ?')
        .run(eid).changes;
    }

    return { framesDeleted, archiveRedacted, chunkVectorsPurged, entitiesErased, relationsErased };
  }

  /**
   * Fixpoint sweep of every B-frame that (transitively) references an already-
   * erased frame. A synthesized B-frame stores {references:[…]} in its content
   * JSON and carries no archiveUids, so the summary/raw-turn sweeps cannot reach
   * it. Shared by the subject sweep (eraseBySourceRef step 4) and the single-frame
   * erase (eraseFrameComplete) — the latter for SUBJECT-LESS frames (connector /
   * ingest_source single frames) that resolve no subject and so would otherwise
   * leave a referencing B-frame (which can quote the erased PII) behind. Fixpoint:
   * a B-frame may reference another B-frame; erased ones vanish from the next query
   * so it terminates. Mutates `erasedIds` with the swept B-frame ids.
   * Non-transactional — call inside an ambient transaction only.
   */
  private sweepReferencingBFrames(erasedIds: Set<number>, reason: string): EraseResult {
    const raw = this.db.getDatabase();
    const total = zeroResult();
    const add = (r: EraseResult): void => {
      total.framesDeleted += r.framesDeleted;
      total.archiveRedacted += r.archiveRedacted;
      total.chunkVectorsPurged += r.chunkVectorsPurged;
      total.entitiesErased += r.entitiesErased;
      total.relationsErased += r.relationsErased;
    };
    let grew = true;
    while (grew) {
      grew = false;
      const bframes = raw
        .prepare("SELECT id, content FROM memory_frames WHERE frame_type = 'B'")
        .all() as Array<{ id: number; content: string }>;
      for (const bf of bframes) {
        if (erasedIds.has(bf.id)) continue;
        let refs: unknown;
        try { refs = (JSON.parse(bf.content) as { references?: unknown }).references; } catch { continue; }
        if (!Array.isArray(refs)) continue;
        if (refs.some((id) => typeof id === 'number' && erasedIds.has(id))) {
          const r = this.eraseFrameInternal(bf.id, reason);
          if (r.framesDeleted > 0) { erasedIds.add(bf.id); grew = true; add(r); }
        }
      }
    }
    return total;
  }

  /**
   * Subject-level sweep: erase everything derived from a (source, source_ref)
   * subject. It reaches the subject's derived corpus through THREE keys, because
   * one harvested item fans out into frames that are keyed differently:
   *   (a) the distilled SUMMARY frame — linked via metadata.archiveUids;
   *   (b) the verbatim per-turn [mind-rawturn …] frames — keyed by the conversation
   *       content prefix (= sanitize(source∥sourceRef)); they carry NO archive link,
   *       so a link-only sweep would leave the subject's full dialogue recall-able;
   *   (c) synthesized B-frames that reference any erased frame in their content JSON.
   * Then it redacts any subject provenance row no frame reached (orphan provenance).
   * Atomic over the whole sweep.
   *
   * A frame that also links OTHER source_refs is still deleted wholesale (a merged
   * summary containing the subject's PII cannot be partially redacted) — its other
   * provenance rows are redacted too, which is the conservative Art.17 outcome.
   */
  eraseBySourceRef(source: string, sourceRef: string, reason: string): EraseResult {
    return this.db.getDatabase().transaction((): EraseResult => {
      const raw = this.db.getDatabase();
      const total = zeroResult();
      const add = (r: EraseResult): void => {
        total.framesDeleted += r.framesDeleted;
        total.archiveRedacted += r.archiveRedacted;
        total.chunkVectorsPurged += r.chunkVectorsPurged;
        total.entitiesErased += r.entitiesErased;
        total.relationsErased += r.relationsErased;
      };

      // 1. Every archive uid for this subject.
      const uids = (raw
        .prepare('SELECT archive_uid FROM raw_archive WHERE source = ? AND source_ref = ?')
        .all(source, sourceRef) as Array<{ archive_uid: string }>).map(r => r.archive_uid);
      // NB: do NOT early-return on an empty uid set. A subject can have verbatim
      // [mind-rawturn] frames (2b) + referencing B-frames (4) with NO raw_archive
      // row — a legacy pre-#7 conversation, or one whose raw_archive.append failed
      // while the raw-turns still wrote. Bailing here left that raw PII dialogue
      // recall-able (the reference-class leak). Steps 2b/4 key off the conv-prefix
      // and content references, independent of raw_archive, so they must still run;
      // 2a and step 5 iterate `uids`, so they are natural no-ops when it is empty.
      const uidSet = new Set(uids);

      const frameIds = new Set<number>();

      // 2a. SUMMARY frames linking any subject uid (reverse lookup). LIKE-prefilter
      //     the metadata JSON, then verify precisely via readArchiveUids (tolerates
      //     the legacy scalar archiveUid + malformed metadata).
      const likeStmt = raw.prepare('SELECT id, metadata FROM memory_frames WHERE metadata LIKE ?');
      for (const uid of uids) {
        for (const row of likeStmt.all(`%${uid}%`) as Array<{ id: number; metadata?: string }>) {
          if (!row.metadata) continue;
          let meta: Record<string, unknown>;
          try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { continue; }
          if (!meta || typeof meta !== 'object') continue;
          if (readArchiveUids(meta).some(u => uidSet.has(u))) frameIds.add(row.id);
        }
      }

      // 2b. Verbatim raw-turn frames for this conversation, keyed by content prefix.
      //     The trailing space after the conv key makes the match EXACT (so a sweep
      //     of 'item' never catches 'item-9'). Escape LIKE metacharacters (the key
      //     is sanitized to [A-Za-z0-9_-] but escape defensively).
      const convKey = rawTurnConvKey({ source, id: sourceRef });
      const prefix = `${MIND_RAWTURN_PREFIX} conv:${convKey} `.replace(/[\\%_]/g, ch => `\\${ch}`);
      for (const row of raw
        .prepare("SELECT id FROM memory_frames WHERE content LIKE ? ESCAPE '\\'")
        .all(`${prefix}%`) as Array<{ id: number }>) {
        frameIds.add(row.id);
      }

      // 2c. Archive-less SUMMARY frames for this subject. 2a is archiveUid-keyed,
      //     so a harvested summary whose raw_archive.append failed (or a legacy
      //     pre-#7 frame) — carrying metadata.sourceId but NO archiveUids — slips
      //     through, leaving the distilled PII recall-able after a subject-level
      //     DSAR. Recover it symmetric to eraseFrameComplete's fallback: match
      //     metadata.sourceId === source_ref AND the content platform-prefix
      //     ('[Harvest:<src>] …' server / '[<src>] …' MCP) === source. The LIKE is
      //     a prefilter only; the two EXACT code checks are the subject identity,
      //     so 'item' never over-erases 'item-9' and a sibling subject is safe.
      //     Escape LIKE metacharacters in source_ref (mirroring 2b) to keep the
      //     prefilter narrow — the exact meta.sourceId check backstops either way.
      const srLike = sourceRef.replace(/[\\%_]/g, ch => `\\${ch}`);
      const metaLike = raw.prepare("SELECT id, content, metadata FROM memory_frames WHERE metadata LIKE ? ESCAPE '\\'");
      for (const row of metaLike.all(`%${srLike}%`) as Array<{ id: number; content?: string; metadata?: string }>) {
        if (!row.metadata) continue;
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { continue; }
        if (!meta || typeof meta !== 'object' || meta.sourceId !== sourceRef) continue;
        const tok = row.content?.match(/^\[(?:Harvest:)?([^\]]+)\]/)?.[1];
        if (tok === source) frameIds.add(row.id);
      }

      // 3. Erase the direct frame set; track what was actually deleted for the
      //    B-frame reference sweep below.
      const erasedIds = new Set<number>();
      for (const fid of frameIds) {
        const r = this.eraseFrameInternal(fid, reason);
        if (r.framesDeleted > 0) erasedIds.add(fid);
        add(r);
      }

      // 4. B-frame reference sweep — a synthesized B-frame references erased
      //    frames in its content JSON and carries no archiveUids, so 2a/2b cannot
      //    reach it. Shared with the single-frame path (see sweepReferencingBFrames).
      add(this.sweepReferencingBFrames(erasedIds, reason));

      // 5. Redact any subject archive row not reached via a frame (orphan
      //    provenance). Already-redacted rows are idempotent no-ops (return false),
      //    so this never double-counts rows handled in step 3.
      for (const uid of uids) {
        if (this.archive.erase(uid, reason)) total.archiveRedacted += 1;
      }

      return total;
    })();
  }
}
