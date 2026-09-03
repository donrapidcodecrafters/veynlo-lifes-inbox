import { describe, expect, it } from "vitest";
import { matchesFileSignature } from "./file-signature";

describe("matchesFileSignature", () => {
  it("accepts a real PDF header", () => {
    expect(matchesFileSignature(Buffer.from("%PDF-1.7\n%rest of file"), "application/pdf")).toBe(true);
  });

  it("rejects a PNG mislabeled as a PDF", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(matchesFileSignature(png, "application/pdf")).toBe(false);
  });

  it("accepts a real PNG signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(matchesFileSignature(png, "image/png")).toBe(true);
  });

  it("accepts a real JPEG signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(matchesFileSignature(jpeg, "image/jpeg")).toBe(true);
  });

  it("rejects plain text claiming to be a JPEG", () => {
    expect(matchesFileSignature(Buffer.from("just some text, not an image"), "image/jpeg")).toBe(false);
  });

  it("accepts a real HEIC ftyp box", () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4)]);
    expect(matchesFileSignature(heic, "image/heic")).toBe(true);
  });

  it("rejects a JPEG mislabeled as HEIC", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(matchesFileSignature(jpeg, "image/heic")).toBe(false);
  });

  it("accepts any content for text/plain (no reliable magic bytes)", () => {
    expect(matchesFileSignature(Buffer.from("anything at all"), "text/plain")).toBe(true);
  });

  it("rejects an unrecognized mime type outright", () => {
    expect(matchesFileSignature(Buffer.from("whatever"), "application/octet-stream")).toBe(false);
  });

  it("does not throw on a too-short buffer", () => {
    expect(matchesFileSignature(Buffer.from([1, 2]), "application/pdf")).toBe(false);
    expect(matchesFileSignature(Buffer.from([1, 2]), "image/png")).toBe(false);
    expect(matchesFileSignature(Buffer.from([1, 2]), "image/heic")).toBe(false);
  });
});
