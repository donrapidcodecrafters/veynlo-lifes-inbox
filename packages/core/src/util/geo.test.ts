import { describe, expect, it } from "vitest";
import { haversineDistanceMeters, estimateTravelTime, TRAVEL_ESTIMATE_UNCERTAINTY_NOTE } from "./geo";

describe("haversineDistanceMeters", () => {
  it("returns ~0 for the same point", () => {
    const p = { lat: 40.7128, lng: -74.006 };
    expect(haversineDistanceMeters(p, p)).toBeLessThan(1);
  });

  it("computes a known distance (NYC to LA, ~3936 km) within 1% tolerance", () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };
    const meters = haversineDistanceMeters(nyc, la);
    expect(meters).toBeGreaterThan(3_900_000);
    expect(meters).toBeLessThan(3_970_000);
  });

  it("is symmetric", () => {
    const a = { lat: 51.5074, lng: -0.1278 };
    const b = { lat: 48.8566, lng: 2.3522 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 6);
  });
});

describe("estimateTravelTime", () => {
  it("always carries the uncertainty note", () => {
    const a = { lat: 37.7749, lng: -122.4194 };
    const b = { lat: 37.3382, lng: -121.8863 };
    const result = estimateTravelTime(a, b);
    expect(result.uncertaintyNote).toBe(TRAVEL_ESTIMATE_UNCERTAINTY_NOTE);
    expect(result.method).toBe("haversine_rough_estimate");
  });

  it("never returns zero minutes even for very close points", () => {
    const a = { lat: 40.0, lng: -74.0 };
    const b = { lat: 40.0001, lng: -74.0001 };
    const result = estimateTravelTime(a, b);
    expect(result.estimatedMinutes).toBeGreaterThanOrEqual(1);
  });

  it("scales roughly linearly with distance", () => {
    const origin = { lat: 40.0, lng: -74.0 };
    const near = { lat: 40.1, lng: -74.0 };
    const far = { lat: 41.0, lng: -74.0 };
    const nearEstimate = estimateTravelTime(origin, near);
    const farEstimate = estimateTravelTime(origin, far);
    expect(farEstimate.estimatedMinutes).toBeGreaterThan(nearEstimate.estimatedMinutes);
    expect(farEstimate.distanceMeters).toBeGreaterThan(nearEstimate.distanceMeters);
  });
});
