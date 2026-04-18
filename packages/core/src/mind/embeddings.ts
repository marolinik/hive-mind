/**
 * Base interface for embedding providers.
 *
 * A provider converts text into a fixed-dimension Float32Array vector suitable
 * for insertion into the sqlite-vec vec0 virtual table (`memory_frames_vec`).
 * Every concrete embedder (InProcess, Ollama, API, LiteLLM, Mock) implements
 * this interface so they are freely interchangeable.
 */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}
