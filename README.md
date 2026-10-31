<img src="assets/icon.svg" width="96" height="96" alt="mola-harness icon">

# mola-harness

A minimal agent harness for individual developers: a small loop, DeepSeek-first,
model-agnostic, local-first — with zero dependencies.

mola-harness is the layer *around* the model: the agent loop (call model →
execute tool → observe → repeat), tool schemas, safety gates, and session logs.
It is deliberately small: one loop, two tools in v0.1, and a provider interface
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
deepseek preset) and are never logged, never written to session files, and
never accepted on the command line. A real provider without a key is a clear
error, not a silent mock fallback.

## How it works

```text
user message → system prompt (small, fixed budget) → provider.complete()
  → tool calls? → execute tools (gated) → tool results back to provider
  → repeat until final text or max steps
```

### Providers

| Preset | Endpoint | Default model |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `custom` | `MOLA_BASE_URL` | `MOLA_MODEL` (required) |
| `mock` | — (no network) | — (scripted) |

The transport is OpenAI-compatible chat completions over `fetch`. To add a
provider, implement one `complete()` method — the loop never sees provider
details.

### Tools (v0.1)

| Tool | What it does | Gate |
|---|---|---|
| `read` | Read a text file in the workspace | Resolved path must stay inside the workspace root; size cap |
| `bash` | Run one command in the workspace | **Allowlist, not a denylist**: `ls`, `pwd`, `echo`, `wc`, `head`, `date`, `uname` only; no shell, no pipes, no redirects, no substitution; timeout + output cap |

A bad call returns an error *as a tool result* (visible to the model), never
a crash. `--dry-run` prints the tool calls the loop *would* execute without
executing them — observe mode by default, act only when asked.

**Honest limit:** v0.1 confinement + allowlist is process-level hardening,
**not a sandbox**. Real isolation (container, VM, or dedicated OS user) is on
the roadmap. Do not run untrusted tasks with v0.1 and call it sandboxed.

### Config (environment only in v0.1)

| Variable | Meaning |
|---|---|
| `MOLA_PROVIDER` | `mock` (default) \| `deepseek` \| `custom` |
| `MOLA_MODEL` | Model id (preset default when unset) |
| `MOLA_API_KEY` | API key (or `DEEPSEEK_API_KEY` for deepseek) |
| `MOLA_BASE_URL` | Custom endpoint base (custom preset) |
| `MOLA_WORKSPACE` | Workspace root (default: current directory) |
| `MOLA_MAX_STEPS` | Loop cap (default 10) |

### Sessions

Every run appends to `.mola/sessions/<id>.jsonl` in the workspace:
messages, tool calls, tool results, and the final answer. Inspectable,
replayable, and free of secrets.

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

## Roadmap (v0.2)

1. Measure DeepSeek tool-calling reliability on a fixed task set — the
   project's first real benchmark story (no surveyed harness documents one,
   so this must be measured, not claimed).
2. Skills (progressive disclosure) + MCP host with on-demand schema loading.
3. Resume/fork + compaction; isolated-context subagents.
4. Allow/ask/deny permissions + lifecycle hooks for deterministic checks.
5. Real isolation for tool execution (container/VM/dedicated user).
6. Config file (`mola.json`), TUI mode, plugin/skill registry.

## Tests

```sh
npm test   # mock-provider loop + safety-gate checks, no network, no keys
```

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
