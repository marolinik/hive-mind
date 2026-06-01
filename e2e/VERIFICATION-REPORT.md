# wiki-web E2E Visual Verification Report

## 1. Executive Summary

**OVERALL VERDICT: READY_WITH_CAVEATS — 6/6 routes PASS (4 on the first automated pass; entity + wiki confirmed PASS after re-capture).**

A full end-to-end visual verification of the `@hive-mind/wiki-web` component was run against a deterministic seed, driving a real Chrome browser through every primary route (home, search, entity, frame, graph, wiki) and capturing screenshots. Of the six routes, **4 passed on the first automated pass** (home, search, frame, graph). The entity and wiki screenshots initially failed — but **not because of a product defect**: the live chrome-devtools capture hit a navigate→screenshot **paint race** that saved wrong-page images (the graph view for `/entity/1`, the home page for `/wiki/hive-mind`). Re-capturing with an a11y-snapshot paint barrier — and cross-checking against the browserless `e2e:http` harness (9/9) and a11y snapshots — confirms **both routes render correct seeded data → 6/6**. (Both routes also exercise the two bugs fixed this session: the entity-detail 404, BUG #2 / `38936e4`, and the native-ESM crash that broke every node consumer including the wiki server, BUG #1 / `ace91db`.) With both fixes committed on top of `e2db71a`, the full vitest suite is **GREEN at 548/548** and `typecheck`, `lint`, and `build` all pass. For the current ship scope (local-first plugin + MCP server + wiki-web), the two CRITICAL/HIGH regressions are resolved and regression-guarded. It is **READY_WITH_CAVEATS** rather than fully READY because (a) the `/graph` view still fetches `vis-network` from the `unpkg.com` CDN at runtime — a direct contradiction of the advertised "zero cloud dependency" promise (FINDING #3, OPEN), and (b) the working tree is not clean for a release tag and the two fix commits are not yet pushed.

---

## 2. How the platform was verified

Verification used a **deterministic seed** so every assertion is reproducible and screenshot diffs are meaningful:

- **Sentinel token `ZephyrFixture`** prefixes every seeded frame, making seeded content unambiguous in search results and frame views (no collision with real data).
- **5 entities, 4 relations, 6 frames, 6 wiki pages** are written into a fresh `.mind` SQLite DB:
  - Entities: `Hive Mind` (project), `SQLite`, `Hybrid Search`, `Marko Markovic`, `Egzakta`.
  - Relations: `Hive Mind --uses--> SQLite`, `Hive Mind --implements--> Hybrid Search`, `Marko Markovic --works_on--> Hive Mind`, `Marko Markovic --founder_of--> Egzakta`.
  - Frames 1–6 carry mixed importance (critical / important / normal) and timestamps in the `2026-06-01 15:34:33–34` window.
  - Wiki pages: `egzakta`, `hive-mind`, `hybrid-search`, `marko-markovic`, `sqlite`, plus `index`.

The harness exercises the **full production chain**, not a mock: the wiki-web UI issues requests that flow **UI → `callMcp` CLI bridge → `MindDB` → SQLite/FTS5**, the same path used in real deployment. Pages were rendered in a **real Chrome instance driven via chrome-devtools**, and a screenshot of each route was captured to `D:/Projects/hive-mind/.e2e-tmp/artifacts/{01-home,02-search,03-entity,04-frame,05-graph,06-wiki}.png`. Each screenshot was then independently assessed by a vision pass against the expected seeded content.

---

## 3. E2E visual verification results

| Route | URL | Verdict | What was observed | Issues |
|-------|-----|---------|-------------------|--------|
| home | `/` | **PASS** | Dark, fully-styled layout. Sidebar with `hive-mind` branding + nav (Home active, Search, Graph) + search box. Main: "Welcome" heading, CLI-bridge subtitle, Health list (`data_quality_score: 90`, `total_entities: 5`, `total_frames: 6`, `total_pages: 6`), Wiki pages links (egzakta, hive-mind, hybrid-search, marko-markovic, sqlite, index), Quick links. No errors/empty state. | Two benign extra Health fields (`issues: empty`, `compiled_at`); all 4 required values present and correct. |
| search | `/search?q=ZephyrFixture` | **PASS** | "Search" page, query pre-filled `ZephyrFixture`. "Frames (6)" with exactly 6 `ZephyrFixture:`-prefixed results, each with id, timestamp, and importance badge (critical/important/normal). "Entities (0)" and "Wiki pages (0)" both show "No matches." | None |
| entity | `/entity/1` | **PASS**\* | Entity detail for "Hive Mind", `type: project · id: 1`. Outgoing: `implements → entity 4`, `uses → entity 3`. Incoming: `works_on → entity 2`. | \*First automated capture saved the wrong page (paint race — see adjudication); re-captured cleanly → PASS. Exercises BUG #2 (`38936e4`). |
| frame | `/frame/1` | **PASS** | "Frame 1" heading, metadata line `2026-06-01 15:34:33 · important · user_stated`, monospace content block: "ZephyrFixture: Hive Mind is a local-first AI memory system built on SQLite with hybrid search." | None |
| graph | `/graph` | **PASS** | Fully rendered vis-network graph: 5 labeled nodes (SQLite, Hive Mind, Hybrid Search, Marko Markovic, Egzakta) and 4 directed labeled edges (`uses`, `implements`, `works_on`, `founder_of`) with arrowheads. Populated, not blank. | FINDING #3 (vis-network loaded from `unpkg.com` CDN — local-first violation); minor cosmetic label overlap. |
| wiki | `/wiki/hive-mind` | **PASS**\* | Article "Hive Mind", meta "compiled … · 6 source frames", a "Source frames — synthesis pending" section listing all 6 `ZephyrFixture` frames with recall scores, plus a back-to-home link. | \*First automated capture saved the home page (same paint race); re-captured cleanly → PASS. |

### Re-capture adjudication (entity + wiki)

The first automated pass flagged `/entity/1` and `/wiki/hive-mind` as FAIL because the saved screenshots showed the **wrong page** (the graph view and the home page, respectively). Root cause was **not** a product defect but a **capture paint race**: the live chrome-devtools run issued `navigate_page` → `take_screenshot` with no explicit paint barrier, so some screenshots captured a frame from the wrong route. This is a genuine lesson for the live ("you-based") tier — fixed by inserting an a11y-snapshot barrier between navigate and screenshot (the committed Playwright tier auto-waits and is immune by construction).

After re-capturing with the barrier, **both routes render correct seeded data** and were re-judged **PASS** (entity: "Hive Mind", project, id 1, all three relations; wiki: the article with its 6 source frames). Independently, the browserless `e2e:http` harness asserts both routes' HTML on the fixed build and passes **9/9**, and a11y snapshots confirm the exact content — so the 6/6 result rests on three independent checks, not a single screenshot.

---

## 4. Bugs found & fixed this session

### BUG #1 — CRITICAL — duplicate `getCliPath` export crashed every native-node consumer
- **Commit:** `ace91db`
- **What:** `packages/enrichment/src/cli-bridge.js` exported `getCliPath` twice (an inline `export` plus a trailing re-export). Under strict native ESM that is a hard `SyntaxError`, so `@hive-mind/enrichment` failed to parse and **every node-run consumer crashed on import** — the wiki-web server **and all 5 Claude Code lifecycle hooks** (`session-start`, `user-prompt-submit`, `stop`, `pre-compact`, `post-tool-use`). Shipped since v0.3.0.
- **Why 512 tests missed it:** vitest runs through **esbuild**, which **silently dedupes duplicate exports**, so the module loaded fine under test. Real `node` (and `node --check`) is strict and rejects it. The unit suite never exercised a real native-ESM parse of the file, so the crash was invisible to CI.
- **Guard:** a new `native-esm-syntax.test.js` (36 cases) now runs a real `node --check` over the enrichment/hooks JS files, so a re-introduction fails CI. Suite went 512 → **548**.

### BUG #2 — HIGH — `/entity/:id` never matched (every entity page + graph drill-down 404'd)
- **Commit:** `38936e4`
- **What:** wiki-web passed the numeric id as a **NAME** query to `search_entities`, which never matched by id, so **every `/entity/:id` and every graph-node drill-down returned 404**.
- **Fix:** enumerate entities and **match by id**; additionally dropped the unsafe `|| data[0]` fallback that would otherwise render a wrong/arbitrary entity for an unknown id.

---

## 5. Open findings

### FINDING #3 — MEDIUM — `/graph` loads `vis-network` from an external CDN (local-first violation) — **OPEN**
- **Location:** `packages/wiki-web/src/views/graph.js:8` loads `vis-network@9.1.9` `min.js` from `https://unpkg.com` at runtime. This is the **only** external runtime fetch in wiki-web (the rest of `src` was scanned — no other CDN/http leaks).
- **Impact:** hive-mind's headline promise is "local-first, zero cloud dependency." The knowledge-graph view is **fully broken offline** and **silently issues a request to `unpkg.com` on every visit** (privacy/CSP concern). This directly contradicts the core product claim and **should be fixed before shipping wiki-web in a release**.
- **Fix:** vendor `vis-network` into `packages/wiki-web` and serve it from the existing `express.static` mount; reference it locally. Adding a Content-Security-Policy (see FINDING #4) would also block accidental external script loads.

### FINDING #4 — LOW — `/favicon.ico` 404 + no security headers — **OPEN**
- **Location:** `packages/wiki-web/server.js` mounts only `express.static` — no favicon route and no `Content-Security-Policy`/helmet headers.
- **Impact:** Cosmetic 404 on favicon; missing CSP. Low-impact. Best bundled with the FINDING #3 CDN fix, since a CSP reinforces the local-first guarantee.

---

## 6. What is left before production

### Blockers (must address before a release tag if wiki-web ships)

- **[HIGH] FINDING #3 OPEN — `/graph` fetches `vis-network.min.js` from `unpkg.com` at runtime.** Confirmed at `packages/wiki-web/src/views/graph.js:8`, the only external runtime fetch in wiki-web. Breaks offline use and contradicts "zero cloud dependency." Fix: vendor the asset and serve it locally via `express.static`.
- **[MEDIUM] Local commits not yet pushed.** The e2e harness is now committed and `.e2e-tmp/` is gitignored, so the working tree is clean. The branch is **ahead of `origin/chore/phase-0-release-hardening`** by the two fix commits (`ace91db`, `38936e4`) plus the harness commit — held locally pending an explicit push decision (publishing is outward-facing).

### What's left (prioritized)

- **[P1]** Run `npm audit fix` (non-force) on a clean machine — clears 2 highs + 4 moderates, lockfile-only per S6 handoff. A prior attempt was run-and-reverted; redo on a clean checkout. Not a hard blocker for local-first scope, but land it before any publish.
- **[P1]** FINDING #4 — `/favicon.ico` 404 (cosmetic) + add security headers (CSP/helmet) to wiki-web; bundle with the FINDING #3 CDN fix.
- **[P1]** Decide the eslint `.planning/` ignore — blocked by a config-protection hook needing explicit user OK. Lint currently passes (exit 0), so this is housekeeping, not a gate.
- **[P2]** `@hive-mind/shim-core` does not exist in-repo — `packages/` holds exactly 7 dirs (no shim-core); source lives only in external/proprietary `hive-mind-clients`. **Hard gate** for Phase 3 adapters and ALL of Phase 6. Outside the current local-first ship scope but blocks the multi-adapter roadmap.
- **[P2]** enrichment JS→TS migration (Phase 2b) — `packages/enrichment` is plain JS (16 `.js`, 0 `.ts`, no tsconfig). The "already TS" claim was verified FALSE. Migrate preserving ES exports so all 5 hooks keep working, ≥80% coverage. The new native-esm-syntax guard (`ace91db`) reduces the regression risk that motivated this.
- **[P2]** Publish infrastructure not present — no `.changeset/` config or `.github/workflows/publish.yml`. v0.4.0 metadata is publish-ready but the OIDC/changesets pipeline is unbuilt. Add config + `npm pack --dry-run` on all 7 packages before any registry push (push itself is HELD).
- **[P2]** Held-risky migrations requiring explicit user OK — `claude-hive-mind` archive+delete, and the pnpm + Turborepo + Changesets + OIDC publish migration. These touch shared remote/publish surfaces; CLAUDE.md explicitly defers the pnpm/Turborepo move. Do not start without sign-off.
- **[P3]** Phase 4/5 exit numbers need paid trio-judge eval runs — LoCoMo ≥75%/85%, LongMemEval_S ≥85%, abstention ≥70%, ablation, cross-family re-judge (~$15–200/run, HELD). Code scaffolds are landable in-repo (`assessRetrievalConfidence` abstain scaffold shipped in `e2db71a`; MCP reranker parity fixed in `7b79179`), but the numbers can't be claimed without the runs.
- **[P3]** MCP Streamable HTTP transport + multi-tenant scoping unsketched — server is stdio-only today; HTTP transport and `user_id`/`agent_id`/`run_id` scoping are architecturally unsketched. Not needed for the local single-tenant plugin ship; relevant only for a hosted/multi-tenant future.

---

## 7. Reproduce

Manual two-step (deterministic seed, then serve):

```bash
# 1) Seed a fresh deterministic .mind DB (ZephyrFixture token, 5 entities / 4 relations / 6 frames / 6 wiki pages)
node e2e/seed.mjs

# 2) Serve wiki-web against the seeded DB on port 3939
PORT=3939 node e2e/serve.mjs
```

Then open `http://localhost:3939/` and walk the routes: `/`, `/search?q=ZephyrFixture`, `/entity/1`, `/frame/1`, `/graph`, `/wiki/hive-mind`.

Committed harness (one-shot, once wired into package scripts):

```bash
npm run e2e:http
```

This runs the committed `e2e/` harness (`seed.mjs` + `serve.mjs` + `http-verify.mjs`, with `playwright.config.ts` for the browser pass), seeding, serving, and verifying each route end-to-end through the UI → `callMcp` CLI bridge → `MindDB` → SQLite/FTS5 chain.

---

*Grounded against `chore/phase-0-release-hardening` (fixes `ace91db`, `38936e4` + the e2e harness commit). CI gates GREEN: vitest 548/548, `tsc --build` typecheck exit 0, eslint exit 0, build via tsc; `npm run e2e:http` 9/9. Committed screenshots: `e2e/screenshots/{01-home,02-search,03-entity,04-frame,05-graph,06-wiki}.png`.*
