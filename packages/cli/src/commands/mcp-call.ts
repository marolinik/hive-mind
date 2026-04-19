/**
 * `hive-mind-cli mcp call <tool> [--args JSON]` — spawn a short-lived
 * MCP server child, run an `initialize` + `tools/call`, print the
 * result, and tear down.
 *
 * Deliberately raw JSON-RPC rather than pulling @modelcontextprotocol/sdk
 * as a CLI dependency — the message shape is stable and the smoke script
 * already proves this works end-to-end. Extra ~50 lines here vs an extra
 * ~10MB of installed SDK for every CLI consumer.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolveMcpServerEntry } from './mcp-start.js';

export interface McpCallOptions {
  tool: string;
  args?: Record<string, unknown>;
  /** Overall timeout for initialize + call + teardown. */
  timeoutMs?: number;
  /** Extra env vars merged over process.env before launching the child. */
  env?: Record<string, string | undefined>;
  /** Test hook — raw transport factory returning stdin/stdout streams. */
  transport?: () => {
    stdin: Writable;
    stdout: Readable;
    kill: () => void;
    exitPromise: Promise<number>;
  };
}

export interface McpCallResult {
  ok: boolean;
  tool: string;
  /** Raw MCP tool result (content array) when ok. */
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  /** True when the server reported the call as an application error. */
  isError?: boolean;
  /** Human-readable error when ok=false. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INITIALIZE_ID = 1;
const CALL_ID = 2;

function spawnMcpChild(envOverride?: Record<string, string | undefined>): {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
  exitPromise: Promise<number>;
} {
  const entry = resolveMcpServerEntry();
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    process.execPath,
    [entry],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(envOverride ?? {}) },
    },
  );

  // Drain stderr so a chatty server can't block on buffered logs.
  child.stderr.on('data', () => { /* intentional drop — preserves parent stderr for CLI */ });

  const exitPromise = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => { if (!child.killed) child.kill('SIGTERM'); },
    exitPromise,
  };
}

/** Parse newline-delimited JSON-RPC messages out of a rolling buffer. */
function createLineParser(): {
  feed: (chunk: string) => Array<Record<string, unknown>>;
} {
  let buffer = '';
  return {
    feed(chunk: string) {
      buffer += chunk;
      const messages: Array<Record<string, unknown>> = [];
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            messages.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // Non-JSON line on stdout (shouldn't happen for a conformant MCP server).
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
      return messages;
    },
  };
}

/** Wait for a JSON-RPC response with a matching id, or reject on timeout. */
function awaitResponse(
  stdout: Readable,
  parser: ReturnType<typeof createLineParser>,
  id: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stdout.off('data', onData);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for response id=${id}`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (const msg of parser.feed(text)) {
        if (msg['id'] === id) {
          clearTimeout(timer);
          stdout.off('data', onData);
          resolve(msg);
          return;
        }
      }
    };

    stdout.on('data', onData);
  });
}

export async function runMcpCall(options: McpCallOptions): Promise<McpCallResult> {
  if (!options.tool) {
    return { ok: false, tool: '', error: 'tool name is required (e.g. `mcp call recall_memory`)' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.transport
    ? options.transport()
    : spawnMcpChild(options.env);

  const parser = createLineParser();

  try {
    // 1. initialize
    const initReq = {
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hive-mind-cli', version: '0.1.0' },
      },
    };
    transport.stdin.write(JSON.stringify(initReq) + '\n');
    const initResp = await awaitResponse(transport.stdout, parser, INITIALIZE_ID, timeoutMs);
    if (initResp['error']) {
      return { ok: false, tool: options.tool, error: `initialize failed: ${JSON.stringify(initResp['error'])}` };
    }

    // 2. initialized notification (no id, no response expected)
    transport.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');

    // 3. tools/call
    const callReq = {
      jsonrpc: '2.0',
      id: CALL_ID,
      method: 'tools/call',
      params: {
        name: options.tool,
        arguments: options.args ?? {},
      },
    };
    transport.stdin.write(JSON.stringify(callReq) + '\n');
    const callResp = await awaitResponse(transport.stdout, parser, CALL_ID, timeoutMs);

    if (callResp['error']) {
      const err = callResp['error'] as { code?: number; message?: string };
      return {
        ok: false,
        tool: options.tool,
        error: err.message ?? 'unknown MCP error',
      };
    }

    const result = callResp['result'] as {
      content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
      isError?: boolean;
    } | undefined;

    return {
      ok: true,
      tool: options.tool,
      content: result?.content ?? [],
      isError: result?.isError ?? false,
    };
  } catch (err) {
    return {
      ok: false,
      tool: options.tool,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    transport.kill();
    await transport.exitPromise.catch(() => { /* already dead */ });
  }
}

export function renderMcpCallResult(result: McpCallResult, format: 'plain' | 'json' = 'plain'): string {
  if (format === 'json') return JSON.stringify(result, null, 2);

  if (!result.ok) {
    return `mcp call ${result.tool}: FAILED — ${result.error ?? 'unknown error'}`;
  }

  const lines: string[] = [];
  lines.push(`mcp call ${result.tool}: ok${result.isError ? ' (tool reported isError=true)' : ''}`);
  if (result.content && result.content.length > 0) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(block.text);
      } else {
        lines.push(JSON.stringify(block));
      }
    }
  } else {
    lines.push('(empty content)');
  }
  return lines.join('\n');
}
