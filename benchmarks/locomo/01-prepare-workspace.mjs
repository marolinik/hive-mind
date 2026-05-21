#!/usr/bin/env node
// Phase 1 — Prepare LoCoMo workspace
//
// Creates a clean `proj-locomo-<unix_ms>` workspace via WorkspaceManager.ensure
// (idempotent direct-id create — bypasses slug-collision logic since the id is
// already unique by construction). Writes RUN.json that downstream phases use
// to find the workspace, the dataset, and to assert the dataset hasn't drifted.
//
// Re-running is safe: if RUN.json already exists, this script is a no-op
// unless --force is passed. This lets `node run.mjs --start-from=2` skip
// preparation on iteration runs of the harness itself.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR_LOCAL = resolve(__dirname, 'data');
const RUN_FILE = resolve(DATA_DIR_LOCAL, 'RUN.json');
const MANIFEST_FILE = resolve(DATA_DIR_LOCAL, 'MANIFEST.json');

// Library mode: import compiled hive-mind dist directly via file URLs.
// This avoids depending on the hive-mind-test sandbox's node_modules
// resolution (which may not link @hive-mind/core).
const HIVE_MIND_ROOT = 'D:/Projects/hive-mind';
const SETUP_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/cli/dist/setup.js`).href;
const WM_URL = pathToFileURL(`${HIVE_MIND_ROOT}/packages/core/dist/workspace-manager.js`).href;

const DEFAULT_CONV_IDX = 0;

async function main() {
  const force = process.argv.includes('--force');
  const convIdxArg = process.argv.find(a => a.startsWith('--conv-idx='));
  const convIdx = convIdxArg ? parseInt(convIdxArg.split('=')[1], 10) : DEFAULT_CONV_IDX;

  // Refuse to run unless Phase 0 has produced MANIFEST.json — otherwise we
  // can't pin the dataset sha to the run.
  if (!existsSync(MANIFEST_FILE)) {
    throw new Error(`MANIFEST.json missing — run 00-fetch-dataset.mjs first.\n  expected at: ${MANIFEST_FILE}`);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));

  if (existsSync(RUN_FILE) && !force) {
    const existing = JSON.parse(readFileSync(RUN_FILE, 'utf8'));
    console.log(`[noop] RUN.json exists — workspace=${existing.workspace}`);
    console.log(`       (pass --force to create a new workspace)`);
    return;
  }

  // Lazy-import the hive-mind dist. If this throws ERR_MODULE_NOT_FOUND, the
  // CLI hasn't been built — surface the fix command.
  let resolveDataDir, WorkspaceManager;
  try {
    ({ resolveDataDir } = await import(SETUP_URL));
    ({ WorkspaceManager } = await import(WM_URL));
  } catch (e) {
    throw new Error(
      `Failed to import hive-mind dist: ${e.message}\n` +
      `  Build with:  cd ${HIVE_MIND_ROOT}/packages/cli && npm run build\n` +
      `  And:         cd ${HIVE_MIND_ROOT}/packages/core && npm run build`
    );
  }

  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) {
    throw new Error(
      `HIVE_MIND_DATA_DIR resolved to ${dataDir} but the directory does not exist. ` +
      `Run hive-mind-cli init first, or set HIVE_MIND_DATA_DIR explicitly.`
    );
  }

  const ts = Date.now();
  const wsId = `proj-locomo-${ts}`;
  const wm = new WorkspaceManager(dataDir);
  const ws = wm.ensure(wsId, {
    name: `LoCoMo Replay ${new Date(ts).toISOString().replace(/[:.]/g, '-')}`,
    group: 'measurement',
  });

  const mindPath = wm.getMindPath(wsId);
  const run = {
    workspace: ws.id,
    workspace_config: ws,
    mind_path: mindPath,
    data_dir: dataDir,
    conv_idx: convIdx,
    dataset_sha256: manifest.sha256,
    dataset_url: manifest.source_url,
    started_at: new Date(ts).toISOString(),
  };
  writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));

  console.log(`[ok] workspace created`);
  console.log(`     id        : ${ws.id}`);
  console.log(`     mind_path : ${mindPath}`);
  console.log(`     conv_idx  : ${convIdx}`);
  console.log(`     RUN.json  : ${RUN_FILE}`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
