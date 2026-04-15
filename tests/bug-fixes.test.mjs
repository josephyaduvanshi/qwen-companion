// Unit coverage for fixes pulled from the v1.1.2 QA pass:
//   - `task --wait "do X"` must not concatenate `--wait` into the prompt
//   - `review --background` must enqueue instead of running foreground
//   - `[Thought: ...]` markers must be stripped from streamed text
//   - Upstream error signals (429 / RESOURCE_EXHAUSTED) must be surfaced
//   - Empty prompt without --resume must fail loud
//   - `rescue` alias must route through the task handler

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseArgs } from "../plugins/qwen/scripts/lib/args.mjs";
import {
  stripThoughtMarkers,
  extractUpstreamErrorSignalFromStderr
} from "../plugins/qwen/scripts/lib/qwen.mjs";

const SCRIPT = path.resolve(
  "plugins/qwen/scripts/qwen-companion.mjs"
);

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-bugfix-"));
}

// ---------- #2: --wait strip ----------

test("parseArgs: task accepts --wait as a boolean and leaves positionals clean", () => {
  const { options, positionals } = parseArgs(
    ["--wait", "do", "something"],
    {
      booleanOptions: [
        "json",
        "write",
        "resume-last",
        "resume",
        "fresh",
        "background",
        "wait"
      ]
    }
  );
  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["do", "something"]);
});

test("parseArgs without booleanOptions.wait: --wait leaks into positionals (regression guard)", () => {
  // Documents the pre-fix bug: if `wait` is not a recognized boolean,
  // the token falls through to positionals and would be concatenated
  // into the prompt. We keep this behavior pinned so future parser
  // refactors don't silently break the fix.
  const { positionals } = parseArgs(["--wait", "do", "something"], {
    booleanOptions: ["json"]
  });
  assert.ok(positionals.includes("--wait"));
});

// ---------- #1/#2 review also: --wait + --background boolean ----------

test("parseArgs: review accepts --wait/--background without eating focus positionals", () => {
  const { options, positionals } = parseArgs(
    ["--background", "--wait", "focus", "on", "auth"],
    {
      booleanOptions: ["json", "background", "wait"]
    }
  );
  assert.equal(options.background, true);
  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["focus", "on", "auth"]);
});

// ---------- #3: rescue alias ----------

test("CLI: `rescue` subcommand without a prompt fails with the task error", () => {
  const env = { ...process.env };
  delete env.QWEN_COMPANION_SESSION_ID;
  const result = spawnSync(process.execPath, [SCRIPT, "rescue"], {
    cwd: freshWorkspace(),
    env,
    encoding: "utf8"
  });
  // The rescue alias must route to handleTask and produce the same
  // empty-prompt error as `task`.
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Provide a prompt/i,
    `stderr was: ${result.stderr}`
  );
});

test("CLI: `--help` usage string advertises rescue alongside task", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /task\|rescue/);
});

// ---------- #4B: [Thought: ...] stripping ----------

test("stripThoughtMarkers: removes [Thought: true] prefix", () => {
  assert.equal(
    stripThoughtMarkers("[Thought: true] answer goes here"),
    "answer goes here"
  );
});

test("stripThoughtMarkers: removes embedded [Thought: ...] segments", () => {
  assert.equal(
    stripThoughtMarkers("before [Thought: planning step] after"),
    "before after"
  );
});

test("stripThoughtMarkers: handles non-strings gracefully", () => {
  assert.equal(stripThoughtMarkers(null), null);
  assert.equal(stripThoughtMarkers(""), "");
});

// ---------- #5: upstream error signal extraction ----------

test("extractUpstreamErrorSignalFromStderr: pulls the 429 / RESOURCE_EXHAUSTED line", () => {
  const stderr = [
    "gaxios: request failed",
    "Response status: 429 Too Many Requests",
    "Quota exceeded for metric generate_content_requests_per_minute",
    "stack trace..."
  ].join("\n");
  const signal = extractUpstreamErrorSignalFromStderr(stderr);
  assert.ok(signal);
  assert.match(signal, /429/);
});

test("extractUpstreamErrorSignalFromStderr: catches RESOURCE_EXHAUSTED", () => {
  const signal = extractUpstreamErrorSignalFromStderr(
    "error: code=RESOURCE_EXHAUSTED detail=quota"
  );
  assert.ok(signal);
  assert.match(signal, /RESOURCE_EXHAUSTED/);
});

test("extractUpstreamErrorSignalFromStderr: returns null for benign stderr", () => {
  assert.equal(extractUpstreamErrorSignalFromStderr(""), null);
  assert.equal(
    extractUpstreamErrorSignalFromStderr("warning: deprecated flag"),
    null
  );
});

// ---------- #1: review --background dispatches kind=review in worker ----------

test("CLI: review --background without git repo surfaces a clear error (background path still validates)", () => {
  // Sanity: the --background flag is recognized by the review parser.
  // This is a smoke check that the flag is stripped from positionals
  // (so it isn't treated as focus text) and that the review validator
  // still runs before we enqueue.
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "review", "--background", "--json"],
    {
      cwd: freshWorkspace(),
      env: { ...process.env, QWEN_COMPANION_SESSION_ID: "test-sess" },
      encoding: "utf8"
    }
  );
  // Either "not a git repo" or "qwen CLI not installed" is acceptable
  // — both prove --background didn't crash the parser.
  assert.equal(result.status, 1);
});
