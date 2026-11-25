import test from "node:test";
import assert from "node:assert/strict";
import { LocalApproval } from "../src/auth.js";

test("DSH approval invitations are scoped, short-lived and consumed once", () => {
  let time = 0;
  const auth = new LocalApproval({ now: () => time });
  const invitation = auth.invite("setup");
  assert.equal(auth.exchange(invitation, "manage"), undefined);
  const key = auth.exchange(invitation, "setup");
  assert.ok(key);
  assert.equal(auth.exchange(invitation, "setup"), undefined);
  assert.equal(auth.permits(key, "setup"), true);
  assert.equal(auth.permits(key, "manage"), false);
  assert.equal(auth.permits(undefined, "setup"), false);
  const expired = auth.invite("manage");
  time += 60001;
  assert.equal(auth.exchange(expired, "manage"), undefined);
  time += 30 * 60000;
  assert.equal(auth.permits(key, "setup"), false);
  const active = auth.exchange(auth.invite("manage"), "manage");
  auth.close();
  assert.equal(auth.permits(active, "manage"), false);
});

test("an in-use approval session is not evicted by newer ones", () => {
  // The management page polls every 4 s. Eviction must cost the least recently
  // used session, not the tab the user currently has open.
  const auth = new LocalApproval();
  const live = auth.exchange(auth.invite("manage"), "manage");
  assert.equal(auth.permits(live, "manage"), true);
  for (let index = 0; index < 130; index++) {
    auth.permits(live, "manage");
    auth.exchange(auth.invite("manage"), "manage");
  }
  assert.equal(auth.permits(live, "manage"), true, "an actively used session survives the cap");
  const idle = auth.exchange(auth.invite("manage"), "manage");
  for (let index = 0; index < 140; index++) auth.exchange(auth.invite("manage"), "manage");
  assert.equal(auth.permits(idle, "manage"), false, "an unused session is evicted instead");
});
