import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MindDB } from './db.js';
import { FrameStore } from './frames.js';
import { RawArchive, RAW_ARCHIVE_REDACTION_MARKER } from './raw-archive.js';
import { KnowledgeGraph } from './knowledge.js';
import { SessionStore } from './sessions.js';
import { MindErasure, type EraseResult } from './erasure.js';
import { SuppressionStore } from './suppression.js';
import { rawTurnHeader, rawTurnConvKey } from '../harvest/raw-turns.js';
import { decisionOfSubjectId } from '../harvest/decision-derivation.js';

// ── Test helpers ───────────────────────────────────────────────────────────
const DIM = 1024;
/** A syntactically-valid vec0 float[1024] blob — content irrelevant, we only
 *  ever assert on presence/absence, never on similarity. No embedder needed. */
function fakeVecBlob(): Uint8Array {
  return new Uint8Array(new Float32Array(DIM).fill(0.1).buffer);
}

function cnt(db: MindDB, sql: string, ...params: unknown[]): number {
  return (db.getDatabase().prepare(sql).get(...params) as { c: number }).c;
}

/** Simulate a chunk-indexed frame WITHOUT an embedder: insert a chunk row +
 *  its chunk-vec row (rowid = chunk id, exactly as HybridSearch does). */
function addChunk(db: MindDB, frameId: number, idx: number, text: string): number {
  const raw = db.getDatabase();
  const res = raw.prepare(
    'INSERT INTO memory_frame_chunks (frame_id, chunk_idx, content, char_start, char_end) VALUES (?,?,?,?,?)'
  ).run(frameId, idx, text, 0, text.length);
  const chunkId = Number(res.lastInsertRowid);
  raw.prepare(`INSERT INTO memory_frame_chunks_vec (rowid, embedding) VALUES (${chunkId}, ?)`).run(fakeVecBlob());
  return chunkId;
}

/** Insert a whole-frame vector row (rowid = frame id, as HybridSearch does). */
function addFrameVec(db: MindDB, frameId: number): void {
  db.getDatabase().prepare(`INSERT INTO memory_frames_vec (rowid, embedding) VALUES (${frameId}, ?)`).run(fakeVecBlob());
}

const ZERO: EraseResult = {
  framesDeleted: 0, archiveRedacted: 0, chunkVectorsPurged: 0, entitiesErased: 0, relationsErased: 0,
};

// ── FrameStore.delete() chunk-vec leak fix ──────────────────────────────────
describe('FrameStore.delete — chunk-vec leak fix', () => {
  let db: MindDB;
  let frames: FrameStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('g', 'g', 'test');
    frames = new FrameStore(db);
  });
  afterEach(() => db.close());

  it('purges memory_frame_chunks_vec rows for the frame (the vec0 leak)', () => {
    const f = frames.createIFrame('g', 'frame body', 'normal', 'import');
    const chunkId = addChunk(db, f.id, 0, 'chunk body');
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks_vec WHERE rowid = ?', chunkId)).toBe(1);

    expect(frames.delete(f.id)).toBe(true);

    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks_vec WHERE rowid = ?', chunkId)).toBe(0);   // vec purged
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks WHERE frame_id = ?', f.id)).toBe(0);       // rows cascaded
  });
});

// ── MindErasure.eraseFrame ──────────────────────────────────────────────────
describe('MindErasure.eraseFrame', () => {
  let db: MindDB;
  let frames: FrameStore;
  let archive: RawArchive;
  let kg: KnowledgeGraph;
  let erasure: MindErasure;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('harvest', 'harvest', 'test');
    frames = new FrameStore(db);
    archive = new RawArchive(db);
    kg = new KnowledgeGraph(db);
    erasure = new MindErasure(db);
  });
  afterEach(() => db.close());

  it('deletes the frame from every retrieval store and redacts its provenance', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'c1', content: 'SENSITIVE PII' });
    const archiveId = archive.getByUid(r.archiveUid)!.id;   // frozen handle (uid rotates on erase)
    const f = frames.createIFrame('harvest', 'summary quoting PII', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [r.archiveUid] }));
    addFrameVec(db, f.id);
    const chunkId = addChunk(db, f.id, 0, 'chunk quoting PII');

    const res = erasure.eraseFrame(f.id, 'dsar#1');

    expect(res.framesDeleted).toBe(1);
    expect(res.archiveRedacted).toBe(1);
    expect(res.chunkVectorsPurged).toBe(1);

    // Frame gone from EVERY recall path:
    expect(frames.getById(f.id)).toBeUndefined();
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_fts WHERE rowid = ?', f.id)).toBe(0);
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_vec WHERE rowid = ?', f.id)).toBe(0);
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks WHERE frame_id = ?', f.id)).toBe(0);
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks_vec WHERE rowid = ?', chunkId)).toBe(0);

    // Provenance skeleton kept but content redacted (the audit record survives);
    // the uid rotated on erase, so resolve by the frozen id.
    const row = archive.getById(archiveId)!;
    expect(row.content).toBe(RAW_ARCHIVE_REDACTION_MARKER);
    expect(row.erased_at).not.toBeNull();
    expect(row.source_ref).toBe('c1');   // skeleton frozen
  });

  it('hard-deletes an orphaned entity + its relations but preserves a shared entity', () => {
    const f1 = frames.createIFrame('harvest', 'frame one', 'normal', 'import');
    const f2 = frames.createIFrame('harvest', 'frame two', 'normal', 'import');
    const entA = kg.createEntity('person', 'Alice Orphan', {});   // linked ONLY to f1
    const entB = kg.createEntity('person', 'Bob Shared', {});     // linked to f1 AND f2
    kg.linkEntityToFrame(entA.id, f1.id);
    kg.linkEntityToFrame(entB.id, f1.id);
    kg.linkEntityToFrame(entB.id, f2.id);
    kg.createRelation(entA.id, entB.id, 'knows');                 // A -> B

    const res = erasure.eraseFrame(f1.id, 'dsar');

    expect(res.entitiesErased).toBe(1);                           // only the orphan A
    expect(res.relationsErased).toBe(1);                          // the A->B relation
    expect(kg.getEntity(entA.id)).toBeUndefined();               // A physically gone
    expect(kg.getEntity(entB.id)).toBeDefined();                 // B survives (shared)
    expect(cnt(db, 'SELECT COUNT(*) c FROM kg_entity_frames WHERE entity_id = ?', entB.id)).toBe(1); // still linked to f2
    expect(cnt(db, 'SELECT COUNT(*) c FROM knowledge_relations WHERE source_id = ? OR target_id = ?', entA.id, entA.id)).toBe(0);
  });

  it('returns an all-zero result for an unknown frame id (no throw)', () => {
    expect(erasure.eraseFrame(999_999, 'x')).toEqual(ZERO);
  });

  // #7 review HIGH: harvest created entities with NO frame link, so the orphan
  // sweep could never reach them. importEntitiesForFrame anchors them so erasure
  // (and any provenance op) can. This test pins the write-path→erasure chain.
  it('reaches entities imported via importEntitiesForFrame (harvest write-path linkage)', () => {
    const f = frames.createIFrame('harvest', 'note about Jane Doe', 'normal', 'import');
    const n = kg.importEntitiesForFrame(
      f.id,
      [{ name: 'Jane Doe', type: 'person' }],
      { source: 'claude', importedFrom: 'note.md' },
    );
    expect(n).toBe(1);
    const ent = kg.findEntityByName('Jane Doe')!;
    expect(ent).toBeDefined();
    // The entity is LINKED to its frame (the fix — was unlinked before):
    expect(cnt(db, 'SELECT COUNT(*) c FROM kg_entity_frames WHERE entity_id = ? AND frame_id = ?', ent.id, f.id)).toBe(1);

    const res = erasure.eraseFrame(f.id, 'dsar');
    expect(res.entitiesErased).toBe(1);                        // erasure now reaches it
    expect(kg.findEntityByName('Jane Doe')).toBeUndefined();   // name PII physically gone
  });
});

// ── MindErasure.eraseBySourceRef (subject-level sweep) ───────────────────────
describe('MindErasure.eraseBySourceRef', () => {
  let db: MindDB;
  let frames: FrameStore;
  let archive: RawArchive;
  let erasure: MindErasure;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('harvest', 'harvest', 'test');
    frames = new FrameStore(db);
    archive = new RawArchive(db);
    erasure = new MindErasure(db);
  });
  afterEach(() => db.close());

  it('sweeps every frame + archive row for a (source, source_ref) subject', () => {
    // Two archive rows, SAME (source, source_ref), different content → two uids.
    const a = archive.append({ source: 'claude', sourceRef: 'thread-42', content: 'msg one about the subject' });
    const b = archive.append({ source: 'claude', sourceRef: 'thread-42', content: 'msg two about the subject' });
    const aId = archive.getByUid(a.archiveUid)!.id;   // frozen handles (uids rotate on erase)
    const bId = archive.getByUid(b.archiveUid)!.id;
    const f = frames.createIFrame('harvest', 'thread-42 summary', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [a.archiveUid, b.archiveUid] }));

    const res = erasure.eraseBySourceRef('claude', 'thread-42', 'dsar#7');

    expect(res.framesDeleted).toBe(1);
    expect(res.archiveRedacted).toBe(2);
    expect(frames.getById(f.id)).toBeUndefined();
    expect(archive.getById(aId)!.content).toBe(RAW_ARCHIVE_REDACTION_MARKER);
    expect(archive.getById(bId)!.content).toBe(RAW_ARCHIVE_REDACTION_MARKER);
  });

  it('redacts an orphan archive row with no linking frame in the subject set', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'lonely', content: 'orphan pii' });
    const rId = archive.getByUid(r.archiveUid)!.id;   // frozen handle (uid rotates on erase)

    const res = erasure.eraseBySourceRef('claude', 'lonely', 'dsar');

    expect(res.framesDeleted).toBe(0);
    expect(res.archiveRedacted).toBe(1);
    expect(archive.getById(rId)!.content).toBe(RAW_ARCHIVE_REDACTION_MARKER);
  });

  it('is a no-op (all-zero) when no archive rows match the subject', () => {
    expect(erasure.eraseBySourceRef('claude', 'no-such-ref', 'x')).toEqual(ZERO);
  });

  // Reference-class leak (recovered in the erase-surface review): a subject can
  // have verbatim [mind-rawturn] frames with NO raw_archive row at all — a
  // raw_archive.append that failed while the raw-turns still wrote, or a legacy
  // pre-#7 conversation. eraseBySourceRef must NOT early-return on the empty uid
  // set; the 2b sweep is conv-prefix-keyed, independent of raw_archive.
  it('sweeps verbatim raw-turns for a subject with NO raw_archive row (append-failed / legacy)', () => {
    const convKey = rawTurnConvKey({ source: 'gemini', id: 'no-archive' });
    const t1 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 0, 'user')}\nverbatim PII`, 'normal', 'import');
    const t2 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 1, 'assistant')}\nmore PII`, 'normal', 'import');
    expect(cnt(db, 'SELECT COUNT(*) c FROM raw_archive WHERE source = ? AND source_ref = ?', 'gemini', 'no-archive')).toBe(0);

    const res = erasure.eraseBySourceRef('gemini', 'no-archive', 'dsar');

    expect(frames.getById(t1.id)).toBeUndefined();
    expect(frames.getById(t2.id)).toBeUndefined();
    expect(res.framesDeleted).toBe(2);
    expect(res.archiveRedacted).toBe(0);   // no provenance rows to redact
  });

  // #7 P1 (S4 residual): subject-mode must ALSO erase the distilled SUMMARY frame
  // when it has NO archive link (raw_archive.append failed / legacy pre-#7). 2a is
  // archiveUid-keyed so it misses it; recover symmetric to eraseFrameComplete's
  // fallback via metadata.sourceId (= sourceRef) + the content platform-prefix.
  // Frame-mode already handled this; subject-mode (route {source,sourceRef} + MCP
  // source+source_ref) left the summary recall-able — an Art.17 completeness hole.
  it('erases an archive-less summary frame for the subject (metadata.sourceId + prefix fallback)', () => {
    // Harvest summary with NO archiveUids — exactly what harvest.ts writes when
    // rawArchive.append throws: content platform-prefix + metadata.sourceId.
    const f = frames.createIFrame('harvest', '[Harvest:gemini] Trip planning\n\nsummary quoting PII', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ sourceId: 'g-trip', status: 'unreviewed' }));
    // Its verbatim raw-turns (swept by 2b — pinned so we don't regress them).
    const convKey = rawTurnConvKey({ source: 'gemini', id: 'g-trip' });
    const t1 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 0, 'user')}\nverbatim PII`, 'normal', 'import');
    // A DIFFERENT subject's summary (same source) MUST survive.
    const other = frames.createIFrame('harvest', '[Harvest:gemini] Other trip\n\nkeep me', 'normal', 'import');
    frames.setMetadata(other.id, JSON.stringify({ sourceId: 'g-other' }));
    expect(cnt(db, 'SELECT COUNT(*) c FROM raw_archive WHERE source = ? AND source_ref = ?', 'gemini', 'g-trip')).toBe(0);

    const res = erasure.eraseBySourceRef('gemini', 'g-trip', 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();     // archive-less summary erased (the fix)
    expect(frames.getById(t1.id)).toBeUndefined();    // raw-turn still swept
    expect(frames.getById(other.id)).toBeDefined();   // other subject untouched
    expect(res.framesDeleted).toBe(2);                // summary + raw-turn
  });

  // #7 review CRITICAL: verbatim [mind-rawturn …] frames carry NO archiveUids, so a
  // link-only sweep leaves the subject's full dialogue recall-able. They must be
  // swept by their content-prefix conversation key (= sanitize(source∥sourceRef)).
  it('purges the conversation raw-turn frames (content-prefix keyed, no archive link)', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'item-9', content: 'summary source' });
    const f = frames.createIFrame('harvest', 'summary of item-9', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [r.archiveUid] }));
    const convKey = rawTurnConvKey({ source: 'claude', id: 'item-9' });
    const t1 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 0, 'user')}\nverbatim PII turn one`, 'normal', 'import');
    const t2 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 1, 'assistant')}\nverbatim PII turn two`, 'normal', 'import');
    // A DIFFERENT subject's raw-turn (same source) MUST survive.
    const otherKey = rawTurnConvKey({ source: 'claude', id: 'other-item' });
    const o = frames.createIFrame('harvest', `${rawTurnHeader(otherKey, 0, 'user')}\nunrelated dialogue`, 'normal', 'import');

    const res = erasure.eraseBySourceRef('claude', 'item-9', 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();    // summary
    expect(frames.getById(t1.id)).toBeUndefined();   // verbatim turn 1
    expect(frames.getById(t2.id)).toBeUndefined();   // verbatim turn 2
    expect(frames.getById(o.id)).toBeDefined();      // other subject untouched
    expect(res.framesDeleted).toBe(3);
    expect(res.archiveRedacted).toBe(1);
    // FTS purged for a swept verbatim turn (no longer recall-able):
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_fts WHERE rowid = ?', t1.id)).toBe(0);
  });

  it('does NOT over-erase when one subject key is a prefix of another', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'item', content: 's' });
    const f = frames.createIFrame('harvest', 'summary item', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [r.archiveUid] }));
    // Raw-turn belonging to 'item-9' must NOT be caught by a sweep of 'item'.
    const longerKey = rawTurnConvKey({ source: 'claude', id: 'item-9' });
    const survivor = frames.createIFrame('harvest', `${rawTurnHeader(longerKey, 0, 'user')}\nkeep me`, 'normal', 'import');

    erasure.eraseBySourceRef('claude', 'item', 'dsar');

    expect(frames.getById(survivor.id)).toBeDefined();   // 'item-9' turn not swept by 'item'
  });

  // #7 review LOW: synthesized B-frames reference the erased frames in content JSON
  // and carry no archiveUids — sweep them via the reference intersection.
  it('purges a B-frame that references an erased frame', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'b1', content: 'src' });
    const f = frames.createIFrame('harvest', 'summary', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [r.archiveUid] }));
    const b = frames.createBFrame('harvest', 'Shared entity: Jane Doe', f.id, [f.id]);

    const res = erasure.eraseBySourceRef('claude', 'b1', 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();
    expect(frames.getById(b.id)).toBeUndefined();    // B-frame swept
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_fts WHERE rowid = ?', b.id)).toBe(0);
    expect(res.framesDeleted).toBe(2);               // summary + B-frame
  });
});

describe('MindErasure.eraseFrameComplete (shared route + MCP primitive)', () => {
  let db: MindDB;
  let frames: FrameStore;
  let archive: RawArchive;
  let erasure: MindErasure;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('harvest', 'harvest', 'test');
    frames = new FrameStore(db);
    archive = new RawArchive(db);
    erasure = new MindErasure(db);
  });
  afterEach(() => db.close());

  it('sweeps a linked harvested summary + its raw-turns (archive-linked path)', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'c1', content: 'summary source' });
    const f = frames.createIFrame('harvest', 'summary of c1', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ sourceId: 'c1', archiveUids: [r.archiveUid] }));
    const convKey = rawTurnConvKey({ source: 'claude', id: 'c1' });
    const t1 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 0, 'user')}\nPII a`, 'normal', 'import');
    const t2 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 1, 'assistant')}\nPII b`, 'normal', 'import');

    const res = erasure.eraseFrameComplete(f.id, 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();
    expect(frames.getById(t1.id)).toBeUndefined();
    expect(frames.getById(t2.id)).toBeUndefined();
    expect(res.framesDeleted).toBe(3);
    expect(res.archiveRedacted).toBe(1);
  });

  it('reaches raw-turns via the metadata.sourceId + content-prefix FALLBACK when the summary has no archive link', () => {
    // No archive row / no archiveUids — content carries the server harvest prefix.
    const f = frames.createIFrame('harvest', '[Harvest:gemini] Trip\n\nsummary', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ sourceId: 'g1' }));
    const convKey = rawTurnConvKey({ source: 'gemini', id: 'g1' });
    const t1 = frames.createIFrame('harvest', `${rawTurnHeader(convKey, 0, 'user')}\nPII`, 'normal', 'import');

    const res = erasure.eraseFrameComplete(f.id, 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();
    expect(frames.getById(t1.id)).toBeUndefined();   // reached via fallback
    expect(res.framesDeleted).toBe(2);
  });

  it('returns all-zero for an unknown frame id (no throw)', () => {
    expect(erasure.eraseFrameComplete(999999, 'x')).toEqual(ZERO);
  });

  // A single-frame memory (connector / ingest_source style: no archiveUids, no
  // metadata.sourceId, no raw-turns) that a synthesized B-frame references.
  // eraseFrameComplete's documented intent is to reach "referencing B-frames";
  // for a SUBJECT-LESS frame it resolved no subject → never ran the B-frame sweep,
  // so the B-frame (which can quote the erased frame's PII) survived. Must sweep it.
  it('sweeps a B-frame referencing the erased frame even when the frame has NO subject link', () => {
    const f = frames.createIFrame('harvest', '[Harvest:connector:crm] Jane Doe record\n\nverbatim PII', 'normal', 'import');
    const b = frames.createBFrame('harvest', 'Synthesized: Jane Doe is a CRM contact', f.id, [f.id]);

    const res = erasure.eraseFrameComplete(f.id, 'dsar');

    expect(frames.getById(f.id)).toBeUndefined();
    expect(frames.getById(b.id)).toBeUndefined();   // B-frame swept (no residual synthesized PII)
    expect(res.framesDeleted).toBe(2);              // the frame + its referencing B-frame
  });
});

// ── FrameStore.compact — no vector/index leak (review MEDIUM #3) ─────────────
describe('FrameStore.compact — no orphaned vector/index rows', () => {
  let db: MindDB;
  let frames: FrameStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('g', 'g', 'test');
    frames = new FrameStore(db);
  });
  afterEach(() => db.close());

  it('pruning a temporary frame leaves no orphan in _vec / _fts / _chunks_vec', () => {
    // A temporary frame older than the 30-day prune threshold, fully indexed.
    const f = frames.createIFrame('g', 'ephemeral note', 'temporary', 'import', '2020-01-01T00:00:00Z');
    addFrameVec(db, f.id);
    const chunkId = addChunk(db, f.id, 0, 'ephemeral chunk');

    frames.compact(30, 90);

    expect(frames.getById(f.id)).toBeUndefined();
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_vec WHERE rowid = ?', f.id)).toBe(0);
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frames_fts WHERE rowid = ?', f.id)).toBe(0);
    expect(cnt(db, 'SELECT COUNT(*) c FROM memory_frame_chunks_vec WHERE rowid = ?', chunkId)).toBe(0);
  });
});

// ── #7 P2: claude-code `decision-of` derived subject ─────────────────────────
// claude-code harvest's extractDecisions emits a SEPARATE import item keyed on
// stableHarvestId('claude-code','decision-of',parentId) that quotes the parent's
// decision lines. It lands as its OWN (source, source_ref) subject — a different
// archiveUid/raw-turn key than the parent, and it is not a B-frame — so a sweep of
// the PARENT never reaches it: the derived frame survives erasure AND (its key being
// un-suppressed) re-materializes on the next re-import. The persisted frame drops
// item.metadata.extractedFrom (harvest stamps only kind/confidence/status/
// sourceId/archiveUids), so the derived subject is reached by RECOMPUTING its key.
describe('MindErasure.eraseBySourceRef — claude-code decision-of derived subject (#7 P2)', () => {
  let db: MindDB;
  let frames: FrameStore;
  let archive: RawArchive;
  let erasure: MindErasure;
  let suppression: SuppressionStore;
  beforeEach(() => {
    db = new MindDB(':memory:');
    new SessionStore(db).ensure('harvest', 'harvest', 'test');
    frames = new FrameStore(db);
    archive = new RawArchive(db);
    erasure = new MindErasure(db);
    suppression = new SuppressionStore(db);
  });
  afterEach(() => db.close());

  /** Seed a harvested claude-code subject exactly as harvest.ts writes it:
   *  a raw_archive row + a summary frame linked via archiveUids + metadata.sourceId
   *  + the '[Harvest:claude-code] …' content prefix. Returns the frame id. */
  function seedSubject(sourceRef: string, title: string, content: string): number {
    const r = archive.append({ source: 'claude-code', sourceRef, content });
    const f = frames.createIFrame('harvest', `[Harvest:claude-code] ${title}\n\n${content}`, 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ sourceId: sourceRef, status: 'unreviewed', archiveUids: [r.archiveUid] }));
    return f.id;
  }

  const PARENT_REF = 'projects/foo/.mind/decisions-2026.md';
  const DERIVED_REF = decisionOfSubjectId(PARENT_REF);

  it('erases the derived decision-of frame when the parent subject is erased', () => {
    const parent = seedSubject(PARENT_REF, 'Decisions 2026', 'we DECIDED to ship X');
    const derived = seedSubject(DERIVED_REF, 'Decisions from: Decisions 2026', 'we DECIDED to ship X');

    const res = erasure.eraseBySourceRef('claude-code', PARENT_REF, 'dsar#42');

    expect(frames.getById(parent)).toBeUndefined();    // parent (baseline)
    expect(frames.getById(derived)).toBeUndefined();   // derived reached (the fix)
    expect(res.framesDeleted).toBe(2);                 // parent summary + derived summary
  });

  it('suppresses the derived decision-of key so it cannot re-materialize on re-import', () => {
    seedSubject(PARENT_REF, 'Decisions 2026', 'we DECIDED to ship X');
    seedSubject(DERIVED_REF, 'Decisions from: Decisions 2026', 'we DECIDED to ship X');

    erasure.eraseBySourceRef('claude-code', PARENT_REF, 'dsar#42');

    expect(suppression.isSuppressed('claude-code', PARENT_REF)).toBe(true);   // parent (baseline)
    expect(suppression.isSuppressed('claude-code', DERIVED_REF)).toBe(true);  // derived key (the fix)
  });

  it('does NOT record a phantom derived suppression when the parent had no decision-of frame', () => {
    // A claude-code note with no decision derivation → no derived frame exists.
    const plainRef = 'projects/foo/.mind/plain.md';
    const plainDerived = decisionOfSubjectId(plainRef);
    seedSubject(plainRef, 'Plain note', 'nothing notable here');

    erasure.eraseBySourceRef('claude-code', plainRef, 'dsar');

    expect(suppression.isSuppressed('claude-code', plainRef)).toBe(true);         // explicit subject recorded
    expect(suppression.isSuppressed('claude-code', plainDerived)).toBe(false);    // no phantom derived row
    expect(suppression.list()).toHaveLength(1);                                   // exactly one entry
  });

  it('does not attempt a decision-of cascade for a non-claude-code source', () => {
    const r = archive.append({ source: 'claude', sourceRef: 'thread-1', content: 'x' });
    const f = frames.createIFrame('harvest', 'summary', 'normal', 'import');
    frames.setMetadata(f.id, JSON.stringify({ archiveUids: [r.archiveUid] }));

    erasure.eraseBySourceRef('claude', 'thread-1', 'dsar');

    // Only the explicit subject is suppressed — no derived 'decision-of' row for
    // an adapter that never derives decisions.
    expect(suppression.list().map((s) => s.sourceRef)).toEqual(['thread-1']);
  });

  // Atomicity invariant (erasure.ts preamble: "Every multi-table erasure runs in
  // ONE better-sqlite3 transaction — a partial erasure is a compliance failure").
  // The P2 refactor extracted the sweep into a non-transactional eraseSubjectFrames
  // called TWICE (primary + derived) inside eraseBySourceRef's single transaction.
  // Pin that the whole cascade is one atomic unit: a failure on the LAST write (the
  // derived suppression.record, after the primary erase + primary record already ran
  // in the txn) must roll back EVERYTHING — no half-erased subject, no orphan
  // suppression row. (A released better-sqlite3 savepoint is NOT durable; the outer
  // rollback discards it — so this also holds when eraseFrameComplete wraps this.)
  it('rolls the whole primary+derived cascade back atomically if a later write throws', () => {
    const parent = seedSubject(PARENT_REF, 'Decisions 2026', 'we DECIDED to ship X');
    const derived = seedSubject(DERIVED_REF, 'Decisions from: Decisions 2026', 'we DECIDED to ship X');

    // Inject a failure on the DERIVED suppression.record — the final write in the
    // cascade, after the primary subject has already been erased + recorded inside
    // the same transaction. Delegate the primary record to the real implementation.
    const realRecord = SuppressionStore.prototype.record;
    const spy = vi.spyOn(SuppressionStore.prototype, 'record').mockImplementation(function (
      this: SuppressionStore, source: string, sourceRef: string, reason?: string,
    ): void {
      if (sourceRef === DERIVED_REF) throw new Error('injected mid-transaction failure on derived record');
      realRecord.call(this, source, sourceRef, reason);
    });

    expect(() => erasure.eraseBySourceRef('claude-code', PARENT_REF, 'dsar')).toThrow('injected mid-transaction failure');
    spy.mockRestore();

    // FULL rollback — the transaction guarantee held:
    expect(frames.getById(parent)).toBeDefined();    // primary erase rolled back
    expect(frames.getById(derived)).toBeDefined();   // derived erase rolled back
    expect(suppression.list()).toHaveLength(0);      // primary record rolled back too — no orphan
  });
});
