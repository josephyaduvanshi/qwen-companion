import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  generateJobId,
  getConfig,
  listJobs,
  loadState,
  resolveJobFile,
  resolveStateDir,
  saveState,
  setConfig,
  upsertJob,
  writeJobFile
} from "../plugins/qwen/scripts/lib/state.mjs";

function freshDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-state-"));
}

test("state: load default when file missing", () => {
  const data = freshDataDir();
  process.env.CLAUDE_PLUGIN_DATA = data;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-cwd-"));
  const state = loadState(cwd);
  assert.equal(state.version, 1);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.config, {});
});

test("state: upsert + list round-trip", () => {
  const data = freshDataDir();
  process.env.CLAUDE_PLUGIN_DATA = data;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-cwd-"));

  upsertJob(cwd, { id: "task-a", status: "queued", title: "A" });
  upsertJob(cwd, { id: "task-b", status: "running", title: "B" });
  upsertJob(cwd, { id: "task-a", status: "completed" });

  const jobs = listJobs(cwd);
  const a = jobs.find((j) => j.id === "task-a");
  assert.equal(a.status, "completed");
  assert.equal(a.title, "A"); // Preserved across patches.
  const b = jobs.find((j) => j.id === "task-b");
  assert.equal(b.status, "running");
});

test("state: config set/get", () => {
  const data = freshDataDir();
  process.env.CLAUDE_PLUGIN_DATA = data;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-cwd-"));
  setConfig(cwd, "exampleFlag", true);
  assert.equal(getConfig(cwd).exampleFlag, true);
  setConfig(cwd, "exampleFlag", false);
  assert.equal(getConfig(cwd).exampleFlag, false);
});

test("state: job file round-trip", () => {
  const data = freshDataDir();
  process.env.CLAUDE_PLUGIN_DATA = data;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-cwd-"));
  upsertJob(cwd, { id: "task-x", status: "queued" });
  writeJobFile(cwd, "task-x", { id: "task-x", result: { rawOutput: "hello" } });
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, "task-x"), "utf8"));
  assert.equal(stored.result.rawOutput, "hello");
});

test("state: generateJobId honors prefix", () => {
  const id = generateJobId("task");
  assert.match(id, /^task-[a-z0-9]+-[a-z0-9]+$/);
});

test("state: resolveStateDir is scoped to the data env var", () => {
  const data = freshDataDir();
  process.env.CLAUDE_PLUGIN_DATA = data;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-scoped-"));
  const dir = resolveStateDir(cwd);
  assert.ok(dir.startsWith(path.join(data, "state")));
});
