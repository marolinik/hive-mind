// Flat ESLint config (ESLint 10 / typescript-eslint 8).
//
// This is a deliberately LIGHT, non-type-checked gate. Its job is to catch
// real correctness smells (undefined refs, unused symbols, unsafe empties,
// fallthrough) across the workspace WITHOUT the cost and churn of type-aware
// linting on 18.8k LOC. It is meant to pass and stay meaningful — tighten it
// (add recommendedTypeChecked, import ordering, etc.) once the codebase has
// been brought up to a stricter baseline. See PRODUCTION-CONSOLIDATION-PLAN
// Section 6.3 for the rationale.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output, deps, research scripts, generated type decls, and the
    // browser-side wiki UI are out of scope for this first gate. The wiki-web
    // frontend and the plain-JS enrichment package migrate to TS in Phase 2;
    // they join the lint gate then.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/*/dist/**',
      'benchmarks/**',
      'coverage/**',
      '**/*.d.ts',
    ],
  },

  // Base JS recommendations for every linted file.
  js.configs.recommended,

  // TypeScript sources: typescript-eslint recommended (syntactic tier).
  ...tseslint.configs.recommended,

  // Node + ESM globals for all first-party source.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentional escape-hatch patterns the codebase uses on purpose.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is used pragmatically at DB/JSON boundaries; not this gate's fight.
      '@typescript-eslint/no-explicit-any': 'off',
      // Empty catch blocks are a deliberate best-effort pattern (e.g. watermark
      // writes, db.close on already-closed handles) and are commented as such.
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
);
