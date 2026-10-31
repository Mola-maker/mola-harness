# mola-harness — architecture design (v0.1)

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
  `harness-survey.md` (Phase 2) in this directory. No benchmark numbers are
  claimed anywhere: no surveyed candidate documents a measured latency or
  token-efficiency figure, and mola-harness's own numbers must be measured
  by mola-harness itself (v0.2).

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
  operator's OS user behind a bypassable name denylist. mola-harness treats
  that as the anti-pattern (see Safety).

## The agent loop (v0.1)

```
user message → system prompt (small, fixed budget) → provider.complete()
  → tool calls? → execute tools (gated) → tool results back to provider
  → repeat until final text or max steps
```

- One loop, one agent, one workspace. No planner module, no swarm in v0.1.
- Every turn (messages, tool calls, tool results) is appended to a JSONL
  session log, so a run is inspectable and replayable.
- `--dry-run` prints the tool calls the loop *would* execute without
  executing them — the `observe`-mode descendant from the dsh prototype:
  safe by default, act only when asked.

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
    set, and the only provider the smoke test uses. It proves the loop, the
    tools, and the session log; it proves nothing about model quality.
- Keys: `MOLA_API_KEY`, falling back to `DEEPSEEK_API_KEY` for the deepseek
  preset. A missing key for a real provider is a clear error, not a silent
  mock fallback.
- **Open question (from the survey):** DeepSeek's tool-calling reliability
  through this loop must be verified empirically before claiming
  DeepSeek-first quality. No surveyed docs settle it. v0.2 measures it.

## Tool system + safety gates (v0.1)

- Tools are registered in a small registry with hand-rolled argument
  validation (no zod dependency). A bad argument returns an error *as a tool
  result* (visible to the model), never a crash.
- v0.1 tools:
  - `read`: read a file. Confined to the workspace root (resolved path must
    stay under it; `..` escapes and absolute outside paths are refused),
    with a size cap.
  - `bash`: run a command. **Allowlist gate, not a denylist** (the dsh
    prototype's lesson): the command name must be on a small list
    (`ls`, `pwd`, `echo`, `wc`, `head`, `date`, `uname`); shell
    metacharacters (pipes, redirects, `;`, `&`, backticks, `$()`) are
    refused; it runs with no shell (`execFile`), cwd confined to the
    workspace, a timeout, and an output cap.
- Permissions, v0.1 shape: allowlist = allow, everything else = deny.
  Interactive ask mode, per-tool permission rules, and lifecycle hooks for
  deterministic checks are v0.2 (the Claude Code layer).
- **Honest limit, stated in the README:** v0.1 confinement + allowlist is
  process-level hardening, NOT a sandbox. Real isolation (container, VM, or
  dedicated OS user) is on the v0.2 roadmap. Never claim v0.1 is sandboxed.

## Session / memory (v0.1)

- Append-only JSONL per run: `.mola/sessions/<id>.jsonl` under the workspace
  (messages, tool calls, tool results, final answer).
- No vector memory, no RAG, no cross-run memory store in v0.1 — the same
  honest boundary the dsh prototype has (its "memory" is its SQLite store +
  session history + bounded reads).
- v0.2: resume/fork by session id, compaction of long sessions, and
  isolated-context subagents.

## Config (v0.1)

Environment only, no config file yet (a `mola.json` is v0.2):

| Variable | Meaning |
|---|---|
| `MOLA_PROVIDER` | `mock` (default) \| `deepseek` \| `custom` |
| `MOLA_MODEL` | Model id (preset default when unset) |
| `MOLA_API_KEY` | API key (or `DEEPSEEK_API_KEY` for deepseek) |
| `MOLA_BASE_URL` | Custom endpoint base (custom preset) |
| `MOLA_WORKSPACE` | Workspace root (default: current directory) |
| `MOLA_MAX_STEPS` | Loop cap (default 10) |

## Plugin / skill extensibility

- v0.1: the tool registry *is* the extension point (register a tool
  definition + handler; the loop needs no changes). That is the seam the
  v0.2 skill system and MCP host attach to.
- v0.2: skills with progressive disclosure (load a skill's description
  first, its body on demand), an MCP host with on-demand schema loading,
  lifecycle hooks, and the router/worker split for multi-step work.

## Project layout (v0.1)

```text
src/
  cli.ts        argument parsing + entrypoint
  config.ts     env-based config (no keys logged)
  providers.ts  Provider interface + mock + OpenAI-compatible
  tools.ts      tool registry + read + gated bash
  loop.ts       agent loop + JSONL session log
tests/
  smoke.mjs     mock-provider loop test + safety-gate checks
assets/icon.svg
docs/ARCHITECTURE.md
README.md
LICENSE (Apache-2.0)
package.json (zero dependencies; Node >= 22 for type-stripping)
```

## v0.2 roadmap (next steps)

1. Measure DeepSeek tool-calling reliability on a fixed task set; publish
   the numbers (this becomes the project's first real benchmark story).
2. Skills (progressive disclosure) + MCP host with on-demand schema loading.
3. Resume/fork + compaction; isolated-context subagents.
4. Allow/ask/deny permissions + lifecycle hooks for deterministic checks.
5. Real isolation for tool execution (container/VM/dedicated user) so the
   "sandbox" claim becomes true.
6. Config file (`mola.json`), TUI mode, and a plugin/skill registry.
