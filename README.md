<img src="assets/icon.svg" width="96" height="96" alt="mola-harness icon">

# mola-harness

A minimal agent harness for individual developers: a small loop, DeepSeek-first,
model-agnostic, local-first — with zero dependencies.

mola-harness is the layer *around* the model: the agent loop (call model →
execute tool → observe → repeat), tool schemas, safety gates, and session logs.
It is deliberately small: one loop, a handful of tools, and a provider interface
you can point at DeepSeek or any OpenAI-compatible endpoint. Everything else
is designed to be added as an extension, not baked into the core.

## Quickstart (no key, no install)

Requires Node ≥ 22. Clone and run — the mock provider needs no network and no
API key, so the loop, tools, and session log work immediately:

```sh
git clone https://github.com/Mola-maker/mola-harness.git
cd mola-harness
node src/cli.ts run "read package.json and tell me its name" --provider mock
```

You should see the answer plus a session path like
`.mola/sessions/<id>.jsonl` — every turn is logged there as JSONL.

## Real provider (key via environment only)

```sh
DEEPSEEK_API_KEY=... node src/cli.ts run "summarize README.md" --provider deepseek
```

Keys come from the environment (`MOLA_API_KEY`, or `DEEPSEEK_API_KEY` for the
deepseek preset) and are never logged, never written to session files, never
accepted on the command line, and never allowed in `mola.json` (a
secret-looking key in a config file is a hard error). A real provider without
a key is a clear error, not a silent mock fallback.

## Commands

```sh
node src/cli.ts run "task" [options]              # start a run
node src/cli.ts resume <session-id> ["follow-up"] # continue a run from its log
node src/cli.ts fork <session-id> ["follow-up"]   # branch a run into a new session
node src/cli.ts sessions                          # list sessions in the workspace
```

Session ids accept a unique prefix. A session that already ended with an
answer needs a follow-up message to resume; a session stopped at max steps
resumes directly.

### Options

| Flag | Meaning |
|---|---|
| `--provider mock\|deepseek\|custom` | Provider preset |
| `--model MODEL` | Model id |
| `--workspace DIR` | Workspace root (default: current directory) |
| `--max-steps N` | Loop cap (default 10) |
| `--dry-run` | Print planned tool calls without executing them |
| `--yes` | Treat `ask` permissions as allowed |
| `--sandbox` | Run `bash` under `bwrap` when available (warn + fall back otherwise) |

## How it works

```text
user message → system prompt (small, fixed budget) → provider.complete()
  → tool calls? → permission check → hooks → execute tools (gated)
  → tool results back to provider → repeat until final text or max steps
```

### Providers

| Preset | Endpoint | Default model |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `custom` | `MOLA_BASE_URL` | `MOLA_MODEL` (required) |
| `mock` | — (no network) | — (scripted) |

The transport is OpenAI-compatible chat completions over `fetch`. Requests
retry on 429/5xx with backoff (honoring `Retry-After`) and a configurable
timeout; malformed tool arguments become tool errors, never a loop crash.
To add a provider, implement one `complete()` method — the loop never sees
provider details.

### Tools

| Tool | What it does | Gate |
|---|---|---|
| `read` | Read a text file in the workspace | Path must stay inside the workspace root; size cap |
| `write` | Write a text file in the workspace | Same confinement; refuses `.mola/`; `ask` by default |
| `glob` | List files matching `*` / `**` / `?` | Skips `.mola`, `node_modules`, `.git`; result cap |
| `grep` | Regex-search file contents | Skips binary files and `.mola`; match cap |
| `bash` | Run one command in the workspace | **Allowlist, not a denylist**: `ls`, `pwd`, `echo`, `wc`, `head`, `date`, `uname` by default (extendable via `mola.json`); no shell, no pipes, no redirects, no substitution; scrubbed env; timeout + output cap |
| `skill` | Load a skill's full body by name | Only discovered skills (see below) |
| `subagent` | Run an isolated subagent on a subtask | Own history, restricted tools, step + depth caps; only a summary returns |
| `mcp_<server>_<tool>` | Call an MCP server's tool | Per-server timeout; server errors returned as tool results |

A bad call returns an error *as a tool result* (visible to the model), never
a crash. `--dry-run` prints the tool calls the loop *would* execute without
executing them — observe mode by default, act only when asked.

### Permissions (allow/ask/deny)

`mola.json` maps tool names to `allow`, `ask`, or `deny` (plus a `default`
rule and an `mcp:*` wildcard). Defaults: `read`/`glob`/`grep`/`skill`/`bash`
allow, `write`/`subagent`/MCP tools ask. `ask` prompts on a TTY, denies when
non-interactive, and `--yes` allows. Every decision is written to the session
log.

### Hooks

`mola.json` maps lifecycle events to commands: `session:start`,
`before-tool`, `after-tool`, `session:end`. Hooks run with a timeout and a
scrubbed environment plus `MOLA_HOOK_EVENT` / `MOLA_HOOK_TOOL` /
`MOLA_HOOK_JSON`. A hook failure is logged and never breaks the loop.

### Skills (progressive disclosure)

Put a `SKILL.md` in `skills/<name>/` with frontmatter `name:` and
`description:`. The system prompt lists only names + one-line descriptions;
the model loads a full body with the `skill` tool when it fits the task.

### MCP host

`mola.json` `mcpServers` maps a server name to `{command, args?, env?}`.
Schemas load from the server at session start (cached per session); calls
carry a timeout. A server that fails to start or list is skipped with a
warning — it never breaks the loop.

### Sessions, resume, fork, compaction

Every run appends to `.mola/sessions/<id>.jsonl` in the workspace:
messages, tool calls, tool results, permission decisions, hook results,
compaction events, and a trailing `session_end` reason. Inspectable,
replayable, and free of secrets.

When the live transcript exceeds a character budget (default 24,000 chars,
~6k tokens at 4 chars/token), old turns compress into one deterministic
summary message; the system prompt + recent turns are kept. The stored log
is never rewritten — compaction only trims what is sent to the provider
next, so no session history is ever lost.

SIGINT ends a run gracefully: a `session_end` marker with reason
`interrupted` is written even while the provider is hanging.

**Honest limit:** v0.2 confinement + allowlist + optional `bwrap` is
hardening, **not a strong sandbox**. `bwrap` is a container boundary, not a
VM, and without `bwrap` the fallback is process-level only. Do not run
untrusted tasks with v0.2 and call it sandboxed.

### Config (`mola.json`)

Precedence: CLI flags > environment > project `.mola/mola.json` > user
`~/.config/mola/mola.json` > defaults. An invalid file fails with the file
name, the key, and the expected shape — never a silent fallback.

| Key | Meaning |
|---|---|
| `provider`, `model`, `baseUrl` | Provider preset, model id, custom endpoint |
| `maxSteps` | Loop cap (default 10) |
| `dryRun`, `yes`, `sandbox` | Booleans matching the CLI flags |
| `requestTimeoutMs`, `maxRetries` | Provider request timeout (default 120,000) and retry count (default 3) |
| `permissions` | `{tool: "allow"\|"ask"\|"deny", "default"?, "mcp:*"?}` |
| `hooks` | `{event: "command"}` for `session:start`, `before-tool`, `after-tool`, `session:end` |
| `bashAllowlist` | Extra commands added to the `bash` allowlist |
| `mcpServers` | `{name: {command, args?, env?}}` |
| `skillsDir` | Skills directory (default `skills`, relative to workspace) |
| `compaction` | `{maxChars, keepMessages}` (defaults 24,000 / 8) |
| `subagent` | `{maxDepth, maxSteps}` (defaults 1 / 5) |

Environment variables: `MOLA_PROVIDER`, `MOLA_MODEL`, `MOLA_BASE_URL`,
`MOLA_WORKSPACE`, `MOLA_MAX_STEPS`, `MOLA_DRY_RUN`, `MOLA_YES`,
`MOLA_SANDBOX`, `MOLA_REQUEST_TIMEOUT_MS`, `MOLA_MAX_RETRIES`,
`MOLA_API_KEY`, `DEEPSEEK_API_KEY`.

### Benchmark

```sh
node tests/bench/run.mjs                  # mock mode: pipeline self-test
node tests/bench/run.mjs --out report.json
DEEPSEEK_API_KEY=... node tests/bench/run.mjs --real   # real DeepSeek measurement
```

The fixed 5-task set scores pass rate, tool-call accuracy (name-sequence
match), and step counts. **Mock-mode scores measure the harness pipeline,
not model quality — never quote them as DeepSeek results.** Real numbers
require a key-holder run with `--real`.

## Design

The architecture is a principled hybrid, reimplemented from scratch:
**Pi's minimal agent loop** (small core, small system prompt, everything else
as an extension) plus **Claude Code's publicly documented harness concepts**
(skills with progressive disclosure, MCP host, lifecycle hooks,
isolated-context subagents, compaction, allow/ask/deny permissions).
Full reasoning, including what was borrowed from DeepSeek's
`dsh-superagent-prototype` research prototype and what was deliberately
avoided (notably its non-sandbox: workers running with full OS-user access
behind a bypassable denylist), is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tests

```sh
npm test   # 14 test files, 138 checks, all offline, no keys
```

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
