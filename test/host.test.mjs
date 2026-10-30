import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

async function lifecycle(mode, expected = /PASS: DSH bridge lifecycle/) {
  const temp = await realpath(os.tmpdir());
  const home = await mkdtemp(path.join(temp, "dsh-host-lifecycle-"));
  try {
    // Isolate a faulty plugin that could otherwise leave the test runner listening.
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("./fixtures/host-lifecycle.mjs", import.meta.url)), home, mode], { timeout: 15000 });
    assert.match(result.stdout, expected);
  } finally {
    assert.equal(path.dirname(home), temp);
    assert.ok(path.basename(home).startsWith("dsh-host-lifecycle-"));
    await rm(home, { recursive: true, force: true });
  }
}

test("DSH unload releases the bridge port before the plugin is enabled again", () => lifecycle("reload"));
test("a failed DSH activation releases the bridge before retry", () => lifecycle("failed-activation"));
test("a tab cited by the user stays authorized across steps and restarts",
  () => lifecycle("grants", /PASS: a cited tab stays authorized/));
test("multi-tab initial context shares one serialized output budget",
  () => lifecycle("budget", /PASS: initial context shares/));
test("host references and read tools prefer WebMCP and retain explicit DOM fallback",
  () => lifecycle("routing", /PASS: host context and browser_read discover/));
test("upload tool and batches only disclose exact user-supplied paths to selected tabs",
  () => lifecycle("upload-policy", /PASS: uploads require/));
