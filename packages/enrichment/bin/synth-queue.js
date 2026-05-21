#!/usr/bin/env node
/**
 * synth-queue inspection + maintenance CLI.
 *
 * Usage:
 *   list [--all] [--limit=N]      list pending (default) or all entries
 *   next                          print next pending entry as JSON
 *   done <id> [--frame=N]         mark task done (manual CC-path completion)
 *   reclaim [--older-than=Nm]     reset stuck in_flight tasks to pending (default 30m)
 *   compact                       drop done entries older than 7d
 *   path                          print the queue file path
 */
import {
  listPending,
  listAll,
  nextPending,
  markDone,
  reclaimInFlight,
  compact,
  _internals,
} from '../src/synth-queue.js';

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'list', positional: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.flags.all = true;
    else if (a.startsWith('--limit=')) out.flags.limit = Number(a.split('=')[1]) || 50;
    else if (a.startsWith('--frame=')) out.flags.frame = Number(a.split('=')[1]);
    else if (a.startsWith('--older-than=')) {
      const v = (a.split('=')[1] || '').replace(/m$/i, '');
      const num = parseInt(v, 10);
      out.flags.olderThanMs = (Number.isFinite(num) ? num : 30) * 60 * 1000;
    }
    else if (!a.startsWith('--')) out.positional.push(a);
  }
  return out;
}

const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
const limit = flags.limit || 50;

switch (cmd) {
  case 'list': {
    const entries = flags.all ? listAll(limit) : listPending(limit);
    process.stdout.write(`# synth-queue: ${entries.length} ${flags.all ? 'entries (all)' : 'pending'}\n`);
    for (const e of entries) {
      const ts = (e.enqueued_at || '').slice(0, 19).replace('T', ' ');
      process.stdout.write(`${ts}  ${e.status.padEnd(10)} ${e.kind.padEnd(16)} ${e.id}  ${e.subject}\n`);
    }
    break;
  }
  case 'next': {
    const e = nextPending();
    if (!e) { process.stdout.write('# no pending synth tasks\n'); break; }
    process.stdout.write(JSON.stringify(e, null, 2) + '\n');
    break;
  }
  case 'done': {
    const id = positional[0];
    if (!id) {
      process.stderr.write('# usage: synth-queue done <id> [--frame=N]\n');
      process.exit(1);
    }
    const result = Number.isFinite(flags.frame) ? { frame_id: flags.frame } : {};
    const ok = markDone(id, result);
    process.stdout.write(ok ? `# marked done: ${id}\n` : `# not found: ${id}\n`);
    if (!ok) process.exit(2);
    break;
  }
  case 'reclaim': {
    const ms = flags.olderThanMs ?? 30 * 60 * 1000;
    const n = reclaimInFlight(ms);
    process.stdout.write(`# reclaimed ${n} stuck in_flight tasks (older than ${Math.round(ms / 60000)}m)\n`);
    break;
  }
  case 'compact': {
    const dropped = compact();
    process.stdout.write(`# compact: dropped ${dropped} done entries\n`);
    break;
  }
  case 'path': {
    process.stdout.write(_internals.QUEUE_FILE + '\n');
    break;
  }
  default:
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.stderr.write('usage: list [--all] [--limit=N] | next | done <id> [--frame=N] | reclaim [--older-than=Nm] | compact | path\n');
    process.exit(1);
}
