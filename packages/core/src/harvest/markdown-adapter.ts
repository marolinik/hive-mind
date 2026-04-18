/**
 * Markdown Adapter — parse .md files into UniversalImportItems split by
 * heading.
 *
 * Splits on `#` / `##` / `###` headings — each section becomes its own
 * `UniversalImportItem`. Bold terms (`**term**`) inside a section are
 * extracted as lightweight concept entities in metadata. If the input
 * has no headings, the whole document is returned as a single item.
 *
 * Like the plaintext adapter, accepts either a file path (short string,
 * no newlines) or raw markdown content.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/markdown-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { SourceAdapter, UniversalImportItem } from './types.js';

interface MarkdownSection {
  heading: string;
  level: number;
  content: string;
}

function splitByHeadings(text: string): MarkdownSection[] {
  const lines = text.split('\n');
  const sections: MarkdownSection[] = [];
  let currentHeading = '';
  let currentLevel = 0;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentLines.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[2].trim();
      currentLevel = headingMatch[1].length;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentLines.join('\n').trim(),
    });
  }

  return sections.filter((s) => s.content.length > 0);
}

function extractBoldTerms(text: string): string[] {
  const matches = text.matchAll(/\*\*([^*]+)\*\*/g);
  const terms: string[] = [];
  for (const m of matches) {
    const term = m[1].trim();
    if (term.length > 1 && term.length < 80) {
      terms.push(term);
    }
  }
  return [...new Set(terms)];
}

export class MarkdownAdapter implements SourceAdapter {
  readonly sourceType = 'markdown' as const;
  readonly displayName = 'Markdown';

  parse(input: unknown): UniversalImportItem[] {
    if (typeof input !== 'string') return [];

    let content: string;
    let sourcePath: string | undefined;

    if (input.length < 500 && !input.includes('\n')) {
      try {
        if (fs.existsSync(input)) {
          content = fs.readFileSync(input, 'utf-8');
          sourcePath = input;
        } else {
          content = input;
        }
      } catch {
        content = input;
      }
    } else {
      content = input;
    }

    if (!content.trim()) return [];

    const sections = splitByHeadings(content);

    if (sections.length === 0) {
      return [
        {
          id: randomUUID(),
          source: 'markdown',
          type: 'document',
          title: sourcePath
            ? sourcePath.split(/[\\/]/).pop()?.replace('.md', '') ?? 'Document'
            : 'Document',
          content: content.slice(0, 4000),
          timestamp: new Date().toISOString(),
          metadata: {
            ...(sourcePath && { filePath: sourcePath }),
            contentType: 'note',
          },
        },
      ];
    }

    const items: UniversalImportItem[] = [];
    const docTitle = sourcePath?.split(/[\\/]/).pop()?.replace('.md', '');

    for (const section of sections) {
      const boldTerms = extractBoldTerms(section.content);
      const entities = boldTerms.slice(0, 10).map((t) => ({ name: t, type: 'concept' }));

      items.push({
        id: randomUUID(),
        source: 'markdown',
        type: 'document',
        title: section.heading || docTitle || 'Untitled section',
        content: section.content.slice(0, 4000),
        timestamp: new Date().toISOString(),
        metadata: {
          ...(sourcePath && { filePath: sourcePath }),
          headingLevel: section.level,
          contentType: 'note',
          ...(entities.length > 0 && { entities }),
        },
      });
    }

    return items;
  }
}
