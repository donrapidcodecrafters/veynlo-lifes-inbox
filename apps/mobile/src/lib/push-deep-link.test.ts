// Same setup as offline-mutation-queue.test.ts — Node's built-in runner via `tsx --test`, loading the
// module under test through CommonJS interop. See that file's header for why this app tests that way
// rather than pulling in jest/vitest.
//
// push-deep-link.ts is deliberately pure (no expo-notifications, no expo-router, no React), which is what
// makes the routing decision testable at all. The component that consumes it is a thin wrapper.
//
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate: this suite runs under `tsx --test`,
   i.e. Node's own test runner rather than a bundler, and loads the module under test through CommonJS on
   purpose. Rewriting these as ESM imports would change what is actually being exercised. */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePushRoute,
  PUSH_FALLBACK_ROUTE,
}: typeof import("./push-deep-link") = require("./push-deep-link.ts");

test("a notification about a specific record opens that record", () => {
  assert.equal(resolvePushRoute({ resourceType: "bill", resourceId: "bill_123" }), "/bill/bill_123");
  assert.equal(resolvePushRoute({ resourceType: "warranty", resourceId: "wty_9" }), "/warranty/wty_9");
  assert.equal(resolvePushRoute({ resourceType: "shipment", resourceId: "shp_7" }), "/shipment/shp_7");
  assert.equal(resolvePushRoute({ resourceType: "return_case", resourceId: "rc_1" }), "/return-case/rc_1");
  assert.equal(
    resolvePushRoute({ resourceType: "health_appointment", resourceId: "ha_2" }),
    "/health-appointment/ha_2",
  );
});

test("school_event lands on the calendar event screen — ingestion gives it an event id", () => {
  assert.equal(resolvePushRoute({ resourceType: "school_event", resourceId: "evt_5" }), "/event/evt_5");
  assert.equal(resolvePushRoute({ resourceType: "calendar_event", resourceId: "evt_5" }), "/event/evt_5");
});

test("saved_memory lands on saved-item, which fetches /v1/memories/{id}", () => {
  assert.equal(resolvePushRoute({ resourceType: "saved_memory", resourceId: "mem_4" }), "/saved-item/mem_4");
});

test("tasks and schedule conflicts go to Timeline, which is where they live", () => {
  assert.equal(resolvePushRoute({ resourceType: "task", resourceId: "tsk_1" }), "/timeline");
  assert.equal(resolvePushRoute({ resourceType: "schedule_conflict", resourceId: "cfl_1" }), "/timeline");
});

test("trip_segment goes to the trips LIST, because its id is a segment id, not a trip id", () => {
  // The regression this guards: `/trip/${resourceId}` looks right and cannot load, because
  // apps/mobile/app/trip/[id].tsx fetches /v1/trips/{id} and this id belongs to trip_segments.
  assert.equal(resolvePushRoute({ resourceType: "trip_segment", resourceId: "seg_3" }), "/trips");
});

test("inbox items, automation runs and legacy release land on their own surfaces", () => {
  assert.equal(resolvePushRoute({ resourceType: "inbox_item", resourceId: "inb_1" }), "/(tabs)/inbox");
  assert.equal(resolvePushRoute({ resourceType: "automation_run", resourceId: "run_1" }), "/automations");
  assert.equal(resolvePushRoute({ resourceType: "legacy_release_config", resourceId: "cfg_1" }), "/sharing");
});

test("no resource in the payload means no navigation, so the app just opens normally", () => {
  // The daily and weekly briefs are exactly this case: real notifications, no single target.
  assert.equal(resolvePushRoute({ notificationId: "ntf_1" }), null);
  assert.equal(resolvePushRoute(null), null);
  assert.equal(resolvePushRoute(undefined), null);
});

test("a half-populated target is treated as no target, never as '/bill/undefined'", () => {
  assert.equal(resolvePushRoute({ resourceType: "bill" }), null);
  assert.equal(resolvePushRoute({ resourceId: "bill_123" }), null);
});

test("an unrecognised resource type falls back to Home rather than being dropped", () => {
  // recall_match, store_credit, refill_reminder and friends: real API resource types whose ids address no
  // mobile screen. Home is where the Needs-You queue surfaces them anyway.
  assert.equal(resolvePushRoute({ resourceType: "recall_match", resourceId: "rcl_1" }), PUSH_FALLBACK_ROUTE);
  assert.equal(resolvePushRoute({ resourceType: "store_credit", resourceId: "stc_1" }), PUSH_FALLBACK_ROUTE);
  assert.equal(
    resolvePushRoute({ resourceType: "a_type_added_after_this_build_shipped", resourceId: "x_1" }),
    PUSH_FALLBACK_ROUTE,
  );
});

test("a resource id with URL-significant characters is encoded, not injected into the path", () => {
  assert.equal(resolvePushRoute({ resourceType: "bill", resourceId: "a/b" }), "/bill/a%2Fb");
});
