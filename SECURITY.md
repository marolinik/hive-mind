# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through **GitHub's private vulnerability reporting** only.

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (this opens a GitHub Security Advisory draft).
3. Include a clear description, reproduction steps, affected version, and impact.

**Do not open a public issue, pull request, or discussion for a vulnerability.** Public disclosure before a fix is available puts all users at risk.

This is a solo / small-team, open-source project. Reports are handled on a best-effort basis:

- **Acknowledgement:** within a few business days of submission.
- **Triage & fix:** prioritized by severity; we will keep you updated through the advisory thread.

There is no bug-bounty program, and no email address is published for security contact — the GitHub Security Advisory channel is the single supported path.

## Supported Versions

Only the latest minor line receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Security Model

hive-mind is **local-first**, and its security posture follows from that:

- **No cloud data egress by default.** Your memory data stays on your machine. Network calls happen only when you explicitly configure an embedding or verification provider that requires one.
- **Local single-file database.** Each mind is a single SQLite file (`*.mind`) stored under `HIVE_MIND_DATA_DIR` (default `~/.hive-mind`). There is no central server and no shared multi-tenant store.
- **API keys come from the environment, never the database.** Provider credentials (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`) are read from environment variables at runtime and are never persisted to the `*.mind` file.
- **Prompt-injection scanning.** Ingested and harvested content is run through a built-in scanner — `scanForInjection(text, context)` in `packages/core/src/injection-scanner.ts` — which flags `role_override`, `prompt_extraction`, and authority-claim patterns and assigns a score. This is a defense-in-depth signal, not a guarantee: treat all untrusted content with care.

### Your responsibilities

Because hive-mind runs entirely on your hardware, securing the environment is up to you:

- Protect your data directory (`HIVE_MIND_DATA_DIR` / `~/.hive-mind`) with appropriate filesystem permissions. The `*.mind` files contain your memory contents in cleartext.
- Keep provider API keys out of source control and shell history; manage them with your OS keychain, a secrets manager, or environment files that are not committed.
- Be cautious about what you ingest. The injection scanner reduces but does not eliminate the risk of malicious instructions embedded in third-party content.

## Scope

In scope: the code in this repository and the published `@hive-mind/*` packages. Out of scope: third-party embedding/LLM providers, your local OS configuration, and any downstream system that consumes hive-mind output.
