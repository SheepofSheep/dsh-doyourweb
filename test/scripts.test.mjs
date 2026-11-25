import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

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

test("the MCP client and browser extension report the package version", async () => {
  const { McpConnection } = await import("../src/apps/runtime.js");
  const declared = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")).version;
  assert.equal(manifest, declared, "the extension manifest version must match the package version");
  const connection = new McpConnection({
    command: process.execPath,
    args: [fileURLToPath(new URL("fixtures/app-mcp.mjs", import.meta.url))],
  });
  try {
    await connection.connect();
    const result = await connection.call("client_version", {});
    assert.equal(result.content[0].text, declared);
  } finally { await connection.close(); }
});

test("the bundled host imports from a package with no parent manifest", async t => {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), "doyourweb-packaged-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const lib = path.join(home, "package", "lib");
  await mkdir(lib, { recursive: true });
  await symlink(path.join(repository, "node_modules"), path.join(home, "node_modules"), "junction");
  const host = await build({ entryPoints: [path.join(repository, "src", "host.js")], bundle: true,
    write: false, platform: "node", format: "esm", target: "node22", packages: "external" });
  const entry = path.join(lib, "host.mjs");
  await writeFile(entry, host.outputFiles[0].contents);
  const { apply } = await import(pathToFileURL(entry));
  assert.equal(typeof apply, "function");
});
