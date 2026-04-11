import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredOutput } from "../plugins/qwen/scripts/lib/qwen.mjs";

test("parseStructuredOutput: returns empty on empty input", () => {
  const result = parseStructuredOutput("");
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /empty response/);
});

test("parseStructuredOutput: passes through bare JSON", () => {
  const raw = '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
  const result = parseStructuredOutput(raw);
  assert.deepEqual(result.parsed, {
    verdict: "approve",
    summary: "ok",
    findings: [],
    next_steps: []
  });
  assert.equal(result.parseError, null);
});

test("parseStructuredOutput: strips markdown code fences", () => {
  const raw = [
    "Here is the review:",
    "",
    "```json",
    '{"verdict":"needs-attention","summary":"danger","findings":[],"next_steps":[]}',
    "```",
    "",
    "Done."
  ].join("\n");
  const result = parseStructuredOutput(raw);
  assert.equal(result.parsed?.verdict, "needs-attention");
  assert.equal(result.parseError, null);
});

test("parseStructuredOutput: extracts JSON from prose surrounding braces", () => {
  const raw = 'preamble {"verdict":"approve","summary":"x","findings":[],"next_steps":[]} trailing text';
  const result = parseStructuredOutput(raw);
  assert.equal(result.parsed?.verdict, "approve");
});

test("parseStructuredOutput: returns parseError when there's no JSON at all", () => {
  const raw = "I refuse to produce JSON. Here is prose instead.";
  const result = parseStructuredOutput(raw);
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /Could not parse/);
});

test("parseStructuredOutput: surfaces failureMessage when empty and meta provided", () => {
  const result = parseStructuredOutput("", { failureMessage: "qwen exited 137" });
  assert.match(result.parseError, /qwen exited 137/);
});

test("parseStructuredOutput: threads reasoningSummary through", () => {
  const result = parseStructuredOutput('{"verdict":"approve","summary":"x","findings":[],"next_steps":[]}', {
    reasoningSummary: ["thought one", "thought two"]
  });
  assert.deepEqual(result.reasoningSummary, ["thought one", "thought two"]);
});
