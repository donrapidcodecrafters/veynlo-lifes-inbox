import { describe, expect, it } from "vitest";
import { extractPlaceCandidate } from "./place-extraction";

describe("extractPlaceCandidate", () => {
  it("extracts coordinates from a Google Maps @lat,lng link", () => {
    const text = "Meet me here: https://www.google.com/maps/place/Some+Place/@37.4224764,-122.0842499,17z/data=xyz";
    const candidate = extractPlaceCandidate(text);
    expect(candidate).toEqual({ address: null, lat: 37.4224764, lng: -122.0842499, source: "extracted_maps_link" });
  });

  it("extracts coordinates from a Google Maps q= link", () => {
    const text = "https://maps.google.com/?q=40.748817,-73.985428";
    const candidate = extractPlaceCandidate(text);
    expect(candidate).toEqual({ address: null, lat: 40.748817, lng: -73.985428, source: "extracted_maps_link" });
  });

  it("extracts coordinates from an Apple Maps ll= link", () => {
    const text = "http://maps.apple.com/?ll=34.052235,-118.243683&q=Somewhere";
    const candidate = extractPlaceCandidate(text);
    expect(candidate).toEqual({ address: null, lat: 34.052235, lng: -118.243683, source: "extracted_maps_link" });
  });

  it("extracts a plain street address with no coordinates", () => {
    const text = "Come pick it up at 1600 Amphitheatre Parkway, Mountain View, CA 94043 after 5pm.";
    const candidate = extractPlaceCandidate(text);
    expect(candidate).toEqual({
      address: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
      lat: null,
      lng: null,
      source: "extracted_address",
    });
  });

  it("returns null for a bare business name with no coordinates or address", () => {
    expect(extractPlaceCandidate("Let's meet at Starbucks")).toBeNull();
  });

  it("returns null for empty or whitespace-only text", () => {
    expect(extractPlaceCandidate("")).toBeNull();
    expect(extractPlaceCandidate("   ")).toBeNull();
  });

  it("prefers a maps-link coordinate match over a plain address in the same text", () => {
    const text = "1600 Amphitheatre Parkway, Mountain View, CA 94043 — or just use https://maps.google.com/?q=37.422,-122.084";
    const candidate = extractPlaceCandidate(text);
    expect(candidate?.source).toBe("extracted_maps_link");
  });

  it("rejects out-of-range coordinates", () => {
    const text = "https://maps.google.com/?q=200.0,-500.0";
    expect(extractPlaceCandidate(text)).toBeNull();
  });
});
