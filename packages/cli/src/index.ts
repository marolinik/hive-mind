#!/usr/bin/env node

/**
 * hive-mind-cli — command-line tools for the hive-mind memory system.
 *
 * Subcommands:
 *   init                           Scaffold data dir + personal.mind (idempotent)
 *   status                         Show frame/entity counts + last activity
 *   mcp start                      Run the MCP server in the foreground
 *   mcp call <tool> [--args JSON]  Invoke one MCP tool + print the result
 *   recall-context "<query>"       Query the personal mind and print hits
 *   save-session [--file P]        Persist stdin or --file as a memory frame
 *   harvest-local --source S --path P  Import conversations from disk
 *   cognify [--since N] [--limit N]    Heuristic KG entity extraction
 *   compile-wiki [--mode full]     Build/refresh the personal wiki
 *   maintenance --compact --reconcile --cognify --wiki --wipe-imports
 *                                  Batch ops for a nightly cron
 *
 * Flags common to all subcommands:
 *   --data-dir P   Override HIVE_MIND_DATA_DIR
 *   --json         Emit machine-readable JSON rather than human text
 */

import { parseArgs } from 'node:util';
import { dispatch, type DispatchArgs } from './dispatch.js';

function parseRootArgs(argv: string[]): DispatchArgs | null {
  // Split "subcommand" out before parseArgs so the subcommand name does
  // not collide with `--` flags. Two-word subcommands `mcp start` and
  // `mcp call <tool>` collapse to `mcp-start` / `mcp-call` so dispatch
  // can route with a single switch.
  const [first, ...rest] = argv;
  if (!first || first === '--help' || first === '-h') {
    return null;
  }

  let subcommand = first;
  let afterSubcommand = rest;
  if (first === 'mcp' && rest.length > 0) {
    subcommand = `mcp-${rest[0]}`;
    afterSubcommand = rest.slice(1);
  }

  const { values, positionals } = parseArgs({
    args: afterSubcommand,
    allowPositionals: true,
    strict: false,
    options: {
      'data-dir': { type: 'string' },
      'json': { type: 'boolean' },
      'limit': { type: 'string' },
      'scope': { type: 'string' },
      'profile': { type: 'string' },
      'query': { type: 'string' },
      'file': { type: 'string' },
      'source': { type: 'string' },
      'path': { type: 'string' },
      'since': { type: 'string' },
      'mode': { type: 'string' },
      'concept': { type: 'string', multiple: true },
      'compact': { type: 'boolean' },
      'wipe-imports': { type: 'boolean' },
      'reconcile': { type: 'boolean' },
      'cognify': { type: 'boolean' },
      'wiki': { type: 'boolean' },
      'max-temp-age-days': { type: 'string' },
      'max-deprecated-age-days': { type: 'string' },
      'session-label': { type: 'string' },
      'importance': { type: 'string' },
      'tool': { type: 'string' },
      'args': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });

  return { subcommand, values, positionals };
}

function printHelp(): void {
  const help = [
    'Usage: hive-mind-cli <subcommand> [options]',
    '',
    'Subcommands:',
    '  init                         Scaffold data dir + personal.mind (idempotent)',
    '  status                       Show frame/entity counts + last activity',
    '  mcp start                    Run the hive-mind MCP server (stdio)',
    '  mcp call <tool> [--args J]   Invoke one MCP tool and print the result',
    '  recall-context "<query>"     Search the personal mind and print hits',
    '  save-session --file PATH     Persist a session summary as a memory frame',
    '  harvest-local --source S --path P   Import local AI tool exports',
    '  cognify                      Heuristic KG entity extraction from recent frames',
    '  compile-wiki [--mode M]      Build/refresh the personal wiki',
    '  maintenance --compact ...    Batch ops for a nightly cron',
    '',
    'Common flags:',
    '  --data-dir PATH              Override HIVE_MIND_DATA_DIR',
    '  --json                       Emit JSON rather than human text',
    '',
    'Environment:',
    '  HIVE_MIND_DATA_DIR           Data directory (default ~/.hive-mind)',
    '  OLLAMA_URL / OLLAMA_MODEL    Preferred embedder and wiki LLM',
    '  VOYAGE_API_KEY               Remote embedder fallback',
    '  OPENAI_API_KEY               Remote embedder fallback',
    '  ANTHROPIC_API_KEY            Wiki synthesizer (Haiku)',
  ].join('\n');
  console.log(help);
}

async function main(): Promise<void> {
  const args = parseRootArgs(process.argv.slice(2));
  if (!args) {
    printHelp();
    process.exit(args === null ? 0 : 1);
    return;
  }

  if (args.values['data-dir']) {
    process.env.HIVE_MIND_DATA_DIR = String(args.values['data-dir']);
  }

  try {
    const output = await dispatch(args);
    if (output !== undefined) process.stdout.write(output);
    if (output && !output.endsWith('\n')) process.stdout.write('\n');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`hive-mind-cli: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('hive-mind-cli fatal:', err);
  process.exit(1);
});
