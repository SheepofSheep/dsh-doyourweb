import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CaptureStore } from "../src/captures.js";
import { projectMcpResult } from "../src/apps/runtime.js";

test("capture retention persists ownership and leaves legacy, unrelated and edited files alone", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-capture-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = id => `dsh-capture-00000000-0000-0000-0000-${String(id).padStart(12, "0")}.png`;
  for (const legacy of ["browser-legacy.png", "personal.png", name(99)]) await writeFile(path.join(directory, legacy), "preserve");
  let store = new CaptureStore(directory, { maxFiles: 2 });
  for (const id of [1, 2]) { const file = path.join(directory, name(id)); await writeFile(file, "capture"); await store.record(file); }
  await writeFile(path.join(directory, name(1)), "human edit must survive");
  store = new CaptureStore(directory, { maxFiles: 1 });
  const third = path.join(directory, name(3)); await writeFile(third, "new capture"); await store.record(third);
  const files = await readdir(directory);
  assert.ok(files.includes(name(1)), "an edited screenshot is no longer removed by retention");
  assert.equal(files.includes(name(2)), false, "only an unchanged owned file is removed");
  for (const legacy of ["browser-legacy.png", "personal.png", name(99), name(3)]) assert.ok(files.includes(legacy));
  assert.equal(JSON.parse(await readFile(path.join(directory, ".dsh-owned-captures.json"), "utf8")).length, 1);
});

test("capture retention removes expired owned files on the next capture", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-capture-expiry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 0;
  const store = new CaptureStore(directory, { maxAgeMs: 10, now: () => time });
  const first = path.join(directory, "dsh-capture-00000000-0000-0000-0000-000000000001.png");
  const second = path.join(directory, "dsh-capture-00000000-0000-0000-0000-000000000002.png");
  await writeFile(first, "first"); await store.record(first); time = 11;
  await writeFile(second, "second"); await store.record(second);
  assert.equal((await readdir(directory)).includes(path.basename(first)), false);
  assert.equal(await readFile(second, "utf8"), "second");
});

test("desktop and MCP screenshots obey the same retention as browser captures", async t => {
  // The apps layer writes into the same captures directory. Without a shared
  // store and the `dsh-capture-` prefix those files were never adopted or
  // expired, so a screenshot:true loop grew the directory without bound.
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-capture-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const store = new CaptureStore(directory, { maxFiles: 5 });
  for (let index = 0; index < 20; index++) {
    await projectMcpResult({ content: [{ type: "image", mimeType: "image/png", data: png }] }, directory, 8000, store);
  }
  const files = (await readdir(directory)).filter(name => name.endsWith(".png"));
  assert.ok(files.length <= 5, `retention kept ${files.length} screenshots, expected at most 5`);
  assert.ok(files.every(name => /^dsh-capture-[a-f0-9-]{36}\.png$/.test(name)),
    "desktop captures must use the owned-capture name so the shared index adopts them");
  await writeFile(path.join(directory, "personal.png"), "keep");
  await projectMcpResult({ content: [{ type: "image", mimeType: "image/png", data: png }] }, directory, 8000, store);
  assert.ok((await readdir(directory)).includes("personal.png"), "an unrelated file is never removed");
});


test("non-PNG captures are adopted after a restart instead of being orphaned", async t => {
  // MCP/desktop screenshots are written as jpg or webp. The index must adopt every
  // extension we actually produce, or a restart permanently disowns them and they
  // grow without bound — exactly what retention exists to prevent.
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-capture-ext-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = (id, ext) => `dsh-capture-00000000-0000-0000-0000-${String(id).padStart(12, "0")}.${ext}`;
  for (const [id, ext] of [[1, "png"], [2, "jpg"], [3, "webp"]]) {
    const file = path.join(directory, name(id, ext));
    await writeFile(file, "capture");
    await new CaptureStore(directory, { maxFiles: 10 }).record(file);
  }
  const fresh = path.join(directory, name(4, "png"));
  await writeFile(fresh, "new");
  await new CaptureStore(directory, { maxFiles: 0 }).record(fresh);
  const left = (await readdir(directory)).filter(file => /\.(png|jpg|webp)$/.test(file));
  assert.deepEqual(left, [], "every owned capture must be adoptable after a restart");
});

test("a capture that cannot be deleted does not wedge retention", async t => {
  // A screenshot open in a viewer, or a locked profile path, makes unlink fail. That
  // must not stop retention for the rest of the process.
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-capture-locked-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = id => `dsh-capture-00000000-0000-0000-0000-${String(id).padStart(12, "0")}.png`;
  await mkdir(path.join(directory, name(1)), { recursive: true });
  const store = new CaptureStore(directory, { maxFiles: 1 });
  await store.record(path.join(directory, name(1))).catch(() => {});
  const healthy = path.join(directory, name(2));
  await writeFile(healthy, "ok");
  await store.record(healthy);
  assert.ok((await readdir(directory)).includes(name(2)), "a later healthy capture is still recorded");
});
