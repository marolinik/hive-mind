import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transformers = vi.hoisted(() => ({
  env: { allowRemoteModels: true, cacheDir: 'original-cache' },
  extractor: vi.fn(),
  model: vi.fn(),
  modelFromPretrained: vi.fn(),
  pipeline: vi.fn(),
  tokenizer: vi.fn(),
  tokenizerFromPretrained: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: transformers.env,
  pipeline: transformers.pipeline,
  AutoModelForSequenceClassification: {
    from_pretrained: transformers.modelFromPretrained,
  },
  AutoTokenizer: {
    from_pretrained: transformers.tokenizerFromPretrained,
  },
}));

import { createInProcessEmbedder } from './inprocess-embedder.js';
import { createInProcessReranker } from './inprocess-reranker.js';
import {
  modelLoadLockPath,
  withTransformersModelLoad,
} from './transformers-model-load.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function startLockHolder(lockPath: string, signalPath: string, releaseMs: number | null) {
  const script = [
    'const Database = require("better-sqlite3");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [dbPath, signalPath, releaseValue] = process.argv.slice(1);',
    'fs.mkdirSync(path.dirname(dbPath), { recursive: true });',
    'const db = new Database(dbPath, { timeout: 0 });',
    'db.exec("BEGIN IMMEDIATE");',
    'fs.writeFileSync(signalPath, "locked");',
    'if (releaseValue === "never") {',
    '  setInterval(() => {}, 1000);',
    '} else {',
    '  setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, Number(releaseValue));',
    '}',
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['-e', script, lockPath, signalPath, releaseMs === null ? 'never' : String(releaseMs)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  const exit = Promise.race([
    once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr })),
    once(child, 'error').then(([error]) => Promise.reject(error)),
  ]);
  return { child, exit };
}

const tempRoots: string[] = [];
const childProcesses: Array<{
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}> = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempRoots.push(root);
  return root;
}

function corruptError(onnxPath: string): Error {
  return new Error(`Load model from ${onnxPath} failed: Protobuf parsing failed.`);
}

describe('local Transformers model loading', () => {
  beforeEach(() => {
    transformers.env.allowRemoteModels = true;
    transformers.env.cacheDir = 'original-cache';
    transformers.extractor.mockReset();
    transformers.model.mockReset();
    transformers.modelFromPretrained.mockReset();
    transformers.pipeline.mockReset();
    transformers.tokenizer.mockReset();
    transformers.tokenizerFromPretrained.mockReset();
    transformers.pipeline.mockResolvedValue(transformers.extractor);
    transformers.modelFromPretrained.mockResolvedValue(transformers.model);
    transformers.tokenizerFromPretrained.mockResolvedValue(transformers.tokenizer);
  });

  afterEach(async () => {
    const holders = childProcesses.splice(0);
    for (const { child } of holders) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(holders.map(({ exit }) => exit));
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
    vi.restoreAllMocks();
  });

  it('passes per-call cache directories and initializes distinct models concurrently', async () => {
    const root = makeTempRoot('transformers-distinct');
    const cacheDir = path.join(root, 'cache');
    const pipelineStarted = deferred<void>();
    const tokenizerStarted = deferred<void>();
    const releasePipeline = deferred<void>();
    const releaseTokenizer = deferred<void>();

    transformers.pipeline.mockImplementationOnce(async () => {
      pipelineStarted.resolve();
      await releasePipeline.promise;
      return transformers.extractor;
    });
    transformers.tokenizerFromPretrained.mockImplementationOnce(async () => {
      tokenizerStarted.resolve();
      await releaseTokenizer.promise;
      return transformers.tokenizer;
    });

    const embedderPromise = createInProcessEmbedder({ cacheDir, model: 'Xenova/embed-model' });
    await pipelineStarted.promise;
    const rerankerPromise = createInProcessReranker({ cacheDir, model: 'Xenova/rerank-model' });

    try {
      await Promise.race([
        tokenizerStarted.promise,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('Distinct model load was serialized')),
          1_000,
        )),
      ]);
    } finally {
      releasePipeline.resolve();
      releaseTokenizer.resolve();
    }
    await Promise.all([embedderPromise, rerankerPromise]);

    const canonicalCacheDir = fs.realpathSync.native(cacheDir);
    expect(transformers.pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/embed-model', {
      dtype: 'fp32',
      cache_dir: canonicalCacheDir,
    });
    expect(transformers.tokenizerFromPretrained).toHaveBeenCalledWith('Xenova/rerank-model', {
      cache_dir: canonicalCacheDir,
    });
    expect(transformers.modelFromPretrained).toHaveBeenCalledWith('Xenova/rerank-model', {
      dtype: 'fp32',
      cache_dir: canonicalCacheDir,
    });
    expect(transformers.env).toEqual({ allowRemoteModels: true, cacheDir: 'original-cache' });
  });

  it('serializes simultaneous callers for the same model and cache', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-same'), 'cache');
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const load = async () => {
      const call = ++calls;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (call === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return call;
      } finally {
        active -= 1;
      }
    };

    const first = withTransformersModelLoad({ cacheDir, model: 'Xenova/same-model', load });
    await firstStarted.promise;
    const second = withTransformersModelLoad({ cacheDir, model: 'Xenova/same-model', load });
    await nextTurn();
    expect(calls).toBe(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(maxActive).toBe(1);
  });

  it('releases the same-model lock when a loader fails', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-failure'), 'cache');
    const failure = new Error('provider download failed');
    await expect(withTransformersModelLoad({
      cacheDir,
      model: 'Xenova/failure-model',
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
    await expect(withTransformersModelLoad({
      cacheDir,
      model: 'Xenova/failure-model',
      load: async () => 'recovered',
    })).resolves.toBe('recovered');
  });

  it('waits asynchronously for a live process holding the same model lock', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-live-process'), 'cache');
    const model = 'Xenova/process-model';
    const signalPath = path.join(path.dirname(cacheDir), 'locked');
    const holder = startLockHolder(modelLoadLockPath(cacheDir, model), signalPath, 350);
    childProcesses.push(holder);
    await waitForFile(signalPath);

    const startedAt = Date.now();
    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      load: async () => 'loaded',
    })).resolves.toBe('loaded');
    const result = await holder.exit;

    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  it('times out without stealing a lock from a live process', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-timeout'), 'cache');
    const model = 'Xenova/timeout-model';
    const signalPath = path.join(path.dirname(cacheDir), 'locked');
    const holder = startLockHolder(modelLoadLockPath(cacheDir, model), signalPath, null);
    childProcesses.push(holder);
    await waitForFile(signalPath);

    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      lockTimeoutMs: 60,
      load: async () => 'must-not-run',
    })).rejects.toThrow('Timed out waiting 60ms for local model cache lock');

    holder.child.kill();
    await holder.exit;
  });

  it('acquires immediately after a lock-holder process is terminated', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-crash'), 'cache');
    const model = 'Xenova/crash-model';
    const signalPath = path.join(path.dirname(cacheDir), 'locked');
    const holder = startLockHolder(modelLoadLockPath(cacheDir, model), signalPath, null);
    childProcesses.push(holder);
    await waitForFile(signalPath);

    holder.child.kill();
    await holder.exit;
    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      lockTimeoutMs: 1_000,
      load: async () => 'reacquired',
    })).resolves.toBe('reacquired');
  });

  it('quarantines one corrupt model once across two simultaneous callers', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-concurrent-corrupt'), 'cache');
    const model = 'Xenova/corrupt-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');

    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let quarantineNotifications = 0;
    const load = async () => {
      const call = ++calls;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (call === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          throw corruptError(fs.realpathSync.native(onnxPath));
        }
        await nextTurn();
        return call;
      } finally {
        active -= 1;
      }
    };
    const options = {
      cacheDir,
      model,
      load,
      onQuarantine: () => {
        quarantineNotifications += 1;
        throw new Error('notification failure must be ignored');
      },
    };

    const first = withTransformersModelLoad(options);
    await firstStarted.promise;
    const second = withTransformersModelLoad(options);
    await nextTurn();
    expect(calls).toBe(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([2, 3]);
    expect(maxActive).toBe(1);
    expect(quarantineNotifications).toBe(1);
    expect(fs.existsSync(modelDir)).toBe(false);
    expect(fs.readdirSync(path.dirname(modelDir)).filter(
      (entry) => entry.startsWith('corrupt-model.corrupt-'),
    )).toHaveLength(1);
  });

  it('contains asynchronous quarantine notification failures', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-async-notify'), 'cache');
    const model = 'Xenova/async-notify-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');

    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      const load = vi.fn()
        .mockRejectedValueOnce(corruptError(fs.realpathSync.native(onnxPath)))
        .mockResolvedValueOnce('recovered');

      await expect(withTransformersModelLoad({
        cacheDir,
        model,
        load,
        onQuarantine: async () => {
          throw new Error('async callback rejected');
        },
      })).resolves.toBe('recovered');
      await nextTurn();
      await nextTurn();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('recovers a valid single-segment Hugging Face model ID', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-single-segment'), 'cache');
    const model = 'bert-base-uncased';
    const modelDir = path.join(cacheDir, model);
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');
    const load = vi.fn()
      .mockRejectedValueOnce(corruptError(fs.realpathSync.native(onnxPath)))
      .mockResolvedValueOnce('recovered');

    await expect(withTransformersModelLoad({ cacheDir, model, load })).resolves.toBe('recovered');
    expect(load).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(modelDir)).toBe(false);
    expect(fs.readdirSync(cacheDir).filter(
      (entry) => entry.startsWith('bert-base-uncased.corrupt-'),
    )).toHaveLength(1);
  });

  it.each([
    ['wrong model', 'inside'],
    ['outside cache', 'outside'],
  ])('preserves the original error for a reported ONNX path in the %s', async (_name, kind) => {
    const root = makeTempRoot(`transformers-${kind}`);
    const cacheDir = path.join(root, 'cache');
    const model = 'Xenova/expected-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'expected.onnx'), 'expected');

    const reportedPath = kind === 'inside'
      ? path.join(cacheDir, 'Xenova', 'different-model', 'model.onnx')
      : path.join(root, 'outside.onnx');
    fs.mkdirSync(path.dirname(reportedPath), { recursive: true });
    fs.writeFileSync(reportedPath, 'unrelated');
    const failure = corruptError(reportedPath);

    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(fs.existsSync(modelDir)).toBe(true);
  });

  it('preserves the original error when an owner directory is a junction or symlink', async () => {
    const root = makeTempRoot('transformers-owner-link');
    const cacheDir = path.join(root, 'cache');
    const outsideOwner = path.join(root, 'outside-owner');
    const outsideModel = path.join(outsideOwner, 'linked-model');
    const onnxPath = path.join(cacheDir, 'Xenova', 'linked-model', 'model.onnx');
    fs.mkdirSync(outsideModel, { recursive: true });
    fs.writeFileSync(path.join(outsideModel, 'model.onnx'), 'outside');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.symlinkSync(
      outsideOwner,
      path.join(cacheDir, 'Xenova'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const failure = corruptError(fs.realpathSync.native(onnxPath));

    await expect(withTransformersModelLoad({
      cacheDir,
      model: 'Xenova/linked-model',
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(fs.readFileSync(path.join(outsideModel, 'model.onnx'), 'utf8')).toBe('outside');
  });

  it('preserves the original error when the ONNX subtree is a junction or symlink', async () => {
    const root = makeTempRoot('transformers-onnx-link');
    const cacheDir = path.join(root, 'cache');
    const model = 'Xenova/linked-subtree-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const outsideDir = path.join(root, 'outside-onnx');
    const onnxPath = path.join(modelDir, 'onnx', 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'model.onnx'), 'outside');
    fs.symlinkSync(
      outsideDir,
      path.join(modelDir, 'onnx'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const failure = corruptError(onnxPath);

    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(fs.readFileSync(path.join(outsideDir, 'model.onnx'), 'utf8')).toBe('outside');
  });

  it('preserves the original error when quarantine rename fails', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-rename-failure'), 'cache');
    const model = 'Xenova/rename-failure-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');
    const failure = corruptError(onnxPath);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename denied');
    });

    await expect(withTransformersModelLoad({
      cacheDir,
      model,
      load: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(fs.existsSync(modelDir)).toBe(true);
  });

  it('propagates a retry failure unchanged after exactly two attempts', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-retry-failure'), 'cache');
    const model = 'Xenova/retry-failure-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');
    const secondFailure = new Error('retry download failed');
    const load = vi.fn()
      .mockRejectedValueOnce(corruptError(fs.realpathSync.native(onnxPath)))
      .mockRejectedValueOnce(secondFailure);

    await expect(withTransformersModelLoad({ cacheDir, model, load })).rejects.toBe(secondFailure);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retries tokenizer and reranker model together with the same cache directory', async () => {
    const cacheDir = path.join(makeTempRoot('transformers-reranker-retry'), 'cache');
    const model = 'Xenova/reranker-retry-model';
    const modelDir = path.join(cacheDir, ...model.split('/'));
    const onnxPath = path.join(modelDir, 'model.onnx');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(onnxPath, 'corrupt');
    transformers.modelFromPretrained
      .mockRejectedValueOnce(corruptError(fs.realpathSync.native(onnxPath)))
      .mockResolvedValueOnce(transformers.model);

    await expect(createInProcessReranker({ cacheDir, model })).resolves.toBeDefined();

    const canonicalCacheDir = fs.realpathSync.native(cacheDir);
    expect(transformers.tokenizerFromPretrained).toHaveBeenCalledTimes(2);
    expect(transformers.modelFromPretrained).toHaveBeenCalledTimes(2);
    for (const [, options] of transformers.tokenizerFromPretrained.mock.calls) {
      expect(options).toEqual({ cache_dir: canonicalCacheDir });
    }
    for (const [, options] of transformers.modelFromPretrained.mock.calls) {
      expect(options).toEqual({ dtype: 'fp32', cache_dir: canonicalCacheDir });
    }
  });

  it.runIf(process.platform === 'win32')('uses one lock key for Windows path case variants', () => {
    const cacheDir = path.join(makeTempRoot('transformers-case'), 'CacheRoot');
    const first = modelLoadLockPath(cacheDir, 'Xenova/Case-Model');
    const second = modelLoadLockPath(cacheDir.toUpperCase(), 'xenova/case-model');
    expect(first.toLocaleLowerCase('en-US')).toBe(second.toLocaleLowerCase('en-US'));
  });
});
