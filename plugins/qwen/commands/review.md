---
description: Run a Qwen code review against local git state using the built-in /review reviewer
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Before running, estimate the review size so we can decide between foreground (`--wait`) and background (`--background`).

Quick size check:

```bash
git status --short | head -40
git diff --shortstat
git diff --shortstat --cached
```

If the change is small (≲20 files, ≲500 changed lines), prefer foreground. If it is large or ambiguous, ask the user:

- `Run now and wait (--wait) (Recommended for small changes)`
- `Run in the background (--background)`

Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" review "$ARGUMENTS"
```

Output rules:
- `/qwen:review` invokes Qwen's built-in `/review` slash command. It auto-detects git state and produces a Markdown review.
- Present the Qwen review output verbatim to the user.
- Do not paraphrase, summarize, or add commentary.
- `/qwen:review` does not accept custom focus text. For focused reviews use `/qwen:adversarial-review`.
- After presenting the review, STOP. Do not fix any findings until the user explicitly asks which ones to address.
