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
  return {
    info: (msg, data) =>
      data !== undefined ? console.info(prefix, msg, data) : console.info(prefix, msg),
    warn: (msg, data) =>
      data !== undefined ? console.warn(prefix, msg, data) : console.warn(prefix, msg),
    error: (msg, data) =>
      data !== undefined ? console.error(prefix, msg, data) : console.error(prefix, msg),
    debug: (msg, data) =>
      data !== undefined ? console.debug(prefix, msg, data) : console.debug(prefix, msg),
  };
}
