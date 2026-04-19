/**
 * `hive-mind-cli mcp start` — run the hive-mind MCP server in the
 * foreground with inherited stdio, so any MCP client (Claude Code,
 * Claude Desktop, Codex) can connect over stdio without the user
 * having to know about the separate @hive-mind/mcp-server package.
 *
 * We spawn a fresh node subprocess instead of importing the server
 * in-process because:
 *   - stdio:'inherit' wires client → child directly, no buffering
 *   - signal forwarding is straightforward (parent exits with child
 *     exit code; SIGINT/SIGTERM propagate naturally)
 *   - the server owning its own process keeps the shutdown path
 *     free of CLI teardown interleaving
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

export interface McpStartOptions {
  /** Extra env vars merged over process.env before launching the child. */
  env?: Record<string, string | undefined>;
  /**
   * Override for tests — a function that runs the server and returns an
   * exit code. When provided, the real subprocess spawn is skipped.
   */
  runner?: () => Promise<number>;
}

/**
 * Resolve the hive-mind MCP server binary via the standard require.resolve
 * path. Throws if the dep isn't installed (missing workspace link, broken
 * install, etc.) rather than silently failing.
 */
export function resolveMcpServerEntry(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@hive-mind/mcp-server');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      '@hive-mind/mcp-server is not resolvable from the CLI. ' +
      'Run `npm install` at the repo root, or install @hive-mind/mcp-server ' +
      `alongside @hive-mind/cli. (${msg})`,
    );
  }
}

export async function runMcpStart(options: McpStartOptions = {}): Promise<number> {
  if (options.runner) return options.runner();

  const entry = resolveMcpServerEntry();
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });

  // Forward SIGINT/SIGTERM so the user's Ctrl+C reaches the server
  // before it reaches our own exit handler.
  const forward = (sig: NodeJS.Signals): void => {
    if (!child.killed) child.kill(sig);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  return new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal && code === null) {
        // Child killed by signal — synthesize a conventional exit code.
        resolve(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
        return;
      }
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      // Spawn failed — surface the OS-level error.
      console.error(`hive-mind-cli mcp start: ${err.message}`);
      resolve(1);
    });
  });
}
