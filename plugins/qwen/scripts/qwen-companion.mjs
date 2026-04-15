#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getDefaultModel,
  getQwenAuthStatus,
  getQwenAvailability,
  getSessionRuntimeStatus,
  interruptQwenTurn,
  parseStructuredOutput,
  readOutputSchema,
  runQwenReview,
  runQwenTurn,
  VALID_REASONING_EFFORTS
} from "./lib/qwen.mjs";
import { binaryAvailable, gracefullyTerminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA_FILE = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// Qwen model aliases. Left open so users can pass any model string —
// aliases exist only for ergonomics.
const MODEL_ALIASES = new Map([
  ["plus", "qwen3.5-plus"],
  ["max", "qwen3-max"],
  ["turbo", "qwen3-turbo"],
  ["coder", "qwen3-coder-plus"],
  ["glm", "glm-5"],
  ["kimi", "kimi-k2.5"]
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/qwen-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/qwen-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/qwen-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/qwen-companion.mjs task|rescue [--background] [--wait] [--write] [--resume-last|--resume|--fresh] [--model <model|alias>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/qwen-companion.mjs status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  node scripts/qwen-companion.mjs result [job-id] [--json]",
      "  node scripts/qwen-companion.mjs cancel [job-id] [--json]",
      "  node scripts/qwen-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) return null;
  const normalized = String(model).trim();
  if (!normalized) return null;
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return null;
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

// Pull `--include-dirs <path>[,<path>...]` (alias: `--include-directories`)
// out of the raw argv. Supports both repeated flag occurrences AND
// comma-separated lists, and removes the consumed tokens from argv so the
// remaining flags can be handed to `parseCommandInput` unchanged.
//
// This lives outside `parseArgs` because that parser has no concept of
// "repeatable value option" — the rest of the codebase only uses
// single-value flags, and we don't want to change its contract.
function extractIncludeDirs(argv) {
  const dirs = [];
  const remaining = [];
  const FLAGS = new Set(["--include-dirs", "--include-directories"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") {
      remaining.push(token);
      continue;
    }
    const eqIdx = token.indexOf("=");
    const head = eqIdx >= 0 ? token.slice(0, eqIdx) : token;
    if (FLAGS.has(head)) {
      let raw;
      if (eqIdx >= 0) {
        raw = token.slice(eqIdx + 1);
      } else {
        raw = argv[i + 1];
        if (raw === undefined) {
          throw new Error(`Missing value for ${head}`);
        }
        i += 1;
      }
      for (const part of String(raw).split(",")) {
        const trimmed = part.trim();
        if (trimmed) dirs.push(trimmed);
      }
      continue;
    }
    remaining.push(token);
  }
  // De-dupe while preserving order.
  const seen = new Set();
  const deduped = [];
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    deduped.push(d);
  }
  return { includeDirs: deduped, remaining };
}

// Detect absolute paths in the user's prompt that plainly live outside
// `cwd`. Used to warn Qwen via a system-prompt addendum when the user
// did not pass `--include-dirs` — so Qwen is less likely to silently
// redirect the write into `~/.qwen/tmp/<workspace>/`.
function findOutsideCwdPathHints(prompt, cwd) {
  if (typeof prompt !== "string" || !prompt) return [];
  // Match POSIX absolute paths and `~/...` paths. We do NOT try to handle
  // Windows drive letters — the rest of the companion assumes POSIX.
  const matches = prompt.match(/(?:(?<=^)|(?<=[\s"'`(<]))(?:~\/[^\s"'`)<>]+|\/[^\s"'`)<>]+)/g);
  if (!matches) return [];
  const home = process.env.HOME ?? "";
  const resolvedCwd = path.resolve(cwd);
  const hits = [];
  const seen = new Set();
  for (const raw of matches) {
    let candidate = raw;
    if (candidate.startsWith("~/")) {
      if (!home) continue;
      candidate = path.join(home, candidate.slice(2));
    }
    if (!path.isAbsolute(candidate)) continue;
    // Ignore things that look like flags or URLs.
    const resolved = path.resolve(candidate);
    const rel = path.relative(resolvedCwd, resolved);
    const isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (isInside) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    hits.push(resolved);
  }
  return hits;
}

// Build the defensive system-prompt note used when the user's prompt
// references absolute paths outside `cwd` but did not pass
// `--include-dirs`. Without this, Qwen's write_file tool silently
// redirects writes into `~/.qwen/tmp/<workspace>/` — users think the
// write "didn't happen".
function buildOutsideCwdAddendum(cwd, outsidePaths) {
  const list = outsidePaths.map((p) => `  - ${p}`).join("\n");
  return [
    `Write files only under: ${cwd}.`,
    `If you need to write elsewhere (e.g. ${outsidePaths[0]}), do NOT attempt the write.`,
    "Instead, list the required absolute paths in your final answer so the caller can re-run with `--include-dirs <parent>`.",
    "Paths the user mentioned that appear to be outside the workspace:",
    list
  ].join("\n");
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) return jobs;
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

// ---------- setup ----------

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const qwenStatus = getQwenAvailability(cwd);
  const authStatus = qwenStatus.available
    ? await getQwenAuthStatus(cwd)
    : { loggedIn: false, detail: "qwen CLI unavailable", authType: null };
  const defaultModel = qwenStatus.available ? getDefaultModel(cwd) : null;
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!qwenStatus.available) {
    nextSteps.push("Install Qwen Code with `npm install -g @qwen-code/qwen-code`.");
  }
  if (qwenStatus.available && !authStatus.loggedIn) {
    if (authStatus.authType === "qwen-oauth") {
      nextSteps.push("Run `!qwen auth qwen-oauth` to complete OAuth.");
    } else if (authStatus.authType) {
      nextSteps.push(`Configure credentials for ${authStatus.authType} auth (see ~/.qwen/settings.json).`);
    } else {
      nextSteps.push("Run `!qwen auth qwen-oauth` or configure an API key in ~/.qwen/settings.json.");
    }
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/qwen:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && qwenStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    qwen: qwenStatus,
    auth: authStatus,
    defaultModel,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const report = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ---------- helpers for task / review / cancel ----------

function ensureQwenAvailable(cwd) {
  const availability = getQwenAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Qwen Code CLI is not installed. Install it with `npm install -g @qwen-code/qwen-code`, then rerun `/qwen:setup`."
    );
  }
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") return "adversarial-review";
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function recordSpawnedPid(workspaceRoot, jobId) {
  return (child) => {
    if (!child || !child.pid) return;
    upsertJob(workspaceRoot, { id: jobId, pid: child.pid });
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

// ---------- task ----------

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Qwen Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Qwen Resume" : "Qwen Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  jobId,
  includeDirs,
  allowExternalResume = false
}) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    includeDirs: Array.isArray(includeDirs) ? includeDirs : [],
    allowExternalResume: Boolean(allowExternalResume)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter(
    (job) => job.id !== options.excludeJobId
  );
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running")
  );
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /qwen:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  // Guard against cross-Claude-session thread pollution. When we are
  // running inside a Claude session (QWEN_COMPANION_SESSION_ID is set)
  // and that session has no tracked resumable task, refuse to fall
  // back to external session discovery — resuming a different
  // session's thread would silently stitch unrelated work together.
  // Bypass the guard only when the caller explicitly opts in, or when
  // we are running outside Claude (no SESSION_ID_ENV).
  const sessionId = getCurrentClaudeSessionId();
  if (sessionId && !options.allowExternalResume) {
    return null;
  }

  // Fallback: scan ~/.qwen/projects/<cwd>/chats/*.jsonl for sessions
  // created outside this plugin (e.g. the user running `qwen` directly
  // in a terminal). Returns null if the directory is empty or missing.
  return findLatestTaskThread(workspaceRoot);
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureQwenAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId,
      allowExternalResume: Boolean(request.allowExternalResume)
    });
    if (!latestThread) {
      throw new Error("No previous Qwen task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const includeDirs = Array.isArray(request.includeDirs) ? request.includeDirs : [];

  // Defensive: if the user's prompt names absolute paths outside `cwd` and
  // they did NOT pass --include-dirs, prepend a system-prompt note so
  // Qwen surfaces the required paths instead of silently redirecting
  // writes to `~/.qwen/tmp/<workspace>/`.
  let appendSystemPrompt = request.appendSystemPrompt;
  if (request.write && includeDirs.length === 0 && request.prompt) {
    const outside = findOutsideCwdPathHints(request.prompt, workspaceRoot);
    if (outside.length > 0) {
      const note = buildOutsideCwdAddendum(workspaceRoot, outside);
      appendSystemPrompt = appendSystemPrompt
        ? `${note}\n\n${appendSystemPrompt}`
        : note;
    }
  }

  const result = await runQwenTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt || (resumeThreadId ? DEFAULT_CONTINUE_PROMPT : ""),
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    includeDirs,
    appendSystemPrompt,
    onProgress: request.onProgress,
    onSpawn: request.onSpawn
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    rawOutput,
    stderr: result.stderr,
    touchedFiles: result.touchedFiles,
    toolCalls: result.toolCalls,
    usage: result.usage,
    reasoningSummary: result.reasoningSummary,
    permissionDenials: result.permissionDenials,
    durationMs: result.durationMs
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

// ---------- background worker ----------

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "qwen-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

// Persist the queued record, then spawn the detached worker. Shared by
// task/review/adversarial-review background paths — the worker dispatches
// on storedJob.kind to run the right flow.
function enqueueBackgroundJob(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

// Legacy name kept for any callers that still reach in by this spelling.
const enqueueBackgroundTask = enqueueBackgroundJob;

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /qwen:status ${payload.jobId} for progress.\n`;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );

  const kind = storedJob.kind ?? "task";
  const runner = () => {
    if (kind === "review" || kind === "adversarial-review") {
      return executeReviewRun({
        ...request,
        reviewName: request.reviewName ?? (kind === "adversarial-review" ? "Adversarial Review" : "Review"),
        onProgress: progress,
        onSpawn: recordSpawnedPid(workspaceRoot, options["job-id"])
      });
    }
    return executeTaskRun({
      ...request,
      onProgress: progress,
      onSpawn: recordSpawnedPid(workspaceRoot, options["job-id"])
    });
  };

  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    runner,
    { logFile }
  );
}

async function handleTask(argv) {
  // Extract --include-dirs / --include-directories first — the generic
  // parseArgs has no repeatable-value-option concept, so we pre-strip
  // those tokens and hand the rest to parseCommandInput.
  const normalized = normalizeArgv(argv);
  const { includeDirs, remaining } = extractIncludeDirs(normalized);

  const { options, positionals } = parseCommandInput(remaining, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    // `--wait` is accepted (no-op) purely so it is stripped from
    // positionals. Without this, `task --wait "do X"` would concatenate
    // the literal token `--wait` into the prompt.
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
      "wait",
      "allow-external-resume"
    ],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const allowExternalResume = Boolean(options["allow-external-resume"]);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  const hasPrompt = Boolean(prompt && String(prompt).trim());
  if (!hasPrompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  if (options.background) {
    ensureQwenAvailable(cwd);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id,
      includeDirs,
      allowExternalResume
    });
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        allowExternalResume,
        jobId: job.id,
        includeDirs,
        onProgress: progress,
        onSpawn: recordSpawnedPid(workspaceRoot, job.id)
      }),
    { json: options.json }
  );
}

// ---------- review ----------

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Qwen Review" : `Qwen ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function buildNativeReviewTargetHint(target) {
  if (target.mode === "working-tree") return "working tree changes";
  if (target.mode === "branch") return `branch diff against ${target.baseRef}`;
  return "";
}

function validateNativeReviewRequest(_target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/qwen:review\` maps to the built-in reviewer and does not accept custom focus text. Retry with \`/qwen:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
}

async function executeReviewRun(request) {
  ensureQwenAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  if (reviewName === "Review") {
    validateNativeReviewRequest(target, focusText);
    const workspaceRoot = resolveWorkspaceRoot(request.cwd);
    const result = await runQwenReview(workspaceRoot, {
      model: request.model,
      targetHint: buildNativeReviewTargetHint(target),
      includeDirs: Array.isArray(request.includeDirs) ? request.includeDirs : [],
      onProgress: request.onProgress,
      onSpawn: request.onSpawn
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      qwen: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.finalMessage,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status === 0 ? 0 : 1,
        stdout: result.finalMessage,
        stderr: result.stderr
      },
      {
        reviewLabel: reviewName,
        targetLabel: target.label,
        reasoningSummary: result.reasoningSummary
      }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
      jobTitle: `Qwen ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runQwenTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA_FILE),
    includeDirs: Array.isArray(request.includeDirs) ? request.includeDirs : [],
    onProgress: request.onProgress,
    onSpawn: request.onSpawn
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    failureMessage: result.error?.message ?? result.stderr,
    reasoningSummary: result.reasoningSummary
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    qwen: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Qwen ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function handleReviewCommand(argv, config) {
  const normalized = normalizeArgv(argv);
  const { includeDirs, remaining } = extractIncludeDirs(normalized);
  const { options, positionals } = parseCommandInput(remaining, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  if (options.background) {
    ensureQwenAvailable(cwd);
    const request = {
      cwd,
      base: options.base,
      scope: options.scope,
      model,
      focusText,
      reviewName: config.reviewName,
      includeDirs
    };
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        focusText,
        reviewName: config.reviewName,
        includeDirs,
        onProgress: progress,
        onSpawn: recordSpawnedPid(workspaceRoot, job.id)
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

// ---------- status / result / cancel / resume-candidate ----------

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptQwenTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Qwen turn interrupt for ${turnId} on ${threadId}.`
        : `Qwen turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  const termination = await gracefullyTerminateProcessTree(job.pid ?? Number.NaN, {
    gracePeriodMs: 2000
  });
  appendLogLine(
    job.logFile,
    termination.attempted
      ? `Cancelled by user (signal=${termination.finalSignal ?? "?"}${termination.exitedGracefully ? ", graceful" : ", forced"}).`
      : "Cancelled by user."
  );

  const completedAt = nowIso();
  // If cancel fires mid-stream before a result envelope was seen, any
  // partial finalMessage we captured (often a JSON fragment like `},`)
  // would end up as the stored summary — which renders as noise in
  // status/listing output. Prefer a clean placeholder, falling back to
  // the job's original prompt excerpt if present.
  const cleanCancelSummary =
    (typeof existing.summary === "string" && existing.summary.trim() && existing.summary) ||
    (typeof job.summary === "string" && job.summary.trim() && job.summary) ||
    "Cancelled by user.";

  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
    summary: cleanCancelSummary
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    summary: cleanCancelSummary,
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

// ---------- dispatcher ----------

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
    case "rescue":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? fileURLToPath(new URL(`file://${path.resolve(process.argv[1])}`)) : null;
    return entry && path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

// Exported for tests.
export {
  ROOT_DIR,
  MODEL_ALIASES,
  normalizeRequestedModel,
  normalizeReasoningEffort,
  buildSetupReport,
  buildTaskRunMetadata,
  buildAdversarialReviewPrompt,
  executeTaskRun,
  executeReviewRun,
  findLatestResumableTaskJob
};
