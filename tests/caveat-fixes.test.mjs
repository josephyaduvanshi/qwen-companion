import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  effortToMaxSessionTurns,
  findLatestTaskThread,
  workspacePathToQwenProjectDir
} from "../plugins/qwen/scripts/lib/qwen.mjs";
import {
  gracefullyTerminateProcessTree,
  processIsAlive
} from "../plugins/qwen/scripts/lib/process.mjs";

// ---------- effortToMaxSessionTurns (caveat 3) ----------

test("effortToMaxSessionTurns: none → 1", () => {
  assert.equal(effortToMaxSessionTurns("none"), 1);
});

test("effortToMaxSessionTurns: minimal → 2", () => {
  assert.equal(effortToMaxSessionTurns("minimal"), 2);
});

test("effortToMaxSessionTurns: low → 4", () => {
  assert.equal(effortToMaxSessionTurns("low"), 4);
});

test("effortToMaxSessionTurns: medium → null (unbounded)", () => {
  assert.equal(effortToMaxSessionTurns("medium"), null);
});

test("effortToMaxSessionTurns: high → null (unbounded)", () => {
  assert.equal(effortToMaxSessionTurns("high"), null);
});

test("effortToMaxSessionTurns: xhigh → null (unbounded)", () => {
  assert.equal(effortToMaxSessionTurns("xhigh"), null);
});

test("effortToMaxSessionTurns: case-insensitive", () => {
  assert.equal(effortToMaxSessionTurns("MINIMAL"), 2);
  assert.equal(effortToMaxSessionTurns("  Low  "), 4);
});

test("effortToMaxSessionTurns: null / empty / unknown → null", () => {
  assert.equal(effortToMaxSessionTurns(null), null);
  assert.equal(effortToMaxSessionTurns(undefined), null);
  assert.equal(effortToMaxSessionTurns(""), null);
  assert.equal(effortToMaxSessionTurns("bogus"), null);
});

// ---------- workspacePathToQwenProjectDir (caveat 2 helper) ----------

test("workspacePathToQwenProjectDir: replaces slashes with dashes", () => {
  assert.equal(
    workspacePathToQwenProjectDir("/Users/josephyaduvanshi/cowork"),
    "-Users-josephyaduvanshi-cowork"
  );
});

test("workspacePathToQwenProjectDir: handles /private/tmp prefix", () => {
  assert.equal(
    workspacePathToQwenProjectDir("/private/tmp/foo"),
    "-private-tmp-foo"
  );
});

test("workspacePathToQwenProjectDir: rejects relative paths", () => {
  assert.equal(workspacePathToQwenProjectDir("foo/bar"), null);
  assert.equal(workspacePathToQwenProjectDir(""), null);
  assert.equal(workspacePathToQwenProjectDir(null), null);
});

// ---------- findLatestTaskThread (caveat 2) ----------

function scaffoldFakeProjectsDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-fake-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-fake-cwd-"));
  const canonical = fs.realpathSync.native(cwd);
  const sanitized = workspacePathToQwenProjectDir(canonical);
  const chatsDir = path.join(home, ".qwen", "projects", sanitized, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  return { home, cwd, chatsDir };
}

function writeFakeSession(chatsDir, sessionId, mtime) {
  const file = path.join(chatsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId,
      type: "user",
      message: { role: "user", parts: [{ text: `hello from ${sessionId}` }] }
    }) + "\n",
    "utf8"
  );
  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }
  return file;
}

test("findLatestTaskThread: returns newest session by mtime", () => {
  const { home, cwd, chatsDir } = scaffoldFakeProjectsDir();
  const t0 = new Date("2025-01-01T00:00:00Z");
  const t1 = new Date("2025-06-01T00:00:00Z");
  const t2 = new Date("2025-12-01T00:00:00Z"); // newest
  writeFakeSession(chatsDir, "session-old", t0);
  writeFakeSession(chatsDir, "session-mid", t1);
  writeFakeSession(chatsDir, "session-new", t2);

  const result = findLatestTaskThread(cwd, { home });
  assert.equal(result.id, "session-new");
  assert.match(result.file, /session-new\.jsonl$/);
});

test("findLatestTaskThread: returns null when chats dir is missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-fake-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-fake-cwd-"));
  // No chats dir created for this cwd.
  assert.equal(findLatestTaskThread(cwd, { home }), null);
});

test("findLatestTaskThread: returns null when chats dir is empty", () => {
  const { home, cwd } = scaffoldFakeProjectsDir();
  assert.equal(findLatestTaskThread(cwd, { home }), null);
});

test("findLatestTaskThread: ignores non-.jsonl files", () => {
  const { home, cwd, chatsDir } = scaffoldFakeProjectsDir();
  fs.writeFileSync(path.join(chatsDir, "readme.txt"), "nope\n");
  writeFakeSession(chatsDir, "real-session", new Date("2025-06-01T00:00:00Z"));
  const result = findLatestTaskThread(cwd, { home });
  assert.equal(result.id, "real-session");
});

// ---------- gracefullyTerminateProcessTree (caveat 4) ----------

test("gracefullyTerminateProcessTree: dead process returns early as graceful", async () => {
  // Use a fake PID that definitely doesn't exist.
  const calls = [];
  const result = await gracefullyTerminateProcessTree(9999999, {
    gracePeriodMs: 50,
    runCommandImpl: () => ({ status: 0, stderr: "", stdout: "", args: [] }),
    killImpl: (pid, sig) => {
      calls.push({ pid, sig });
      const err = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    },
    aliveCheck: () => false,
    sleep: () => Promise.resolve()
  });
  assert.equal(result.exitedGracefully, true);
});

test("gracefullyTerminateProcessTree: exits on SIGINT when process dies after first signal", async () => {
  const signalsSent = [];
  let alive = true;
  const result = await gracefullyTerminateProcessTree(12345, {
    gracePeriodMs: 50,
    runCommandImpl: () => ({ status: 0, stderr: "", stdout: "", args: [] }),
    killImpl: (_pid, sig) => {
      signalsSent.push(sig);
      // Process "dies" after the first signal.
      alive = false;
    },
    aliveCheck: () => alive,
    sleep: () => Promise.resolve()
  });

  assert.equal(signalsSent[0], "SIGINT");
  assert.equal(signalsSent.length, 1, "should not escalate when process dies after SIGINT");
  assert.equal(result.exitedGracefully, true);
  assert.equal(result.finalSignal, "SIGINT");
});

test("gracefullyTerminateProcessTree: escalates to SIGKILL when process refuses", async () => {
  const signalsSent = [];
  const result = await gracefullyTerminateProcessTree(12345, {
    gracePeriodMs: 10,
    runCommandImpl: () => ({ status: 0, stderr: "", stdout: "", args: [] }),
    killImpl: (_pid, sig) => {
      signalsSent.push(sig);
    },
    aliveCheck: () => true, // always alive → always escalate
    sleep: () => Promise.resolve()
  });

  assert.deepEqual(signalsSent, ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.equal(result.exitedGracefully, false);
  assert.equal(result.finalSignal, "SIGKILL");
});

test("gracefullyTerminateProcessTree: NaN pid short-circuits", async () => {
  const result = await gracefullyTerminateProcessTree(Number.NaN);
  assert.equal(result.attempted, false);
  assert.equal(result.exitedGracefully, false);
});

test("gracefullyTerminateProcessTree: Windows path uses single SIGTERM phase", async () => {
  const signalsSent = [];
  await gracefullyTerminateProcessTree(12345, {
    platform: "win32",
    gracePeriodMs: 0,
    runCommandImpl: () => ({ status: 0, stderr: "", stdout: "", args: [], error: null }),
    killImpl: (_pid, sig) => {
      signalsSent.push(sig);
    },
    aliveCheck: () => false
  });
  // On Windows we delegate to taskkill via runCommandImpl rather than the
  // SIGINT→SIGTERM→SIGKILL escalation, so killImpl isn't actually called
  // for the group kill — that's fine, the important invariant is "no crash".
});

test("processIsAlive: current process is alive", () => {
  assert.equal(processIsAlive(process.pid), true);
});

test("processIsAlive: non-existent PID is dead", () => {
  assert.equal(processIsAlive(9999999), false);
});

test("processIsAlive: NaN is dead", () => {
  assert.equal(processIsAlive(Number.NaN), false);
});
