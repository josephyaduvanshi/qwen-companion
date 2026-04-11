import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/qwen/scripts/lib/args.mjs";

test("parseArgs: boolean and value options with aliases", () => {
  const { options, positionals } = parseArgs(
    ["--write", "-m", "plus", "--json", "fix", "the", "bug"],
    {
      valueOptions: ["model"],
      booleanOptions: ["write", "json"],
      aliasMap: { m: "model" }
    }
  );
  assert.equal(options.write, true);
  assert.equal(options.json, true);
  assert.equal(options.model, "plus");
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("parseArgs: inline --key=value form", () => {
  const { options } = parseArgs(["--model=qwen3-max"], {
    valueOptions: ["model"]
  });
  assert.equal(options.model, "qwen3-max");
});

test("parseArgs: missing value throws", () => {
  assert.throws(
    () => parseArgs(["--model"], { valueOptions: ["model"] }),
    /Missing value for --model/
  );
});

test("parseArgs: -- stops flag parsing", () => {
  const { options, positionals } = parseArgs(["--write", "--", "--not-a-flag", "x"], {
    booleanOptions: ["write"]
  });
  assert.equal(options.write, true);
  assert.deepEqual(positionals, ["--not-a-flag", "x"]);
});

test("splitRawArgumentString: handles quotes and escapes", () => {
  assert.deepEqual(
    splitRawArgumentString('--model plus "fix the login bug" --write'),
    ["--model", "plus", "fix the login bug", "--write"]
  );
  assert.deepEqual(
    splitRawArgumentString("hello\\ world one 'two three'"),
    ["hello world", "one", "two three"]
  );
});
