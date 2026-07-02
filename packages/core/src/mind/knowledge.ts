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
import { normalizeEntityName } from './entity-normalizer.js';

function safeParseProps(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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

  /**
   * Exact-name lookup. Returns the active entity whose name equals the
   * query (case-sensitive), or undefined.
   *
   * Use this instead of `searchEntities(name, 3).find(...)` for dedup —
   * the LIKE-based fuzzy search drops the exact match out of the top-K
   * window once enough similarly-named entities accumulate, which causes
   * dedup failures and runaway duplicate-row growth (e.g. 3506 copies of
   * "Phase" because "Phase 1", "Phase 2", … alphabetically precede the
   * plain "Phase" in a LIKE '%Phase%' result).
   */
  findEntityByName(name: string): Entity | undefined {
    return this.db
      .getDatabase()
      .prepare(
        'SELECT * FROM knowledge_entities WHERE name = ? AND valid_to IS NULL LIMIT 1',
      )
      .get(name) as Entity | undefined;
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

  /**
   * Merge active entities that share a normalized name + type. The survivor is
   * the entity with the most relations (ties broken by lowest/oldest id); each
   * duplicate's relations are re-pointed to the survivor, properties are merged
   * (survivor wins on key conflicts, but `seen_count` is summed), and the
   * duplicate is retired (bitemporal soft-delete). Runs in a single transaction.
   *
   * Shared by `cleanup_entities` (MCP, mode='dedup') and the CLI
   * `maintenance --dedupe-entities` flag so the merge logic has one definition.
   *
   * @returns `{ groups }` duplicate groups processed, `{ merged }` entities retired.
   */
  dedupeByName(): { groups: number; merged: number } {
    const raw = this.db.getDatabase();
    const grouped = new Map<string, Entity[]>();
    for (const e of this.getEntities(100_000)) {
      const key = `${normalizeEntityName(e.name)}::${e.entity_type.toLowerCase()}`;
      let g = grouped.get(key);
      if (!g) {
        g = [];
        grouped.set(key, g);
      }
      g.push(e);
    }

    let groups = 0;
    let merged = 0;
    const relCount = (id: number): number =>
      this.getRelationsFrom(id).length + this.getRelationsTo(id).length;

    const tx = raw.transaction(() => {
      for (const group of grouped.values()) {
        if (group.length <= 1) continue;
        groups += 1;
        // Survivor = most relations; ties → lowest (oldest) id.
        const sorted = [...group].sort((a, b) => relCount(b.id) - relCount(a.id) || a.id - b.id);
        const keep = sorted[0];

        for (const dup of sorted.slice(1)) {
          // Re-point the duplicate's relations onto the survivor, then retire them.
          for (const rel of this.getRelationsFrom(dup.id)) {
            try {
              this.createRelation(keep.id, rel.target_id, rel.relation_type, rel.confidence, safeParseProps(rel.properties));
            } catch {
              /* may already exist or be schema-rejected — the retire below still applies */
            }
            this.retireRelation(rel.id);
          }
          for (const rel of this.getRelationsTo(dup.id)) {
            try {
              this.createRelation(rel.source_id, keep.id, rel.relation_type, rel.confidence, safeParseProps(rel.properties));
            } catch {
              /* idem */
            }
            this.retireRelation(rel.id);
          }

          // Merge properties: survivor wins on conflicts, seen_count is summed.
          const keepProps = safeParseProps(keep.properties);
          const dupProps = safeParseProps(dup.properties);
          const mergedProps: Record<string, unknown> = { ...dupProps, ...keepProps };
          mergedProps.seen_count =
            Number(keepProps.seen_count ?? 1) + Number(dupProps.seen_count ?? 1);
          this.updateEntity(keep.id, { properties: mergedProps });
          this.retireEntity(dup.id);
          merged += 1;
        }
      }
    });
    tx();
    return { groups, merged };
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

  /** Create + link a batch of entities to the frame they were extracted from,
   *  so the kg_entity_frames bridge reaches them (GDPR erasure orphan sweep +
   *  contextual scoring). Per-entity failures are non-fatal. Returns the count
   *  created. */
  importEntitiesForFrame(
    frameId: number,
    entities: Array<{ name: string; type?: string }>,
    provenance: { source: string; importedFrom?: string },
  ): number {
    let created = 0;
    for (const ent of entities) {
      try {
        const e = this.createEntity(ent.type || 'concept', ent.name, {
          source: provenance.source,
          imported_from: provenance.importedFrom,
        });
        this.linkEntityToFrame(e.id, frameId);
        created++;
      } catch { /* non-fatal per-entity (schema-rejected / bad name) — as in the harvest routes */ }
    }
    return created;
  }

  /** Link an entity to a frame it was extracted from (kg_entity_frames bridge).
   *  Powers the 'contextual' scoring signal. Idempotent per (entity, frame). */
  linkEntityToFrame(entityId: number, frameId: number): void {
    try {
      this.db.getDatabase().prepare(
        'INSERT OR IGNORE INTO kg_entity_frames (entity_id, frame_id) VALUES (?, ?)',
      ).run(entityId, frameId);
    } catch { /* bridge table absent on a pre-migration DB — best-effort */ }
  }

  /** Seed entities whose name appears in free text (case-insensitive, name ≥3
   *  chars), longest-name-first. Used to seed contextual scoring from a query. */
  findEntitiesInText(text: string, limit = 12): number[] {
    try {
      const rows = this.db.getDatabase().prepare(
        "SELECT id FROM knowledge_entities WHERE valid_to IS NULL AND length(name) >= 3 AND instr(lower(?), lower(name)) > 0 ORDER BY length(name) DESC LIMIT ?",
      ).all(text, limit) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    } catch { return []; }
  }

  /** BFS from seed entities (≤maxDepth) and map the reached entities to the
   *  frames they were extracted from via the kg_entity_frames bridge, returning
   *  frameId → shortest graph distance. Empty when the bridge is unpopulated. */
  frameDistancesFromEntities(seedEntityIds: number[], maxDepth = 3): Map<number, number> {
    const frameDist = new Map<number, number>();
    if (seedEntityIds.length === 0) return frameDist;
    const entityDist = new Map<number, number>();
    for (const seed of seedEntityIds) {
      entityDist.set(seed, 0); // the seed entity itself is distance 0
      for (const [eid, d] of this.bfsDistances(seed, maxDepth)) {
        const prev = entityDist.get(eid);
        if (prev === undefined || d < prev) entityDist.set(eid, d);
      }
    }
    try {
      const stmt = this.db.getDatabase().prepare(
        'SELECT frame_id FROM kg_entity_frames WHERE entity_id = ?',
      );
      for (const [eid, d] of entityDist) {
        for (const { frame_id } of stmt.all(eid) as Array<{ frame_id: number }>) {
          const prev = frameDist.get(frame_id);
          if (prev === undefined || d < prev) frameDist.set(frame_id, d);
        }
      }
    } catch { return new Map(); } // bridge absent — no contextual signal
    return frameDist;
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
