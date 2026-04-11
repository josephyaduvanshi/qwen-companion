// Qwen CLI adapter.
//
// Wraps the Qwen Code CLI (`qwen`) using its `--output-format stream-json`
// protocol. Replaces the Codex app-server JSON-RPC broker layer from
// codex-plugin-cc. Per-task process spawning; no persistent broker.
//
// Public API (mirrors the shape expected by qwen-companion.mjs):
//
//   getQwenAvailability(cwd)   -> { available, detail }
//   getQwenAuthStatus(cwd)     -> Promise<{ loggedIn, detail, authType }>
//   getDefaultModel(cwd)       -> string | null
//   getSessionRuntimeStatus()  -> { label }
//   runQwenTurn(cwd, options)  -> Promise<TurnResult>
//   interruptQwenTurn()        -> Promise<{ attempted, interrupted, detail }>
//
// TurnResult shape:
//   {
//     status: 0 | 1,
//     exitCode: number,
//     threadId: string | null,   // Qwen session_id
//     turnId:   string | null,   // message id from Qwen (first assistant message)
//     finalMessage: string,      // concatenated text output
//     stderr: string,
//     error: unknown | null,
//     reasoningSummary: string[],
//     touchedFiles: string[],
//     toolCalls: Array<{ name, id }>,
//     usage: object | null,
//     permissionDenials: string[]
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

// ---------- Turn execution ----------

function buildQwenArgs(options = {}) {
  const args = ["--output-format", "stream-json", "--include-partial-messages"];

  const sandbox = options.sandbox ?? "workspace-write";
  if (sandbox === "workspace-write") {
    args.push("--yolo");
  } else {
    // read-only: plan mode (no edits) — qwen's closest equivalent.
    args.push("--approval-mode", "plan");
  }

  if (options.model) {
    args.push("--model", String(options.model));
  }

  if (options.sessionId) {
    args.push("--session-id", String(options.sessionId));
  }

  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }

  return args;
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
      state.toolCalls.push({ name, id: toolId });
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
        state.finalMessage += delta.text;
        return;
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        state.currentThinking += delta.thinking;
        return;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        // Tool input streaming — intentionally ignored; captured in tool_result below.
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
          state.finalMessage = block.text;
        }
      }
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        const normalized = block.thinking.replace(/\s+/g, " ").trim();
        if (normalized && !state.reasoningSegments.includes(normalized)) {
          state.reasoningSegments.push(normalized);
        }
      }
    }
    return;
  }

  // Tool result events carry evidence of touched files when tools report paths.
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
      const detail = typeof event.result === "string" && event.result ? event.result : (event.error ?? "Qwen returned an error.");
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
      state.finalMessage = event.result;
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

export async function runQwenTurn(cwd, options = {}) {
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  if (!prompt.trim()) {
    throw new Error("runQwenTurn requires a non-empty prompt.");
  }

  const args = buildQwenArgs(options);
  const env = options.env ?? process.env;
  const bin = resolveQwenBinary(env);

  const state = {
    threadId: null,
    turnId: null,
    model: null,
    finalMessage: "",
    reasoningSegments: [],
    currentThinking: "",
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

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Become a process group leader on POSIX so terminateProcessTree()
        // can deliver SIGTERM to the whole group in one call. `detached: true`
        // is harmless on Windows — we still rely on `taskkill /T /F`.
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
        // Non-JSON lines are ignored but surfaced as progress.
        options.onProgress?.({
          message: `Non-JSON output: ${line.slice(0, 160)}`,
          stderrMessage: null
        });
        return;
      }
      try {
        handleStreamEvent(event, state, options.onProgress ?? null);
      } catch (err) {
        // Don't let a handler bug tear down the process — capture and continue.
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
      let status = 0;
      if (state.resultStatus === "error" || state.error || exitCode !== 0) {
        status = 1;
      }
      // If we never saw a result envelope and nothing in finalMessage, surface stderr.
      if (!state.resultEnvelopeSeen && !state.finalMessage && state.stderrBuffer.trim() && !state.error) {
        state.error = new Error(state.stderrBuffer.trim().split("\n").slice(-5).join("\n"));
        status = 1;
      }
      settle({
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
      });
    });

    // Feed the prompt on stdin (avoids shell-escaping positionals).
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      fail(err);
    }
  });
}

export async function interruptQwenTurn(_cwd, _options = {}) {
  // Qwen has no cross-process turn interrupt like Codex's app-server. The
  // companion's cancel handler still calls terminateProcessTree() against the
  // worker PID, which is how cancellation actually takes effect.
  return { attempted: false, interrupted: false, detail: null };
}
