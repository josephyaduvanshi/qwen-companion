import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runQwenTurn } from "../plugins/qwen/scripts/lib/qwen.mjs";
import { installFakeQwen } from "./fake-qwen-fixture.mjs";

function freshCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-runtime-"));
}

test("runQwenTurn: default hello-world scenario streams text deltas", async () => {
  const { binPath } = installFakeQwen();
  const events = [];
  const cwd = freshCwd();
  const result = await runQwenTurn(cwd, {
    prompt: "say hi",
    env: { ...process.env, QWEN_BIN: binPath },
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.status, 0, `expected success, got stderr=${result.stderr}`);
  assert.equal(result.finalMessage, "hello world");
  assert.equal(result.threadId, "fake-session-00000000");
  assert.equal(result.turnId, "msg-hi");
  assert.ok(result.usage);
  assert.equal(result.usage.total_tokens, 7);
  assert.ok(result.durationMs > 0);

  // Progress events: Starting → Turn started → Turn completed → Qwen turn finished
  const phases = events.map((e) => e.phase).filter(Boolean);
  assert.ok(phases.includes("starting"), `missing starting phase, got ${phases}`);
  assert.ok(phases.includes("finalizing"));
  assert.ok(phases.includes("done"));
});

test("runQwenTurn: thinking deltas become reasoning summary", async () => {
  const { binPath } = installFakeQwen();
  const cwd = freshCwd();
  const result = await runQwenTurn(cwd, {
    prompt: "ping",
    env: { ...process.env, QWEN_BIN: binPath, FAKE_QWEN_SCENARIO: "with-thinking" }
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "pong");
  assert.deepEqual(result.reasoningSummary, ["Thinking about pong."]);
});

test("runQwenTurn: tool_use blocks land in toolCalls", async () => {
  const { binPath } = installFakeQwen();
  const cwd = freshCwd();
  const result = await runQwenTurn(cwd, {
    prompt: "read something",
    env: { ...process.env, QWEN_BIN: binPath, FAKE_QWEN_SCENARIO: "tool-use" }
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "done");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.equal(result.toolCalls[0].id, "tool-1");
});

test("runQwenTurn: error scenario returns status 1 with surfaced message", async () => {
  const { binPath } = installFakeQwen();
  const cwd = freshCwd();
  const result = await runQwenTurn(cwd, {
    prompt: "break",
    env: { ...process.env, QWEN_BIN: binPath, FAKE_QWEN_SCENARIO: "error" }
  });

  assert.equal(result.status, 1);
  assert.ok(result.error);
  assert.match(result.error.message, /Simulated qwen failure/);
});

test("runQwenTurn: empty prompt throws", async () => {
  const { binPath } = installFakeQwen();
  await assert.rejects(
    () =>
      runQwenTurn(freshCwd(), {
        prompt: "",
        env: { ...process.env, QWEN_BIN: binPath }
      }),
    /non-empty prompt/
  );
});
