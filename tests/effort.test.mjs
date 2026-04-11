import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONTINUE_PROMPT,
  effortToSystemPrompt,
  VALID_REASONING_EFFORTS
} from "../plugins/qwen/scripts/lib/qwen.mjs";
import { normalizeReasoningEffort } from "../plugins/qwen/scripts/qwen-companion.mjs";

test("VALID_REASONING_EFFORTS covers the codex-compatible set", () => {
  for (const level of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.ok(VALID_REASONING_EFFORTS.has(level), `missing ${level}`);
  }
});

test("effortToSystemPrompt: medium returns null (no injection)", () => {
  assert.equal(effortToSystemPrompt("medium"), null);
  assert.equal(effortToSystemPrompt(null), null);
  assert.equal(effortToSystemPrompt(undefined), null);
});

test("effortToSystemPrompt: non-medium levels produce distinct strings", () => {
  const none = effortToSystemPrompt("none");
  const minimal = effortToSystemPrompt("minimal");
  const high = effortToSystemPrompt("high");
  const xhigh = effortToSystemPrompt("xhigh");
  assert.ok(none && none.length > 0);
  assert.ok(minimal && minimal.length > 0);
  assert.ok(high && high.length > 0);
  assert.ok(xhigh && xhigh.length > 0);
  assert.notEqual(none, minimal);
  assert.notEqual(high, xhigh);
});

test("effortToSystemPrompt: case-insensitive", () => {
  assert.equal(effortToSystemPrompt("HIGH"), effortToSystemPrompt("high"));
});

test("effortToSystemPrompt: unknown levels produce null", () => {
  assert.equal(effortToSystemPrompt("turbo"), null);
  assert.equal(effortToSystemPrompt("extreme"), null);
});

test("normalizeReasoningEffort: passes through valid values", () => {
  assert.equal(normalizeReasoningEffort("high"), "high");
  assert.equal(normalizeReasoningEffort("Xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("  minimal  "), "minimal");
});

test("normalizeReasoningEffort: rejects unknown", () => {
  assert.throws(
    () => normalizeReasoningEffort("extreme"),
    /Unsupported reasoning effort/
  );
});

test("normalizeReasoningEffort: null → null", () => {
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort(undefined), null);
  assert.equal(normalizeReasoningEffort(""), null);
});

test("DEFAULT_CONTINUE_PROMPT is a non-empty string", () => {
  assert.equal(typeof DEFAULT_CONTINUE_PROMPT, "string");
  assert.ok(DEFAULT_CONTINUE_PROMPT.length > 10);
});
