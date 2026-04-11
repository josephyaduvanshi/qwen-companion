---
description: Run a Qwen review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Before running, estimate the review size so we can decide between foreground and background.

Quick size check:

```bash
git status --short | head -40
git diff --shortstat
git diff --shortstat --cached
```

If the change is small, prefer foreground. If it is large or ambiguous, ask the user:

- `Run now and wait (--wait) (Recommended for small changes)`
- `Run in the background (--background)`

Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" adversarial-review "$ARGUMENTS"
```

Output rules:
- `/qwen:adversarial-review` builds a strict adversarial review prompt, passes the repository context to Qwen, and enforces a JSON-schema'd response (verdict, summary, findings with severity/file/line ranges, next steps).
- The companion renders the structured response as Markdown sorted by severity.
- Present the command output verbatim to the user.
- Do not paraphrase, summarize, or add commentary.
- After presenting findings, STOP. You MUST explicitly ask the user which findings, if any, to fix before touching code. Auto-applying adversarial fixes is forbidden even if the fix looks obvious.
- Extra positional text is forwarded as focus instructions (e.g. `/qwen:adversarial-review look for race conditions around cache invalidation`).
