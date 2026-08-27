# @hive-mind/core

## 0.5.0

### Minor Changes

- 1462670: Add a normalization-aware external-memory ingress guard and enforce it at the
  HarvestPipeline boundary before untrusted imports reach an LLM or memory.

### Patch Changes

- b96b732: Harden knowledge-graph extraction and CLI cognify so model output is parsed
  fail-closed, entity provenance is atomic, resumable scans stay idempotent, and
  unexpected database failures are no longer hidden.
- 266aadb: chore(release): establish the Changesets + OIDC trusted-publishing pipeline.
  
  First managed release of the `@hive-mind/*` package set (all 7 version in
  lockstep). No runtime behavior changes — this changeset exists to drive the
  initial "Version Packages" PR and validate the publish workflow (dry-run gated).
  Subsequent changesets describe real feature/fix changes.
  
  To publish the current `0.4.0` as the first version instead of bumping to
  `0.4.1`, delete this changeset before the first CI release (see RELEASING.md).
