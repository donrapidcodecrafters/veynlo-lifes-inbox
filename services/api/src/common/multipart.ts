import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";

/**
 * Reads the uploaded file from a multipart request, turning "this isn't a multipart request at all" into a
 * 400 instead of a 500.
 *
 * `@fastify/multipart`'s `req.file()` THROWS `FastifyError: the request is not multipart` when the request
 * body is anything else — JSON, most obviously. Nest maps that to nothing, so all four upload endpoints
 * answered an authenticated caller with a 500:
 *
 *   POST /v1/documents/upload
 *   POST /v1/memories/upload
 *   POST /v1/ingestion/voice-note
 *   POST /v1/ingestion/share-screenshot
 *
 * Each already had an `if (!file) throw new BadRequestException(...)` guard immediately below the call —
 * but that line is unreachable for a non-multipart body, because `req.file()` never returns to reach it.
 * A correctly-formed multipart request with no file part always did return 400, which is why this hid: the
 * guard works, just not for the case anyone hits first.
 *
 * Found by calling all 560 routes authenticated with a JSON body during the R3 sweep. Shared rather than
 * fixed in place four times, so a fifth upload endpoint added later inherits the behaviour instead of
 * repeating the bug — the same reasoning as the merged-record leak that was fixed across six services
 * rather than at the one site where it was reported.
 */
export async function readMultipartFile(req: FastifyRequest, noFileMessage: string): Promise<MultipartFile> {
  let file: MultipartFile | undefined;
  try {
    file = await req.file();
  } catch (err) {
    // Narrow deliberately: only the "wrong content type" case becomes a 400. A genuine parser failure
    // partway through a real multipart stream is a different problem and must not be relabelled as the
    // caller's fault.
    const code = (err as { code?: string }).code;
    if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE" || /not multipart/i.test(String((err as Error).message))) {
      throw new BadRequestException({
        code: "NOT_MULTIPART",
        message: "This endpoint expects a multipart/form-data upload.",
      });
    }
    throw err;
  }
  if (!file) throw new BadRequestException({ code: "NO_FILE", message: noFileMessage });
  return file;
}
