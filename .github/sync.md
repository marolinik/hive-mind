# Memory Substrate Sync — `hive-mind` ↔ `waggle-os`

This is the hive-mind side of a bidirectional GitHub Actions sync system.
The full operating manual lives in the production repo at
[`marolinik/waggle-os/.github/sync.md`](https://github.com/marolinik/waggle-os/blob/main/.github/sync.md)
— treat that as canonical for design rationale, allowlist policy,
bidirectional bug-fix protocol, and recovery procedures.

This file documents only what's specific to the hive-mind side.

---

## What this repo carries

`.github/workflows/sync-to-waggle-os.yml` — opens an auto-PR on
`marolinik/waggle-os` whenever master receives a push touching:

- `packages/core/src/mind/**`
- `packages/core/src/harvest/**`
- `packages/wiki-compiler/**`
- `packages/mcp-server/**`
- `packages/cli/**`

Per the audit at
[`waggle-os PM decisions/2026-04-26-memory-sync-audit.md`](https://github.com/marolinik/waggle-os/blob/main/PM-Waggle-OS/decisions/2026-04-26-memory-sync-audit.md),
hive-mind is empirically the more active substrate repo, so this
direction carries the heavier production burden.

The workflow:

- **Excludes `*.test.ts` files from the sync patch.** Tests are handled
  by waggle-os's `mind-parity-check.yml` at CI run time — it injects
  hive-mind tests under a `-hive-mind` filename suffix on every
  relevant PR. Committed sync of test files would duplicate that
  injection mechanism.
- **Rewrites `packages/mcp-server/` → `packages/memory-mcp/`** in the
  patch headers, because waggle-os keeps the MCP server package under
  a different directory name. Other 4 trigger paths (core,
  wiki-compiler, cli) match directly between the two repos.
- **Never auto-merges.** PRs sit for human review on the waggle-os side.

The reverse direction (waggle-os → hive-mind) is implemented in the
sibling workflow `marolinik/waggle-os/.github/workflows/sync-mind.yml`.

---

## Setup (one-time, by Marko)

Both workflows ship inactive by default. To activate:

```bash
# Create fine-grained PAT scoped to marolinik/waggle-os with
# `pull_request: write` + `contents: write` permissions (via GitHub UI).
gh secret set WAGGLE_OS_SYNC_TOKEN --repo marolinik/hive-mind
gh variable set WAGGLE_OS_SYNC_ENABLED --body 'true' --repo marolinik/hive-mind

# Pair with the symmetric activation in waggle-os:
gh secret set HIVE_MIND_SYNC_TOKEN --repo marolinik/waggle-os
gh variable set MIND_SYNC_ENABLED --body 'true' --repo marolinik/waggle-os
```

Both directions should be activated together — asymmetric activation
is supported (the kill switch lets either side flip independently) but
is operationally suboptimal.

To deactivate without removing the secret:

```bash
gh variable set WAGGLE_OS_SYNC_ENABLED --body 'false' --repo marolinik/hive-mind
```

If `WAGGLE_OS_SYNC_TOKEN` is missing while `WAGGLE_OS_SYNC_ENABLED` is
true, the workflow fails fast with a structured error pointing here.

---

## When the patch doesn't apply

`git apply --3way` handles small index mismatches. For larger conflicts,
the workflow exits with an error and uploads the patch as a 30-day
artifact. Manual reconciliation:

1. Pull the artifact `sync-patch-<short-sha>` from the workflow run.
2. Check out waggle-os main locally; `git apply` the
   `patch.diff` (the rewritten one with `mcp-server → memory-mcp`
   already applied) on a branch named
   `auto-sync/hive-mind-<short-sha>`.
3. Resolve conflicts; commit + open the PR by hand following the body
   template in the workflow.

This is rare in practice because hive-mind's mind/ files are mostly
verbatim extractions of waggle-os's. Genuine conflicts mean waggle-os
has its own change at the same lines — exactly the case the human
review is supposed to catch.

---

## Cross-references

- Forward-direction workflow:
  [`waggle-os/.github/workflows/sync-mind.yml`](https://github.com/marolinik/waggle-os/blob/main/.github/workflows/sync-mind.yml)
- Parity check (in waggle-os, runs hive-mind tests against the production substrate):
  [`waggle-os/.github/workflows/mind-parity-check.yml`](https://github.com/marolinik/waggle-os/blob/main/.github/workflows/mind-parity-check.yml)
- Closure memo (full Memory Sync Repair history, 5 commits, lessons learned):
  [`waggle-os PM decisions/2026-04-27-memory-sync-repair-CLOSED.md`](https://github.com/marolinik/waggle-os/blob/main/PM-Waggle-OS/decisions/2026-04-27-memory-sync-repair-CLOSED.md)
  *(Note: PM-Waggle-OS is a sibling repo to waggle-os; the path above resolves through the relative checkout layout used during Memory Sync Repair.)*
- EXTRACTION.md (this repo): the file-by-file map between waggle-os
  and hive-mind packages — the ground truth for the
  `mcp-server → memory-mcp` path rewrite + which paths are extracted
  in the first place.
