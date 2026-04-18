import { describe, it, expect } from 'vitest';
import { PdfAdapter } from './pdf-adapter.js';

describe('PdfAdapter', () => {
  const adapter = new PdfAdapter();

  it('exposes canonical sourceType and displayName', () => {
    expect(adapter.sourceType).toBe('pdf');
    expect(adapter.displayName).toBe('PDF Document');
  });

  it('returns [] from the synchronous parse entry point regardless of input', () => {
    // Parsing PDFs is inherently async — the sync entry is a documented stub.
    expect(adapter.parse('anything')).toEqual([]);
    expect(adapter.parse({ path: '/tmp/fake.pdf' })).toEqual([]);
    expect(adapter.parse(null)).toEqual([]);
  });

  it('parseFile throws a clear error for nonexistent paths', async () => {
    await expect(
      adapter.parseFile('/nonexistent/definitely/missing.pdf'),
    ).rejects.toThrow(/PDF file not found/);
  });
});
