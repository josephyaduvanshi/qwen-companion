# qwen-plugin-cc

Claude Code marketplace plugin that delegates investigation, implementation,
and research tasks to [Qwen Code](https://github.com/QwenLM/qwen-code) from
inside a Claude Code session.

Architecture is adapted from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc):
same state model, same job tracking, same command/skill/agent layout. The CLI
integration layer is rewritten to speak Qwen Code's `--output-format stream-json`
protocol instead of the Codex `app-server` JSON-RPC broker.

## Why not ACP mode?

Qwen Code supports an `--acp` (Agent Client Protocol) mode, and an earlier
third-party qwen plugin is built on it. We intentionally chose `stream-json`:

- **Resilience** — one process per task, no long-lived handshake state machine
  to drift out of sync across qwen releases.
- **Debuggability** — plain newline-delimited JSON on stdout is easy to tail,
  grep, and replay.
- **Familiarity** — Qwen emits the same stream-json shape Claude Code uses
  internally (system/init, stream_event/message_start, content_block_delta,
  tool_use, result). The adapter is small and obvious.

The tradeoff: no bidirectional turn-interrupt RPC. Cancellation works by
`SIGTERM`ing the tracked worker PID, which is sufficient for the single-turn
rescue workflow this plugin actually targets.

## What's in v0.1

| Component | Status |
| --- | --- |
| `/qwen:setup` | ✅ Detects qwen binary, auth type, default model |
| `/qwen:rescue` (+ `qwen-rescue` subagent) | ✅ Foreground tasks via stream-json |
| `/qwen:status` | ✅ Job table, live details, progress preview |
| `/qwen:result` | ✅ Stored payload + resume hint |
| `/qwen:cancel` | ✅ Kills tracked PID, marks job cancelled |
| Session lifecycle hook | ✅ Auto-cleans jobs on SessionEnd |
| Skills: runtime / result-handling / prompting | ✅ |
| `/qwen:review` and `/qwen:adversarial-review` | ⏳ Planned for v0.2 |
| Background tasks (`--background`) | ⏳ Planned for v0.2 |
| `--resume-last` / conversation resume | ⏳ Planned for v0.2 (requires `--chat-recording`) |
| Stop-time review gate | ⏳ Not planned |

## Installing locally

```bash
# From anywhere Claude Code can see the marketplace:
claude plugin marketplace add /path/to/qwen-plugin-cc
claude plugin install qwen@qwen-plugin-cc
```

Then:

```
/qwen:setup
/qwen:rescue investigate why the auth middleware drops cookies on logout
```

## Prerequisites

- Node.js ≥ 18.18
- Qwen Code CLI installed (`npm install -g @qwen-code/qwen-code`)
- A configured auth method in `~/.qwen/settings.json`. Common options:
  - `qwen-oauth` — run `qwen auth qwen-oauth`
  - `openai`-compatible with DashScope — set `DASHSCOPE_API_KEY` and point
    `modelProviders.openai[0].baseUrl` at DashScope in `~/.qwen/settings.json`

`/qwen:setup` checks all of this and tells you exactly which step failed.

## Commands

### `/qwen:setup`

Health check for the runtime. Reports node, npm, qwen binary version, auth
state, default model, and session runtime label. If qwen is missing and npm
is available, offers to install it.

### `/qwen:rescue [--write|--read-only] [--model <name|alias>] <task>`

Forwards to the `qwen:qwen-rescue` subagent, which does exactly one
`qwen-companion.mjs task` invocation and returns stdout verbatim. Defaults to
`--write` (writable workspace) unless you ask for read-only.

Model aliases resolved by the companion: `plus` → `qwen3.5-plus`, `max` →
`qwen3-max`, `turbo` → `qwen3-turbo`, `coder` → `qwen3-coder-plus`. Any other
string passes through unchanged.

### `/qwen:status [job-id] [--wait] [--all]`

Without a job id: compact Markdown table of recent and active jobs scoped to
the current Claude session. With a job id: full details including progress
preview and log file path. `--wait` blocks until the job finishes (default
4-minute timeout).

### `/qwen:result [job-id]`

Prints the stored final output for a finished job. Includes a
`qwen --resume <session_id>` footer you can paste into the qwen CLI to pick
up the conversation directly.

### `/qwen:cancel [job-id]`

Terminates an active job. Sends `SIGTERM` to the worker PID, marks the job as
`cancelled` in state, and appends the cancellation to the job log.

## State layout

The companion writes state under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/`
(falls back to `$TMPDIR/qwen-companion/<slug>-<hash>/` outside Claude Code):

```
state.json         # config + jobs index
jobs/
  task-<id>.json   # full per-job record (request, payload, rendered output)
  task-<id>.log    # timestamped progress log
```

Jobs are session-scoped (`QWEN_COMPANION_SESSION_ID` is exported by the
SessionStart hook). Queued/running jobs owned by a session are torn down on
SessionEnd. The state file is capped at 50 jobs; older jobs are pruned
automatically.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CLAUDE_PLUGIN_DATA` | Parent directory for plugin state. Set by Claude Code. |
| `QWEN_COMPANION_SESSION_ID` | Exported by the SessionStart hook so jobs scope to the current Claude session. |
| `QWEN_BIN` | Override the qwen binary used by the companion (handy for tests). |

## Running tests

```bash
npm test
```

Tests cover:

- `args.mjs` flag parser (boolean, value, aliases, `--`, inline `--key=value`)
- `state.mjs` persistence, upsert, config, job file round-trip
- `render.mjs` setup/status/task/result/cancel renderers
- `runtime.test.mjs` end-to-end via `fake-qwen-fixture.mjs` — exercises
  hello-world, thinking-delta, tool-use, and error scenarios through the
  real `runQwenTurn` code path with a synthetic qwen binary

## Attribution

This plugin is derived from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), licensed
Apache-2.0. See `NOTICE` for details.
