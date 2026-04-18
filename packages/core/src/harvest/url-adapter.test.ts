import { describe, it, expect } from 'vitest';
import { UrlAdapter } from './url-adapter.js';

describe('UrlAdapter', () => {
  const adapter = new UrlAdapter();

  it('returns [] for non-HTML strings and bare URLs', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse('')).toEqual([]);
    expect(adapter.parse('https://example.com')).toEqual([]);
    expect(adapter.parse('plain text, no tags')).toEqual([]);
  });

  it('strips scripts, styles, nav/footer/header and extracts title + description', () => {
    const html = `<!doctype html>
<html>
<head>
  <title>  Hive-Mind   Launch  </title>
  <meta name="description" content="A memory system for AI agents."/>
</head>
<body>
  <nav>should be removed</nav>
  <header>header too</header>
  <script>alert('x');</script>
  <style>body { color: red; }</style>
  <div>
    <h1>Welcome</h1>
    <p>First paragraph of real content.</p>
    <p>Second paragraph.</p>
  </div>
  <footer>bye</footer>
</body>
</html>`;
    const items = adapter.parse(html);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('url');
    expect(items[0].title).toBe('Hive-Mind Launch');
    expect(items[0].metadata.description).toBe('A memory system for AI agents.');
    expect(items[0].content).toContain('Welcome');
    expect(items[0].content).toContain('First paragraph of real content.');
    expect(items[0].content).not.toContain('alert');
    expect(items[0].content).not.toContain('should be removed');
    expect(items[0].content).not.toContain('header too');
    expect(items[0].content).not.toContain('bye');
  });

  it('splits long pages (> 4000 chars plain text) by headings', () => {
    // parseHtml only splits by headings once the stripped plain text exceeds
    // 4000 chars — below that a single item is returned. Size each section
    // comfortably above the per-section 30-char minimum and past the 4000-char
    // whole-page threshold.
    const longPara = 'p '.repeat(1000); // ~2000 chars per section
    const html = `<html><body>
<h1>First Section</h1><p>${longPara}</p>
<h2>Second Section</h2><p>${longPara}</p>
<h3>Third Section</h3><p>${longPara}</p>
</body></html>`;
    const items = adapter.parse(html);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const combined = items.map((i) => i.title).join(' | ');
    expect(combined).toContain('First Section');
  });
});
