/**
 * Ontology — simple in-memory entity-type registry with shape validation.
 *
 * Distinct from KnowledgeGraph's own built-in validation (which reads
 * `ValidationSchema` set via `setValidationSchema`) — this module is a
 * standalone utility for callers that want to validate entity payloads
 * before passing them to the KG. The two layers can be used together or
 * independently.
 *
 * Extracted from Waggle OS `packages/core/src/mind/ontology.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

export interface EntitySchema {
  required: string[];
  optional: string[];
}

export class Ontology {
  private schemas = new Map<string, EntitySchema>();

  define(type: string, schema: EntitySchema): void {
    this.schemas.set(type, schema);
  }

  getSchema(type: string): EntitySchema | undefined {
    return this.schemas.get(type);
  }

  hasType(type: string): boolean {
    return this.schemas.has(type);
  }

  getTypes(): string[] {
    return Array.from(this.schemas.keys());
  }
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

export function validateEntity(
  ontology: Ontology,
  entity: { type: string; properties: Record<string, unknown> },
): ValidationResult {
  const issues: string[] = [];
  const schema = ontology.getSchema(entity.type);

  if (!schema) {
    return { valid: false, issues: [`Unknown entity type: ${entity.type}`] };
  }

  for (const prop of schema.required) {
    if (!(prop in entity.properties)) {
      issues.push(`Missing required property: ${prop}`);
    }
  }

  const known = new Set([...schema.required, ...schema.optional]);
  for (const prop of Object.keys(entity.properties)) {
    if (!known.has(prop)) {
      issues.push(`Unknown property: ${prop}`);
    }
  }

  return { valid: issues.length === 0, issues };
}
