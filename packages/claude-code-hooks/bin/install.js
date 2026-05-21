#!/usr/bin/env node
/**
 * Install / uninstall / verify / preview the hive-mind Claude Code hooks against
 * the user's ~/.claude/settings.json.
 *
 * Prefer the plugin route (`/plugin install hive-mind@hive-mind` in Claude Code)
 * over this manual installer. This script remains as a fallback for users who
 * cannot use the plugin marketplace (older Claude Code versions, CI, etc.).
 *
 * SAFETY:
 *   - never runs install without explicit `install --confirm`.
 *   - always backs up settings.json before any modification.
 *   - `preview` writes a non-binding preview file the user inspects first.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  deriveWorkspace,
  buildRecallQuery,
  getCliPath,
  callMcp,
} from '@hive-mind/enrichment';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(PKG_ROOT, 'hooks');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const PREVIEW_FILE = path.join(os.homedir(), '.hive-mind', 'settings.preview.json');

function hookCmd(name) {
  const hookPath = path.join(HOOKS_DIR, `${name}.js`).replace(/\\/g, '/');
  return `node "${hookPath}"`;
}

function buildHookEntries() {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start'), timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('user-prompt-submit'), timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop'), timeout: 3 }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: hookCmd('pre-compact'), timeout: 5 }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: hookCmd('post-tool-use'), timeout: 2 }] }],
  };
}

function ensureDirFor(file) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function cmdVerify() {
  const lines = [];
  // 1. Enrichment module
  try {
    if (typeof deriveWorkspace !== 'function' || typeof buildRecallQuery !== 'function') {
      throw new Error('exports missing');
    }
    lines.push('ENRICHMENT MODULE OK');
  } catch (err) {
    lines.push(`ENRICHMENT MODULE FAIL: ${err.message}`);
  }

  // 2. CLI bridge
  const cli = getCliPath();
  if (cli) {
    lines.push(`CLI bridge OK (cli at ${cli})`);
  } else {
    lines.push('CLI bridge: will fall back to `npx -y @hive-mind/cli` (slow first call, cached after)');
  }
  // Try a tiny call regardless — npx fallback is functional even without a local CLI
  const probe = await callMcp('recall_memory', { query: 'verify probe', limit: 1, scope: 'personal' }, { timeoutMs: 8000 });
  if (probe.ok) {
    const n = Array.isArray(probe.data) ? probe.data.length : 0;
    lines.push(`CLI probe OK (recall returned ${n} hits)`);
  } else {
    lines.push(`CLI probe WARN: ${probe.error}`);
  }

  // 3. Workspace derivation
  const cwd = process.cwd();
  const ws = deriveWorkspace(cwd);
  lines.push(`WORKSPACE FOR CWD: ${ws.id} (name="${ws.name}", cwd=${cwd})`);

  // 4. Hook scripts present
  const hookFiles = ['session-start.js', 'user-prompt-submit.js', 'stop.js', 'pre-compact.js', 'post-tool-use.js'];
  for (const h of hookFiles) {
    const p = path.join(HOOKS_DIR, h);
    if (existsSync(p)) lines.push(`HOOK ${h} OK`);
    else lines.push(`HOOK ${h} MISSING`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

function cmdPreview() {
  const entries = buildHookEntries();
  const preview = {
    _comment: 'PREVIEW — paste the `hooks` block into ~/.claude/settings.json, or run `hive-mind-hooks install --confirm` to merge automatically (with backup). Prefer `/plugin install hive-mind@hive-mind` inside Claude Code for the cleanest setup.',
    hooks: entries,
  };
  ensureDirFor(PREVIEW_FILE);
  writeFileSync(PREVIEW_FILE, JSON.stringify(preview, null, 2) + '\n', 'utf8');
  process.stdout.write(`Preview written to: ${PREVIEW_FILE}\n`);
  process.exit(0);
}

function cmdInstall(confirm) {
  if (!confirm) {
    process.stdout.write('Refusing to modify settings.json without --confirm.\nRun: install --confirm\n');
    process.exit(1);
    return;
  }
  if (!existsSync(SETTINGS)) {
    process.stdout.write(`No settings.json at ${SETTINGS}. Aborting.\n`);
    process.exit(1);
    return;
  }
  // Backup
  const backup = `${SETTINGS}.test-backup-${Date.now()}`;
  copyFileSync(SETTINGS, backup);
  process.stdout.write(`Backed up to: ${backup}\n`);

  let json;
  try {
    json = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (err) {
    process.stdout.write(`Failed to parse settings.json: ${err.message}\nAborting.\n`);
    process.exit(1);
    return;
  }
  const entries = buildHookEntries();
  json.hooks = { ...(json.hooks || {}), ...entries };
  writeFileSync(SETTINGS, JSON.stringify(json, null, 2) + '\n', 'utf8');
  process.stdout.write(`Installed sandbox hooks into: ${SETTINGS}\n`);
  process.exit(0);
}

function cmdUninstall(confirm, backupPath) {
  if (!confirm) {
    process.stdout.write('Refusing to modify settings.json without --confirm.\nRun: uninstall --confirm [--backup PATH]\n');
    process.exit(1);
    return;
  }
  if (backupPath && existsSync(backupPath)) {
    copyFileSync(backupPath, SETTINGS);
    process.stdout.write(`Restored ${SETTINGS} from ${backupPath}\n`);
    process.exit(0);
    return;
  }
  // Otherwise, just remove the keys we added.
  if (!existsSync(SETTINGS)) {
    process.stdout.write('No settings.json found.\n');
    process.exit(0);
    return;
  }
  let json;
  try { json = JSON.parse(readFileSync(SETTINGS, 'utf8')); }
  catch { process.stdout.write('Could not parse settings.json. Aborting.\n'); process.exit(1); return; }
  const sandboxNeedles = ['@hive-mind/claude-code-hooks', 'packages/claude-code-hooks/hooks'];
  if (json.hooks && typeof json.hooks === 'object') {
    for (const [evt, list] of Object.entries(json.hooks)) {
      if (!Array.isArray(list)) continue;
      json.hooks[evt] = list.filter((entry) => {
        const cmd = entry && entry.hooks && entry.hooks[0] && entry.hooks[0].command;
        if (typeof cmd !== 'string') return true;
        return !sandboxNeedles.some((n) => cmd.includes(n));
      });
      if (json.hooks[evt].length === 0) delete json.hooks[evt];
    }
  }
  writeFileSync(SETTINGS, JSON.stringify(json, null, 2) + '\n', 'utf8');
  process.stdout.write(`Removed sandbox hook entries from ${SETTINGS}\n`);
  process.exit(0);
}

function help() {
  process.stdout.write([
    'hive-mind-hooks <command>',
    '',
    'Commands:',
    '  verify                       run smoke checks',
    '  preview                      write settings.preview.json (no edits)',
    '  install --confirm            merge hooks into ~/.claude/settings.json (backs up first)',
    '  uninstall --confirm          remove sandbox hook entries',
    '  uninstall --confirm --backup PATH   restore from a specific backup',
    '',
  ].join('\n'));
}

const cmd = process.argv[2];
const flags = process.argv.slice(3);
const confirm = flags.includes('--confirm');
const backupIdx = flags.indexOf('--backup');
const backupPath = backupIdx >= 0 ? flags[backupIdx + 1] : undefined;

switch (cmd) {
  case 'verify':    await cmdVerify();    break;
  case 'preview':   cmdPreview();    break;
  case 'install':   cmdInstall(confirm);    break;
  case 'uninstall': cmdUninstall(confirm, backupPath);    break;
  case '--help':
  case '-h':
  case 'help':
  case undefined:   help(); process.exit(0); break;
  default:          help(); process.exit(1);
}
