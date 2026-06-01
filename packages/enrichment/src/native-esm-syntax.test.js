/**
 * Native-ESM syntax guard.
 *
 * WHY THIS EXISTS: vitest transforms modules through esbuild, which silently
 * DEDUPES duplicate exports. So a `export function foo(){}` + `export { foo }`
 * duplicate (a hard `SyntaxError` under real `node`) loads fine under vitest and
 * every unit test stays green — while `node packages/wiki-web/src/server.js` and
 * every Claude Code hook crash on import in production. That exact bug shipped in
 * cli-bridge.js from v0.3.0 and was invisible to 512 green tests.
 *
 * These tests shell out to a real `node` so the strict native parser — not
 * esbuild — is the judge. `node --check` parses without executing.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/enrichment/src -> repo root
const REPO = path.resolve(__dirname, '..', '..', '..');

// Plain-JS packages that ship as source and are run by native `node`
// (not bundled, so esbuild never gets a chance to mask a syntax error).
const ROOTS = [
  'packages/enrichment/src',
  'packages/wiki-web/src',
  'packages/wiki-web/bin',
  'packages/wiki-web/public',
  'packages/claude-code-hooks/hooks',
  'packages/claude-code-hooks/bin',
  'e2e',
];

function walkJs(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(full));
    else if (/\.(js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walkJs(path.join(REPO, r)));

describe('native ESM syntax (esbuild masks what node rejects)', () => {
  it('discovers plain-JS sources to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('node --check passes: %s', (file) => {
    expect(() =>
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('native import of @hive-mind/enrichment resolves (the original cli-bridge crash)', () => {
    const code =
      "import('@hive-mind/enrichment')" +
      '.then(() => process.exit(0))' +
      '.catch((e) => { console.error(e && e.message); process.exit(1); })';
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: REPO,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
