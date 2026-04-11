import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const signal = options.signal ?? "SIGTERM";

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, signal);
    return { attempted: true, delivered: true, method: "process-group", signal };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, signal);
        return { attempted: true, delivered: true, method: "process", signal };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process", signal };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group", signal };
  }
}

/**
 * Check whether a PID is still alive. Cross-platform best-effort —
 * returns false on ESRCH and EPERM (processes we can't signal), true
 * otherwise. Uses `kill(pid, 0)` which sends no signal.
 */
export function processIsAlive(pid, options = {}) {
  if (!Number.isFinite(pid)) return false;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM = process exists but we can't signal it. Treat as alive.
    if (error?.code === "EPERM") return true;
    return false;
  }
}

/**
 * Gracefully terminate a process tree in escalating phases:
 *   SIGINT  (graceful — qwen and most POSIX tools exit cleanly)
 *   SIGTERM (request termination)
 *   SIGKILL (force termination)
 *
 * Each phase waits up to `gracePeriodMs` for the process to exit before
 * escalating. Returns the final signal that was delivered and whether
 * the process actually exited before the terminal SIGKILL. Never throws
 * on a missing process; that is treated as "already dead".
 *
 * On Windows, falls back to a single `taskkill /T /F` call — the
 * Win32 signal model doesn't map onto SIGINT/SIGTERM/SIGKILL usefully.
 */
export async function gracefullyTerminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, exitedGracefully: false, signal: null };
  }

  const platform = options.platform ?? process.platform;
  const gracePeriodMs = Math.max(0, Number(options.gracePeriodMs) || 2000);
  const signals = options.signals ?? (platform === "win32" ? ["SIGTERM"] : ["SIGINT", "SIGTERM", "SIGKILL"]);
  const aliveCheck = options.aliveCheck ?? ((p) => processIsAlive(p, options));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastResult = { attempted: false, delivered: false, method: null, signal: null };
  let exitedGracefully = false;

  for (let i = 0; i < signals.length; i += 1) {
    const signal = signals[i];
    const isFinalPhase = i === signals.length - 1;

    try {
      lastResult = terminateProcessTree(pid, { ...options, signal });
    } catch (error) {
      // Unexpected kill failure — record and continue escalating.
      lastResult = { attempted: true, delivered: false, method: "error", signal, error };
    }

    if (isFinalPhase) {
      // No waiting after the terminal signal — we've done all we can.
      break;
    }

    // Poll for exit up to gracePeriodMs.
    const deadline = Date.now() + gracePeriodMs;
    const pollInterval = Math.min(100, gracePeriodMs);
    while (Date.now() < deadline) {
      if (!aliveCheck(pid)) {
        exitedGracefully = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollInterval);
    }

    if (exitedGracefully) break;
  }

  // One last status check to confirm.
  if (!exitedGracefully && !aliveCheck(pid)) {
    exitedGracefully = true;
  }

  return {
    ...lastResult,
    exitedGracefully,
    finalSignal: lastResult.signal
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
