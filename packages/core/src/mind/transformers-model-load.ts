import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const LOCK_WAIT_TIMEOUT_MS = 12 * 60 * 1_000;
const LOCK_RETRY_MIN_MS = 35;
const LOCK_RETRY_JITTER_MS = 30;
const SAFE_HUGGING_FACE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const CORRUPT_ONNX_ERROR = /^Load model from (.+\.onnx) failed:\s*Protobuf parsing failed\.?$/i;
const LOCK_DIRECTORY = '.hive-mind-model-locks';

export interface TransformersModelLoadOptions<T> {
  cacheDir: string;
  model: string;
  load: (canonicalCacheDir: string) => Promise<T>;
  lockTimeoutMs?: number;
  onQuarantine?: (quarantineDir: string) => void | Promise<void>;
}

function normalizeLockKey(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}

export function modelLoadLockPath(cacheDir: string, model: string): string {
  const modelHash = createHash('sha256')
    .update(normalizeLockKey(model))
    .digest('hex')
    .slice(0, 16);
  return path.join(path.resolve(cacheDir), LOCK_DIRECTORY, `${modelHash}.sqlite`);
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String((error as Error & { code?: unknown }).code);
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_BUSY_SNAPSHOT'
    || code === 'SQLITE_LOCKED';
}

async function acquireCrossProcessLock(
  database: Database.Database,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  for (;;) {
    try {
      database.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      if (performance.now() >= deadline) {
        throw new Error(
          `Timed out waiting ${timeoutMs}ms for local model cache lock`,
          { cause: error },
        );
      }
    }

    const retryMs = LOCK_RETRY_MIN_MS + Math.random() * LOCK_RETRY_JITTER_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  return root === candidate || isWithin(root, candidate);
}

function assertUnlinkedPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Model cache path escapes its cache root');
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Model cache path crosses a filesystem link: ${current}`);
    }
  }
}

function validateQuarantinePaths(
  canonicalCacheDir: string,
  modelDir: string,
  reportedOnnxPath: string,
): { modelDir: string; quarantineRoot: string } | null {
  if (!path.isAbsolute(reportedOnnxPath)) return null;
  if (!fs.existsSync(modelDir) || !fs.existsSync(reportedOnnxPath)) return null;

  assertUnlinkedPath(canonicalCacheDir, modelDir);
  assertUnlinkedPath(canonicalCacheDir, reportedOnnxPath);

  const quarantineRoot = path.dirname(modelDir);
  const modelStats = fs.lstatSync(modelDir);
  const reportStats = fs.lstatSync(reportedOnnxPath);
  const rootStats = fs.lstatSync(quarantineRoot);
  if (!modelStats.isDirectory() || !reportStats.isFile() || !rootStats.isDirectory()) return null;

  const realCacheDir = fs.realpathSync.native(canonicalCacheDir);
  const realQuarantineRoot = fs.realpathSync.native(quarantineRoot);
  const realModelDir = fs.realpathSync.native(modelDir);
  const realOnnxPath = fs.realpathSync.native(reportedOnnxPath);
  if (!isWithinOrEqual(realCacheDir, realQuarantineRoot)
    || !isWithin(realQuarantineRoot, realModelDir)
    || path.dirname(realModelDir) !== realQuarantineRoot
    || !isWithin(realModelDir, realOnnxPath)) {
    return null;
  }

  return { modelDir: realModelDir, quarantineRoot: realQuarantineRoot };
}

function quarantineCorruptModel(
  canonicalCacheDir: string,
  model: string,
  reportedOnnxPath: string,
): string | null {
  if (!SAFE_HUGGING_FACE_MODEL_ID.test(model)) return null;

  const modelDir = path.join(canonicalCacheDir, ...model.split('/'));
  const firstValidation = validateQuarantinePaths(canonicalCacheDir, modelDir, reportedOnnxPath);
  if (!firstValidation) return null;

  // Re-resolve immediately before the move so a changed link/path cannot redirect it.
  const finalValidation = validateQuarantinePaths(canonicalCacheDir, modelDir, reportedOnnxPath);
  if (!finalValidation) return null;

  const quarantineDir = path.join(
    finalValidation.quarantineRoot,
    `${path.basename(finalValidation.modelDir)}.corrupt-${Date.now()}-${randomUUID()}`,
  );
  fs.renameSync(finalValidation.modelDir, quarantineDir);
  return quarantineDir;
}

function reportedCorruptOnnxPath(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return error.message.trim().match(CORRUPT_ONNX_ERROR)?.[1] ?? null;
}

function notifyQuarantine(
  callback: TransformersModelLoadOptions<unknown>['onQuarantine'],
  quarantineDir: string,
): void {
  try {
    const notification = callback?.(quarantineDir);
    if (notification) {
      void Promise.resolve(notification).catch(() => undefined);
    }
  } catch {
    // Notification is advisory and must not alter model recovery control flow.
  }
}

function prepareLockDatabase(canonicalCacheDir: string, model: string): Database.Database {
  const lockPath = modelLoadLockPath(canonicalCacheDir, model);
  const lockDir = path.dirname(lockPath);
  fs.mkdirSync(lockDir, { recursive: true });

  const lockDirStats = fs.lstatSync(lockDir);
  if (!lockDirStats.isDirectory() || lockDirStats.isSymbolicLink()) {
    throw new Error('Local model lock path is not a regular directory');
  }
  const realLockDir = fs.realpathSync.native(lockDir);
  if (!isWithin(canonicalCacheDir, realLockDir)) {
    throw new Error('Local model lock path escapes its cache root');
  }
  if (fs.existsSync(lockPath)) {
    const lockStats = fs.lstatSync(lockPath);
    if (!lockStats.isFile() || lockStats.isSymbolicLink()) {
      throw new Error('Local model lock database is not a regular file');
    }
  }

  return new Database(lockPath, { timeout: 0 });
}

async function runModelLoad<T>(options: TransformersModelLoadOptions<T>): Promise<T> {
  const timeoutMs = options.lockTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('Local model cache lock timeout must be a non-negative finite number');
  }

  const requestedCacheDir = path.resolve(options.cacheDir);
  fs.mkdirSync(requestedCacheDir, { recursive: true });
  const canonicalCacheDir = fs.realpathSync.native(requestedCacheDir);
  const lockDatabase = prepareLockDatabase(canonicalCacheDir, options.model);
  let result!: T;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    await acquireCrossProcessLock(lockDatabase, timeoutMs);

    try {
      result = await options.load(canonicalCacheDir);
    } catch (firstError) {
      const reportedOnnxPath = reportedCorruptOnnxPath(firstError);
      if (!reportedOnnxPath) throw firstError;

      let quarantineDir: string | null = null;
      try {
        quarantineDir = quarantineCorruptModel(canonicalCacheDir, options.model, reportedOnnxPath);
      } catch {
        // Preserve the original loader error if safe quarantine cannot complete.
      }
      if (!quarantineDir) throw firstError;

      notifyQuarantine(options.onQuarantine, quarantineDir);
      result = await options.load(canonicalCacheDir);
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let cleanupError: unknown;
  let hasCleanupError = false;
  if (lockDatabase.inTransaction) {
    try {
      lockDatabase.exec('ROLLBACK');
    } catch (error) {
      cleanupError = error;
      hasCleanupError = true;
    }
  }
  try {
    lockDatabase.close();
  } catch (error) {
    if (!hasCleanupError) cleanupError = error;
    hasCleanupError = true;
  }

  if (hasPrimaryError) throw primaryError;
  if (hasCleanupError) throw cleanupError;
  return result;
}

/**
 * Serializes one model/cache load across workers and processes. SQLite owns
 * the OS lock, so process termination releases it without PID/age heuristics.
 */
export function withTransformersModelLoad<T>(options: TransformersModelLoadOptions<T>): Promise<T> {
  return runModelLoad(options);
}
