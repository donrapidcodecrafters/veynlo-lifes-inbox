// Node's built-in runner via `tsx --test`, same as the sibling suites. See offline-mutation-queue.test.ts
// for why this app tests that way.
//
// These are the two rules that were shipped on reasoning alone, because no available technique can
// register a genuine OS notification tap on iOS Simulator (and Android has no push token without an EAS
// projectId). The delivery half stays recorded as unverified; this pins the half that can be proven.
//
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate: this suite runs under `tsx --test`,
   i.e. Node's own test runner rather than a bundler, and loads the module under test through CommonJS on
   purpose. Rewriting these as ESM imports would change what is actually being exercised. */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPushNavigator,
}: typeof import("./push-navigator") = require("./push-navigator.ts");

/** Records what expo-router would have been asked to do. */
function fakeTarget() {
  const calls: Array<{ op: "push" | "replace"; route: string }> = [];
  return {
    calls,
    push: (route: string) => calls.push({ op: "push", route }),
    replace: (route: string) => calls.push({ op: "replace", route }),
  };
}

test("the first push navigates on top, so Back returns where the user was", () => {
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  assert.equal(nav.go({ resourceType: "bill", resourceId: "bill_1" }), "navigated");
  assert.deepEqual(target.calls, [{ op: "push", route: "/bill/bill_1" }]);
});

test("§16 — five taps never means five screens to back out of", () => {
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  for (const id of ["bill_1", "bill_2", "bill_3", "bill_4", "bill_5"]) {
    nav.go({ resourceType: "bill", resourceId: id });
  }
  // One push onto the user's screen, then replaces — so the back stack grows by exactly one, ever.
  assert.deepEqual(
    target.calls.map((c) => c.op),
    ["push", "replace", "replace", "replace", "replace"],
  );
  assert.equal(target.calls[target.calls.length - 1]!.route, "/bill/bill_5");
});

test("a brief with no target does not navigate at all", () => {
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  assert.equal(nav.go({ notificationId: "ntf_1" }), "no-route");
  assert.deepEqual(target.calls, []);
});

test("a brief does not consume the first-push slot", () => {
  // The regression this guards: if "no-route" still set openedFromPush, the NEXT real push would replace
  // the screen the user was on rather than pushing onto it — silently eating whatever they were looking at.
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  nav.go({ notificationId: "ntf_brief" });
  nav.go({ resourceType: "warranty", resourceId: "wty_1" });
  assert.deepEqual(target.calls, [{ op: "push", route: "/warranty/wty_1" }]);
});

test("an unroutable resource type still navigates, to Home", () => {
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  assert.equal(nav.go({ resourceType: "recall_match", resourceId: "rcl_1" }), "navigated");
  assert.deepEqual(target.calls, [{ op: "push", route: "/(tabs)" }]);
});

test("the cold-start replay guard reports a notification as handled only after it is marked", () => {
  const nav = createPushNavigator(fakeTarget());
  assert.equal(nav.alreadyHandled("ntf_1"), false);
  nav.markHandled("ntf_1");
  assert.equal(nav.alreadyHandled("ntf_1"), true);
  // A different notification is unaffected — only the replayed launch response is suppressed.
  assert.equal(nav.alreadyHandled("ntf_2"), false);
});

test("a warm tap marks its notification, so a later cold-start read cannot replay it", () => {
  // getLastNotificationResponseAsync keeps returning the launch response for the life of the process. If a
  // warm tap did not mark it, a remount would re-navigate and yank the user out of wherever they had gone.
  const target = fakeTarget();
  const nav = createPushNavigator(target);
  nav.markHandled("ntf_launch");
  nav.go({ resourceType: "bill", resourceId: "bill_1" });
  assert.equal(nav.alreadyHandled("ntf_launch"), true);
  assert.equal(target.calls.length, 1);
});
