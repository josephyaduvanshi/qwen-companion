# qwen-plugin-cc

A Claude Code marketplace plugin that delegates rescue work, investigations,
and code reviews to the [Qwen Code](https://github.com/QwenLM/qwen-code) CLI.

Architecture is adapted from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — same
state model, same job tracking, same command / skill / agent layout. The CLI
integration layer is rewritten to speak Qwen Code's `--output-format
stream-json` protocol instead of the Codex `app-server` JSON-RPC broker.

## Why another qwen plugin?

There is at least one other community qwen plugin that builds on Qwen's
`--acp` (Agent Client Protocol) mode. This one deliberately uses
`stream-json` instead. Three reasons:

1. **Resilience** — one process per task, no long-lived handshake state
   machine to drift out of sync across qwen releases.
2. **Debuggability** — plain newline-delimited JSON on stdout is easy to
   tail, grep, and replay. Every event in the protocol is a line of JSON.
3. **Familiarity** — qwen's stream-json format mirrors the one Claude Code
   uses internally (system/init → stream_event/content_block_delta →
   result). Porting from `codex-plugin-cc` was mostly a matter of swapping
   the event-handler state machine.

## Feature parity

| Feature | codex-plugin-cc | qwen-plugin-cc v1.0 |
|---|---|---|
| `/codex:setup` → `/qwen:setup` | ✅ | ✅ — detects qwen binary, auth, default model, review-gate state |
| `/codex:rescue` → `/qwen:rescue` | ✅ | ✅ — full parity including `--model`/`--effort`/`--resume`/`--fresh` |
| `/codex:review` → `/qwen:review` | ✅ via JSON-RPC `review/start` | ✅ via qwen's native `/review` slash command |
| `/codex:adversarial-review` → `/qwen:adversarial-review` | ✅ with output schema | ✅ with the same schema enforced via `--append-system-prompt` |
| `/codex:status` / `result` / `cancel` | ✅ | ✅ |
| `--effort none..xhigh` | ✅ GPT-5.4 reasoning control | ✅ mapped to `--append-system-prompt` directives |
| `--model <name\|alias>` | ✅ | ✅ with aliases `plus`, `max`, `turbo`, `coder`, `glm`, `kimi` |
| `--background` task worker | ✅ | ✅ — detached subprocess, same job lifecycle |
| `--resume-last` / `--fresh` | ✅ | ✅ via `qwen --chat-recording --resume <session>` |
| Stop-time review gate | ✅ | ✅ — `Stop` hook that BLOCK/ALLOW based on qwen review |
| Session lifecycle hook | ✅ | ✅ — tears down session-scoped jobs on SessionEnd |
| Shared app-server broker | ✅ | ❌ not needed — qwen has no persistent server |
| `turn/interrupt` RPC | ✅ | ❌ cancel is PID-tree kill (`detached: true` + `kill(-pid)`) |
| `touchedFiles` from structured protocol | ✅ | ✅ from qwen `tool_use` events (`write_file`, `edit`, `replace`, `create_file`) |
| Version-bumping tool | ✅ | ✅ `scripts/bump-version.mjs` |
| CI workflow | ✅ | ✅ `.github/workflows/pull-request-ci.yml.template` (rename to `.yml` after cloning) |

## Prerequisites

- Node.js ≥ 18.18
- Qwen Code CLI ≥ 0.14: `npm install -g @qwen-code/qwen-code`
- A configured auth method in `~/.qwen/settings.json`. Common options:
  - `qwen-oauth` — run `qwen auth qwen-oauth`
  - `openai`-compatible with DashScope — set `DASHSCOPE_API_KEY` and point
    `modelProviders.openai[0].baseUrl` at DashScope in `~/.qwen/settings.json`
  - `anthropic`, `gemini`, `vertex-ai` — set the corresponding API key env var

`/qwen:setup` checks all of this and tells you which step failed.

## Installing into Claude Code

```bash
# Clone the repository somewhere Claude Code can see it:
git clone https://github.com/<owner>/qwen-plugin-cc.git
cd qwen-plugin-cc

# Add it as a local marketplace:
claude plugin marketplace add /absolute/path/to/qwen-plugin-cc

# Install the plugin:
claude plugin install qwen@qwen-plugin-cc
```

Then inside Claude Code:

```
/qwen:setup
/qwen:rescue investigate why the auth middleware drops cookies on logout
/qwen:review                     # native reviewer over working-tree diff
/qwen:adversarial-review         # structured review with JSON-schema'd findings
```

## Commands

### `/qwen:setup [--enable-review-gate|--disable-review-gate]`

Health check for the runtime. Reports node, npm, qwen binary version, auth
state, default model, session runtime label, and whether the stop-time
review gate is enabled for this repo. If qwen is missing and npm is
available, offers to install it.

### `/qwen:rescue [--background|--wait] [--model <alias>] [--effort <level>] [--resume|--fresh] <task>`

Forwards to the `qwen:qwen-rescue` subagent. The subagent invokes the
companion exactly once and returns qwen's output verbatim — no
summarization, no follow-up work.

Flags:

- `--background` — run detached, return a job id immediately
- `--wait` — run foreground (default)
- `--model <alias>` — `plus`/`max`/`turbo`/`coder`/`glm`/`kimi` or a full
  model string
- `--effort <level>` — `none`/`minimal`/`low`/`medium`/`high`/`xhigh`.
  `medium` is the default (no system-prompt injection). Other levels add
  a short reasoning directive to `--append-system-prompt`.
- `--resume` / `--fresh` — resume the most recent qwen session vs start
  fresh. When neither is given, the command asks via `AskUserQuestion` if
  there is a resumable session from this Claude session.

### `/qwen:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]`

Runs qwen's built-in `/review` slash command. It detects git scope
automatically, runs `git status`/`diff`/`log`, reads changed files, and
returns a Markdown review. Does not accept custom focus text — use
`/qwen:adversarial-review` for focused review.

### `/qwen:adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]`

Builds a strict adversarial review prompt, passes repository context, and
enforces a JSON-schema'd response via `--append-system-prompt`. The
companion parses the structured response and renders findings sorted by
severity (critical → high → medium → low), including file:line ranges,
recommendations, and next steps.

Extra positional text is forwarded as focus instructions:

```
/qwen:adversarial-review look for race conditions around cache invalidation
```

### `/qwen:status [job-id] [--wait] [--timeout-ms <ms>] [--all]`

Without a job id, prints a compact Markdown table of recent and active
jobs scoped to the current Claude session. With a job id, shows full
details including progress preview, log file path, elapsed time, and
cancel/result hints. `--wait` blocks until the job finishes (default
4-minute timeout).

### `/qwen:result [job-id]`

Prints the stored final output for a finished job. Includes a
`qwen --chat-recording --resume <session_id>` footer you can paste into
the qwen CLI to pick up the conversation directly.

### `/qwen:cancel [job-id]`

Terminates an active job. Sends `SIGTERM` to the tracked PID's process
group (the worker was spawned with `detached: true` on POSIX so
`kill(-pid)` reaches the full subtree). Marks the job as `cancelled` in
state and appends the cancellation to the job log.

## State layout

The companion writes state under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/`
(falls back to `$TMPDIR/qwen-companion/<slug>-<hash>/` outside Claude Code):

```
state.json         # config + jobs index
jobs/
  task-<id>.json   # full per-job record (request, payload, rendered output)
  task-<id>.log    # timestamped progress log
```

Jobs are session-scoped. `QWEN_COMPANION_SESSION_ID` is exported by the
SessionStart hook; queued/running jobs owned by a session are torn down on
SessionEnd. The state file is capped at 50 jobs; older jobs are pruned
automatically.

## Skills bundled with the plugin

All three are internal (`user-invocable: false`) — they guide Claude when
invoking qwen on your behalf.

- **`qwen-cli-runtime`** — the one-Bash-call contract used by the
  `qwen-rescue` subagent.
- **`qwen-result-handling`** — how to present qwen output (preserve verdict,
  findings, file:line; never auto-fix review findings without explicit
  approval).
- **`qwen-prompting`** — how to compose effective qwen prompts with XML
  tag blocks (`<task>`, `<structured_output_contract>`,
  `<verification_loop>`, `<grounding_rules>`, `<action_safety>`).

## Stop-time review gate

Optional per-repo. Enable with `/qwen:setup --enable-review-gate`. When
you try to end a Claude Code session, the `Stop` hook will:

1. Run a short qwen task with the stop-review prompt
2. Require qwen's first line to be either `ALLOW: <reason>` or
   `BLOCK: <reason>`
3. Block session end if qwen found an issue with the previous turn's
   edits

Disable with `/qwen:setup --disable-review-gate`.

## Environment variables

| Variable | Purpose |
|---|---|
| `CLAUDE_PLUGIN_DATA` | Parent directory for plugin state. Set by Claude Code. |
| `QWEN_COMPANION_SESSION_ID` | Exported by the SessionStart hook so jobs scope to the current session. |
| `QWEN_BIN` | Override the qwen binary used by the companion (handy for tests). |

## Development

```bash
git clone https://github.com/<owner>/qwen-plugin-cc.git
cd qwen-plugin-cc
node --test tests/*.test.mjs
```

**Testing.** 80+ automated tests covering:

- `args.mjs` — flag parser (boolean, value, aliases, inline `--key=value`,
  `--` separator, quoted prompts)
- `state.mjs` — persistence, upsert, config, job file round-trip
- `render.mjs` — setup / status / task / result / cancel renderers
- `runtime.test.mjs` — end-to-end via `fake-qwen-fixture.mjs` (hello-world,
  thinking-delta, tool-use, error scenarios)
- `effort.test.mjs` — reasoning effort normalization and system-prompt mapping
- `parse-structured.test.mjs` — JSON extraction from Markdown code fences and prose
- `stop-gate.test.mjs` — ALLOW / BLOCK first-line parsing
- `commands.test.mjs` — MODEL_ALIASES, buildTaskRunMetadata,
  buildAdversarialReviewPrompt, findLatestResumableTaskJob
- `process.test.mjs` — runCommand, binaryAvailable, terminateProcessTree
- `git.test.mjs` — resolveReviewTarget, collectReviewContext against real
  temp git repos
- `bump-version.test.mjs` — version synchronization across manifests

**Version bumping.**

```bash
node scripts/bump-version.mjs 1.0.1          # bump to a new version
node scripts/bump-version.mjs --check        # verify all manifests agree
```

**CI.** A ready-to-use workflow is shipped as
`.github/workflows/pull-request-ci.yml.template`. Rename it to `.yml`
after cloning to enable CI:

```bash
mv .github/workflows/pull-request-ci.yml.template \
   .github/workflows/pull-request-ci.yml
```

It runs the test suite on Node 18/20/22 × ubuntu/macos, syntax-checks
every `.mjs` file, validates JSON manifests, and verifies
`bump-version.mjs --check` passes.

## Troubleshooting

**`qwen: not found` during setup.** Install the CLI:
`npm install -g @qwen-code/qwen-code`. Then rerun `/qwen:setup`.

**`openai selected but DASHSCOPE_API_KEY / OPENAI_API_KEY are not set`.**
Edit `~/.qwen/settings.json`:

```json
{
  "security": { "auth": { "selectedType": "openai" } },
  "model": { "name": "qwen3.5-plus" },
  "env": { "DASHSCOPE_API_KEY": "sk-..." }
}
```

Or run `qwen auth qwen-oauth` to switch to OAuth.

**`/qwen:review` hangs.** Native `/review` spawns tool calls (shell + file
read). Give it up to 60s on large diffs, or run in the background:
`/qwen:review --background` and poll `/qwen:status`.

**`--resume-last` says "No previous Qwen task thread".** The companion only
resumes threads from its own tracked-jobs list. If you ran `qwen` outside
Claude Code, that history is not visible to the plugin. Either run
`/qwen:rescue` once inside Claude Code to establish a thread, or invoke
qwen directly with `qwen --chat-recording --resume <session_id>`.

**Orphaned qwen processes after `/qwen:cancel`.** The companion spawns qwen
with `detached: true`, so `kill(-pid)` reaches the full subtree. If you
still see orphans, check `pgrep -af qwen` — they're usually unrelated.

## Attribution

This plugin is derived from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc),
Copyright 2025 OpenAI, Apache-2.0 licensed. See `NOTICE` and `LICENSE`
for the full terms. Large portions of the state model, job tracking,
rendering, command layout, skill design, and test harness are direct
ports of that project's work.

The CLI adapter (`plugins/qwen/scripts/lib/qwen.mjs`) was rewritten from
scratch to speak Qwen Code's stream-json protocol.

## License

Apache-2.0. See `LICENSE`.
