import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CaptureStore } from "../src/captures.js";

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
