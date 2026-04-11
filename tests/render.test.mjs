import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/qwen/scripts/lib/render.mjs";

test("renderSetupReport: ready output lists each check", () => {
  const rendered = renderSetupReport({
    ready: true,
    node: { detail: "v20.0.0" },
    npm: { detail: "10.0.0" },
    qwen: { detail: "0.14.3" },
    auth: { detail: "openai via DASHSCOPE_API_KEY" },
    defaultModel: "qwen3.5-plus",
    sessionRuntime: { label: "direct CLI (stream-json)" },
    actionsTaken: [],
    nextSteps: []
  });
  assert.match(rendered, /# Qwen Setup/);
  assert.match(rendered, /Status: ready/);
  assert.match(rendered, /node: v20\.0\.0/);
  assert.match(rendered, /qwen: 0\.14\.3/);
  assert.match(rendered, /default model: qwen3\.5-plus/);
});

test("renderSetupReport: needs attention surfaces next steps", () => {
  const rendered = renderSetupReport({
    ready: false,
    node: { detail: "v20.0.0" },
    npm: { detail: "10.0.0" },
    qwen: { detail: "not found" },
    auth: { detail: "qwen CLI unavailable" },
    defaultModel: null,
    sessionRuntime: { label: "direct CLI (stream-json)" },
    actionsTaken: [],
    nextSteps: ["Install Qwen Code with `npm install -g @qwen-code/qwen-code`."]
  });
  assert.match(rendered, /needs attention/);
  assert.match(rendered, /Install Qwen Code/);
});

test("renderTaskResult: raw output is printed verbatim", () => {
  const rendered = renderTaskResult({ rawOutput: "hello world", reasoningSummary: [] }, {});
  assert.equal(rendered, "hello world\n");
});

test("renderTaskResult: reasoning appended when present", () => {
  const rendered = renderTaskResult(
    { rawOutput: "done", reasoningSummary: ["considered options", "picked plan A"] },
    {}
  );
  assert.match(rendered, /done/);
  assert.match(rendered, /Reasoning:/);
  assert.match(rendered, /- considered options/);
  assert.match(rendered, /- picked plan A/);
});

test("renderTaskResult: failure message when no raw output", () => {
  const rendered = renderTaskResult({ rawOutput: "", failureMessage: "boom" }, {});
  assert.equal(rendered, "boom\n");
});

test("renderStatusReport: empty state", () => {
  const rendered = renderStatusReport({
    sessionRuntime: { label: "direct CLI (stream-json)" },
    config: {},
    running: [],
    latestFinished: null,
    recent: []
  });
  assert.match(rendered, /No jobs recorded yet/);
});

test("renderStatusReport: single completed job in recent list", () => {
  const rendered = renderStatusReport({
    sessionRuntime: { label: "direct CLI (stream-json)" },
    config: {},
    running: [],
    latestFinished: {
      id: "task-1",
      kindLabel: "rescue",
      title: "Qwen Task",
      status: "completed",
      phase: "done",
      summary: "finished",
      duration: "2s",
      threadId: "s-1"
    },
    recent: []
  });
  assert.match(rendered, /Latest finished/);
  assert.match(rendered, /task-1/);
  assert.match(rendered, /Qwen session ID: s-1/);
  assert.match(rendered, /qwen --resume s-1/);
});

test("renderJobStatusReport: adds cancel + result hints", () => {
  const rendered = renderJobStatusReport({
    id: "task-2",
    kindLabel: "rescue",
    title: "Qwen Task",
    status: "running",
    phase: "running",
    elapsed: "1s",
    progressPreview: ["Turn started"]
  });
  assert.match(rendered, /Cancel: \/qwen:cancel task-2/);
});

test("renderStoredJobResult: footer includes session id when present", () => {
  const rendered = renderStoredJobResult(
    { id: "task-3", title: "Qwen Task", status: "completed" },
    { threadId: "abc", result: { rawOutput: "body" } }
  );
  assert.match(rendered, /^body/);
  assert.match(rendered, /Qwen session ID: abc/);
  assert.match(rendered, /qwen --resume abc/);
});

test("renderCancelReport: includes follow-up hint", () => {
  const rendered = renderCancelReport({ id: "task-4", title: "Qwen Task", summary: "x" });
  assert.match(rendered, /# Qwen Cancel/);
  assert.match(rendered, /Cancelled task-4/);
  assert.match(rendered, /\/qwen:status/);
});
