---
"@hive-mind/core": patch
"@hive-mind/cli": patch
---

Harden knowledge-graph extraction and CLI cognify so model output is parsed
fail-closed, entity provenance is atomic, resumable scans stay idempotent, and
unexpected database failures are no longer hidden.
