/**
 * URL Adapter — fetch web pages (or accept pre-fetched HTML) and extract
 * readable content.
 *
 * The synchronous `parse()` entry point accepts pre-fetched HTML strings
 * — use this when the caller already has the page body (e.g. from an
 * existing crawler). `fetchAndParse(url)` pulls the page via the built-in
 * `fetch` with a 15s timeout and a descriptive User-Agent.
 *
 * HTML cleanup uses tag-aware stripping (drops script/style/nav/footer/
 * header entirely, converts headings to markdown-style) rather than a
 * naive tag regex, so the resulting plain text preserves document
 * structure well enough for heading-based splitting below.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/url-adapter.ts`.
 * Scrub: User-Agent rebranded `Waggle-Memory/1.0` → `Hive-Mind/1.0` so
 * server logs of hive-mind consumers don't falsely attribute traffic to
 * Waggle OS.
 */

import { randomUUID } from 'node:crypto';
import type { SourceAdapter, UniversalImportItem } from './types.js';

/** Strip HTML tags and decode common entities. Returns plain text. */
function stripHtml(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');

  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');

  text = text.replace(/<[^>]+>/g, '');

  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Extract <title> from HTML. */
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : undefined;
}

/** Extract meta description from HTML. */
function extractDescription(html: string): string | undefined {
  const match =
    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) ??
    html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  return match ? match[1].trim() : undefined;
}

export class UrlAdapter implements SourceAdapter {
  readonly sourceType = 'url' as const;
  readonly displayName = 'Web URL';

  parse(input: unknown): UniversalImportItem[] {
    if (typeof input !== 'string') return [];

    if (input.includes('<html') || input.includes('<body') || input.includes('<div')) {
      return this.parseHtml(input, undefined);
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
      return [];
    }

    return [];
  }

  /** Fetch a URL and parse its content. Async because of network I/O. */
  async fetchAndParse(url: string): Promise<UniversalImportItem[]> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Hive-Mind/1.0 (knowledge harvester)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();

    if (contentType.includes('text/html') || contentType.includes('xhtml')) {
      return this.parseHtml(body, url);
    }

    return [
      {
        id: randomUUID(),
        source: 'url',
        type: 'document',
        title: url,
        content: body.slice(0, 4000),
        timestamp: new Date().toISOString(),
        metadata: { sourceUrl: url, contentType: 'article' },
      },
    ];
  }

  private parseHtml(html: string, sourceUrl: string | undefined): UniversalImportItem[] {
    const title = extractTitle(html) ?? sourceUrl ?? 'Web page';
    const description = extractDescription(html);
    const plainText = stripHtml(html);

    if (!plainText || plainText.length < 50) return [];

    if (plainText.length <= 4000) {
      return [
        {
          id: randomUUID(),
          source: 'url',
          type: 'document',
          title,
          content: plainText,
          timestamp: new Date().toISOString(),
          metadata: {
            ...(sourceUrl && { sourceUrl }),
            ...(description && { description }),
            contentType: 'article',
          },
        },
      ];
    }

    const sections = plainText.split(/\n(?=#{1,3}\s)/);
    const items: UniversalImportItem[] = [];

    for (const section of sections) {
      const trimmed = section.trim();
      if (trimmed.length < 30) continue;

      const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
      const sectionTitle = headingMatch ? headingMatch[1].trim() : title;

      items.push({
        id: randomUUID(),
        source: 'url',
        type: 'document',
        title: sectionTitle === title ? title : `${title} — ${sectionTitle}`,
        content: trimmed.slice(0, 4000),
        timestamp: new Date().toISOString(),
        metadata: {
          ...(sourceUrl && { sourceUrl }),
          contentType: 'article',
        },
      });
    }

    return items.length > 0
      ? items
      : [
          {
            id: randomUUID(),
            source: 'url',
            type: 'document',
            title,
            content: plainText.slice(0, 4000),
            timestamp: new Date().toISOString(),
            metadata: {
              ...(sourceUrl && { sourceUrl }),
              contentType: 'article',
            },
          },
        ];
  }
}
