/**
 * Fires `cli cognify` in the background, detached, idempotent.
 *
 * 2026-05-07: defaults switched from heuristic to LLM extraction
 * (`--extractor=llm --executor=cc`). The heuristic produces ~96% noise
 * entities ("ACC", "ACTIVE", random capitalised tokens) that pollute the
 * knowledge graph and silently displace high-signal entities from the
 * top-N wiki page slot. LLM extraction is slower (~30s/3-frame batch)
 * but produces wiki-grade entities. Throttled by post-tool-use hook
 * (60s default) so per-turn cost stays bounded.
 *
 * Set HIVE_MIND_COGNIFY_EXTRACTOR=heuristic to opt back in to the old
 * regex pass (e.g. when claude -p is unavailable).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getCliPath } from './cli-bridge.js';

/**
 * @param {{sinceFrameId?:number, extractor?:'heuristic'|'llm'}} [opts]
 * @returns {{spawned:boolean, error?:string}}
 */
export function triggerCognify(opts = {}) {
  const cliPath = getCliPath();
  if (!existsSync(cliPath)) {
    return { spawned: false, error: `cli not found at ${cliPath}` };
  }
  const extractor = opts.extractor
    ?? process.env.HIVE_MIND_COGNIFY_EXTRACTOR
    ?? 'llm';
  try {
    const args = [cliPath, 'cognify', '--json', `--extractor=${extractor}`];
    if (extractor === 'llm') {
      // 'cc' uses the user's claude -p subscription; 'api' requires
      // ANTHROPIC_API_KEY. Default to cc since this is fired in the
      // user's interactive session and the OSS path is opt-in.
      args.push(`--executor=${process.env.HIVE_MIND_COGNIFY_EXECUTOR ?? 'cc'}`);
    }
    if (opts.sinceFrameId !== undefined) {
      args.push('--since', String(opts.sinceFrameId));
    }
    const child = spawn(process.execPath, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
    return { spawned: true };
  } catch (err) {
    return { spawned: false, error: err instanceof Error ? err.message : String(err) };
  }
}
