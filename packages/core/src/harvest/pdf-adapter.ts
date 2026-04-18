/**
 * PDF Adapter — extract text from PDF files via `pdf-parse`.
 *
 * `pdf-parse` is an **optional** peer dependency — install it if you want
 * to harvest PDFs. Without it, `parseFile()` throws a clear install
 * message. The synchronous `parse()` entry returns `[]` because PDF
 * parsing is inherently async; callers should use `parseFile(path)`.
 *
 * Output: one `UniversalImportItem` per ~3000-char chunk, paragraph-split
 * via `chunkByParagraphs`. Each chunk carries the page count and author
 * in metadata when available.
 *
 * Extracted from Waggle OS `packages/core/src/harvest/pdf-adapter.ts`.
 * Scrub: none — this module has no proprietary dependencies.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { SourceAdapter, UniversalImportItem } from './types.js';
import { chunkByParagraphs } from './chunk-utils.js';

const MAX_CHUNK_LENGTH = 3000;

export class PdfAdapter implements SourceAdapter {
  readonly sourceType = 'pdf' as const;
  readonly displayName = 'PDF Document';

  parse(_input: unknown): UniversalImportItem[] {
    // Synchronous parse not supported for PDF — use parseFile().
    return [];
  }

  /** Parse a PDF file from a file path. */
  async parseFile(filePath: string): Promise<UniversalImportItem[]> {
    let PDFParseClass: unknown;
    try {
      const mod = await import('pdf-parse');
      PDFParseClass = mod.PDFParse;
    } catch {
      throw new Error(
        'pdf-parse is not installed. Install it with: npm install pdf-parse\n' +
          'Then retry the import.',
      );
    }

    if (typeof PDFParseClass !== 'function') {
      throw new Error('pdf-parse module found but PDFParse class not available.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`PDF file not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const parser = new (PDFParseClass as new (opts: { data: Buffer }) => {
      load(): Promise<void>;
      getText(params?: object): Promise<{ text: string; pages: { text: string }[] }>;
      getInfo(params?: object): Promise<{ info: Record<string, string>; numPages: number }>;
      destroy(): Promise<void>;
    })({ data: buffer });

    await parser.load();

    const textResult = await parser.getText();
    let infoResult: { info: Record<string, string>; numPages: number } | undefined;
    try {
      infoResult = await parser.getInfo();
    } catch {
      /* info extraction is non-fatal */
    }

    await parser.destroy();

    const fullText = textResult.text ?? '';
    if (fullText.trim().length < 10) {
      return [];
    }

    const info = infoResult?.info ?? {};
    const numPages = infoResult?.numPages ?? 0;
    const docTitle =
      info['Title'] ??
      filePath.split(/[\\/]/).pop()?.replace('.pdf', '') ??
      'PDF Document';

    const chunks = chunkByParagraphs(fullText, MAX_CHUNK_LENGTH);

    return chunks.map((chunk, i) => ({
      id: randomUUID(),
      source: 'pdf' as const,
      type: 'document' as const,
      title: chunks.length > 1 ? `${docTitle} (part ${i + 1})` : docTitle,
      content: chunk.slice(0, 4000),
      timestamp: new Date().toISOString(),
      metadata: {
        filePath,
        contentType: 'paper' as const,
        pages: numPages,
        ...(info['Author'] && { author: info['Author'] }),
        part: i + 1,
        totalParts: chunks.length,
      },
    }));
  }
}
