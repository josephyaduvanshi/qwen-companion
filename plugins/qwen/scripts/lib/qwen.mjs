// Qwen CLI adapter.
//
// Wraps the Qwen Code CLI (`qwen`) using its `--output-format stream-json`
// protocol. Replaces the Codex app-server JSON-RPC broker layer from
// codex-plugin-cc. Per-task process spawning; no persistent broker.
//
// Public API (mirrors the shape expected by qwen-companion.mjs):
//
//   getQwenAvailability(cwd)    -> { available, detail }
//   getQwenAuthStatus(cwd)      -> Promise<{ loggedIn, detail, authType }>
//   getDefaultModel(cwd)        -> string | null
//   getSessionRuntimeStatus()   -> { label }
//   runQwenTurn(cwd, options)   -> Promise<TurnResult>
//   runQwenReview(cwd, options) -> Promise<TurnResult> (native /review)
//   interruptQwenTurn()         -> Promise<{ attempted, interrupted, detail }>
//   parseStructuredOutput(text, meta) -> { parsed, rawOutput, parseError, reasoningSummary }
//   buildPersistentTaskThreadName(prompt) -> string
//   findLatestTaskThread(cwd)   -> { id } | null
//   VALID_REASONING_EFFORTS     -> Set<string>
//   effortToSystemPrompt(effort) -> string | null
//   DEFAULT_CONTINUE_PROMPT     -> string
//
// TurnResult shape:
//   {
//     status: 0 | 1,
//     exitCode: number,
//     threadId: string | null,   // Qwen session_id
//     turnId:   string | null,   // first assistant message id
//     finalMessage: string,      // concatenated text output
//     stderr: string,
//     error: Error | null,
//     reasoningSummary: string[],
//     touchedFiles: string[],
//     toolCalls: Array<{ name, id, input }>,
//     usage: object | null,
//     permissionDenials: string[],
//     durationMs: number | null
//   }

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { binaryAvailable, runCommand } from "./process.mjs";

const QWEN_BIN_ENV = "QWEN_BIN";
const QWEN_HOME = path.join(os.homedir(), ".qwen");
const QWEN_SETTINGS_FILE = path.join(QWEN_HOME, "settings.json");
const QWEN_OAUTH_FILE = path.join(QWEN_HOME, "oauth_creds.json");

const TASK_THREAD_PREFIX = "Qwen Companion Task";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

// Effort levels accepted by --effort. Mirrors codex's set so users can type
// the same flags; translated into system-prompt addenda below.
export const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

const EFFORT_SYSTEM_PROMPTS = {
  none: "Do not use reasoning. Reply directly without deliberation.",
  minimal: "Use minimal reasoning. Be terse and decisive.",
  low: "Think briefly before answering.",
  // medium = no injection; this is qwen's default behavior.
  medium: null,
  high: "Think carefully and consider multiple angles before answering.",
  xhigh:
    "Think very carefully. Consider edge cases, alternative approaches, and potential pitfalls before answering. Verify your output against the stated requirements before finalizing."
};

export function effortToSystemPrompt(effort) {
  if (effort == null) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized || normalized === "medium") return null;
  return EFFORT_SYSTEM_PROMPTS[normalized] ?? null;
}

// Effort levels also cap qwen's tool-call budget via --max-session-turns.
// This gives --effort real teeth: low-effort runs get a hard budget, not
// just a prompt nudge. High-effort runs keep qwen's default (unbounded)
// because there's no way to *force* qwen to use more turns than it
// naturally would.
//
// A "session turn" is one round of user → assistant (+ tool calls within
// that round). max-session-turns 1 means qwen can make tool calls within
// a single round but cannot start a new round of thinking.
const EFFORT_MAX_TURNS = {
  none: 1,
  minimal: 2,
  low: 4,
  medium: null,
  high: null,
  xhigh: null
};

export function effortToMaxSessionTurns(effort) {
  if (effort == null) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return null;
  const turns = EFFORT_MAX_TURNS[normalized];
  return typeof turns === "number" ? turns : null;
}

export function resolveQwenBinary(env = process.env) {
  return env[QWEN_BIN_ENV] || "qwen";
}

export function getQwenAvailability(cwd) {
  return binaryAvailable(resolveQwenBinary(), ["--version"], { cwd });
}

function readQwenSettings() {
  try {
    return JSON.parse(fs.readFileSync(QWEN_SETTINGS_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function getDefaultModel(_cwd) {
  const settings = readQwenSettings();
  return settings?.model?.name ?? null;
}

/**
 * Inspect Qwen's auth state without spawning the CLI whenever possible.
 *
 * - `qwen-oauth`: looks for ~/.qwen/oauth_creds.json.
 * - `openai` / `anthropic` / `gemini` / `vertex-ai`: verifies the key env
 *   variable is actually populated (either inside settings.json or in the
 *   live process env).
 * - Unknown or missing settings: falls back to `qwen auth status`.
 */
export async function getQwenAuthStatus(cwd) {
  const settings = readQwenSettings();
  const selectedType = settings?.security?.auth?.selectedType ?? null;
  const settingsEnv = settings?.env ?? {};
  const hasVar = (name) => Boolean(settingsEnv[name] || process.env[name]);

  if (selectedType === "qwen-oauth") {
    if (fs.existsSync(QWEN_OAUTH_FILE)) {
      return { loggedIn: true, detail: "qwen-oauth credentials present", authType: selectedType };
    }
    return {
      loggedIn: false,
      detail: "qwen-oauth selected but ~/.qwen/oauth_creds.json is missing",
      authType: selectedType
    };
  }

  const apiKeyChecks = {
    openai: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "vertex-ai": ["GOOGLE_APPLICATION_CREDENTIALS"]
  };

  if (selectedType && apiKeyChecks[selectedType]) {
    const candidates = apiKeyChecks[selectedType];
    const found = candidates.find(hasVar);
    if (found) {
      return {
        loggedIn: true,
        detail: `${selectedType} auth via ${found}`,
        authType: selectedType
      };
    }
    return {
      loggedIn: false,
      detail: `${selectedType} selected but none of ${candidates.join(", ")} are set`,
      authType: selectedType
    };
  }

  const probe = runCommand(resolveQwenBinary(), ["auth", "status"], { cwd });
  if (probe.error && /** @type {NodeJS.ErrnoException} */ (probe.error).code === "ENOENT") {
    return { loggedIn: false, detail: "qwen CLI not installed", authType: null };
  }
  if (probe.status === 0) {
    return {
      loggedIn: true,
      detail: probe.stdout.trim() || "authenticated",
      authType: selectedType
    };
  }
  return {
    loggedIn: false,
    detail: probe.stderr.trim() || probe.stdout.trim() || "not authenticated",
    authType: selectedType
  };
}

export function getSessionRuntimeStatus(_env, _workspaceRoot) {
  return { label: "direct CLI (stream-json)" };
}

// ---------- Output schema → system-prompt helper ----------

export function readOutputSchema(schemaPath) {
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read output schema at ${schemaPath}: ${err?.message ?? err}`);
  }
}

function buildSchemaSystemPrompt(schema) {
  if (!schema) return null;
  const body = typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
  return [
    "Your final assistant message MUST be a single JSON object (and ONLY that",
    "object — no code fences, no prose, no trailing commentary) that validates",
    "against this JSON Schema:",
    "",
    body,
    "",
    "If you cannot produce valid JSON, produce an object with `verdict` set to",
    "`blocked` and a single finding describing the reason."
  ].join("\n");
}

// ---------- Prompt assembly ----------

function buildAppendedSystemPrompt({ effort, outputSchema, extraSystemPrompt }) {
  const parts = [];
  const effortPrompt = effortToSystemPrompt(effort);
  if (effortPrompt) parts.push(effortPrompt);
  const schemaPrompt = buildSchemaSystemPrompt(outputSchema);
  if (schemaPrompt) parts.push(schemaPrompt);
  if (extraSystemPrompt) parts.push(String(extraSystemPrompt));
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

// ---------- Turn execution ----------

/**
 * Build the argv list for spawning the Qwen CLI.
 *
 * Supported options (non-exhaustive):
 *   - sandbox: "workspace-write" | "read-only"
 *   - resumeThreadId: string
 *   - model: string
 *   - includeDirs: string[] — expand Qwen's write sandbox beyond cwd.
 *       Emitted as `--include-directories <a>,<b>`. Required when the
 *       prompt asks Qwen to write files outside the workspace cwd;
 *       without it, Qwen silently redirects writes to
 *       `~/.qwen/tmp/<workspace>/` even in yolo mode.
 *   - extraArgs: string[]
 */
function buildQwenArgs(options = {}) {
  const args = ["--output-format", "stream-json", "--include-partial-messages"];

  const sandbox = options.sandbox ?? "workspace-write";
  if (sandbox === "workspace-write") {
    args.push("--yolo");
  } else {
    // read-only: plan mode (no edits) — qwen's closest equivalent.
    args.push("--approval-mode", "plan");
  }

  // Always enable chat recording so sessions can be resumed later via
  // `qwen --chat-recording --resume <id>`. This is a transparency promise:
  // resume won't silently break if the user hasn't toggled a global setting.
  if (options.enableChatRecording !== false) {
    args.push("--chat-recording");
  }

  if (options.resumeThreadId) {
    args.push("--resume", String(options.resumeThreadId));
  }

  if (options.model) {
    args.push("--model", String(options.model));
  }

  // --effort level → hard tool-call budget via --max-session-turns.
  // Complements (does not replace) the system-prompt directive below.
  const maxTurns = effortToMaxSessionTurns(options.effort);
  if (typeof maxTurns === "number" && maxTurns > 0) {
    args.push("--max-session-turns", String(maxTurns));
  }

  const appendedSystemPrompt = buildAppendedSystemPrompt({
    effort: options.effort,
    outputSchema: options.outputSchema,
    extraSystemPrompt: options.appendSystemPrompt
  });
  if (appendedSystemPrompt) {
    args.push("--append-system-prompt", appendedSystemPrompt);
  }

  if (options.systemPrompt) {
    args.push("--system-prompt", String(options.systemPrompt));
  }

  if (Array.isArray(options.includeDirs) && options.includeDirs.length > 0) {
    // Qwen accepts a comma-separated list on --include-directories.
    // De-dupe and drop empties so callers can pass raw user input.
    const cleaned = [];
    const seen = new Set();
    for (const entry of options.includeDirs) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    if (cleaned.length > 0) {
      args.push("--include-directories", cleaned.join(","));
    }
  }

  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }

  return args;
}

// Tool names that write to the workspace. Used to populate `touchedFiles`
// from structured tool_use events instead of scraping free-text output.
const WRITE_TOOL_NAMES = new Set(["write_file", "edit", "replace", "create_file"]);

function extractTouchedFilesFromToolInput(toolName, input) {
  if (!WRITE_TOOL_NAMES.has(toolName)) return [];
  if (!input || typeof input !== "object") return [];
  const candidates = [];
  for (const key of ["file_path", "path", "filepath", "filename"]) {
    if (typeof input[key] === "string" && input[key]) {
      candidates.push(input[key]);
    }
  }
  return candidates;
}

// Strip stray `[Thought: ...]` / `[Thinking: ...]` markers that some
// upstream providers embed in streamed assistant text on resumed turns.
// These should never have leaked out of the reasoning channel in the
// first place — strip defensively so they don't render in final output.
const THOUGHT_MARKER_RE = /\[Thought(?:ing)?:\s*[^\]]*\]\s*/gi;
export function stripThoughtMarkers(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(THOUGHT_MARKER_RE, "");
}

// Scan the stderr buffer for upstream error signals (429 / quota /
// RESOURCE_EXHAUSTED / rate limit) and return the first matching line,
// truncated. Helps surface actionable detail that would otherwise be
// lost because the JSON result envelope only carries a generic message.
export function extractUpstreamErrorSignalFromStderr(stderr) {
  if (typeof stderr !== "string" || !stderr) return null;
  const lines = stderr.split(/\r?\n/);
  const re = /\b(429|RESOURCE_EXHAUSTED|QUOTA|rate[- ]?limit)/i;
  for (const raw of lines) {
    if (re.test(raw)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
    }
  }
  return null;
}

function handleStreamEvent(event, state, onProgress) {
  const type = event?.type;
  if (!type) return;

  // System init — grab session ID immediately.
  if (type === "system" && event.subtype === "init") {
    if (typeof event.session_id === "string" && event.session_id) {
      state.threadId = event.session_id;
    }
    if (typeof event.model === "string") {
      state.model = event.model;
    }
    onProgress?.({
      message: `Starting qwen (model=${state.model ?? "default"}, session=${state.threadId ?? "?"})`,
      phase: "starting",
      threadId: state.threadId
    });
    return;
  }

  // Granular incremental events (requires --include-partial-messages).
  if (type === "stream_event") {
    const inner = event.event;
    if (!inner || typeof inner !== "object") return;

    if (inner.type === "message_start") {
      if (inner.message?.id && !state.turnId) {
        state.turnId = inner.message.id;
      }
      onProgress?.({
        message: "Turn started",
        phase: "running",
        threadId: state.threadId,
        turnId: state.turnId
      });
      return;
    }

    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      const name = inner.content_block.name || "tool";
      const toolId = inner.content_block.id ?? null;
      state.toolCalls.push({ name, id: toolId, input: null });
      onProgress?.({
        message: `Tool: ${name}`,
        phase: "investigating",
        threadId: state.threadId,
        turnId: state.turnId
      });
      return;
    }

    if (inner.type === "content_block_delta") {
      const delta = inner.delta;
      if (!delta) return;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.finalMessage += stripThoughtMarkers(delta.text);
        return;
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        state.currentThinking += delta.thinking;
        return;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        state.currentToolInputJson += delta.partial_json;
        return;
      }
      return;
    }

    if (inner.type === "content_block_stop") {
      if (state.currentThinking) {
        const normalized = state.currentThinking.replace(/\s+/g, " ").trim();
        if (normalized) {
          state.reasoningSegments.push(normalized);
        }
        state.currentThinking = "";
      }
      if (state.currentToolInputJson) {
        try {
          const parsed = JSON.parse(state.currentToolInputJson);
          const last = state.toolCalls[state.toolCalls.length - 1];
          if (last) {
            last.input = parsed;
            for (const file of extractTouchedFilesFromToolInput(last.name, parsed)) {
              state.touchedFiles.add(file);
            }
          }
        } catch {
          /* partial JSON wasn't complete; ignore */
        }
        state.currentToolInputJson = "";
      }
      return;
    }

    if (inner.type === "message_stop") {
      onProgress?.({
        message: "Turn completed",
        phase: "finalizing",
        threadId: state.threadId,
        turnId: state.turnId
      });
      return;
    }

    return;
  }

  // Full assistant message — used as a fallback when deltas were absent.
  if (type === "assistant") {
    const message = event.message;
    if (!message) return;
    if (message.id && !state.turnId) {
      state.turnId = message.id;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        if (!state.finalMessage) {
          state.finalMessage = stripThoughtMarkers(block.text);
        }
      }
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        const normalized = block.thinking.replace(/\s+/g, " ").trim();
        if (normalized && !state.reasoningSegments.includes(normalized)) {
          state.reasoningSegments.push(normalized);
        }
      }
      if (block?.type === "tool_use") {
        const name = block.name || "tool";
        const input = block.input ?? null;
        state.toolCalls.push({ name, id: block.id ?? null, input });
        for (const file of extractTouchedFilesFromToolInput(name, input)) {
          state.touchedFiles.add(file);
        }
      }
    }
    return;
  }

  // Tool result events don't help us much structurally on qwen (no path
  // metadata), but we still scan for file-looking strings so rescue tasks
  // that read files get some coverage.
  if (type === "tool_result" || type === "user") {
    const message = event.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.content === "string") {
        const matches = block.content.match(/(?:^|\s)([./\w][\w./-]+\.[a-zA-Z0-9]{1,6})\b/g);
        if (matches) {
          for (const m of matches) {
            const trimmed = m.trim();
            if (trimmed) state.touchedFiles.add(trimmed);
          }
        }
      }
    }
    return;
  }

  // Final envelope.
  if (type === "result") {
    state.resultEnvelopeSeen = true;
    state.usage = event.usage ?? null;
    state.permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    state.durationMs = event.duration_ms ?? null;

    if (event.is_error) {
      let detail;
      if (typeof event.result === "string" && event.result) {
        detail = event.result;
      } else if (event.error && typeof event.error === "object") {
        // Qwen/upstream providers sometimes emit
        // `error: { type, message, code, ... }` — surface the message
        // and the type so users see RESOURCE_EXHAUSTED / 429 / etc.
        const parts = [];
        if (typeof event.error.message === "string" && event.error.message) {
          parts.push(event.error.message);
        }
        if (typeof event.error.type === "string" && event.error.type) {
          parts.push(`[${event.error.type}]`);
        }
        if (typeof event.error.code === "string" && event.error.code) {
          parts.push(`(${event.error.code})`);
        }
        detail = parts.length > 0 ? parts.join(" ") : "Qwen returned an error.";
      } else if (typeof event.error === "string" && event.error) {
        detail = event.error;
      } else {
        detail = "Qwen returned an error.";
      }
      const stderrSignal = extractUpstreamErrorSignalFromStderr(state.stderrBuffer);
      if (stderrSignal) {
        detail = `${detail} — ${stderrSignal}`;
      }
      state.resultStatus = "error";
      state.error = new Error(String(detail));
      onProgress?.({
        message: `Qwen error: ${state.error.message}`,
        phase: "failed",
        threadId: state.threadId,
        turnId: state.turnId
      });
      return;
    }

    state.resultStatus = "success";
    if (typeof event.result === "string" && event.result && !state.finalMessage) {
      state.finalMessage = stripThoughtMarkers(event.result);
    }
    onProgress?.({
      message: "Qwen turn finished",
      phase: "done",
      threadId: state.threadId,
      turnId: state.turnId
    });
    return;
  }
}

function createTurnState() {
  return {
    threadId: null,
    turnId: null,
    model: null,
    finalMessage: "",
    reasoningSegments: [],
    currentThinking: "",
    currentToolInputJson: "",
    toolCalls: [],
    touchedFiles: new Set(),
    stderrBuffer: "",
    resultStatus: null,
    resultEnvelopeSeen: false,
    error: null,
    usage: null,
    permissionDenials: [],
    durationMs: null
  };
}

function toTurnResult(state, exitCode) {
  let status = 0;
  if (state.resultStatus === "error" || state.error || exitCode !== 0) {
    status = 1;
  }
  if (!state.resultEnvelopeSeen && !state.finalMessage && state.stderrBuffer.trim() && !state.error) {
    const signal = extractUpstreamErrorSignalFromStderr(state.stderrBuffer);
    const tail = state.stderrBuffer.trim().split("\n").slice(-5).join("\n");
    state.error = new Error(signal ? `${signal}\n${tail}` : tail);
    status = 1;
  }
  return {
    status,
    exitCode,
    threadId: state.threadId,
    turnId: state.turnId,
    finalMessage: state.finalMessage,
    stderr: state.stderrBuffer.trim(),
    error: state.error,
    reasoningSummary: state.reasoningSegments,
    touchedFiles: [...state.touchedFiles],
    toolCalls: state.toolCalls,
    usage: state.usage,
    permissionDenials: state.permissionDenials,
    durationMs: state.durationMs
  };
}

export async function runQwenTurn(cwd, options = {}) {
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  if (!prompt.trim() && !options.resumeThreadId) {
    throw new Error("runQwenTurn requires a non-empty prompt (or a resumeThreadId to continue a thread).");
  }

  const args = buildQwenArgs(options);
  const env = options.env ?? process.env;
  const bin = resolveQwenBinary(env);
  const state = createTurnState();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Become a process group leader on POSIX so terminateProcessTree()
        // can deliver SIGTERM to the whole group in one call. Harmless on
        // Windows — we still rely on `taskkill /T /F`.
        detached: process.platform !== "win32"
      });
    } catch (err) {
      reject(err);
      return;
    }

    options.onSpawn?.(child);

    const rl = readline.createInterface({ input: child.stdout });
    let settled = false;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(payload);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(err);
    };

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        options.onProgress?.({
          message: `Non-JSON output: ${line.slice(0, 160)}`,
          stderrMessage: null
        });
        return;
      }
      try {
        handleStreamEvent(event, state, options.onProgress ?? null);
      } catch (err) {
        state.error = err;
      }
    });

    child.stderr.on("data", (chunk) => {
      state.stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      fail(err);
    });

    child.on("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : signal ? 1 : 0;
      settle(toTurnResult(state, exitCode));
    });

    // Feed the prompt on stdin (avoids shell-escaping positionals).
    // Resume flows can pass an empty prompt if they only want to continue.
    try {
      child.stdin.write(prompt || DEFAULT_CONTINUE_PROMPT);
      child.stdin.end();
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Invoke Qwen's built-in `/review` slash command non-interactively.
 *
 * Qwen ships with native code-review prompts registered under slash_commands.
 * By piping `/review` as the prompt we get the tuned qwen reviewer — it
 * auto-detects git state, runs its own tool calls, and emits structured
 * markdown findings without us needing to build our own adversarial prompt.
 */
export async function runQwenReview(cwd, options = {}) {
  const focus = options.focus && String(options.focus).trim() ? String(options.focus).trim() : "";
  const targetHint = options.targetHint ? ` ${String(options.targetHint)}` : "";
  const prompt = `/review${targetHint}${focus ? ` ${focus}` : ""}`;
  // Qwen's native /review slash command is behaviorally read-only (it
  // reads files + runs git, never edits). We spawn in "workspace-write"
  // (yolo) so qwen can actually run `git diff` / `git log` — the stricter
  // "plan" mode blocks all shell execution which prevents the reviewer
  // from seeing the diff.
  return runQwenTurn(cwd, {
    ...options,
    sandbox: "workspace-write",
    prompt,
    enableChatRecording: false
  });
}

export async function interruptQwenTurn(_cwd, _options = {}) {
  // Qwen has no cross-process turn interrupt like Codex's app-server.
  // The companion's cancel handler still calls terminateProcessTree()
  // against the worker PID, which is how cancellation actually takes effect.
  return { attempted: false, interrupted: false, detail: null };
}

// ---------- Structured output parsing ----------

/**
 * Pull a JSON object out of a free-text response. Handles code fences and
 * leading/trailing prose. Returns `{ parsed, rawOutput, parseError }`.
 */
export function parseStructuredOutput(text, meta = {}) {
  const rawOutput = typeof text === "string" ? text : "";
  const reasoningSummary = meta.reasoningSummary ?? [];
  if (!rawOutput.trim()) {
    return {
      parsed: null,
      rawOutput,
      parseError: meta.failureMessage || "Qwen returned an empty response.",
      reasoningSummary
    };
  }

  const candidates = [];
  const fenced = rawOutput.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(rawOutput);

  for (const candidate of candidates) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) continue;
    const slice = candidate.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(slice);
      return { parsed, rawOutput, parseError: null, reasoningSummary };
    } catch {
      /* keep trying */
    }
  }

  return {
    parsed: null,
    rawOutput,
    parseError: "Could not parse a JSON object out of the response.",
    reasoningSummary
  };
}

// ---------- Thread tracking ----------

function shorten(text, limit = 56) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

export function buildPersistentTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

/**
 * Convert an absolute filesystem path into the directory name Qwen uses
 * under `~/.qwen/projects/`. Qwen's naming convention replaces `/` with
 * `-` so `/private/tmp/foo` becomes `-private-tmp-foo`.
 *
 * The input must be a canonical (realpath-resolved) absolute path so that
 * `/tmp/foo` (which macOS symlinks to `/private/tmp/foo`) picks the right
 * bucket.
 */
export function workspacePathToQwenProjectDir(canonicalAbsPath) {
  const normalized = String(canonicalAbsPath || "").replace(/\\/g, "/");
  if (!normalized.startsWith("/")) return null;
  return normalized.replaceAll("/", "-");
}

function canonicalizeCwd(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Look up the most recent resumable task thread for a given workspace.
 *
 * Scans `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl` — qwen writes a
 * JSONL transcript per session when `--chat-recording` is enabled. The
 * filename stem is the session id. Returns the newest file by mtime, or
 * null if the directory doesn't exist or is empty.
 *
 * This lets `/qwen:rescue --resume-last` pick up qwen sessions created
 * outside Claude Code — e.g. sessions you started by running `qwen`
 * directly in the terminal.
 *
 * The companion's tracked-jobs state is still the authoritative source
 * when it has a candidate; this is the fallback.
 */
export function findLatestTaskThread(workspaceRoot, options = {}) {
  const home = options.home ?? os.homedir();
  const projectsRoot = path.join(home, ".qwen", "projects");
  const canonical = canonicalizeCwd(workspaceRoot);
  const projectDir = workspacePathToQwenProjectDir(canonical);
  if (!projectDir) return null;

  const chatsDir = path.join(projectsRoot, projectDir, "chats");
  let entries;
  try {
    entries = fs.readdirSync(chatsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const abs = path.join(chatsDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { id: entry.name.replace(/\.jsonl$/, ""), file: abs, mtimeMs: stat.mtimeMs };
    }
  }

  if (!newest) return null;
  return { id: newest.id, file: newest.file, mtimeMs: newest.mtimeMs };
}
