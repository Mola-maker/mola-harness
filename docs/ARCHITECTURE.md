# mola-harness — architecture design (v0.2)

- **Date:** 2026-11-01
- **Audience:** individual developers. Local-first, low cost, easy setup.
- **Decision (from Phase 1 + Phase 2 research):** a principled hybrid, reimplemented
  from scratch in TypeScript with zero dependencies — **Pi's minimal agent loop**
  plus **Claude Code's publicly documented harness concepts** — with DeepSeek as a
  first-class provider and a narrow model-agnostic provider interface.
- **License:** Apache-2.0. Pi is MIT (compatible; this core is written originally
  and credits Pi as inspiration, so no MIT-notice mixing problem). Claude Code is
  proprietary: no code, text, or assets are copied from it — only publicly
  documented ideas are reimplemented. Goose/SmolAgents are Apache-2.0 but were
  not chosen for architectural reasons (see survey).
- **Evidence base:** `dsh-superagent-prototype.md` (Phase 1) and
  `harness-survey.md` (Phase 2) in the research notes. No benchmark numbers are
  claimed without measurement: no surveyed candidate documents a measured latency
  or token-efficiency figure, and mola-harness's own model numbers must be
  measured by mola-harness itself (`tests/bench/run.mjs --real`).

## Why this shape

- Pi's documented thesis — four default tools, a sub-1,000-token system prompt,
  everything else as an extension — is the smallest core a solo dev can fully
  understand, explain, and extend. That is also the most trendable story.
- Pi names DeepSeek among its supported providers with mid-session switching;
  OpenCode requires a user-written custom provider block for DeepSeek. So
  DeepSeek-first is a preset promotion on the Pi shape, not a config burden.
- Claude Code's transferable mechanisms fill Pi's documented gaps: skills
  (progressive disclosure, keeping the prompt small as features grow), hooks
  (deterministic checks instead of trusting the model's self-evaluation),
  isolated-context subagents, compaction, and allow/ask/deny permissions.
- The alternatives fail a hard constraint, not a preference: AutoGen is in
  maintenance mode (Microsoft, 2026-10-02); Goose's own docs warn it works
  best with Claude models (wrong risk for DeepSeek-first); LangGraph/SmolAgents
  are libraries, not a finished terminal harness; OpenCode is a large
  client–server product to differentiate against.
- From the dsh prototype we borrow ideas, not code or the host: attention
  philosophy + `observe` mode (see `--dry-run` below), simplified gate+Mandate
  thinking, router/worker split (later), single-writer engine + effect queue
  (later), structured human questions, worker slots with a reserved human-wake
  slot, versioned prompt configs, and the SourceKind plugin-protocol idea.
  We avoid: the DSH host lock-in, the multi-step setup burden, prompt-text
  safety thresholds, single-repo/polling-only intake — and, above all, the
  prototype's non-sandbox: workers there run `danger-full-access` as the
  operator's OS user behind a bypassable denylist. mola-harness treats that
  as the anti-pattern (see Safety).

## The agent loop (v0.2)

```
user message → system prompt (small, fixed budget) → provider.complete()
  → tool calls? → permission check → hooks → execute tools (gated)
  → tool results back to provider → repeat until final text or max steps
```

- One loop, one agent, one workspace. Subagents are child loops, not a swarm.
- Every turn (messages, tool calls, tool results, permission decisions, hook
  results, compaction events, session_end reason) is appended to a JSONL
  session log, so a run is inspectable and replayable.
- `--dry-run` prints the tool calls the loop *would* execute without
  executing them — the `observe`-mode descendant from the dsh prototype:
  safe by default, act only when asked.
- SIGINT is raced against the provider call, so an interrupted run writes
  its `session_end` marker promptly even while the provider hangs.

## Provider abstraction

```ts
interface Provider {
  complete(req: { model: string; messages: Message[]; tools: ToolDef[] })
    : Promise<{ text: string; toolCalls: ToolCall[] }>;
}
```

- Transport is OpenAI-compatible chat completions over `fetch` — no SDK
  dependency. Tool calls use the standard function-call shape.
- Presets (all key-via-env, never stored or logged):
  - `deepseek` (first-class default when a key is present):
    base `https://api.deepseek.com/v1`, default model `deepseek-chat`.
  - `custom`: any OpenAI-compatible endpoint via `MOLA_BASE_URL` + `MOLA_MODEL`.
  - `mock`: deterministic, scripted, no network — the default when no key is
    set, and the only provider the tests use. It proves the loop, the
    tools, and the session log; it proves nothing about model quality.
- Keys: `MOLA_API_KEY`, falling back to `DEEPSEEK_API_KEY` for the deepseek
  preset. A missing key for a real provider is a clear error, not a silent
  mock fallback.
- Robustness (v0.2): retries on 429/5xx with backoff, honoring `Retry-After`;
  configurable request timeout; malformed (non-object or unparsable) tool
  arguments are marked and reported to the model as tool errors, never a
  loop crash.
- **Open question (from the survey):** DeepSeek's tool-calling reliability
  through this loop must be verified empirically before claiming
  DeepSeek-first quality. No surveyed docs settle it. `tests/bench/` is the
  measurement instrument; the numbers await a key-holder run.

## Tool system + safety gates (v0.2)

- Tools are registered in a small registry with hand-rolled argument
  validation (no zod dependency). A bad argument returns an error *as a tool
  result* (visible to the model), never a crash.
- v0.2 tools:
  - `read`: read a file. Confined to the workspace root (resolved path must
    stay under it; `..` escapes and absolute outside paths are refused),
    with a size cap.
  - `write`: write a file. Same confinement; refuses `.mola/` (session
    state); creates parent directories; content cap. `ask` by default.
  - `glob`: list files by `*`/`**`/`?` pattern. Skips `.mola`,
    `node_modules`, `.git`; result cap.
  - `grep`: regex search over text files (binary sniffed out), scoped to
    a file or directory; match cap.
  - `bash`: run a command. **Allowlist gate, not a denylist** (the dsh
    prototype's lesson): the command name must be on a small list
    (`ls`, `pwd`, `echo`, `wc`, `head`, `date`, `uname`, plus
    `mola.json` `bashAllowlist` additions); shell metacharacters (pipes,
    redirects, `;`, `&`, backticks, `$()`) are refused; it runs with no
    shell (`execFile`), cwd confined to the workspace, a scrubbed env
    (PATH + locale/timezone only), a timeout, and an output cap.
  - `skill`: load a discovered skill's full body on demand.
  - `subagent`: run a child loop (see below).
  - `mcp_<server>_<tool>`: remote tools from configured MCP servers.
- Permissions, v0.2 shape: per-tool allow/ask/deny from `mola.json`
  (explicit rule > `mcp:*` wildcard > built-in default > `default` rule >
  ask). `ask` prompts on a TTY, denies when non-interactive, `--yes`
  allows. Every decision is logged.
- Lifecycle hooks, v0.2: `session:start`, `before-tool`, `after-tool`,
  `session:end` commands from `mola.json`, run with a timeout and a
  scrubbed env. Hook failures are logged, never fatal.
- **Honest limit, stated in the README:** v0.2 confinement + allowlist +
  optional `bwrap` is process/container-level hardening, NOT a strong
  sandbox. Without `bwrap`, `--sandbox` warns and falls back to
  process-level isolation. Never claim v0.2 is sandboxed.

## Session / memory (v0.2)

- Append-only JSONL per run: `.mola/sessions/<id>.jsonl` under the workspace
  (messages, tool calls, tool results, permission decisions, hook results,
  compaction events, final answer, session_end reason).
- Resume/fork: `mola resume <id>` replays the log into provider messages
  and continues; `mola fork <id>` does the same into a new session file
  with a `forked` marker. Tool results carry `toolCallId` so replay
  rebuilds exact provider history.
- Compaction: when the live transcript exceeds a character budget (chars/4
  token estimate), old turns compress into one deterministic summary
  message (first lines, truncated); system prompt + recent turns are kept.
  The stored log is never rewritten — compaction only trims what the
  provider sees next.
- No vector memory, no RAG, no cross-run memory store in v0.2 — the same
  honest boundary the dsh prototype has (its "memory" is its SQLite store +
  session history + bounded reads).

## Config (v0.2)

Two-level `mola.json`: project `.mola/mola.json` overrides user
`~/.config/mola/mola.json` (or `$XDG_CONFIG_HOME/mola/mola.json`).
Precedence: CLI > env > project > user > defaults. Nested objects
(permissions, hooks, mcpServers, compaction, subagent) merge per key;
`bashAllowlist` unions. Unknown keys, wrong types, and any secret-looking
key are hard errors naming the file and the key. Keys come from the
environment only.

| Variable | Meaning |
|---|---|
| `MOLA_PROVIDER` | `mock` (default) \| `deepseek` \| `custom` |
| `MOLA_MODEL` | Model id (preset default when unset) |
| `MOLA_API_KEY` | API key (or `DEEPSEEK_API_KEY` for deepseek) |
| `MOLA_BASE_URL` | Custom endpoint base (custom preset) |
| `MOLA_WORKSPACE` | Workspace root (default: current directory) |
| `MOLA_MAX_STEPS` | Loop cap (default 10) |
| `MOLA_DRY_RUN`, `MOLA_YES`, `MOLA_SANDBOX` | Boolean flags |
| `MOLA_REQUEST_TIMEOUT_MS`, `MOLA_MAX_RETRIES` | Provider robustness knobs |

## Plugin / skill extensibility

- v0.2: the tool registry *is* the extension point (register a tool
  definition + handler; the loop needs no changes). Skills attach via
  `skills/*/SKILL.md` discovery + the `skill` tool; MCP servers attach via
  `mcpServers` config + the stdio JSON-RPC client (`src/mcp.ts`).
- MCP schemas load from the server at session start and are cached per
  session — never bundled. A dead server is skipped with a warning.
- Subagents attach as a tool: a child `runLoop` with its own history,
  a restricted tool subset (builtins + skills, no MCP, no further nesting
  beyond `maxDepth`), a step cap, and its own session log linked by
  `parentSessionId`. Only the child's final answer (truncated) returns.

## Project layout (v0.2)

```text
src/
  cli.ts        run/resume/fork/sessions + entrypoint
  config.ts     two-level mola.json + env + CLI precedence (no keys logged)
  providers.ts  Provider interface + mock + OpenAI-compatible (retry/timeout)
  tools.ts      tool registry + read/write/glob/grep/gated bash/skill
  loop.ts       agent loop + permissions + hooks + compaction + JSONL log
  permissions.ts allow/ask/deny resolution
  hooks.ts      lifecycle hook runner (timeout, scrubbed env, never fatal)
  skills.ts     SKILL.md discovery + frontmatter + prompt section
  mcp.ts       stdio JSON-RPC client + tool loading
  sandbox.ts   bwrap detection + argv prefix
  compaction.ts deterministic transcript compaction
  session.ts   list/replay JSONL sessions
tests/
  run.mjs       runner (14 files, 138 checks, offline, no keys)
  smoke.mjs     mock-provider loop test + safety-gate checks
  config.mjs    precedence + validation + secret rejection
  permissions.mjs / hooks.mjs / skills.mjs / mcp.mjs / subagent.mjs
  compaction.mjs / resume.mjs / tools2.mjs / provider-retry.mjs
  sigint.mjs / sandbox.mjs / bench.mjs
  bench/        fixed 5-task set + runner (mock + --real)
  helpers/      fake MCP server, hanging-provider runner
assets/icon.svg
docs/ARCHITECTURE.md
README.md
CHANGELOG.md
.github/workflows/ci.yml (Node 22, npm test)
LICENSE (Apache-2.0)
package.json (zero dependencies; Node >= 22 for type-stripping)
```

## v0.3 roadmap (next steps)

1. Real DeepSeek measurement: run `tests/bench/run.mjs --real` with a key
   and publish the numbers (the project's first real benchmark story).
2. Stronger isolation for tool execution (VM or dedicated OS user) so the
   "sandbox" claim becomes true.
3. Router/worker split for multi-step work; single-writer engine + effect
   queue (dsh prototype ideas, reimplemented).
4. TUI mode, `mola.json` schema validation command, plugin/skill registry.
