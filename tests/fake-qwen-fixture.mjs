// Emits a small, controllable fake "qwen" binary for use in tests.
//
// The fake binary is a Node script that prints a canned stream-json
// transcript to stdout. It ignores stdin content and most flags; it only
// honors the scenario label passed via FAKE_QWEN_SCENARIO env var.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const FAKE_QWEN_SOURCE = String.raw`// Auto-generated fake qwen binary for qwen-companion tests.
// Invoked by the sibling shell shim (./qwen) via \`node qwen.mjs "$@"\`.
import process from "node:process";
import fs from "node:fs";

const scenario = process.env.FAKE_QWEN_SCENARIO || "hello-world";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Handle --version eagerly.
if (process.argv.includes("--version")) {
  process.stdout.write("fake-qwen 0.0.1\n");
  process.exit(0);
}

// Handle "auth status" as a fallback check path.
if (process.argv.includes("auth") && process.argv.includes("status")) {
  if (process.env.FAKE_QWEN_AUTH === "bad") {
    process.stderr.write("not authenticated\n");
    process.exit(1);
  }
  process.stdout.write("authenticated as fake-user\n");
  process.exit(0);
}

const args = process.argv.slice(2);

// Drain stdin so the parent can call stdin.end() cleanly.
let stdinBuffer = "";
process.stdin.on("data", (chunk) => { stdinBuffer += String(chunk); });

function dumpArgsIfRequested() {
  if (!process.env.FAKE_QWEN_DUMP_ARGS) return;
  try {
    fs.writeFileSync(process.env.FAKE_QWEN_DUMP_ARGS, JSON.stringify({
      args,
      stdin: stdinBuffer,
      cwd: process.cwd()
    }));
  } catch { /* best effort */ }
}

async function run() {
  await new Promise((resolve) => process.stdin.on("end", resolve));
  dumpArgsIfRequested();

  const sessionId = "fake-session-00000000";
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "fake-qwen-plus",
    cwd: process.cwd(),
    tools: [],
    qwen_code_version: "0.0.1"
  });

  if (scenario === "error") {
    emit({
      type: "result",
      subtype: "error",
      session_id: sessionId,
      is_error: true,
      result: "Simulated qwen failure."
    });
    process.exit(1);
  }

  if (scenario === "with-thinking") {
    emit({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: "msg-abc" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking about pong." } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "message_stop" } });
    emit({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      is_error: false,
      duration_ms: 42,
      num_turns: 1,
      result: "pong",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      permission_denials: []
    });
    process.exit(0);
  }

  if (scenario === "tool-use") {
    emit({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: "msg-tool" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read_file" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 1 } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "message_stop" } });
    emit({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      is_error: false,
      duration_ms: 80,
      result: "done",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      permission_denials: []
    });
    process.exit(0);
  }

  // Default "hello-world" scenario.
  emit({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: "msg-hi" } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "message_stop" } });
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    duration_ms: 25,
    num_turns: 1,
    result: "hello world",
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    permission_denials: []
  });
  process.exit(0);
}

run().catch((err) => {
  process.stderr.write(String(err?.message ?? err) + "\n");
  process.exit(2);
});
`;

export function installFakeQwen(dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-companion-fake-"))) {
  // Write the ESM script as qwen.mjs so Node doesn't have to guess the
  // module type. The actual "qwen" binary is a thin shell/cmd shim that
  // execs `node qwen.mjs "$@"`. Without this two-file setup, spawning
  // a shebang script without a nearby package.json fails on Node 18/20
  // with "Cannot use import statement outside a module".
  const scriptPath = path.join(dir, "qwen.mjs");
  fs.writeFileSync(scriptPath, FAKE_QWEN_SOURCE, "utf8");

  const binPath = path.join(dir, os.platform() === "win32" ? "qwen.cmd" : "qwen");
  if (os.platform() === "win32") {
    fs.writeFileSync(binPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(
      binPath,
      `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`,
      "utf8"
    );
    fs.chmodSync(binPath, 0o755);
  }
  return { dir, binPath, scriptPath };
}
