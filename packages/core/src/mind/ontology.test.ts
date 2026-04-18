import { describe, it, expect } from 'vitest';
import { Ontology, validateEntity } from './ontology.js';

describe('Ontology', () => {
  it('define + getSchema + hasType + getTypes round-trip', () => {
    const o = new Ontology();
    o.define('person', { required: ['email'], optional: ['nickname'] });
    o.define('org', { required: ['name'], optional: [] });

    expect(o.hasType('person')).toBe(true);
    expect(o.hasType('mystery')).toBe(false);
    expect(o.getSchema('person')?.required).toEqual(['email']);
    expect(o.getTypes().sort()).toEqual(['org', 'person']);
  });
});

describe('validateEntity', () => {
  const ontology = new Ontology();
  ontology.define('person', { required: ['email'], optional: ['nickname'] });

  it('returns invalid for unknown entity types', () => {
    const result = validateEntity(ontology, { type: 'alien', properties: {} });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatch(/Unknown entity type: alien/);
  });

  it('returns valid when required props are present and no unknown props', () => {
    const result = validateEntity(ontology, {
      type: 'person',
      properties: { email: 'a@x', nickname: 'A' },
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('flags missing required properties', () => {
    const result = validateEntity(ontology, {
      type: 'person',
      properties: { nickname: 'anon' },
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Missing required property: email');
  });

  it('flags unknown properties not in required or optional', () => {
    const result = validateEntity(ontology, {
      type: 'person',
      properties: { email: 'a@x', age: 99 },
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Unknown property: age');
  });
});
