# Contributing to hive-mind

Thanks for your interest. **hive-mind** is a local-first AI memory system:
persistent memory, semantic search, a knowledge graph, and a wiki compiler
for AI agents — running entirely on your machine with no cloud dependency.
This repo is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
monorepo of seven TypeScript packages built with `tsc --build` project
references and tested with [Vitest](https://vitest.dev).

## Prerequisites

- **Node.js >= 20** (see `engines` in `package.json`)
- **npm** (the workspace manager — this repo does not use pnpm or Turborepo)

## Getting started

```bash
git clone https://github.com/marolinik/hive-mind
cd hive-mind
npm install
npm run build
npm test
```

`npm install` links all workspaces, `npm run build` compiles the project
references, and `npm test` runs the full Vitest suite (currently 312 tests).

## Project layout

All packages are scoped `@hive-mind/*` and live under `packages/`:

| Package | Path | What it does |
| --- | --- | --- |
| [`@hive-mind/core`](packages/core) | `packages/core` | Memory store, hybrid search, knowledge graph, harvest pipeline |
| [`@hive-mind/wiki-compiler`](packages/wiki-compiler) | `packages/wiki-compiler` | Compiles memories into a browsable wiki |
| [`@hive-mind/mcp-server`](packages/mcp-server) | `packages/mcp-server` | MCP server (stdio) exposing the memory tools |
| [`@hive-mind/cli`](packages/cli) | `packages/cli` | Command-line interface |
| [`@hive-mind/claude-code-hooks`](packages/claude-code-hooks) | `packages/claude-code-hooks` | Claude Code lifecycle hooks, `/hive` command |
| [`@hive-mind/enrichment`](packages/enrichment) | `packages/enrichment` | Memory enrichment (cognify, verification) |
| [`@hive-mind/wiki-web`](packages/wiki-web) | `packages/wiki-web` | Local Express server (port 3717) for browsing the wiki |

## Development workflow

1. **Branch from `master`** — `master` is the default branch.
   ```bash
   git switch -c feat/your-change master
   ```
2. **Write tests** for your change. Place them next to the code as
   `*.test.ts` or under the package's `tests/` directory.
3. **Run the suite** — `npm test` must pass before you open a PR.
4. **Lint and typecheck** before pushing:
   ```bash
   npm run lint
   npm run typecheck
   ```
   `npm run lint` runs ESLint (flat config in `eslint.config.js`) and
   `npm run typecheck` runs `tsc --build`. Both are real CI gates alongside
   `npm test` — see `.github/workflows/ci.yml`.

### Running a single package's tests

Vitest reads the root config, so scope a run with a path filter:

```bash
npx vitest run packages/core            # one package
npx vitest run packages/core/src/foo.test.ts   # one file
npx vitest packages/core                # watch mode
```

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/). The
subject is `<type>: <description>`:

```
feat: add recency decay to hybrid search
fix(cli): respect HIVE_MIND_DATA_DIR in cognify watermark
```

Accepted types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`,
`perf`, `ci`.

## Pull request guidelines

- **One concern per PR.** If you are describing several unrelated changes,
  split them into separate PRs.
- **Fill in the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`):
  description, type of change, linked issue, and the checklist.
- **PR title follows Conventional Commits** (it becomes the squash subject).
- **Link an issue** for any major change — open or reference one with
  `Closes #123`. Bug reports and feature requests have their own issue
  templates under `.github/ISSUE_TEMPLATE/`.
- Confirm `npm test`, `npm run lint`, and `npm run typecheck` all pass.

## Code style

- **TypeScript** throughout; keep public surfaces typed and avoid `any`
  without justification.
- **Small, focused modules** — high cohesion, low coupling. Prefer many
  small files over a few large ones.
- **Prefer immutable data**; avoid in-place mutation.
- Handle errors explicitly; do not silently swallow them.

ESLint's flat config is a deliberately light, non-type-checked tier and
ignores `dist/`, `benchmarks/`, and the `wiki-web` frontend. Type safety is
enforced separately by `npm run typecheck`.

## Reporting bugs and security issues

- **Bugs and feature requests:** open a [GitHub issue](https://github.com/marolinik/hive-mind/issues)
  using the templates under `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities:** do **not** open a public issue. Follow the
  private reporting process in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under
[Apache-2.0](LICENSE).
