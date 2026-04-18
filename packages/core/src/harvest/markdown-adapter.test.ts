import { describe, it, expect } from 'vitest';
import { MarkdownAdapter } from './markdown-adapter.js';

describe('MarkdownAdapter', () => {
  const adapter = new MarkdownAdapter();

  it('returns [] for non-string inputs', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse(42)).toEqual([]);
  });

  it('returns a single item with an "Untitled section" fallback title when there are no headings', () => {
    // Text with no heading lines produces one section whose `heading` is empty;
    // parse() then uses the `section.heading || docTitle || 'Untitled section'`
    // cascade, and with no sourcePath and no heading we land on the fallback.
    // The `title: 'Document'` branch only triggers when splitByHeadings returns
    // zero sections at all (e.g. input that collapses to empty content).
    const items = adapter.parse('Just a short line of markdown without headings.\n\nAnother paragraph.');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Untitled section');
  });

  it('splits by heading and extracts bold terms as concept entities', () => {
    const md = `# Launch

Summary of the **Q2 launch**.

## Team

The **Alice** team is leading.

## Risk

**Stripe** integration is the blocker.`;
    const items = adapter.parse(md);
    expect(items.length).toBeGreaterThanOrEqual(3);
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Launch');
    expect(titles).toContain('Team');
    expect(titles).toContain('Risk');

    const launch = items.find((i) => i.title === 'Launch')!;
    const entities = launch.metadata.entities as Array<{ name: string; type: string }>;
    expect(entities).toEqual([{ name: 'Q2 launch', type: 'concept' }]);

    const risk = items.find((i) => i.title === 'Risk')!;
    expect(risk.metadata.headingLevel).toBe(2);
  });

  it('stores first-level heading at headingLevel=1, second at 2', () => {
    const items = adapter.parse(`# One\n\nAlpha\n\n## Two\n\nBravo`);
    expect(items[0].metadata.headingLevel).toBe(1);
    expect(items[1].metadata.headingLevel).toBe(2);
  });
});
