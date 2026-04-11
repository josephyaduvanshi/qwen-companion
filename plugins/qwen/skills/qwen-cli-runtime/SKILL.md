---
name: qwen-cli-runtime
description: Internal helper contract for calling the qwen-companion runtime from Claude Code
user-invocable: false
---

# Qwen Runtime

Use this skill only inside the `qwen:qwen-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `qwen` CLI strings, or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `qwen:qwen-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `qwen-prompting` skill to rewrite the user's request into a tighter Qwen prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--model` unset by default. Add `--model` only when the user explicitly asks for one.
- Map `plus` → `qwen3.5-plus`, `max` → `qwen3-max`, `turbo` → `qwen3-turbo`, `coder` → `qwen3-coder-plus`. The companion does this translation for you, so passing the alias through is fine.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--model`, pass it through to `task`.
- Default to a write-capable Qwen run by adding `--write` unless the user explicitly asks for read-only behavior.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Qwen cannot be invoked, return nothing.

Limitations of v0.1:
- Background (`--background`) execution is not supported yet. Always run foreground.
- `--resume`/`--resume-last` is not supported yet. Every rescue starts a fresh Qwen session.
- There is no `review` or `adversarial-review` command in v0.1. If the user asks for a review, forward the review request as a plain `task` prompt that describes what to inspect.
