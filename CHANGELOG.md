# Changelog

## 0.2.0 — 2026-11-01

Production-hardening release: the harness is now configurable, permissioned,
extensible, and resumable — still zero dependencies, still offline-testable.

Added:
- `mola.json` config: project `.mola/mola.json` overrides user
  `~/.config/mola/mola.json`; precedence CLI > env > project > user >
  defaults. Invalid configs fail with file + key + expected shape, and any
  secret-looking key in a config file is rejected (keys stay env-only).
- Permissions (allow/ask/deny) per tool name, with an `mcp:*` wildcard.
  `ask` prompts on a TTY, denies when non-interactive, and `--yes` allows.
  Every decision is written to the session log.
- Lifecycle hooks (`session:start`, `before-tool`, `after-tool`,
  `session:end`): commands from `mola.json`, run with a timeout and a
  scrubbed env. A hook failure is logged and never breaks the loop.
- Skills with progressive disclosure: `skills/*/SKILL.md` auto-discovered
  (frontmatter `name`/`description`); the system prompt lists names +
  one-liners only; the `skill` tool loads the full body on demand.
- MCP host: stdio JSON-RPC client. Server schemas load from the server at
  session start (cached per session); calls carry a timeout; a dead server
  is skipped with a warning, never fatal. Remote tools appear as
  `mcp_<server>_<tool>`.
- `subagent` tool: isolated context (own history, restricted tool subset,
  step cap, depth cap); only a summary returns to the parent loop.
- Compaction: when the live transcript exceeds a character budget, old
  turns compress into one deterministic summary message; system prompt +
  recent turns are kept. The stored session log is never rewritten.
- `mola resume <session-id>`, `mola fork <session-id>`, `mola sessions`:
  replay from JSONL and continue, or branch into a new session.
- New tools: `write` (workspace-confined, `ask` by default, refuses
  `.mola/`), `glob` (`*`/`**`/`?`), `grep` (regex, skips binary/`.mola`).
  `bash` allowlist is extendable via `mola.json` `bashAllowlist`, and
  child processes get a scrubbed env (PATH + locale/timezone only).
- `--sandbox`: runs `bash` under `bwrap` when available; without `bwrap`
  it warns clearly and falls back to process-level isolation.
- Provider robustness: retries on 429/5xx with backoff, honoring
  `Retry-After`; configurable request timeout; malformed tool arguments
  become tool errors, never a loop crash.
- SIGINT ends a run gracefully: a `session_end` marker with reason
  `interrupted` is written even while the provider is hanging.
- Benchmark skeleton (`tests/bench/`): fixed 5-task set + runner with
  pass rate, tool-call accuracy, and step counts. Mock mode validates the
  pipeline; `--real` with `DEEPSEEK_API_KEY` measures DeepSeek for real.
- CI workflow is pending, not shipped: the push token lacks the `workflow`
  scope, so `.github/workflows/ci.yml` could not be pushed with this
  release. Adding it via the GitHub web UI (or a token with workflow
  scope) is the only leftover item.

Changed:
- `npm test` now runs 14 test files (138 checks, all offline, no keys).
- Session logs now record permission decisions, hook results, compaction
  events, warnings, and a trailing `session_end` reason; tool results
  carry their `toolCallId` so replay rebuilds exact provider history.

Honest limits (unchanged in spirit, narrower in scope):
- v0.2 is still not a strong sandbox: `bwrap` is a container boundary,
  not a VM, and without `bwrap` the fallback is process-level only.
- Mock-mode benchmark scores measure the harness pipeline, not model
  quality. Real DeepSeek measurements still await a key-holder run.

## 0.1.0 — 2026-11-01

Initial release: minimal agent loop, `read` + allowlisted `bash`, mock and
OpenAI-compatible providers, env-only config, JSONL session logs.
