import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transformers = vi.hoisted(() => ({
  env: { allowRemoteModels: false, cacheDir: '' },
  model: vi.fn(),
  modelFromPretrained: vi.fn(),
  tokenizer: vi.fn(),
  tokenizerFromPretrained: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: transformers.env,
  AutoModelForSequenceClassification: {
    from_pretrained: transformers.modelFromPretrained,
  },
  AutoTokenizer: {
    from_pretrained: transformers.tokenizerFromPretrained,
  },
}));

import { createInProcessReranker } from './inprocess-reranker.js';

const tempRoots: string[] = [];

describe('createInProcessReranker', () => {
  beforeEach(() => {
    transformers.env.allowRemoteModels = false;
    transformers.env.cacheDir = '';
    transformers.model.mockReset();
    transformers.modelFromPretrained.mockReset();
    transformers.tokenizer.mockReset();
    transformers.tokenizerFromPretrained.mockReset();
    transformers.modelFromPretrained.mockResolvedValue(transformers.model);
    transformers.tokenizerFromPretrained.mockResolvedValue(transformers.tokenizer);
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('requests tensors and supports single and batch scoring', async () => {
    transformers.tokenizer.mockResolvedValue({ input_ids: 'tokens' });
    transformers.model
      .mockResolvedValueOnce({ logits: { data: new Float32Array([0.75]), dims: [1, 1] } })
      .mockResolvedValueOnce({ logits: { data: new Float32Array([0.25, 0.5]), dims: [2, 1] } });
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reranker-test-'));
    tempRoots.push(cacheDir);

    const reranker = await createInProcessReranker({ cacheDir });
    await expect(reranker.score('query', 'document')).resolves.toBeCloseTo(0.75);
    await expect(reranker.scoreBatch('query', ['first', 'second'])).resolves.toEqual([
      0.25,
      0.5,
    ]);

    const canonicalCacheDir = fs.realpathSync.native(cacheDir);
    expect(transformers.tokenizerFromPretrained).toHaveBeenCalledWith(
      'Xenova/ms-marco-MiniLM-L-6-v2',
      { cache_dir: canonicalCacheDir },
    );
    expect(transformers.modelFromPretrained).toHaveBeenCalledWith(
      'Xenova/ms-marco-MiniLM-L-6-v2',
      { dtype: 'fp32', cache_dir: canonicalCacheDir },
    );
    expect(transformers.tokenizer).toHaveBeenNthCalledWith(1, 'query', {
      text_pair: 'document',
      padding: true,
      truncation: true,
      return_tensor: true,
    });
    expect(transformers.tokenizer).toHaveBeenNthCalledWith(2, ['query', 'query'], {
      text_pair: ['first', 'second'],
      padding: true,
      truncation: true,
      return_tensor: true,
    });
  });
});
