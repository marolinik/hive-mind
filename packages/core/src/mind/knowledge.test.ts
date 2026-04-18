import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { MindDB } from './db.js';
import { KnowledgeGraph, type ValidationSchema } from './knowledge.js';

describe('KnowledgeGraph', () => {
  let dbPath: string;
  let db: MindDB;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    dbPath = join(tmpdir(), `hive-mind-kg-test-${Date.now()}-${Math.random()}.mind`);
    db = new MindDB(dbPath);
    kg = new KnowledgeGraph(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
    for (const suffix of ['-shm', '-wal']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  it('createEntity stores type/name/properties and getEntity round-trips', () => {
    const e = kg.createEntity('person', 'Ada', { role: 'engineer' });
    expect(e.entity_type).toBe('person');
    expect(e.name).toBe('Ada');
    expect(JSON.parse(e.properties)).toEqual({ role: 'engineer' });
    expect(e.valid_to).toBeNull();

    const loaded = kg.getEntity(e.id);
    expect(loaded?.id).toBe(e.id);
    expect(loaded?.name).toBe('Ada');
  });

  it('updateEntity rewrites name and properties', () => {
    const e = kg.createEntity('person', 'Ada', { role: 'engineer' });
    const updated = kg.updateEntity(e.id, { name: 'Ada Lovelace', properties: { role: 'mathematician' } });
    expect(updated.name).toBe('Ada Lovelace');
    expect(JSON.parse(updated.properties)).toEqual({ role: 'mathematician' });
  });

  it('retireEntity sets valid_to and excludes the entity from active listings', () => {
    const a = kg.createEntity('person', 'Alice', {});
    const b = kg.createEntity('person', 'Bob', {});

    kg.retireEntity(a.id);

    const active = kg.getEntitiesByType('person');
    expect(active.map((e) => e.id)).toEqual([b.id]);

    // Retired row still readable by id (for history queries).
    expect(kg.getEntity(a.id)?.valid_to).not.toBeNull();
  });

  it('createRelation + getRelationsFrom/getRelationsTo round-trip', () => {
    const alice = kg.createEntity('person', 'Alice', {});
    const acme = kg.createEntity('org', 'Acme', {});

    const rel = kg.createRelation(alice.id, acme.id, 'works_at', 0.9, { since: '2020' });
    expect(rel.confidence).toBe(0.9);
    expect(JSON.parse(rel.properties)).toEqual({ since: '2020' });

    const fromAlice = kg.getRelationsFrom(alice.id);
    expect(fromAlice).toHaveLength(1);
    expect(fromAlice[0].target_id).toBe(acme.id);

    const toAcme = kg.getRelationsTo(acme.id, 'works_at');
    expect(toAcme).toHaveLength(1);
    expect(toAcme[0].source_id).toBe(alice.id);
  });

  it('retireRelation hides the edge from active queries', () => {
    const a = kg.createEntity('person', 'A', {});
    const b = kg.createEntity('person', 'B', {});
    const rel = kg.createRelation(a.id, b.id, 'knows');
    kg.retireRelation(rel.id);

    expect(kg.getRelationsFrom(a.id)).toEqual([]);
    expect(kg.getRelationsTo(b.id)).toEqual([]);
  });

  it('traverse does typed-edge BFS bounded by maxDepth', () => {
    const a = kg.createEntity('person', 'A', {});
    const b = kg.createEntity('person', 'B', {});
    const c = kg.createEntity('person', 'C', {});
    const d = kg.createEntity('person', 'D', {});
    kg.createRelation(a.id, b.id, 'knows');
    kg.createRelation(b.id, c.id, 'knows');
    kg.createRelation(c.id, d.id, 'knows');
    kg.createRelation(a.id, d.id, 'dislikes'); // Different type — must not appear.

    const hop1 = kg.traverse(a.id, 'knows', 1).map((e) => e.name);
    expect(hop1).toEqual(['B']);

    const hop3 = kg.traverse(a.id, 'knows', 3).map((e) => e.name).sort();
    expect(hop3).toEqual(['B', 'C', 'D']);
  });

  it('bfsDistances returns shortest distance to each reachable entity', () => {
    const a = kg.createEntity('t', 'A', {});
    const b = kg.createEntity('t', 'B', {});
    const c = kg.createEntity('t', 'C', {});
    const d = kg.createEntity('t', 'D', {});
    kg.createRelation(a.id, b.id, 'edge');
    kg.createRelation(b.id, c.id, 'edge');
    kg.createRelation(a.id, c.id, 'edge'); // shortcut: A→C direct

    const distances = kg.bfsDistances(a.id, 3);
    expect(distances.get(b.id)).toBe(1);
    expect(distances.get(c.id)).toBe(1); // shortcut wins over via-B path
    expect(distances.has(d.id)).toBe(false);
  });

  it('getEntitiesValidAt reconstructs the graph at a given instant', () => {
    const past = '2020-01-01T00:00:00Z';
    const now = '2025-01-01T00:00:00Z';

    const oldEntity = kg.createEntity('t', 'Old', {}, { valid_from: past, valid_to: '2023-01-01T00:00:00Z' });
    const current = kg.createEntity('t', 'Current', {}, { valid_from: past });

    const asOf2022 = kg.getEntitiesValidAt('2022-01-01T00:00:00Z').map((e) => e.name).sort();
    expect(asOf2022).toEqual(['Current', 'Old']);

    const asOfNow = kg.getEntitiesValidAt(now).map((e) => e.name);
    expect(asOfNow).toEqual(['Current']);

    expect(oldEntity.id).not.toBe(current.id);
  });

  it('searchEntities LIKE matches by name substring', () => {
    kg.createEntity('t', 'Alice', {});
    kg.createEntity('t', 'Alicia', {});
    kg.createEntity('t', 'Bob', {});

    const hits = kg.searchEntities('Ali').map((e) => e.name).sort();
    expect(hits).toEqual(['Alice', 'Alicia']);
  });

  it('getEntityTypeCounts + getEntityCount summarize the active graph', () => {
    kg.createEntity('person', 'A', {});
    kg.createEntity('person', 'B', {});
    kg.createEntity('org', 'Acme', {});
    const retired = kg.createEntity('org', 'Defunct', {});
    kg.retireEntity(retired.id);

    expect(kg.getEntityCount()).toBe(3);

    const counts = kg.getEntityTypeCounts();
    const map = new Map(counts.map((c) => [c.type, c.count]));
    expect(map.get('person')).toBe(2);
    expect(map.get('org')).toBe(1);
  });

  it('validation schema enforces required props and allowed relations', () => {
    const schema: ValidationSchema = {
      person: { required: ['email'], allowedRelations: ['works_at'] },
    };
    kg.setValidationSchema(schema);

    expect(() => kg.createEntity('person', 'Alice', {})).toThrow(/required property 'email'/);
    const alice = kg.createEntity('person', 'Alice', { email: 'a@x' });

    const acme = kg.createEntity('org', 'Acme', {});
    expect(() => kg.createRelation(alice.id, acme.id, 'dislikes')).toThrow(
      /relation 'dislikes' not allowed/,
    );
    const ok = kg.createRelation(alice.id, acme.id, 'works_at');
    expect(ok.relation_type).toBe('works_at');
  });
});
