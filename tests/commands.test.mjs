import test from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_ALIASES,
  buildAdversarialReviewPrompt,
  buildTaskRunMetadata,
  findLatestResumableTaskJob,
  normalizeRequestedModel,
  ROOT_DIR
} from "../plugins/qwen/scripts/qwen-companion.mjs";

test("MODEL_ALIASES exposes the curated qwen shortcuts", () => {
  assert.equal(MODEL_ALIASES.get("plus"), "qwen3.5-plus");
  assert.equal(MODEL_ALIASES.get("max"), "qwen3-max");
  assert.equal(MODEL_ALIASES.get("turbo"), "qwen3-turbo");
  assert.equal(MODEL_ALIASES.get("coder"), "qwen3-coder-plus");
  assert.equal(MODEL_ALIASES.get("glm"), "glm-5");
  assert.equal(MODEL_ALIASES.get("kimi"), "kimi-k2.5");
});

test("normalizeRequestedModel: resolves aliases and passes through unknowns", () => {
  assert.equal(normalizeRequestedModel("plus"), "qwen3.5-plus");
  assert.equal(normalizeRequestedModel("PLUS"), "qwen3.5-plus");
  assert.equal(normalizeRequestedModel("qwen3.5-plus"), "qwen3.5-plus");
  assert.equal(normalizeRequestedModel("custom-model-xyz"), "custom-model-xyz");
});

test("normalizeRequestedModel: null/empty returns null", () => {
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel(undefined), null);
  assert.equal(normalizeRequestedModel(""), null);
  assert.equal(normalizeRequestedModel("   "), null);
});

test("buildTaskRunMetadata: fresh task produces 'Qwen Task' title", () => {
  const meta = buildTaskRunMetadata({ prompt: "fix the login bug" });
  assert.equal(meta.title, "Qwen Task");
  assert.match(meta.summary, /fix the login bug/);
});

test("buildTaskRunMetadata: resume produces 'Qwen Resume' title", () => {
  const meta = buildTaskRunMetadata({ prompt: "", resumeLast: true });
  assert.equal(meta.title, "Qwen Resume");
});

test("buildTaskRunMetadata: stop-gate marker is recognized", () => {
  const meta = buildTaskRunMetadata({
    prompt: "Run a stop-gate review of the previous Claude turn. Blah blah."
  });
  assert.equal(meta.title, "Qwen Stop Gate Review");
});

test("buildAdversarialReviewPrompt: substitutes all template variables", () => {
  const context = {
    target: { label: "working tree diff" },
    collectionGuidance: "use the context below",
    content: "<diff>FAKE DIFF</diff>"
  };
  const prompt = buildAdversarialReviewPrompt(context, "focus on auth flows");
  assert.match(prompt, /Target: working tree diff/);
  assert.match(prompt, /User focus: focus on auth flows/);
  assert.match(prompt, /use the context below/);
  assert.match(prompt, /<diff>FAKE DIFF<\/diff>/);
  // sanity: the template wrapper is present
  assert.match(prompt, /<role>/);
  assert.match(prompt, /<structured_output_contract>/);
});

test("buildAdversarialReviewPrompt: empty focus uses fallback text", () => {
  const prompt = buildAdversarialReviewPrompt(
    {
      target: { label: "branch diff" },
      collectionGuidance: "",
      content: ""
    },
    ""
  );
  assert.match(prompt, /No extra focus provided/);
});

test("findLatestResumableTaskJob: returns most recent task with threadId", () => {
  const jobs = [
    { id: "task-1", jobClass: "task", status: "completed", threadId: "t1" },
    { id: "review-1", jobClass: "review", status: "completed", threadId: "r1" },
    { id: "task-2", jobClass: "task", status: "completed", threadId: "t2" },
    { id: "task-3", jobClass: "task", status: "running", threadId: "t3" } // not resumable
  ];
  const candidate = findLatestResumableTaskJob(jobs);
  assert.equal(candidate.id, "task-1"); // first in list wins
});

test("findLatestResumableTaskJob: returns null when no tasks match", () => {
  assert.equal(findLatestResumableTaskJob([]), null);
  assert.equal(
    findLatestResumableTaskJob([{ id: "review-1", jobClass: "review", status: "completed" }]),
    null
  );
});

test("ROOT_DIR resolves to the plugin root", () => {
  assert.match(ROOT_DIR, /plugins\/qwen$/);
});
