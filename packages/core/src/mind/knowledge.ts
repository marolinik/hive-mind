/**
 * KnowledgeGraph — entities + relations with bitemporal validity.
 *
 * Each entity and relation carries a `valid_from` / `valid_to` pair so the
 * graph can answer "what did I know at time T" without losing history.
 * `retireEntity` / `retireRelation` set `valid_to = now()` instead of
 * deleting — so later queries can reconstruct the graph as-of any moment.
 *
 * Traversal is explicit and bounded: `traverse(startId, relType, maxDepth)`
 * for typed-edge BFS; `bfsDistances(startId, maxDepth)` for distance maps
 * feeding the scoring layer's contextual-score feature.
 *
 * Optional validation: call `setValidationSchema(schema)` to enforce required
 * entity properties and per-type allowed relation types at insert time.
 *
 * Extracted from Waggle OS `packages/core/src/mind/knowledge.ts`.
 * Scrub: none — this module has no proprietary dependencies. Internal
 * feature-number comment prefixes (`9c:` etc.) dropped as noise.
 */

import type { MindDB } from './db.js';

export interface Entity {
  id: number;
  entity_type: string;
  name: string;
  properties: string; // JSON-encoded Record<string, unknown>
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
}

export interface Relation {
  id: number;
  source_id: number;
  target_id: number;
  relation_type: string;
  confidence: number;
  properties: string; // JSON-encoded Record<string, unknown>
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
}

export interface EntityTypeSchema {
  required: string[];
  allowedRelations: string[];
}

export type ValidationSchema = Record<string, EntityTypeSchema>;

export class KnowledgeGraph {
  private db: MindDB;
  private schema: ValidationSchema | null = null;

  constructor(db: MindDB) {
    this.db = db;
  }

  setValidationSchema(schema: ValidationSchema): void {
    this.schema = schema;
  }

  // ── Entity operations ────────────────────────────────────────────────

  createEntity(
    entityType: string,
    name: string,
    properties: Record<string, unknown>,
    temporal?: { valid_from?: string; valid_to?: string },
  ): Entity {
    this.validateEntityProperties(entityType, properties);
    const raw = this.db.getDatabase();

    if (temporal?.valid_from || temporal?.valid_to) {
      const validFrom = temporal.valid_from ?? new Date().toISOString();
      const validTo = temporal.valid_to ?? null;
      const result = raw
        .prepare(
          `INSERT INTO knowledge_entities (entity_type, name, properties, valid_from, valid_to)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(entityType, name, JSON.stringify(properties), validFrom, validTo);
      return raw
        .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
        .get(result.lastInsertRowid) as Entity;
    }

    const result = raw
      .prepare(
        `INSERT INTO knowledge_entities (entity_type, name, properties)
         VALUES (?, ?, ?)`,
      )
      .run(entityType, name, JSON.stringify(properties));
    return raw
      .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
      .get(result.lastInsertRowid) as Entity;
  }

  getEntity(id: number): Entity | undefined {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
      .get(id) as Entity | undefined;
  }

  updateEntity(
    id: number,
    changes: { name?: string; properties?: Record<string, unknown> },
  ): Entity {
    const raw = this.db.getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    if (changes.name !== undefined) {
      sets.push('name = ?');
      values.push(changes.name);
    }
    if (changes.properties !== undefined) {
      sets.push('properties = ?');
      values.push(JSON.stringify(changes.properties));
    }

    if (sets.length > 0) {
      sets.push("recorded_at = datetime('now')");
      raw
        .prepare(`UPDATE knowledge_entities SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
    }
    return raw
      .prepare('SELECT * FROM knowledge_entities WHERE id = ?')
      .get(id) as Entity;
  }

  retireEntity(id: number): void {
    this.db
      .getDatabase()
      .prepare("UPDATE knowledge_entities SET valid_to = datetime('now') WHERE id = ?")
      .run(id);
  }

  getEntitiesByType(entityType: string, limit = 500): Entity[] {
    if (!entityType) {
      return this.getEntities(limit);
    }
    return this.db
      .getDatabase()
      .prepare(
        'SELECT * FROM knowledge_entities WHERE entity_type = ? AND valid_to IS NULL ORDER BY name LIMIT ?',
      )
      .all(entityType, limit) as Entity[];
  }

  /** Paginated entity listing — prevents unbounded fetches. */
  getEntities(limit = 200, offset = 0): Entity[] {
    return this.db
      .getDatabase()
      .prepare(
        'SELECT * FROM knowledge_entities WHERE valid_to IS NULL ORDER BY name LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as Entity[];
  }

  /** Per-type active entity counts (cheap dashboard summary). */
  getEntityTypeCounts(): { type: string; count: number }[] {
    return this.db
      .getDatabase()
      .prepare(
        `SELECT entity_type as type, COUNT(*) as count FROM knowledge_entities
         WHERE valid_to IS NULL GROUP BY entity_type ORDER BY count DESC`,
      )
      .all() as { type: string; count: number }[];
  }

  /** Total active entity count. */
  getEntityCount(): number {
    const row = this.db
      .getDatabase()
      .prepare('SELECT COUNT(*) as cnt FROM knowledge_entities WHERE valid_to IS NULL')
      .get() as { cnt: number };
    return row.cnt;
  }

  searchEntities(query: string, limit = 100): Entity[] {
    return this.db
      .getDatabase()
      .prepare(
        'SELECT * FROM knowledge_entities WHERE name LIKE ? AND valid_to IS NULL ORDER BY name LIMIT ?',
      )
      .all(`%${query}%`, limit) as Entity[];
  }

  getEntitiesValidAt(isoTime: string, limit = 500): Entity[] {
    return this.db
      .getDatabase()
      .prepare(
        `SELECT * FROM knowledge_entities
         WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) LIMIT ?`,
      )
      .all(isoTime, isoTime, limit) as Entity[];
  }

  // ── Relation operations ──────────────────────────────────────────────

  createRelation(
    sourceId: number,
    targetId: number,
    relationType: string,
    confidence = 1.0,
    properties: Record<string, unknown> = {},
  ): Relation {
    this.validateRelation(sourceId, relationType);
    const raw = this.db.getDatabase();
    const result = raw
      .prepare(
        `INSERT INTO knowledge_relations (source_id, target_id, relation_type, confidence, properties)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sourceId, targetId, relationType, confidence, JSON.stringify(properties));
    return raw
      .prepare('SELECT * FROM knowledge_relations WHERE id = ?')
      .get(result.lastInsertRowid) as Relation;
  }

  getRelation(id: number): Relation | undefined {
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM knowledge_relations WHERE id = ?')
      .get(id) as Relation | undefined;
  }

  getRelationsFrom(sourceId: number, relationType?: string): Relation[] {
    if (relationType) {
      return this.db
        .getDatabase()
        .prepare(
          'SELECT * FROM knowledge_relations WHERE source_id = ? AND relation_type = ? AND valid_to IS NULL',
        )
        .all(sourceId, relationType) as Relation[];
    }
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM knowledge_relations WHERE source_id = ? AND valid_to IS NULL')
      .all(sourceId) as Relation[];
  }

  getRelationsTo(targetId: number, relationType?: string): Relation[] {
    if (relationType) {
      return this.db
        .getDatabase()
        .prepare(
          'SELECT * FROM knowledge_relations WHERE target_id = ? AND relation_type = ? AND valid_to IS NULL',
        )
        .all(targetId, relationType) as Relation[];
    }
    return this.db
      .getDatabase()
      .prepare('SELECT * FROM knowledge_relations WHERE target_id = ? AND valid_to IS NULL')
      .all(targetId) as Relation[];
  }

  retireRelation(id: number): void {
    this.db
      .getDatabase()
      .prepare("UPDATE knowledge_relations SET valid_to = datetime('now') WHERE id = ?")
      .run(id);
  }

  // ── Graph traversal ──────────────────────────────────────────────────

  traverse(startId: number, relationType: string, maxDepth: number): Entity[] {
    const visited = new Set<number>([startId]);
    const result: Entity[] = [];
    let frontier = [startId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: number[] = [];
      for (const nodeId of frontier) {
        const rels = this.getRelationsFrom(nodeId, relationType);
        for (const rel of rels) {
          if (!visited.has(rel.target_id)) {
            visited.add(rel.target_id);
            const entity = this.getEntity(rel.target_id);
            if (entity && entity.valid_to === null) {
              result.push(entity);
              nextFrontier.push(rel.target_id);
            }
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  bfsDistances(startId: number, maxDepth: number): Map<number, number> {
    const distances = new Map<number, number>();
    const visited = new Set<number>([startId]);
    let frontier = [startId];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: number[] = [];
      for (const nodeId of frontier) {
        const rels = this.getRelationsFrom(nodeId);
        for (const rel of rels) {
          if (!visited.has(rel.target_id)) {
            visited.add(rel.target_id);
            distances.set(rel.target_id, depth);
            nextFrontier.push(rel.target_id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return distances;
  }

  // ── Validation ───────────────────────────────────────────────────────

  private validateEntityProperties(
    entityType: string,
    properties: Record<string, unknown>,
  ): void {
    if (!this.schema || !this.schema[entityType]) return;
    const typeSchema = this.schema[entityType];

    for (const required of typeSchema.required) {
      if (!(required in properties)) {
        throw new Error(
          `Validation failed: required property '${required}' missing for type '${entityType}'`,
        );
      }
    }
  }

  private validateRelation(sourceId: number, relationType: string): void {
    if (!this.schema) return;
    const source = this.getEntity(sourceId);
    if (!source) return;
    const typeSchema = this.schema[source.entity_type];
    if (!typeSchema) return;

    if (!typeSchema.allowedRelations.includes(relationType)) {
      throw new Error(
        `Validation failed: relation '${relationType}' not allowed for type '${source.entity_type}'`,
      );
    }
  }
}
