import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findHighSignalFiles, chunkContent, harvestHeader } from './harvest.js';

describe('harvest helpers', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hmind-harvest-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('findHighSignalFiles collects only top-level STATE/DECISIONS/PROGRESS in .mind dirs', () => {
    mkdirSync(join(root, 'projA', '.mind', 'checkpoints'), { recursive: true });
    writeFileSync(join(root, 'projA', '.mind', 'STATE.md'), 'state');
    writeFileSync(join(root, 'projA', '.mind', 'DECISIONS.md'), 'decisions');
    writeFileSync(join(root, 'projA', '.mind', 'NOTES.md'), 'notes'); // not high-signal
    writeFileSync(join(root, 'projA', '.mind', 'checkpoints', 'STATE.md'), 'nested'); // subdir → skipped
    // SKIP_DIRS must be pruned entirely
    mkdirSync(join(root, 'node_modules', '.mind'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.mind', 'STATE.md'), 'skip');

    const files = findHighSignalFiles(root).map((f) => f.replace(/\\/g, '/'));
    expect(files.some((f) => f.endsWith('projA/.mind/STATE.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('projA/.mind/DECISIONS.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('NOTES.md'))).toBe(false);
    expect(files.some((f) => f.includes('checkpoints'))).toBe(false);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files).toHaveLength(2);
  });

  it('chunkContent splits only when over the byte cap', () => {
    expect(chunkContent('small body')).toEqual(['small body']);
    const big = 'x'.repeat(40 * 1024);
    const chunks = chunkContent(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(big); // lossless
  });

  it('harvestHeader matches the canonical .harvest format (equivalence-gated)', () => {
    expect(harvestHeader('projA', 'STATE.md', 0, 1)).toBe('[harvest .mind project:projA file:STATE.md]\n\n');
    expect(harvestHeader('projA', 'STATE.md', 1, 3)).toBe(
      '[harvest .mind project:projA file:STATE.md chunk:2/3]\n\n',
    );
  });
});
