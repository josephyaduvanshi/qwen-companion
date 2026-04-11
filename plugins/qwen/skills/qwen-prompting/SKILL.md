---
name: qwen-prompting
description: Internal guidance for composing Qwen Code / Qwen 3.x prompts for coding, review, diagnosis, and research tasks inside the Qwen Claude Code plugin
user-invocable: false
---

# Qwen Prompting

Use this skill when `qwen:qwen-rescue` needs to ask Qwen Code for help.

Prompt Qwen like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per Qwen run. Split unrelated asks into separate runs.
- Tell Qwen what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.
- Qwen Code's default models (`qwen3.5-plus`, `qwen3-max`, `qwen3-coder-plus`) are strong at code edits and tool use but prefer explicit contracts. Spell out file boundaries, acceptance criteria, and stop conditions.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Qwen should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Qwen stays narrow and avoids unrelated refactors.

How to choose prompt shape:
- There is no dedicated `review`/`adversarial-review` command in v0.1 of this plugin. For review-style work, send a `task` prompt with a `<task>Review ...</task>` block plus a strict `<structured_output_contract>`.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt directly.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names.
- Do not raise reasoning or complexity first. Tighten the prompt and verification rules before escalating.
- Ask Qwen for brief, outcome-based progress updates only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Qwen should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

## Reusable blocks

```xml
<task>
  {{concrete job, including file paths, failure messages, or repo state}}
</task>

<structured_output_contract>
  Return a Markdown document with this exact outline:
  ## Summary
  - One sentence.
  ## Findings
  - [severity] title — file:line — one-sentence detail.
  ## Fix plan
  - Ordered list of concrete steps.
  Keep each bullet under 160 characters. No prose outside these sections.
</structured_output_contract>

<default_follow_through_policy>
  If a step is blocked, document the blocker and continue with the next step
  rather than asking a clarifying question. Only stop for missing high-risk
  information (data-loss, auth, destructive migration).
</default_follow_through_policy>

<verification_loop>
  After editing, run the project's test command (`npm test` or the command
  listed in package.json) and paste the last 40 lines of output under a
  `## Verification` heading. If tests fail, iterate until they pass or you
  hit the same failure twice — then stop and report.
</verification_loop>

<grounding_rules>
  Every finding must cite a concrete file path and line range. If a claim
  is an inference, prefix it with "Inference:" and cite the evidence.
</grounding_rules>

<action_safety>
  Touch only files directly related to the task. Do not reformat, rename,
  or refactor unrelated code. If you must edit more than 5 files, stop and
  list them in a `## Requested scope expansion` block first.
</action_safety>
```
