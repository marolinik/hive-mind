# Recall stress test

A fast **precision@3 regression gate** for hive-mind recall quality. Runs a set
of queries against `recall_memory`, scores the top-3 results against expected
substrings, and **exits non-zero** if the run is too slow or average precision
drops below a threshold — so it can guard a CI job or a pre-release check.

```bash
# Prereqs: build the repo (npm run build) and have a populated personal mind.
node benchmarks/recall-stress/run.mjs --queries benchmarks/recall-stress/queries.local.json
```

## Queries are parameterized

The query set lives in a JSON file (not hardcoded), because a useful stress test
references *your* seeded corpus:

```jsonc
{
  "profile": "balanced",        // optional; overridable with --profile
  "minPrecision": 0.5,          // gate threshold; overridable with --min-precision
  "queries": [
    { "cat": "concept", "q": "your query", "expect": ["substring", "another"] },
    { "cat": "edge",    "q": "off-topic query", "expect": [] }  // should surface nothing
  ]
}
```

- `expect` — substrings you hope to see in the top-3 results. Precision@3 =
  (matched hits) / (top-3 hits).
- An empty `expect` is an **edge** query: success = nothing scores as relevant
  (top-1 score < 0.02).

Copy [`queries.example.json`](./queries.example.json) to `queries.local.json`
and edit. **`queries.local.json` is gitignored** — keep personal/proprietary
queries out of the repo.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--queries <path>` | `queries.example.json` | Query set to run. |
| `--profile <p>` | file's `profile` or `balanced` | Recall scoring profile. |
| `--min-precision <0..1>` | file's `minPrecision` or `0.5` | Gate: fail below this avg precision@3. |
| `--max-seconds <n>` | `60` | Gate: fail if the whole run exceeds this. |
| `--out <path>` | (none) | Also write a markdown report to this path. |

Portable: the CLI is resolved via `HIVE_MIND_ROOT` (falling back to the repo
root), so the harness runs from any checkout — no hardcoded paths.
