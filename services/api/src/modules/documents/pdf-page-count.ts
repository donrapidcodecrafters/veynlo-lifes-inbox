/**
 * §28.13 "Protect against ... oversized images/PDF page counts ... and excessive OCR work." A cheap,
 * dependency-free approximation: every page object in an (uncompressed-object-stream) PDF declares
 * `/Type /Page` in its dictionary — counting those occurrences in the raw bytes is a well-known lightweight
 * heuristic. It undercounts PDFs whose page objects live inside compressed object streams (common in
 * PDFs produced by some generators), so this is a defense-in-depth ceiling against a pathological page
 * count, not a billing-accurate page counter — a real parser (pdf-lib et al.) would be needed for that,
 * and isn't justified just to bound abuse.
 */
export function approxPdfPageCount(buffer: Buffer): number {
  const text = buffer.toString("latin1");
  // Matches "/Type /Page" or "/Type/Page" but not "/Type /Pages" (the page-tree root, not a page).
  const matches = text.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return matches?.length ?? 0;
}
