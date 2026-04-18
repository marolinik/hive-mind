/**
 * `hive-mind-cli save-session` — persist a session summary as one or
 * more I-Frames. Intended to run from a post-session hook (Stop in
 * Claude Code, etc.) where the transcript text is piped in on stdin or
 * supplied via --file.
 */

import fs from 'node:fs';
import { openPersonalMind, type CliEnv } from '../setup.js';
import type { Importance } from '@hive-mind/core';

export interface SaveSessionOptions {
  /** Raw session summary text. Takes precedence over `file`. */
  text?: string;
  /** Path to a file containing the session summary. */
  file?: string;
  importance?: Importance;
  sessionLabel?: string;
  env?: CliEnv;
}

export interface SaveSessionResult {
  saved: boolean;
  frameId?: number;
  frameCreatedAt?: string;
  characters: number;
  reason?: string;
}

const SESSION_LABEL_PREFIX = 'cli:save-session';

function readStdinSync(): string {
  try {
    // Node's readFileSync with fd=0 reads stdin synchronously. Works when
    // the CLI is invoked with a pipe. Returns empty string when stdin is a TTY.
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export async function runSaveSession(options: SaveSessionOptions): Promise<SaveSessionResult> {
  const env = options.env ?? openPersonalMind();
  const close = options.env ? () => { /* caller owns */ } : env.close;

  try {
    let text = options.text ?? '';
    if (!text && options.file) {
      try {
        text = fs.readFileSync(options.file, 'utf-8');
      } catch (err) {
        return {
          saved: false,
          characters: 0,
          reason: `Failed to read ${options.file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (!text && !options.env) {
      // Only try stdin when running as a real CLI, not in tests.
      text = readStdinSync();
    }

    const trimmed = text.trim();
    if (trimmed.length < 20) {
      return {
        saved: false,
        characters: trimmed.length,
        reason: 'Session summary is too short (< 20 chars) — nothing saved',
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const label = options.sessionLabel ?? `${SESSION_LABEL_PREFIX}:${today}`;
    const session = env.sessions.ensure(label, undefined, `Saved session summary ${today}`);

    const frame = env.frames.createIFrame(
      session.gop_id,
      trimmed,
      options.importance ?? 'normal',
      'agent_inferred',
    );

    // Best-effort vector indexing. Keyword search via FTS5 still works if this fails.
    try {
      const search = await env.getSearch();
      await search.indexFrame(frame.id, trimmed);
    } catch { /* non-fatal */ }

    return {
      saved: true,
      frameId: frame.id,
      frameCreatedAt: frame.created_at,
      characters: trimmed.length,
    };
  } finally {
    close();
  }
}
