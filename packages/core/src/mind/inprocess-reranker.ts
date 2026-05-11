/**
 * In-process cross-encoder reranker using @huggingface/transformers (ONNX).
 *
 * Cross-encoders take (query, doc) pairs and output a relevance score by
 * jointly attending to both — much more discriminating than vector dot
 * products. Use after RRF to rerank the top-K candidates from hybrid
 * search. Standard pattern in production RAG systems.
 *
 * Default model: Xenova/ms-marco-MiniLM-L-6-v2 — the canonical
 * SentenceTransformers cross-encoder, ~22MB on disk, ~30-50ms per pair
 * on CPU. Trained on MS MARCO passage ranking, generalizes well to
 * mixed-domain technical text.
 *
 * Alternative: Xenova/bge-reranker-base (~280MB, slightly higher quality
 * on out-of-domain queries). Set via `model` config.
 *
 * `@huggingface/transformers` is an optional peer dep — if not installed,
 * createInProcessReranker throws and the caller falls back to no reranking.
 */

import path from 'node:path';
import os from 'node:os';
import { createCoreLogger } from '../logger.js';

const log = createCoreLogger('inprocess-reranker');

export interface Reranker {
  /**
   * Score a single (query, doc) pair. Higher = more relevant.
   * Score scale depends on the model — for ms-marco-MiniLM it's
   * roughly [-10, 10]; relative ordering is what matters.
   */
  score(query: string, doc: string): Promise<number>;

  /**
   * Score N pairs sharing one query. Same-shape result as score() but
   * amortises the model invocation when supported.
   */
  scoreBatch(query: string, docs: string[]): Promise<number[]>;
}

export interface InProcessRerankerConfig {
  model?: string;
  cacheDir?: string;
}

/**
 * Build a reranker backed by @huggingface/transformers. Throws if the
 * package isn't installed — caller is expected to catch and fall back.
 */
export async function createInProcessReranker(
  config?: Partial<InProcessRerankerConfig>,
): Promise<Reranker> {
  const model = config?.model ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
  const cacheDir = config?.cacheDir ?? path.join(os.homedir(), '.hive-mind', 'models');

  log.info(`Loading in-process reranker: ${model} (~22MB first download)`);

  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
    '@huggingface/transformers'
  );
  env.cacheDir = cacheDir;
  env.allowRemoteModels = true;

  // Cross-encoders need direct tokenizer + model access — pipeline API
  // doesn't expose the (text, text_pair) input pattern cleanly across
  // all transformers.js versions. Calling the model directly with
  // tokenized pairs is the stable path.
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const seqModel = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: 'fp32' });

  log.info(`In-process reranker ready: ${model}`);

  /** Score a single pair: tokenize, forward, extract logit. */
  async function scorePair(query: string, doc: string): Promise<number> {
    const inputs = await tokenizer(query, {
      text_pair: doc,
      padding: true,
      truncation: true,
      return_tensors: 'pt',
    });
    const out = await seqModel(inputs);
    // ms-marco-MiniLM outputs a single logit per pair (1-class regression).
    // Other cross-encoders may output 2 classes — take logit[0] - logit[1]
    // as a relevance score in that case.
    const logits = out.logits ?? out[0];
    const data = logits.data as Float32Array | number[];
    if (logits.dims && logits.dims[logits.dims.length - 1] === 2) {
      return Number(data[0]) - Number(data[1]);
    }
    return Number(data[0]);
  }

  return {
    async score(query: string, doc: string): Promise<number> {
      return scorePair(query, doc);
    },

    async scoreBatch(query: string, docs: string[]): Promise<number[]> {
      if (docs.length === 0) return [];
      // Tokenize all pairs together for batch inference. Padding aligns
      // sequences so the model can process them in one forward pass.
      const queries = docs.map(() => query);
      const inputs = await tokenizer(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
        return_tensors: 'pt',
      });
      const out = await seqModel(inputs);
      const logits = out.logits ?? out[0];
      const data = logits.data as Float32Array | number[];
      const dims = logits.dims;
      const lastDim = dims[dims.length - 1];

      const scores: number[] = [];
      if (lastDim === 2) {
        for (let i = 0; i < docs.length; i++) {
          scores.push(Number(data[i * 2]) - Number(data[i * 2 + 1]));
        }
      } else {
        for (let i = 0; i < docs.length; i++) {
          scores.push(Number(data[i]));
        }
      }
      return scores;
    },
  };
}
