---
description: Check whether the local Qwen Code CLI is ready to drive from Claude Code
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json
```

If the result reports `qwen: not found` and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Qwen Code now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Qwen Code (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @qwen-code/qwen-code
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qwen-companion.mjs" setup --json
```

If Qwen Code is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user verbatim.
- If Qwen is installed but not authenticated, preserve the guidance to run `!qwen auth qwen-oauth` or to configure an API key in `~/.qwen/settings.json`.
- If installation was skipped, present the original setup output.
