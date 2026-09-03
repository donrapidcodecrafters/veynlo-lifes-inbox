/**
 * §37 "Create ... ObjectStorage ... interfaces so local mocks can be replaced by AWS/provider
 * implementations" — `StorageService` (S3-compatible: real AWS S3 in production, MinIO locally, same
 * client either way) is the only implementation today. This interface is the seam a future non-S3-shaped
 * backend (or a test double) would implement, and the contract every consumer actually depends on —
 * `documents.service.ts`, `data-export.service.ts`, and `worker-main.ts`'s account-deletion cleanup never
 * need to know it's S3 underneath.
 */
export interface ObjectStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Reads the object back as bytes — used by server-side processing (OCR) that needs the actual content,
   * as opposed to `signedGetUrl`, which hands the caller a URL to fetch it themselves. */
  getObject(key: string): Promise<Buffer>;
  /** `downloadFilename`, when given, sets `Content-Disposition: attachment` on the signed response — a
   * real bug found via live audit: without it, `data-export`'s JSON manifest download served with
   * `Content-Type: application/json` and no disposition header, so most browsers navigate to and render
   * the raw JSON inline instead of downloading it when a user clicks "Download." */
  signedGetUrl(key: string, expiresInSeconds?: number, downloadFilename?: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

/** See queue-producer.interface.ts's identical doc comment for why an explicit token is needed. */
export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");
