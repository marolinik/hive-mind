/**
 * Plaintext Adapter — parse .txt files or raw text into UniversalImportItems.
 *
 * Detects whether the input looks like a short file path (no newlines,
 * under 500 chars) and reads from disk if the file exists, otherwise
 * treats the string as raw content. Either way the result is paragraph-
 * chunked via `chunkByParagraphs`.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/plaintext-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { SourceAdapter, UniversalImportItem } from './types.js';
import { chunkByParagraphs } from './chunk-utils.js';

export class PlaintextAdapter implements SourceAdapter {
  readonly sourceType = 'plaintext' as const;
  readonly displayName = 'Plain Text';

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

    const chunks = chunkByParagraphs(content);
    const docTitle = sourcePath?.split(/[\\/]/).pop()?.replace(/\.\w+$/, '');

    return chunks.map((chunk, i) => ({
      id: randomUUID(),
      source: 'plaintext' as const,
      type: 'document' as const,
      title: docTitle
        ? chunks.length > 1
          ? `${docTitle} (part ${i + 1})`
          : docTitle
        : `Text fragment ${i + 1}`,
      content: chunk.slice(0, 4000),
      timestamp: new Date().toISOString(),
      metadata: {
        ...(sourcePath && { filePath: sourcePath }),
        contentType: 'note',
        part: i + 1,
        totalParts: chunks.length,
      },
    }));
  }
}
