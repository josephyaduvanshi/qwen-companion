import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bumpVersion, checkVersions } from "../scripts/bump-version.mjs";

function scaffoldFakeRepo(version = "0.1.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-bump-test-"));

  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugins", "qwen", ".claude-plugin"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "qwen-companion", version }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "qwen-companion",
        owner: { name: "josephyaduvanshi" },
        metadata: { description: "", version },
        plugins: [{ name: "qwen", version, description: "", source: "./plugins/qwen" }]
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, "plugins", "qwen", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "qwen", version, description: "" }, null, 2) + "\n"
  );

  return dir;
}

test("bumpVersion: updates all three manifests", () => {
  const dir = scaffoldFakeRepo("0.1.0");
  const changed = bumpVersion(dir, "1.0.0");
  assert.equal(changed.length, 3);
  assert.ok(changed.includes("package.json"));
  assert.ok(changed.includes(".claude-plugin/marketplace.json"));
  assert.ok(changed.includes("plugins/qwen/.claude-plugin/plugin.json"));

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(
    fs.readFileSync(path.join(dir, "plugins", "qwen", ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(pkg.version, "1.0.0");
  assert.equal(market.metadata.version, "1.0.0");
  assert.equal(market.plugins[0].version, "1.0.0");
  assert.equal(plugin.version, "1.0.0");
});

test("checkVersions: empty list on match", () => {
  const dir = scaffoldFakeRepo("0.1.0");
  const mismatches = checkVersions(dir, "0.1.0");
  assert.deepEqual(mismatches, []);
});

test("checkVersions: detects mismatch in marketplace", () => {
  const dir = scaffoldFakeRepo("0.1.0");
  const marketPath = path.join(dir, ".claude-plugin", "marketplace.json");
  const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
  market.plugins[0].version = "0.0.9";
  fs.writeFileSync(marketPath, JSON.stringify(market, null, 2));

  const mismatches = checkVersions(dir, "0.1.0");
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /plugins\[qwen\]\.version/);
});

test("bumpVersion: no-op when already at target version", () => {
  const dir = scaffoldFakeRepo("1.0.0");
  const changed = bumpVersion(dir, "1.0.0");
  assert.deepEqual(changed, []);
});

test("bumpVersion: throws on missing marketplace plugin entry", () => {
  const dir = scaffoldFakeRepo("0.1.0");
  const marketPath = path.join(dir, ".claude-plugin", "marketplace.json");
  const market = JSON.parse(fs.readFileSync(marketPath, "utf8"));
  market.plugins = [{ name: "other", version: "0.1.0" }];
  fs.writeFileSync(marketPath, JSON.stringify(market, null, 2));

  assert.throws(() => bumpVersion(dir, "1.0.0"), /plugins\[qwen\]/);
});
