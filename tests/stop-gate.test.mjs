import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStopReviewPrompt,
  parseStopReviewOutput
} from "../plugins/qwen/scripts/stop-review-gate-hook.mjs";

test("parseStopReviewOutput: ALLOW unblocks", () => {
  const result = parseStopReviewOutput("ALLOW: no edits in the previous turn");
  assert.equal(result.ok, true);
});

test("parseStopReviewOutput: BLOCK returns reason", () => {
  const result = parseStopReviewOutput("BLOCK: missing null check on line 42\n\nMore detail below.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing null check on line 42/);
});

test("parseStopReviewOutput: empty output blocks with a hint", () => {
  const result = parseStopReviewOutput("");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no final output/);
});

test("parseStopReviewOutput: unexpected shape blocks with a hint", () => {
  const result = parseStopReviewOutput("Let me think about this...\nMaybe approve? Maybe not.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected answer/);
});

test("parseStopReviewOutput: BLOCK without reason falls back to full text", () => {
  const result = parseStopReviewOutput("BLOCK:");
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test("buildStopReviewPrompt: interpolates previous Claude message", () => {
  const prompt = buildStopReviewPrompt({
    last_assistant_message: "Here is my edit:\n\n```js\nconst x = 1;\n```"
  });
  assert.match(prompt, /Previous Claude response:/);
  assert.match(prompt, /const x = 1/);
  // sanity: the template wrapper is present
  assert.match(prompt, /<compact_output_contract>/);
});

test("buildStopReviewPrompt: empty message produces blank block", () => {
  const prompt = buildStopReviewPrompt({});
  assert.doesNotMatch(prompt, /Previous Claude response:/);
  assert.match(prompt, /<compact_output_contract>/);
});
