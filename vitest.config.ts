import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // {ts,js} so the plain-JS packages (enrichment, wiki-web, claude-code-hooks)
    // are testable too — not just the TypeScript packages.
    include: ['packages/*/src/**/*.{test,spec}.{ts,js}'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.{ts,js}'],
      exclude: ['**/*.{test,spec}.{ts,js}', '**/dist/**']
    }
  }
});
