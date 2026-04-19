/**
 * `hive-mind-cli init` — idempotent workspace scaffolding.
 *
 * Creates HIVE_MIND_DATA_DIR (or ~/.hive-mind) if missing, then opens
 * personal.mind so the SQLite schema + FTS5 + vec0 tables are initialised.
 * Safe to run repeatedly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openPersonalMind, resolveDataDir, type CliEnv } from '../setup.js';

export interface InitOptions {
  /** Override for tests — use an already-open env instead of opening a new one. */
  env?: CliEnv;
  /** Override the target data dir (else resolveDataDir()). */
  dataDir?: string;
}

export interface InitResult {
  dataDir: string;
  personalMindPath: string;
  personalMindCreated: boolean;
  dataDirCreated: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const dataDir = options.env?.dataDir ?? options.dataDir ?? resolveDataDir();
  const personalMindPath = path.join(dataDir, 'personal.mind');

  const dataDirCreated = !fs.existsSync(dataDir);
  const personalMindCreated = !fs.existsSync(personalMindPath);

  // openPersonalMind is idempotent — it creates the dir + opens/initialises the DB.
  const env = options.env ?? openPersonalMind(dataDir);
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    return {
      dataDir: env.dataDir,
      personalMindPath,
      personalMindCreated,
      dataDirCreated,
    };
  } finally {
    close();
  }
}

export function renderInitResult(result: InitResult, format: 'plain' | 'json' = 'plain'): string {
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  if (result.dataDirCreated) {
    lines.push(`Created data dir: ${result.dataDir}`);
  } else {
    lines.push(`Data dir exists: ${result.dataDir}`);
  }
  if (result.personalMindCreated) {
    lines.push(`Created personal mind: ${result.personalMindPath}`);
  } else {
    lines.push(`Personal mind exists: ${result.personalMindPath}`);
  }
  lines.push('');
  lines.push('Ready. Try:');
  lines.push('  hive-mind-cli status');
  lines.push('  hive-mind-cli save-session --file PATH --session-label "first session"');
  lines.push('  hive-mind-cli recall-context "what you want to find"');
  return lines.join('\n');
}
