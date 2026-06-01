# Releasing `@hive-mind/*`

This monorepo publishes its packages to npm in lockstep using
[Changesets](https://github.com/changesets/changesets) + a GitHub Actions
workflow with **npm OIDC trusted publishing** (no long-lived `NPM_TOKEN`) and
automatic **provenance** attestation.

**Package manager:** npm workspaces. Do NOT introduce pnpm or Turborepo
(deferred per `CLAUDE.md`). Changesets is package-manager-agnostic.

## Published packages (the `fixed` lockstep group)

All 7 version together at one shared version:

| Package | What a consumer does with it |
|---------|------------------------------|
| `@hive-mind/core` | Library — the engine (`MindDB`, `HybridSearch`, `KnowledgeGraph`, …) |
| `@hive-mind/enrichment` | Library — in-loop recall/synthesis helpers + the CLI bridge |
| `@hive-mind/wiki-compiler` | Library — compiles frames/entities into wiki pages |
| `@hive-mind/mcp-server` | `npx @hive-mind/mcp-server` — the stdio MCP server (21 tools) |
| `@hive-mind/cli` | `hive-mind-cli` — recall/save/harvest/cognify/compile commands |
| `@hive-mind/claude-code-hooks` | `hive-mind-hooks` — the 5 lifecycle hooks + `/hive` command |
| `@hive-mind/wiki-web` | `hive-mind-wiki` — launches the local read-only wiki UI (port 3717) |

Internal deps are exact-pinned (e.g. `"@hive-mind/core": "0.4.0"`). On
`changeset version`, every internal pin is rewritten to the new version
(`updateInternalDependencies: "patch"`), keeping the set in lockstep. Publish
order is topologically sorted automatically (core → wiki-compiler/enrichment →
mcp-server/cli/claude-code-hooks/wiki-web).

## Day-to-day: authoring a change

1. Make your code change on a feature branch.
2. Add a changeset describing the bump:
   ```bash
   npm run changeset
   ```
   Pick the bump type (the `fixed` group bumps all packages together) and write a
   human-readable summary. Commit the generated `.changeset/*.md`.
3. Open a PR against `master`. CI (`ci.yml`) runs build + test + lint + typecheck.

## Cutting a release (maintainers)

1. Merge feature PRs (each carrying a changeset) into `master`.
2. The `Publish` workflow opens/updates a **"Version Packages" PR** that consumes
   the pending changesets: bumps versions, rewrites internal pins, updates
   `CHANGELOG.md`s.
3. Review and **merge the "Version Packages" PR**.
4. Merging re-triggers `Publish`; it runs `npm run release` (`changeset publish`)
   and publishes the changed packages to npm with provenance, then tags + creates
   GitHub releases.

## Verifying release-readiness locally (no publish)

```bash
npm install
npm run build
npm run typecheck
npm test
npm run lint
# pack every package (no registry write):
npm pack --dry-run --workspaces
# see what changesets would version:
npx changeset status --verbose
# full publish dry-run (no registry write):
npm publish --dry-run --workspaces
```

> Note: `changeset publish` has **no** `--dry-run` flag — use `npm publish --dry-run`
> for the publish dry-run. `changeset publish` (no flag) is what CI runs to do the
> real publish after the "Version Packages" PR merges.

All of the above must be green before a release. `--dry-run` never writes to the
registry.

## First version: `0.4.0` vs `0.4.1`

The packages are at `0.4.0` and have never been published. Two paths:

- **Publish `0.4.0` first (recommended):** delete `.changeset/release-pipeline.md`
  before the first CI run, so CI publishes the current `0.4.0` directly. Add
  changesets only for subsequent releases.
- **Bump to `0.4.1` to exercise the pipeline:** keep `release-pipeline.md`; the
  first release PR bumps all packages to `0.4.1` and publishes that.

## One-time owner setup (required before the FIRST real publish)

OIDC trusted publishing attaches to an *existing* package, so a brand-new package
name cannot be OIDC-published on its very first release. For each package, choose
ONE bootstrap path:

- **Path A (recommended):** owner runs a one-time manual `npm publish --access public`
  locally (after `npm login` or with a granular publish token) to create each
  package on the registry, then wires up the Trusted Publisher and lets CI take
  over for all subsequent releases.
- **Path B:** temporarily add a granular `NPM_TOKEN` (publish scope) to the publish
  step for the first run only, then remove it and switch to OIDC.

Then, for each package at `https://www.npmjs.com/package/<pkg>/access` →
**Trusted Publisher** → GitHub Actions (fields case-sensitive, exact):

- Organization/user: `marolinik`
- Repository: `hive-mind`
- Workflow filename: `publish.yml`
- Environment: leave blank

## Gotchas

- **npm >= 11.5.1** is required for OIDC trusted publishing. Node 20's bundled npm
  is older — the workflow's `npm install -g npm@latest` step is mandatory. If OIDC
  still fails, bump the workflow to `node-version: 22`.
- **Provenance** requires a public repo + public package + a GitHub-hosted runner +
  `id-token: write`. All hold here.
- **Do NOT set `NODE_AUTH_TOKEN` / `always-auth`** in the publish job — a token
  present defeats OIDC.
- **`files` allowlist:** every published package ships only its build output / src
  (+ `package.json`, `README`, `LICENSE`, `NOTICE`). `enrichment` ships `src/` and
  uses a **negated `files` glob** (`"!src/**/*.test.js"`) to keep test files out of
  the tarball — a `.npmignore` does NOT subtract from a `files` allowlist, but a
  negated pattern inside `files` does.
- **Residual dev-only audit advisories:** `npm audit` reports moderates/criticals in
  the vitest/vite/esbuild test chain (all `dev` deps — `npm audit --omit=dev` is
  clean, so nothing reaches consumers). Clearing them needs a breaking `vitest 2→4`
  major; track as its own PR, not a release blocker.
