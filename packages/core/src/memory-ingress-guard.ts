import { scanForInjection, type ScanResult } from './injection-scanner.js';

export interface ExternalMemoryIngressInput {
  title?: string;
  content: string;
}

export interface ExternalMemoryProjectionInput {
  content: string;
  messages?: unknown;
  parseMethod?: unknown;
  maxChars?: number;
}

export type ExternalMemoryIngressDecision =
  | { action: 'allow'; scan: ScanResult }
  | { action: 'block'; reason: 'prompt_injection'; scan: ScanResult };

// Keep an explicit public-ingress budget, checked before concatenation,
// scanning, or normalization so adversarial inputs remain bounded.
const MAX_EXTERNAL_MEMORY_INGRESS_CHARS = 1_000_000;

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  af: '\u2061',
  amp: '&',
  applyfunction: '\u2061',
  apos: "'",
  colon: ':',
  emsp: ' ',
  ensp: ' ',
  gt: '>',
  hairsp: ' ',
  ic: '\u2063',
  invisiblecomma: '\u2063',
  invisibletimes: '\u2062',
  it: '\u2062',
  lrm: '\u200e',
  lt: '<',
  negativemediumspace: '\u200b',
  negativethickspace: '\u200b',
  negativethinspace: '\u200b',
  negativeverythinspace: '\u200b',
  newline: '\n',
  nbsp: ' ',
  nobreak: '\u2060',
  quot: '"',
  rlm: '\u200f',
  shy: '\u00ad',
  tab: '\t',
  thinsp: ' ',
  zwj: '',
  zwnj: '',
  zwsp: '',
  zerowidthspace: '\u200b',
});

type CanonicalMemoryMessage = {
  role: 'user' | 'assistant' | 'system';
  text: string;
};

/**
 * Return only the attacker-controlled text represented by a stored adapter
 * projection. Role prefixes may be omitted only when plain canonical messages
 * exactly reproduce the full content and did not come from universal raw text.
 */
export function projectExternalMemoryContent(input: ExternalMemoryProjectionInput): string {
  let cappedContent = '';
  try {
    const content = typeof input.content === 'string' ? input.content : '';
    const maxChars = input.maxChars;
    cappedContent = maxChars === undefined
      || !Number.isSafeInteger(maxChars)
      || maxChars < 0
      ? content
      : content.slice(0, maxChars);
    if (input.parseMethod === 'universal-text'
      || !Array.isArray(input.messages)
      || input.messages.length === 0) {
      return cappedContent;
    }

    const messages: CanonicalMemoryMessage[] = [];
    for (const candidate of input.messages) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return cappedContent;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return cappedContent;
      const roleDescriptor = Object.getOwnPropertyDescriptor(candidate, 'role');
      const textDescriptor = Object.getOwnPropertyDescriptor(candidate, 'text');
      if (!roleDescriptor || !('value' in roleDescriptor)
        || !textDescriptor || !('value' in textDescriptor)) {
        return cappedContent;
      }
      const role = roleDescriptor.value as unknown;
      const text = textDescriptor.value as unknown;
      if ((role !== 'user' && role !== 'assistant' && role !== 'system')
        || typeof text !== 'string') {
        return cappedContent;
      }
      messages.push({ role, text });
    }

    const serialized = messages
      .map(message => `${message.role}: ${message.text}`)
      .join('\n\n');
    if (serialized !== content) return cappedContent;

    const parts: string[] = [];
    let cursor = 0;
    let offset = 0;
    for (const [index, message] of messages.entries()) {
      if (index > 0) offset += 2;
      const prefixStart = offset;
      const prefixEnd = prefixStart + `${message.role}: `.length;
      if (prefixStart >= cappedContent.length) break;
      if (message.role === 'system') return cappedContent;
      parts.push(cappedContent.slice(cursor, prefixStart));
      cursor = Math.min(prefixEnd, cappedContent.length);
      offset = prefixEnd + message.text.length;
    }
    parts.push(cappedContent.slice(cursor));
    return parts.join('');
  } catch {
    return cappedContent;
  }
}

function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value
    .replace(/&(?:amp;){2,}/gi, '&')
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, (match, hex: string, decimal: string) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name: string) =>
      NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(
      /&(amp|apos|colon|emsp|ensp|gt|hairsp|lt|newline|nbsp|quot|tab|thinsp|zwj|zwnj|zwsp)(?=[^a-z0-9;]|$)/gi,
      (_match, name: string) => NAMED_HTML_ENTITIES[name.toLowerCase()],
    );
}

function decodePercentEncoding(value: string): string {
  if (!/[+%]/.test(value)) return value;
  const withSpaces = value.replace(/\+/g, ' ');
  return withSpaces.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      const bytes = Uint8Array.from(
        run.match(/[0-9a-f]{2}/gi) ?? [],
        hex => Number.parseInt(hex, 16),
      );
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  });
}

function decodeUnicodeEscapes(value: string): string {
  if (!/\\u/i.test(value)) return value;
  return value.replace(
    /\\u(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/gi,
    (match, braced: string | undefined, fixed: string | undefined) => {
      const codePoint = Number.parseInt(braced ?? fixed ?? '', 16);
      if (!Number.isInteger(codePoint) || codePoint > 0x10ffff) return match;
      if (braced !== undefined) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
        return String.fromCodePoint(codePoint);
      }
      return String.fromCharCode(codePoint);
    },
  );
}

function decodeHexEscapes(value: string): string {
  if (!/\\x/i.test(value)) return value;
  return value.replace(/\\x([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

const MIXED_SCRIPT_CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  '\u0391': 'A',
  '\u0392': 'B',
  '\u0395': 'E',
  '\u0396': 'Z',
  '\u0397': 'H',
  '\u0399': 'I',
  '\u039a': 'K',
  '\u039c': 'M',
  '\u039d': 'N',
  '\u039f': 'O',
  '\u03a1': 'P',
  '\u03a4': 'T',
  '\u03a5': 'Y',
  '\u03a7': 'X',
  '\u03b1': 'a',
  '\u03b5': 'e',
  '\u03b9': 'i',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c7': 'x',
  '\u03f2': 'c',
  '\u03f9': 'C',
  '\u0405': 'S',
  '\u0406': 'I',
  '\u0408': 'J',
  '\u0410': 'A',
  '\u0412': 'B',
  '\u0415': 'E',
  '\u041a': 'K',
  '\u041c': 'M',
  '\u041d': 'H',
  '\u041e': 'O',
  '\u0420': 'P',
  '\u0421': 'C',
  '\u0422': 'T',
  '\u0425': 'X',
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0455': 's',
  '\u0456': 'i',
  '\u0458': 'j',
});

const MIXED_SCRIPT_CONFUSABLE_PATTERN = /[\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u03b1\u03b5\u03b9\u03bf\u03c1\u03c7\u03f2\u03f9\u0405\u0406\u0408\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458]/;
const MIXED_SCRIPT_CONFUSABLE_REPLACE_PATTERN = new RegExp(
  MIXED_SCRIPT_CONFUSABLE_PATTERN.source,
  'g',
);

function projectMixedScriptConfusables(value: string): string | undefined {
  if (!MIXED_SCRIPT_CONFUSABLE_PATTERN.test(value)) return undefined;
  let changed = false;
  const projected = value.replace(/[\p{L}\p{M}]+/gu, (token) => {
    if (!/[A-Za-z]/.test(token) || !MIXED_SCRIPT_CONFUSABLE_PATTERN.test(token)) return token;
    changed = true;
    return token.replace(
      MIXED_SCRIPT_CONFUSABLE_REPLACE_PATTERN,
      char => MIXED_SCRIPT_CONFUSABLES[char] ?? char,
    );
  });
  return changed ? projected : undefined;
}

const BASE64_CANDIDATE_PATTERN = /(?:^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{24,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g;
const MAX_BASE64_CANDIDATES = 16;
const MAX_BASE64_CANDIDATE_CHARS = 262_144;
const MAX_BASE64_TOTAL_CHARS = 524_288;
const MAX_BASE64_DEPTH = 4;

type Base64Candidate = {
  value: string;
  start: number;
  end: number;
};

function collectBase64Candidates(source: string, allowImplicitWrapped = false): {
  candidates: Base64Candidate[];
  complete: boolean;
} {
  const wrappedBlocks: Base64Candidate[] = [];

  const trimmed = source.trim();
  const wrappedChunks = trimmed.split(/[ \t\r\n]+/);
  const wrapWidth = wrappedChunks[0]?.length ?? 0;
  if (allowImplicitWrapped
    && wrappedChunks.length > 1
    && wrapWidth >= 4
    && wrapWidth <= 76
    && wrapWidth % 4 === 0
    && wrappedChunks.every(chunk => /^[A-Za-z0-9+/_-]+={0,2}$/.test(chunk))
    && wrappedChunks.slice(0, -1).every(chunk => chunk.length === wrapWidth && !chunk.includes('='))
    && wrappedChunks.at(-1)!.length <= wrapWidth) {
    const candidate = wrappedChunks.join('');
    if (candidate.length >= 24) {
      const start = source.length - source.trimStart().length;
      wrappedBlocks.push({ value: candidate, start, end: start + trimmed.length });
    }
  }

  const directivePattern = /(?:\bdecode\b[^\r\n:]{0,160}\bbase64\b|\bbase64\b[^\r\n:]{0,160}\bdecode\b)[^\r\n:]{0,160}:/gi;
  for (const directive of source.matchAll(directivePattern)) {
    const tailStart = (directive.index ?? 0) + directive[0].length;
    const tail = source.slice(tailStart);
    const wrapped = tail.match(/^[ \t\r\n]*([A-Za-z0-9+/_=-]+(?:[ \t\r\n]+[A-Za-z0-9+/_=-]+)*)/);
    if (!wrapped) continue;
    const captured = wrapped[1];
    const start = tailStart + wrapped[0].indexOf(captured);
    let candidate = '';
    let end = start;
    for (const chunk of captured.matchAll(/[A-Za-z0-9+/_=-]+/g)) {
      candidate += chunk[0];
      end = start + (chunk.index ?? 0) + chunk[0].length;
      if (chunk[0].includes('=')) break;
    }
    if (candidate.length >= 24) wrappedBlocks.push({ value: candidate, start, end });
  }

  const candidates: Base64Candidate[] = [];
  const contiguousPattern = new RegExp(BASE64_CANDIDATE_PATTERN.source, 'g');
  for (const match of source.matchAll(contiguousPattern)) {
    const value = match[1];
    const start = (match.index ?? 0) + match[0].length - value.length;
    const end = start + value.length;
    if (wrappedBlocks.some(block => start >= block.start && end <= block.end)) continue;
    candidates.push({ value, start, end });
  }
  candidates.push(...wrappedBlocks);
  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  return { candidates, complete: true };
}

function decodeBase64Text(candidate: string): string | undefined {
  let normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 1) return undefined;
  if (remainder > 0) normalized += '='.repeat(4 - remainder);

  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    if (!decoded) return undefined;

    let printable = 0;
    let total = 0;
    for (const char of decoded) {
      total++;
      const codePoint = char.codePointAt(0) ?? 0;
      const isPrintable = char === '\n' || char === '\r' || char === '\t'
        || (codePoint >= 0x20 && codePoint !== 0x7f);
      if (codePoint !== 0xfffd && isPrintable) {
        printable++;
      }
    }
    return total > 0 && printable / total >= 0.85 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function addProjection(projections: Set<string>, value: string): void {
  if (projections.has(value)) return;
  projections.add(value);
  const confusable = projectMixedScriptConfusables(value);
  if (confusable !== undefined) projections.add(confusable);
}

const FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;

function isHiddenSeparator(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint <= 0x9f) {
    return codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint >= 0x7f;
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  return FORMAT_CHARACTER_PATTERN.test(char) || DEFAULT_IGNORABLE_PATTERN.test(char);
}

function replaceHiddenSeparators(value: string, replacement: string): string {
  let containsHidden = false;
  for (const char of value) {
    if (isHiddenSeparator(char)) {
      containsHidden = true;
      break;
    }
  }
  if (!containsHidden) return value;

  let projected = '';
  for (const char of value) projected += isHiddenSeparator(char) ? replacement : char;
  return projected;
}

function projectDelimitedWords(value: string): string | undefined {
  const projected = value.replace(
    /(\p{L})[\p{P}\p{S}]+(?=\p{L})/gu,
    '$1 ',
  );
  return projected === value ? undefined : projected;
}

type HtmlTagBoundary =
  | { kind: 'close'; index: number }
  | { kind: 'nested'; index: number }
  | { kind: 'eof'; index: number };

function findHtmlTagBoundary(value: string, start: number): HtmlTagBoundary {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < value.length; index++) {
    const char = value[index];
    if (char === '<') return { kind: 'nested', index };
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return { kind: 'close', index };
    }
  }
  return { kind: 'eof', index: value.length };
}

function normalizeHtmlToken(value: string): string {
  return value.replace(/[:_-]+/g, ' ');
}

function extractHtmlAttributeTokens(value: string, start: number, end: number): string {
  const tokens: string[] = [];
  let index = start;
  while (index < end) {
    while (index < end && /[\s/]/.test(value[index])) index++;
    const nameStart = index;
    while (index < end && !/[\s=/>]/.test(value[index])) index++;
    if (index === nameStart) {
      index++;
      continue;
    }
    const name = normalizeHtmlToken(value.slice(nameStart, index));
    while (index < end && /\s/.test(value[index])) index++;
    if (value[index] !== '=') {
      if (name) tokens.push(name);
      continue;
    }
    index++;
    while (index < end && /\s/.test(value[index])) index++;

    const quote = value[index] === '"' || value[index] === "'"
      ? value[index]
      : undefined;
    if (quote) index++;
    const valueStart = index;
    if (quote) {
      while (index < end && value[index] !== quote) index++;
    } else {
      while (index < end && !/[\s>]/.test(value[index])) index++;
    }
    if (index > valueStart) tokens.push(normalizeHtmlToken(value.slice(valueStart, index)));
    if (quote && index < end) index++;
  }
  return tokens.join(' ');
}

function stripHtmlMarkup(value: string): {
  rendered: string;
  tagNames: string;
  attributes: string;
  lexical: string;
} {
  if (!value.includes('<')) {
    return { rendered: value, tagNames: value, attributes: value, lexical: value };
  }

  const rendered: string[] = [];
  const tagNames: string[] = [];
  const attributes: string[] = [];
  const lexical: string[] = [];
  for (let index = 0; index < value.length;) {
    if (value.startsWith('<!--', index)) {
      const commentEnd = value.indexOf('-->', index + 4);
      if (commentEnd === -1) {
        const visibleTail = value.slice(index + 4);
        rendered.push(visibleTail);
        tagNames.push(visibleTail);
        attributes.push(visibleTail);
        lexical.push(visibleTail);
        break;
      }
      const commentText = value.slice(index + 4, commentEnd);
      if (commentText) {
        tagNames.push(' ', commentText, ' ');
        attributes.push(' ', commentText, ' ');
        lexical.push(' ', commentText, ' ');
      }
      index = commentEnd + 3;
      continue;
    }
    if (value.startsWith('-->', index)) {
      index += 3;
      continue;
    }
    if (value[index] === '<' && /[!/A-Za-z?]/.test(value[index + 1] ?? '')) {
      let tagNameEnd = index + 1;
      if (value[tagNameEnd] === '/') tagNameEnd++;
      const tagNameStart = tagNameEnd;
      while (/[A-Za-z0-9:!_-]/.test(value[tagNameEnd] ?? '')) tagNameEnd++;
      const tagName = normalizeHtmlToken(value.slice(tagNameStart, tagNameEnd));
      const boundary = findHtmlTagBoundary(value, tagNameEnd);
      if (boundary.kind === 'close') {
        const attributeTokens = extractHtmlAttributeTokens(
          value,
          tagNameEnd,
          boundary.index,
        );
        if (tagName) tagNames.push(' ', tagName, ' ');
        if (attributeTokens) attributes.push(' ', attributeTokens, ' ');
        if (tagName || attributeTokens) {
          lexical.push(' ', tagName, ' ', attributeTokens, ' ');
        }
        index = boundary.index + 1;
        continue;
      }
      const visibleTail = value.slice(tagNameEnd, boundary.index);
      rendered.push(visibleTail);
      if (tagName) tagNames.push(' ', tagName, ' ');
      tagNames.push(visibleTail);
      attributes.push(visibleTail);
      if (tagName) lexical.push(' ', tagName, ' ');
      lexical.push(visibleTail);
      if (boundary.kind === 'eof') break;
      index = boundary.index;
      continue;
    }
    rendered.push(value[index]);
    tagNames.push(value[index]);
    attributes.push(value[index]);
    lexical.push(value[index]);
    index++;
  }
  return {
    rendered: rendered.join(''),
    tagNames: tagNames.join(''),
    attributes: attributes.join(''),
    lexical: lexical.join(''),
  };
}

function normalizedIngressProjections(value: string): {
  projections: string[];
  complete: boolean;
};
function normalizedIngressProjections(value: string, includeBase64: boolean): {
  projections: string[];
  complete: boolean;
};
function normalizedIngressProjections(value: string, includeBase64 = true): {
  projections: string[];
  complete: boolean;
} {
  const maxPasses = 64;
  const maxWork = MAX_EXTERNAL_MEMORY_INGRESS_CHARS + 1;
  const originalProjection = value.normalize('NFKC');
  const normalizationStages = new Set([originalProjection]);
  let decodedProjection = originalProjection;
  let complete = false;
  let work = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    work += decodedProjection.length;
    if (work > maxWork) break;
    const decodedText = decodeUnicodeEscapes(decodeHexEscapes(
      decodeHtmlEntities(decodePercentEncoding(decodedProjection)),
    ));
    const decoded = decodedText === decodedProjection
      ? decodedProjection
      : decodedText.normalize('NFKC');
    if (decoded === decodedProjection) {
      complete = true;
      break;
    }
    normalizationStages.add(decoded);
    decodedProjection = decoded;
  }
  if (!complete) return { projections: [decodedProjection], complete: false };

  const htmlProjections = stripHtmlMarkup(decodedProjection);
  const projections = new Set<string>();
  for (const projection of normalizationStages) addProjection(projections, projection);
  for (const projection of new Set([
    htmlProjections.rendered,
    htmlProjections.tagNames,
    htmlProjections.attributes,
    htmlProjections.lexical,
  ])) {
    let unformatted = projection;
    if (unformatted.includes('[')) {
      unformatted = unformatted
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
    }
    if (/[*_~`]/.test(unformatted)) unformatted = unformatted.replace(/[*_~`]/g, '');
    const compact = replaceHiddenSeparators(unformatted, '');
    addProjection(projections, compact);
    if (compact !== unformatted) {
      addProjection(projections, replaceHiddenSeparators(unformatted, ' '));
    }
  }

  if (!includeBase64) return { projections: [...projections], complete: true };

  const candidateLineages = new Map<number, Map<string, number[]>>();
  let nextCandidateLineage = 1;
  const resolveCandidateLineage = (
    parentLineage: number,
    candidate: string,
    ordinal: number,
  ): { lineage: number; created: boolean } => {
    let candidates = candidateLineages.get(parentLineage);
    if (!candidates) {
      candidates = new Map();
      candidateLineages.set(parentLineage, candidates);
    }
    let lineages = candidates.get(candidate);
    if (!lineages) {
      lineages = [];
      candidates.set(candidate, lineages);
    }
    const existing = lineages[ordinal];
    if (existing !== undefined) return { lineage: existing, created: false };
    const lineage = nextCandidateLineage++;
    lineages[ordinal] = lineage;
    return { lineage, created: true };
  };
  let decodedCandidateCount = 0;
  let decodedCandidateChars = 0;
  let base64Sources = [...projections].map(value => ({ value, lineage: 0 }));
  let reachedDepthLimit = true;
  for (let depth = 0; depth < MAX_BASE64_DEPTH; depth++) {
    const decodedValues: Array<{ value: string; lineage: number }> = [];
    for (const source of base64Sources) {
      const collected = collectBase64Candidates(source.value, depth > 0);
      if (!collected.complete) return { projections: [...projections], complete: false };
      const occurrenceCounts = new Map<string, number>();
      for (const occurrence of collected.candidates) {
        const candidate = occurrence.value;
        const ordinal = occurrenceCounts.get(candidate) ?? 0;
        occurrenceCounts.set(candidate, ordinal + 1);
        const occurrenceLineage = resolveCandidateLineage(
          source.lineage,
          candidate,
          ordinal,
        );
        if (!occurrenceLineage.created) continue;
        if (candidate.length > MAX_BASE64_CANDIDATE_CHARS) {
          return { projections: [...projections], complete: false };
        }
        const decoded = decodeBase64Text(candidate);
        if (decoded === undefined) continue;
        decodedCandidateCount++;
        decodedCandidateChars += candidate.length;
        if (decodedCandidateCount > MAX_BASE64_CANDIDATES
          || decodedCandidateChars > MAX_BASE64_TOTAL_CHARS) {
          return { projections: [...projections], complete: false };
        }
        decodedValues.push({ value: decoded, lineage: occurrenceLineage.lineage });
      }
    }
    if (decodedValues.length === 0) {
      reachedDepthLimit = false;
      break;
    }

    const nextSources: Array<{ value: string; lineage: number }> = [];
    for (const decoded of decodedValues) {
      const nested = normalizedIngressProjections(decoded.value, false);
      if (!nested.complete) return { projections: [...projections], complete: false };
      for (const projection of nested.projections) {
        addProjection(projections, projection);
        nextSources.push({ value: projection, lineage: decoded.lineage });
      }
    }
    base64Sources = nextSources;
  }

  if (reachedDepthLimit && base64Sources.length > 0) {
    for (const source of base64Sources) {
      const collected = collectBase64Candidates(source.value, true);
      if (!collected.complete) return { projections: [...projections], complete: false };
      const occurrenceCounts = new Map<string, number>();
      for (const occurrence of collected.candidates) {
        const candidate = occurrence.value;
        const ordinal = occurrenceCounts.get(candidate) ?? 0;
        occurrenceCounts.set(candidate, ordinal + 1);
        const occurrenceSeen = candidateLineages
          .get(source.lineage)
          ?.get(candidate)?.[ordinal] !== undefined;
        if (!occurrenceSeen
          && decodeBase64Text(candidate) !== undefined) {
          return { projections: [...projections], complete: false };
        }
      }
    }
  }

  return { projections: [...projections], complete: true };
}

/** Evaluate untrusted content before it can enter persistent memory. */
export function evaluateExternalMemoryIngress(
  input: ExternalMemoryIngressInput,
): ExternalMemoryIngressDecision {
  const title = input.title ?? '';
  if (title.length > MAX_EXTERNAL_MEMORY_INGRESS_CHARS
    || input.content.length > MAX_EXTERNAL_MEMORY_INGRESS_CHARS - title.length) {
    return {
      action: 'block',
      reason: 'prompt_injection',
      scan: { safe: false, score: 0.6, flags: ['normalization_limit'] },
    };
  }

  const projection = `${title}\n${input.content}`;
  let scan = scanForInjection(projection, 'tool_output');
  if (scan.safe) {
    const normalizedIngress = normalizedIngressProjections(projection);
    for (const normalized of normalizedIngress.projections) {
      if (normalized !== projection) {
        const normalizedScan = scanForInjection(normalized, 'tool_output');
        if (!normalizedScan.safe) {
          scan = normalizedScan;
          break;
        }
      }
      const delimited = projectDelimitedWords(normalized);
      if (delimited !== undefined) {
        const delimitedScan = scanForInjection(delimited, 'tool_output');
        if (!delimitedScan.safe) {
          scan = delimitedScan;
          break;
        }
      }
    }
    if (scan.safe && !normalizedIngress.complete) {
      scan = { safe: false, score: 0.6, flags: ['normalization_limit'] };
    }
  }

  return scan.safe
    ? { action: 'allow', scan }
    : { action: 'block', reason: 'prompt_injection', scan };
}
