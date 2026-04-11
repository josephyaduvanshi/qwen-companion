import test from "node:test";
import assert from "node:assert/strict";

import {
  binaryAvailable,
  formatCommandFailure,
  runCommand,
  runCommandChecked,
  terminateProcessTree
} from "../plugins/qwen/scripts/lib/process.mjs";

test("runCommand: captures stdout on success", () => {
  const result = runCommand("node", ["-e", "console.log('hi')"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /hi/);
});

test("runCommand: captures stderr on failure", () => {
  const result = runCommand("node", ["-e", "process.stderr.write('oops'); process.exit(2)"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /oops/);
});

test("runCommandChecked: throws on non-zero exit", () => {
  assert.throws(
    () => runCommandChecked("node", ["-e", "process.exit(7)"]),
    /exit=7/
  );
});

test("runCommandChecked: returns result on success", () => {
  const result = runCommandChecked("node", ["-e", "console.log('ok')"]);
  assert.equal(result.status, 0);
});

test("binaryAvailable: node is available", () => {
  const result = binaryAvailable("node", ["--version"]);
  assert.equal(result.available, true);
  assert.match(result.detail, /v\d+\.\d+/);
});

test("binaryAvailable: bogus binary reports not found", () => {
  const result = binaryAvailable("this-binary-does-not-exist-xyz-12345");
  assert.equal(result.available, false);
  assert.match(result.detail, /not found/);
});

test("formatCommandFailure: formats exit code failure", () => {
  const text = formatCommandFailure({
    command: "foo",
    args: ["--bar"],
    status: 1,
    signal: null,
    stderr: "bad things",
    stdout: ""
  });
  assert.match(text, /foo --bar/);
  assert.match(text, /exit=1/);
  assert.match(text, /bad things/);
});

test("formatCommandFailure: signal takes precedence over status", () => {
  const text = formatCommandFailure({
    command: "foo",
    args: [],
    status: null,
    signal: "SIGKILL",
    stderr: "",
    stdout: ""
  });
  assert.match(text, /signal=SIGKILL/);
});

test("terminateProcessTree: returns not-attempted for NaN pid", () => {
  const result = terminateProcessTree(Number.NaN);
  assert.equal(result.attempted, false);
  assert.equal(result.delivered, false);
});

test("terminateProcessTree: ESRCH on non-existent pid is handled gracefully", () => {
  // Use an obviously unused PID (very large number).
  const result = terminateProcessTree(9999999);
  assert.equal(result.attempted, true);
  // Delivered may be false (no such process) but should not throw.
  assert.equal(typeof result.delivered, "boolean");
});
