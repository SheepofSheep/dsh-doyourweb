import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

test("contract extraction does not delete unrelated files in --out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-extract-test-"));
  const output = path.join(root, "extract");
  try {
    await mkdir(output);
    await writeFile(path.join(output, "keep.txt"), "preserve me");
    const archive = path.join(root, "bad.asar");
    await writeFile(archive, Buffer.alloc(16));
    const script = fileURLToPath(new URL("../scripts/verify-dsh-contract.mjs", import.meta.url));
    assert.equal(path.dirname(path.resolve(output)), root);
    await assert.rejects(promisify(execFile)(process.execPath, [script, "--asar", archive, "--out", output], { timeout: 5000 }));
    assert.equal(await readFile(path.join(output, "keep.txt"), "utf8"), "preserve me");
    const repository = fileURLToPath(new URL("..", import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [script, "--asar", archive, "--out", repository], { timeout: 5000 }),
      /dedicated directory/);
  } finally {
    assert.equal(path.dirname(output), root);
    assert.ok(path.basename(root).startsWith("dsh-extract-test-"));
    await rm(root, { recursive: true, force: true });
  }
});

test("the MCP client reports the package version, not a stale literal", async () => {
  // A hardcoded version here previously drifted from package.json, so MCP servers
  // were told a version that no longer existed.
  const { readFile } = await import("node:fs/promises");
  const declared = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")).version;
  assert.equal(manifest, declared, "the extension manifest version must match the package version");
  const source = await readFile(new URL("../src/apps/runtime.js", import.meta.url), "utf8");
  assert.equal(/version:\s*"\d+\.\d+\.\d+"/.test(source), false,
    "the MCP client identity must not hardcode a version literal");
  assert.match(source, /PACKAGE_VERSION/, "the version must come from package.json");
});
