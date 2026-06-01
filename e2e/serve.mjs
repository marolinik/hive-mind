#!/usr/bin/env node
/**
 * Boot the wiki-web server against the E2E fixture mind.
 *
 * Reuses the exact env the seed builder used (HIVE_MIND_DATA_DIR + HIVE_MIND_CLI
 * + deterministic flags) so the running server reads the seeded fixture. Shared
 * by the live agent-vision run, the browserless HTTP harness, and Playwright's
 * `webServer`.
 *
 * Usage:  PORT=3939 node e2e/serve.mjs [dataDir]
 *   - Assumes `node e2e/seed.mjs [dataDir]` has already populated the fixture.
 *   - Defaults: port 3939, dataDir <repo>/.e2e-tmp/mind
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, fixtureEnv } from './seed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'packages', 'wiki-web', 'src', 'server.js');

const PORT = Number(process.env.PORT) || 3939;
const dataDir = resolveDataDir(process.argv[2]);

const env = { ...fixtureEnv(dataDir), PORT: String(PORT) };
const child = spawn(process.execPath, [SERVER], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
