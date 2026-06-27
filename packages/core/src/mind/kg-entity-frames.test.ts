import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MindDB } from './db.js';
import { KnowledgeGraph } from './knowledge.js';
import { FrameStore } from './frames.js';
import { SessionStore } from './sessions.js';

// The kg_entity_frames bridge turns the 'contextual' scoring signal from a
// constant 0 into a real graph-proximity boost. These lock the new wiring.
describe('KG entity↔frame bridge (contextual scoring signal)', () => {
  let db: MindDB;
  let kg: KnowledgeGraph;
  let frames: FrameStore;
  let gop: string;

  beforeEach(() => {
    db = new MindDB(':memory:');
    kg = new KnowledgeGraph(db);
    frames = new FrameStore(db);
    gop = new SessionStore(db).create('project:test').gop_id;
  });
  afterEach(() => db.close());

  it('maps query-seeded graph distance back onto frames via the bridge', () => {
    const fAcme = frames.createIFrame(gop, 'Acme adopted Postgres in Q2');
    const fPg = frames.createIFrame(gop, 'Postgres tuning notes');
    const acme = kg.createEntity('org', 'Acme', {});
    const pg = kg.createEntity('tech', 'Postgres', {});
    kg.createRelation(acme.id, pg.id, 'uses'); // acme --1 hop--> pg
    kg.linkEntityToFrame(acme.id, fAcme.id);
    kg.linkEntityToFrame(pg.id, fPg.id);

    const dist = kg.frameDistancesFromEntities([acme.id], 3);
    expect(dist.get(fAcme.id)).toBe(0);
    expect(dist.get(fPg.id)).toBe(1);
  });

  it('linkEntityToFrame is idempotent per (entity, frame)', () => {
    const f = frames.createIFrame(gop, 'x');
    const e = kg.createEntity('org', 'Acme', {});
    kg.linkEntityToFrame(e.id, f.id);
    kg.linkEntityToFrame(e.id, f.id);
    const count = (db.getDatabase().prepare('SELECT COUNT(*) c FROM kg_entity_frames').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('findEntitiesInText seeds from entity names mentioned in a query', () => {
    const acme = kg.createEntity('org', 'Acme', {});
    kg.createEntity('tech', 'Postgres', {});
    expect(kg.findEntitiesInText('how did Acme roll things out?')).toContain(acme.id);
  });

  it('backfillKgEntityFrames links pre-existing frames to mentioned entities', () => {
    const f1 = frames.createIFrame(gop, 'Acme shipped the Q2 release');
    frames.createIFrame(gop, 'unrelated note about the weather');
    const acme = kg.createEntity('org', 'Acme', {});
    expect(db.backfillKgEntityFrames(true)).toBe(1); // only the first frame mentions "Acme"
    expect(kg.frameDistancesFromEntities([acme.id], 3).get(f1.id)).toBe(0);
  });

  it('backfill skips ubiquitous hub entities (>40% of frames)', () => {
    // 30 frames mention "Hubword", 1 mentions "Rareword". cap = max(20, 12) = 20.
    for (let i = 0; i < 30; i++) frames.createIFrame(gop, `note ${i} about Hubword`);
    const rareFrame = frames.createIFrame(gop, 'a single mention of Rareword');
    const hub = kg.createEntity('concept', 'Hubword', {});
    const rare = kg.createEntity('concept', 'Rareword', {});

    db.backfillKgEntityFrames(true);
    expect(kg.frameDistancesFromEntities([hub.id], 3).size).toBe(0); // hub skipped
    expect(kg.frameDistancesFromEntities([rare.id], 3).get(rareFrame.id)).toBe(0);
  });

  it('ON DELETE CASCADE removes bridge rows when a frame is deleted', () => {
    const f = frames.createIFrame(gop, 'y');
    const e = kg.createEntity('org', 'Acme', {});
    kg.linkEntityToFrame(e.id, f.id);
    frames.delete(f.id);
    const count = (db.getDatabase().prepare('SELECT COUNT(*) c FROM kg_entity_frames').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
