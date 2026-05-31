/**
 * Minimal structured logger for @hive-mind/core.
 *
 * Downstream consumers that want structured output (pino, winston, etc.) can
 * replace this by wrapping their logger in the same shape and passing it as
 * a dependency. The library itself only needs info/warn/error/debug.
 */
export interface CoreLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

export function createCoreLogger(tag: string): CoreLogger {
  const prefix = `[hive-mind:${tag}]`;
  // ALL diagnostics go to stderr. stdout is reserved for program data — CLI
  // `--json` envelopes and the MCP stdio protocol — so a library log line on
  // stdout corrupts machine consumers (e.g. `recall-context --json`). console.warn
  // and console.error already target stderr; route info/debug there too rather
  // than console.info/console.debug (which write to stdout).
  return {
    info: (msg, data) =>
      data !== undefined ? console.error(prefix, msg, data) : console.error(prefix, msg),
    warn: (msg, data) =>
      data !== undefined ? console.warn(prefix, msg, data) : console.warn(prefix, msg),
    error: (msg, data) =>
      data !== undefined ? console.error(prefix, msg, data) : console.error(prefix, msg),
    debug: (msg, data) =>
      data !== undefined ? console.error(prefix, msg, data) : console.error(prefix, msg),
  };
}
