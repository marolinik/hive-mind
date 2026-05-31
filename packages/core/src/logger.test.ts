import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCoreLogger } from './logger.js';

describe('createCoreLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes every level to stderr — never the stdout-bound console methods', () => {
    // stdout is reserved for program data (CLI --json envelopes, MCP stdio).
    // A library logger must never write there.
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const log = createCoreLogger('test');
    log.info('hello');
    log.debug('dbg');
    log.warn('careful');
    log.error('boom');

    // None of the stdout-bound console methods may be used.
    expect(info).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(log2).not.toHaveBeenCalled();
    // Diagnostics land on stderr (console.error / console.warn).
    expect(error.mock.calls.length + warn.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('includes the tag prefix in messages', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    createCoreLogger('embedding').info('probing');
    expect(error).toHaveBeenCalledWith('[hive-mind:embedding]', 'probing');
  });
});
