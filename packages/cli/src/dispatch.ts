/**
 * Subcommand dispatcher. Lives in its own module so tests can drive it
 * without going through argv parsing or process.exit.
 */

import { runRecallContext, renderRecallResult } from './commands/recall-context.js';
import { runSaveSession } from './commands/save-session.js';
import { runHarvestLocal, type HarvestSource } from './commands/harvest-local.js';
import { runCognify } from './commands/cognify.js';
import { runCompileWiki } from './commands/compile-wiki.js';
import { runMaintenance } from './commands/maintenance.js';
import { runInit, renderInitResult } from './commands/init.js';
import { runStatus, renderStatusResult } from './commands/status.js';
import type { CliEnv } from './setup.js';
import type { Importance } from '@hive-mind/core';

export interface DispatchArgs {
  subcommand: string;
  values: Record<string, unknown>;
  positionals: string[];
  /** Optional env override for tests — bypasses openPersonalMind(). */
  env?: CliEnv;
}

type OutputFormat = 'plain' | 'json';

function intArg(values: Record<string, unknown>, key: string): number | undefined {
  const v = values[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function formatOf(values: Record<string, unknown>): OutputFormat {
  return values['json'] ? 'json' : 'plain';
}

function json(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export async function dispatch(args: DispatchArgs): Promise<string | undefined> {
  const { subcommand, values, positionals, env } = args;
  const fmt = formatOf(values);

  switch (subcommand) {
    case 'recall-context': {
      const query = (values['query'] as string) ?? positionals[0];
      if (!query) throw new Error('recall-context requires a query (positional or --query)');
      const result = await runRecallContext({
        query,
        limit: intArg(values, 'limit'),
        scope: (values['scope'] as 'personal' | 'all' | undefined) ?? 'personal',
        profile: (values['profile'] as 'balanced' | 'recent' | 'important' | 'connected' | undefined),
        env,
      });
      return fmt === 'json' ? json(result) : renderRecallResult(result, 'plain');
    }

    case 'save-session': {
      const result = await runSaveSession({
        file: values['file'] as string | undefined,
        importance: values['importance'] as Importance | undefined,
        sessionLabel: values['session-label'] as string | undefined,
        env,
      });
      return fmt === 'json' ? json(result) : (
        result.saved
          ? `Saved session summary as frame #${result.frameId} (${result.characters} chars)`
          : `Nothing saved: ${result.reason ?? 'empty input'}`
      );
    }

    case 'harvest-local': {
      const source = values['source'] as HarvestSource | undefined;
      const pth = values['path'] as string | undefined;
      if (!source) throw new Error('harvest-local requires --source (chatgpt|claude|claude-code|gemini|universal)');
      if (!pth) throw new Error('harvest-local requires --path');
      const result = await runHarvestLocal({ source, path: pth, env });
      return fmt === 'json' ? json(result) : (
        `Harvested ${result.itemsFound} items from ${result.source} ` +
        `(${result.framesCreated} new, ${result.duplicatesSkipped} duplicates` +
        (result.errors.length ? `, ${result.errors.length} errors` : '') +
        `)`
      );
    }

    case 'cognify': {
      const result = await runCognify({
        since: intArg(values, 'since'),
        limit: intArg(values, 'limit'),
        env,
      });
      return fmt === 'json' ? json(result) : (
        `Scanned ${result.framesScanned} frames — ${result.entitiesCreated} new entities, ` +
        `${result.entitiesUpdated} updated (lastFrameId=${result.lastFrameId})`
      );
    }

    case 'compile-wiki': {
      const result = await runCompileWiki({
        mode: (values['mode'] as 'incremental' | 'full' | undefined) ?? 'incremental',
        concepts: values['concept'] as string[] | undefined,
        env,
      });
      return fmt === 'json' ? json(result) : (
        `Wiki compiled via ${result.provider} — ${result.pagesCreated} created, ` +
        `${result.pagesUpdated} updated, ${result.pagesUnchanged} unchanged, ` +
        `${result.healthIssues} health issues (${result.durationMs}ms)`
      );
    }

    case 'maintenance': {
      const result = await runMaintenance({
        compact: Boolean(values['compact']),
        wipeImports: Boolean(values['wipe-imports']),
        reconcile: Boolean(values['reconcile']),
        cognify: Boolean(values['cognify']),
        wiki: Boolean(values['wiki']),
        maxTempAgeDays: intArg(values, 'max-temp-age-days'),
        maxDeprecatedAgeDays: intArg(values, 'max-deprecated-age-days'),
        env,
      });
      if (fmt === 'json') return json(result);
      const lines: string[] = [`Maintenance run complete (${result.durationMs}ms)`];
      if (result.compact) lines.push(`  compact:      temp=${result.compact.temporaryPruned} deprecated=${result.compact.deprecatedPruned} pframes=${result.compact.pframesMerged}`);
      if (result.wipeImports) lines.push(`  wipeImports:  ${result.wipeImports.framesDeleted} frames`);
      if (result.reconcile) lines.push(`  reconcile:    fts=${result.reconcile.ftsFixed} vec=${result.reconcile.vecFixed}`);
      if (result.cognify) lines.push(`  cognify:      ${result.cognify.framesScanned} frames, ${result.cognify.entitiesCreated} new, ${result.cognify.entitiesUpdated} updated`);
      if (result.wiki) lines.push(`  wiki:         ${result.wiki.pagesCreated} created, ${result.wiki.pagesUpdated} updated, provider=${result.wiki.provider}`);
      return lines.join('\n');
    }

    case 'init': {
      const result = await runInit({ env });
      return fmt === 'json' ? json(result) : renderInitResult(result, 'plain');
    }

    case 'status': {
      const result = await runStatus({ env });
      return fmt === 'json' ? json(result) : renderStatusResult(result, 'plain');
    }

    default:
      throw new Error(`Unknown subcommand: "${subcommand}". Try: init, status, recall-context, save-session, harvest-local, cognify, compile-wiki, maintenance`);
  }
}
