/**
 * IdentityLayer — single-row "who am I" persistence.
 *
 * Stores a persistent identity record (name, role, department, personality,
 * capabilities, system prompt) in the `identity` table. Exactly one row is
 * allowed — the schema enforces `id = 1` — so this is a stable key-value
 * face for an agent's self-description.
 *
 * `toContext()` produces a compact human-readable block suitable for
 * embedding into LLM system prompts.
 *
 * Extracted from Waggle OS `packages/core/src/mind/identity.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import type { MindDB } from './db.js';

export interface Identity {
  id: number;
  name: string;
  role: string;
  department: string;
  personality: string;
  capabilities: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

type IdentityInput = Omit<Identity, 'id' | 'created_at' | 'updated_at'>;
type IdentityUpdate = Partial<IdentityInput>;

export class IdentityLayer {
  private db: MindDB;

  constructor(db: MindDB) {
    this.db = db;
  }

  create(input: IdentityInput): Identity {
    const raw = this.db.getDatabase();
    raw
      .prepare(
        `INSERT INTO identity (id, name, role, department, personality, capabilities, system_prompt)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.role,
        input.department,
        input.personality,
        input.capabilities,
        input.system_prompt,
      );
    return this.get();
  }

  get(): Identity {
    const raw = this.db.getDatabase();
    const row = raw.prepare('SELECT * FROM identity WHERE id = 1').get() as
      | Identity
      | undefined;
    if (!row) throw new Error('No identity configured');
    return row;
  }

  exists(): boolean {
    const raw = this.db.getDatabase();
    const row = raw.prepare('SELECT 1 FROM identity WHERE id = 1').get();
    return row !== undefined;
  }

  update(changes: IdentityUpdate): Identity {
    if (!this.exists()) throw new Error('No identity configured');

    const fields = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return this.get();

    const sets = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([, v]) => v);

    const raw = this.db.getDatabase();
    raw
      .prepare(
        `UPDATE identity SET ${sets}, updated_at = datetime('now') WHERE id = 1`,
      )
      .run(...values);
    return this.get();
  }

  toContext(): string {
    const id = this.get();
    const parts = [
      `Name: ${id.name}`,
      id.role && `Role: ${id.role}`,
      id.department && `Department: ${id.department}`,
      id.personality && `Personality: ${id.personality}`,
      id.capabilities && `Capabilities: ${id.capabilities}`,
      id.system_prompt && `System Prompt: ${id.system_prompt}`,
    ].filter(Boolean);
    return parts.join('\n');
  }
}
