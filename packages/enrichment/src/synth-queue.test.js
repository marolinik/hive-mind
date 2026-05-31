import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// synth-queue.js captures QUEUE_DIR = join(os.homedir(), '.hive-mind') at module
// load. Point homedir at a throwaway dir BEFORE importing so the drain lock lives
// in a temp location and never touches the real ~/.hive-mind.
let tmpHome;
let sq;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'hmind-synthq-'));
  process.env.USERPROFILE = tmpHome; // Windows os.homedir()
  process.env.HOME = tmpHome; // POSIX os.homedir()
  mkdirSync(join(tmpHome, '.hive-mind'), { recursive: true }); // acquireDrainLock needs the dir
  sq = await import('./synth-queue.js');
});

afterAll(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  // Guarantee a clean lock state between cases.
  sq.releaseDrainLock();
});

describe('synth-queue drain lock', () => {
  it('grants the lock once and blocks a concurrent caller (O_EXCL mutual exclusion)', () => {
    expect(sq.acquireDrainLock()).toBe(true);
    expect(sq.acquireDrainLock()).toBe(false);
    sq.releaseDrainLock();
  });

  it('releaseDrainLock lets the next caller acquire again', () => {
    expect(sq.acquireDrainLock()).toBe(true);
    sq.releaseDrainLock();
    expect(sq.acquireDrainLock()).toBe(true);
    sq.releaseDrainLock();
  });

  it('isDrainLocked reflects the held/released state', () => {
    expect(sq.isDrainLocked()).toBe(false);
    sq.acquireDrainLock();
    expect(sq.isDrainLocked()).toBe(true);
    sq.releaseDrainLock();
    expect(sq.isDrainLocked()).toBe(false);
  });

  it('reclaims a stale lock older than the 10-minute window', () => {
    expect(sq.acquireDrainLock()).toBe(true);
    // Backdate the lock file 11 minutes so it counts as stale.
    const past = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(sq._internals.LOCK_FILE, past, past);
    // A new drain reclaims the stale lock (unlink + recreate)...
    expect(sq.acquireDrainLock()).toBe(true);
    // ...and the freshly-reclaimed lock blocks the next caller.
    expect(sq.acquireDrainLock()).toBe(false);
    sq.releaseDrainLock();
  });

  it('isDrainLocked treats a stale lock as unlocked', () => {
    sq.acquireDrainLock();
    const past = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(sq._internals.LOCK_FILE, past, past);
    expect(sq.isDrainLocked()).toBe(false);
    sq.releaseDrainLock();
  });
});
