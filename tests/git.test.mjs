import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectReviewContext,
  detectDefaultBranch,
  ensureGitRepository,
  getCurrentBranch,
  getWorkingTreeState,
  resolveReviewTarget
} from "../plugins/qwen/scripts/lib/git.mjs";
import { runCommandChecked } from "../plugins/qwen/scripts/lib/process.mjs";

function makeRepo(prefix = "qwen-git-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@local"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
  runCommandChecked("git", ["add", "README.md"], { cwd: dir });
  runCommandChecked("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("ensureGitRepository: succeeds inside a repo", () => {
  const dir = makeRepo();
  const root = ensureGitRepository(dir);
  assert.ok(root.length > 0);
});

test("ensureGitRepository: throws outside a repo", () => {
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-notrepo-"));
  assert.throws(() => ensureGitRepository(nonRepo), /must run inside a Git repository/);
});

test("getCurrentBranch: returns main after init", () => {
  const dir = makeRepo();
  assert.equal(getCurrentBranch(dir), "main");
});

test("detectDefaultBranch: finds local main", () => {
  const dir = makeRepo();
  assert.equal(detectDefaultBranch(dir), "main");
});

test("getWorkingTreeState: detects staged, unstaged, and untracked", () => {
  const dir = makeRepo();
  // staged file
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");
  runCommandChecked("git", ["add", "a.txt"], { cwd: dir });
  // unstaged change
  fs.writeFileSync(path.join(dir, "README.md"), "initial\nmore\n", "utf8");
  // untracked file
  fs.writeFileSync(path.join(dir, "b.txt"), "untracked\n", "utf8");

  const state = getWorkingTreeState(dir);
  assert.deepEqual(state.staged, ["a.txt"]);
  assert.deepEqual(state.unstaged, ["README.md"]);
  assert.deepEqual(state.untracked, ["b.txt"]);
  assert.equal(state.isDirty, true);
});

test("resolveReviewTarget: dirty repo → working-tree", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "c.txt"), "change\n", "utf8");
  const target = resolveReviewTarget(dir, { scope: "auto" });
  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget: explicit --base", () => {
  const dir = makeRepo();
  const target = resolveReviewTarget(dir, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget: unsupported scope throws", () => {
  const dir = makeRepo();
  assert.throws(() => resolveReviewTarget(dir, { scope: "bogus" }), /Unsupported review scope/);
});

test("collectReviewContext: produces a string blob for a dirty repo", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "d.txt"), "added\n", "utf8");
  runCommandChecked("git", ["add", "d.txt"], { cwd: dir });
  const target = resolveReviewTarget(dir, { scope: "working-tree" });
  const context = collectReviewContext(dir, target);
  assert.equal(context.mode, "working-tree");
  assert.ok(context.content.length > 0);
  assert.ok(context.changedFiles.includes("d.txt"));
  assert.equal(context.target.mode, "working-tree");
});
