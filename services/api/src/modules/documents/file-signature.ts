/**
 * §28.13 "quarantine -> size/type/magic-byte validation -> malware scan..." — the mimeType a client sends
 * on a multipart upload is just a header the client controls; nothing before this validated that a file
 * claiming to be `image/png` actually starts with PNG's byte signature. A mismatch here means either the
 * client is lying (a renamed/mislabeled file, deliberately or not) or the browser/OS guessed the wrong
 * content type — either way the pipeline downstream (OCR, previews) is about to treat the bytes as
 * something they're not, so this rejects before storage/scanning rather than after.
 *
 * text/plain is deliberately not checked here — plain text has no reliable magic-byte signature (any byte
 * sequence can be valid text), so ALLOWED_MIME_TYPES's own allowlist plus size limits are the real control
 * for that type, same as most of the industry treats free-text uploads.
 */
export function matchesFileSignature(buffer: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "application/pdf":
      return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    case "image/jpeg":
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/png":
      return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/heic": {
      // ISO base media file format: a 4-byte box size, then "ftyp", then a 4-byte major brand. HEIC/HEIF
      // files use one of a handful of documented brand codes — this isn't exhaustive of every possible
      // HEIF variant, but covers what real cameras/phones (the only realistic source of a HEIC upload)
      // actually produce.
      if (buffer.length < 12 || buffer.subarray(4, 8).toString("latin1") !== "ftyp") return false;
      const brand = buffer.subarray(8, 12).toString("latin1");
      return ["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"].includes(brand);
    }
    case "text/plain":
      return true;
    default:
      return false;
  }
}
