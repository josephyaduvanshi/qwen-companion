# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-04-11

Caveat fixes — closes three of the four known limitations from v1.0.0.

### Added

- **Graceful two-phase cancel** (`gracefullyTerminateProcessTree`). `/qwen:cancel`
  now sends `SIGINT` first, waits 2 s for clean exit, then escalates to
  `SIGTERM` (+2 s) and finally `SIGKILL`. Qwen exits cleanly on SIGINT in
  practice, so the common path no longer force-kills mid-turn. The final
  signal and whether exit was graceful are recorded in the job log.
- `processIsAlive(pid)` helper using `kill(pid, 0)` for cross-platform
  liveness checking.
- **Real `--effort` budget via `--max-session-turns`.** The companion now
  passes a hard tool-call budget to qwen in addition to the system-prompt
  directive: `none → 1`, `minimal → 2`, `low → 4`,
  `medium/high/xhigh → unbounded`. Low-effort runs can no longer sneak
  extra tool rounds past the directive.
- **Resume sees out-of-plugin sessions.** `findLatestTaskThread` now scans
  `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl` and returns the newest
  session id by mtime. `/qwen:rescue --resume-last` can now pick up qwen
  sessions you started directly in a terminal, not just ones this plugin
  launched. Tracked-jobs state is still consulted first; the project-dir
  scan is the fallback.
- `workspacePathToQwenProjectDir(abs)` helper for path-to-project-dir
  conversion (exposed for tests and for users who want to script against
  the same storage layout).
- 23 new tests covering every caveat fix — effort → max-turns mapping,
  path canonicalization, project-dir scan against a fake `~/.qwen`, and
  dependency-injected mocks for the two-phase termination helper.

### Changed

- `terminateProcessTree()` now accepts a `signal` option (default
  `SIGTERM` to preserve the previous behavior).
- `/qwen:cancel` logs the signal that actually terminated the process and
  whether exit was graceful.

## [1.0.0] — 2026-04-11

First production release. Feature parity with
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) except
where noted in `README.md#parity-matrix`.

### Added

- `/qwen:review` — invokes Qwen Code's native `/review` slash command.
  Auto-detects git scope, runs `git status/diff/log`, and returns a
  structured Markdown review.
- `/qwen:adversarial-review [focus ...]` — builds an adversarial review
  prompt, enforces the JSON shape via `--append-system-prompt`, parses the
  structured response, and renders findings sorted by severity.
- `--effort <none|minimal|low|medium|high|xhigh>` — maps to Qwen's
  `--append-system-prompt` so the CLI accepts the same flag as
  codex-plugin-cc. `medium` is the default (no injection); other levels
  inject a short reasoning directive.
- `--background` — spawns a detached `task-worker` subprocess. Returns
  immediately with a job id; `/qwen:status <id>` polls, `/qwen:result <id>`
  fetches the captured output, `/qwen:cancel <id>` kills the process tree.
- `--resume-last` / `--resume` / `--fresh` — resumes the most recent
  resumable Qwen session for this repository via `qwen --chat-recording
  --resume <session_id>`.
- `/qwen:setup --enable-review-gate` / `--disable-review-gate` — toggles
  the optional stop-time review gate per repository.
- Stop-time review gate — when enabled, Claude Code's `Stop` hook runs a
  short Qwen task to BLOCK or ALLOW session end based on the previous
  turn's edits.
- Expanded model aliases: `plus` → `qwen3.5-plus`, `max` → `qwen3-max`,
  `turbo` → `qwen3-turbo`, `coder` → `qwen3-coder-plus`, `glm` → `glm-5`,
  `kimi` → `kimi-k2.5`. Any other string passes through.
- `parseStructuredOutput` helper that strips Markdown code fences and
  extracts JSON from free-text responses.
- Touched-files tracking from Qwen `tool_use` events
  (`write_file`/`edit`/`replace`/`create_file`) instead of regex scraping.
- `scripts/bump-version.mjs` for keeping `package.json`, the marketplace
  manifest, and the plugin manifest in lockstep.
- 80+ automated tests covering args, state, renderers, runtime (with a
  fake-qwen-fixture), stop-gate parsing, commands routing, process
  helpers, git helpers, and version bumping.

### Changed

- Runtime adapter (`lib/qwen.mjs`) rewritten to support `--chat-recording`
  for transparent session resume, `--append-system-prompt` for effort +
  output-schema injection, and structured tool-input tracking.
- `/qwen:review` now runs in `workspace-write` (yolo) mode so qwen can
  actually execute `git diff` / `git log`; qwen's native `/review` prompt
  is behaviorally read-only.
- `terminateProcessTree()` reaches the full process group because child
  processes are spawned with `detached: true` on POSIX.

## [0.1.0] — Unreleased

Initial MVP baseline. `setup`, `rescue` (via `qwen-rescue` subagent),
`status`, `result`, `cancel`, session-lifecycle hook, three skills, basic
test suite. Never published; see the git history for details.

[1.0.0]: https://github.com/<owner>/qwen-plugin-cc/releases/tag/v1.0.0
[0.1.0]: https://github.com/<owner>/qwen-plugin-cc/releases/tag/v0.1.0
