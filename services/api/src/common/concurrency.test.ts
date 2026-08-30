import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` callbacks at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return i * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("preserves input order in the returned results regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20, 5], 4, async (delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return delayMs;
    });
    expect(results).toEqual([30, 10, 20, 5]);
  });

  it("propagates a callback's rejection rather than swallowing it", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});
