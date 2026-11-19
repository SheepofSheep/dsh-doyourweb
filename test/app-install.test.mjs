import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { preparePackage, installConnector, managedDirectory } from "../src/apps/install.js";
import { fingerprint } from "../src/apps/catalog.js";

test("npm review locks transitive versions before approval and installation uses that exact lock", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-reviewed-npm-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const candidate = { id: "fixture", kind: "mcp", label: "Fixture", package: { type: "npm", name: "fixture", version: "1.0.0" } };
  const lock = { name: "dsh-reviewed-connector", version: "1.0.0", lockfileVersion: 3, packages: {
    "": { name: "dsh-reviewed-connector", version: "1.0.0", dependencies: { fixture: "1.0.0" } },
    "node_modules/fixture": { version: "1.0.0", integrity: "sha512-root", resolved: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz", dependencies: { child: "^1.0.0" } },
    "node_modules/child": { version: "1.2.0", integrity: "sha512-child", resolved: "https://registry.npmjs.org/child/-/child-1.2.0.tgz" },
  } };
  const reviewedJson = JSON.stringify(lock), calls = [];
  const find = async () => "npm";
  const prepared = await preparePackage(candidate, undefined, { home, find,
    fetcher: async () => ({ ok: true, text: async () => JSON.stringify({ name: "fixture", version: "1.0.0", bin: { fixture: "index.js" }, dist: { integrity: "sha512-root" } }) }),
    run: async (_command, args, { cwd }) => {
      calls.push(args); assert.ok(args.includes("--package-lock-only")); assert.ok(args.includes("--ignore-scripts"));
      assert.equal(JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")).dependencies.fixture, "1.0.0");
      await writeFile(path.join(cwd, "package-lock.json"), reviewedJson); return { exitCode: 0 };
    },
  });
  assert.equal(prepared.dependencyLock.packages, 2);
  assert.equal(prepared.dependencyLock.sha256, createHash("sha256").update(reviewedJson).digest("hex"));
  assert.notEqual(fingerprint(prepared), fingerprint({ ...prepared, dependencyLock: { sha256: "changed" } }));
  const installed = await installConnector(prepared, home, undefined, { find, run: async (_command, args, { cwd }) => {
    calls.push(args); assert.equal(args[0], "ci"); assert.ok(args.includes("--ignore-scripts"));
    assert.equal(await readFile(path.join(cwd, "package-lock.json"), "utf8"), reviewedJson);
    const manifest = path.join(cwd, "node_modules", "fixture"); await mkdir(manifest, { recursive: true });
    await writeFile(path.join(manifest, "package.json"), '{"version":"1.0.0"}'); return { exitCode: 0 };
  } });
  assert.equal(installed.installed, true); assert.equal(calls.length, 2);
  let ran = false;
  const tampered = { ...prepared, dependencyLock: { ...prepared.dependencyLock, json: reviewedJson.replace("1.2.0", "1.9.0") } };
  await assert.rejects(installConnector(tampered, home, undefined, { find, run: async () => { ran = true; } }), /lock is missing or changed/);
  assert.equal(ran, false);
  await assert.rejects(installConnector(prepared, home, undefined, { find, run: async (_command, _args, { cwd }) => {
    await writeFile(path.join(cwd, "package-lock.json"), reviewedJson.replace("1.2.0", "1.9.0")); return { exitCode: 0 };
  } }), /lock changed during installation/);
  await assert.rejects(installConnector(prepared, home, undefined, { find, run: async (_command, _args, { cwd }) => {
    await writeFile(path.join(cwd, "node_modules", "fixture", "package.json"), '{"version":"2.0.0"}'); return { exitCode: 0 };
  } }), /version differs/);
  assert.equal(path.dirname(path.dirname(installed.command)), path.join(managedDirectory(home, "fixture"), "node_modules"));
});
