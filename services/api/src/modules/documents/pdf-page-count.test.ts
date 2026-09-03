import { describe, expect, it } from "vitest";
import { approxPdfPageCount } from "./pdf-page-count";

function fakePdfWithPages(count: number): Buffer {
  const pages = Array.from({ length: count }, () => "1 0 obj << /Type /Page >> endobj").join("\n");
  return Buffer.from(`%PDF-1.7\n${pages}\ntrailer`);
}

describe("approxPdfPageCount", () => {
  it("counts real page objects", () => {
    expect(approxPdfPageCount(fakePdfWithPages(3))).toBe(3);
  });

  it("does not count the /Pages tree root as a page", () => {
    const buf = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj");
    expect(approxPdfPageCount(buf)).toBe(1);
  });

  it("handles /Type/Page with no space", () => {
    expect(approxPdfPageCount(Buffer.from("<< /Type/Page >>"))).toBe(1);
  });

  it("returns 0 for a non-PDF buffer", () => {
    expect(approxPdfPageCount(Buffer.from("just some text"))).toBe(0);
  });
});
