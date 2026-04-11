import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function createTempWorkspace(prefix = "qwen-plugin-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const oldCwd = process.cwd();
  return {
    root,
    cleanup() {
      process.chdir(oldCwd);
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };
}

export function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(overrides[key]);
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}
