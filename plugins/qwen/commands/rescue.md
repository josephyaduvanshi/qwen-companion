---
description: Delegate investigation, an explicit fix request, or research task to the Qwen rescue subagent
argument-hint: "[--write] [--model <model|plus|max|turbo|coder>] [what Qwen should investigate, solve, or explain]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `qwen:qwen-rescue` subagent.
The final user-visible response must be Qwen's output verbatim.

Raw user request:
$ARGUMENTS

Operating rules:

- The subagent is a thin forwarder. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Qwen companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/qwen:status`, fetch `/qwen:result`, call `/qwen:cancel`, summarize output, or do follow-up work of its own.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- Leave `--model` unset unless the user explicitly asks for a specific model.
- If the user asks for `plus`/`max`/`turbo`/`coder`, map them to qwen aliases: `qwen3.5-plus`, `qwen3-max`, `qwen3-turbo`, `qwen3-coder-plus`. Any other string passes through unchanged.
- Default to a write-capable Qwen run by adding `--write` unless the user explicitly asks for read-only behavior or only wants diagnosis, review, or research without edits.
- If the user did not supply a request, ask what Qwen should investigate or fix.
- If the companion reports that Qwen is missing or unauthenticated, stop and tell the user to run `/qwen:setup`.
