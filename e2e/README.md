# wiki-web end-to-end harness

A reproducible, full-stack verification of the hive-mind **wiki-web** UI. Because
`wiki-web` reads everything through the CLI bridge (`callMcp` → `hive-mind-cli mcp
call …` → `MindDB` → SQLite/FTS5), driving its routes transitively exercises most
of the platform from one surface.

Everything runs against a **deterministic throwaway fixture** seeded under a temp
`HIVE_MIND_DATA_DIR`, so screens are stable and assertable. Seeded content carries
the literal token `ZephyrFixture`, so recall is verified via FTS5/BM25 keyword
match — deterministic even when the embedding provider degrades to "mock".

## Prerequisite

```bash
npm run build      # the server shells out to packages/cli/dist/index.js
```

## Three layers

### 1. Browserless HTTP assertion (CI backbone — no browser needed)

```bash
npm run e2e:http
```

Seeds a fixture, boots the real server, and asserts the HTML/JSON of all 6 routes
+ both JSON APIs + a negative `/entity/999999` → 404. Exit 0 = green. This is the
regression guard for the two bugs found on 2026-06-01 (boot-crash + entity-404).

### 2. Playwright visual tier (optional — real screenshots)

```bash
npm i -D @playwright/test
npx playwright install chromium
npm run e2e:visual          # writes screenshots to e2e/screenshots/
```

Same routes, but in a real Chromium with screenshots and on-screen assertions
(including that the knowledge-graph `<canvas>` actually renders).

### 3. Live agent-vision pass ("you-based")

```bash
node e2e/seed.mjs
PORT=3939 node e2e/serve.mjs        # then drive a browser / MCP and screenshot
```

An agent navigates each route, screenshots it, and **adversarially judges**
whether the screen shows correct real data (not just HTTP 200). The 2026-06-01
run is captured in [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md).

## Files

| File | Role |
|------|------|
| `seed.mjs` | Deterministic fixture builder (via the real CLI bridge). Exits non-zero on any seed failure. |
| `serve.mjs` | Boots wiki-web against a fixture (`PORT`, `[dataDir]`). |
| `http-verify.mjs` | wiki-web — browserless route + JSON assertions (`e2e:http`). |
| `mcp-tools-verify.mjs` | All 21 MCP tools end-to-end via the CLI bridge (`e2e:mcp-tools`). |
| `hooks-verify.mjs` | Live smoke of the 5 Claude Code lifecycle hooks (`e2e:hooks`). |
| `mcp-server-verify.mjs` | stdio JSON-RPC handshake + `npm pack` clean-install check (`e2e:mcp-server`). |
| `_noop-drain.mjs` | No-op `HIVE_MIND_DRAIN_SCRIPT` so the hooks smoke can't touch real `~/.hive-mind`. |
| `playwright.config.ts` + `visual.spec.ts` | Optional visual tier (seeds + serves via `webServer`). |
| `VERIFICATION-REPORT.md` | Latest full-platform verification report. |

Run everything: **`npm run e2e:all`** (http + mcp-tools + hooks + mcp-server).

Fixtures, screenshots, and logs are written under `.e2e-tmp/` (gitignored).

## Reproduce the production gate end to end

```bash
npm run build && npm test && npm run e2e:http
```
