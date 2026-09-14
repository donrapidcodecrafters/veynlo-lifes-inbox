import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { readMultipartFile } from "./multipart";
import { AskDtoSchema } from "../modules/search/dto";

/**
 * Regression cover for the second half of the R3 sweep: an AUTHENTICATED caller sending malformed input
 * must get a 4xx, never a 5xx.
 *
 * Five endpoints failed that, in two root causes:
 *
 *   POST /v1/documents/upload            `req.file()` throws on a non-multipart body
 *   POST /v1/memories/upload             (same)
 *   POST /v1/ingestion/voice-note        (same)
 *   POST /v1/ingestion/share-screenshot  (same)
 *   POST /v1/ask                         `@Body("question")` with no validation pipe at all
 *
 * Both were verified live with curl before and after (500 -> 400 in every case). These tests pin the two
 * units so the next upload endpoint or Ask-adjacent handler cannot quietly reintroduce them.
 */
describe("readMultipartFile", () => {
  /** Stands in for a Fastify request whose `file()` behaves however the test needs. */
  const reqWhere = (file: () => Promise<unknown>) => ({ file }) as unknown as FastifyRequest;

  it("turns a non-multipart body into a 400 instead of letting the parser error escape as a 500", async () => {
    // This is exactly what @fastify/multipart throws for a JSON body — the shape that produced the 500.
    const err = Object.assign(new FastifyLikeError("the request is not multipart"), {
      code: "FST_INVALID_MULTIPART_CONTENT_TYPE",
    });
    await expect(readMultipartFile(reqWhere(() => Promise.reject(err)), "No file was uploaded.")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("recognises the failure by message even when the error carries no code", async () => {
    const err = new FastifyLikeError("the request is not multipart");
    await expect(readMultipartFile(reqWhere(() => Promise.reject(err)), "No file was uploaded.")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("still returns 400 for a well-formed multipart request that carries no file", async () => {
    // This path always worked; the guard just sat below an unreachable line. It must keep working.
    await expect(readMultipartFile(reqWhere(() => Promise.resolve(undefined)), "No file was uploaded.")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("does NOT relabel a genuine mid-stream parser failure as the caller's fault", async () => {
    // A real multipart stream that breaks partway is a different problem. Turning it into a 400 would tell
    // the client to fix a request that was fine, and would hide a server-side failure.
    const err = Object.assign(new FastifyLikeError("Unexpected end of multipart data"), {
      code: "FST_PARTS_LIMIT",
    });
    await expect(readMultipartFile(reqWhere(() => Promise.reject(err)), "No file was uploaded.")).rejects.toThrow(
      "Unexpected end of multipart data",
    );
  });

  it("passes a real file through untouched", async () => {
    const file = { filename: "receipt.pdf", mimetype: "application/pdf", fields: {} };
    await expect(readMultipartFile(reqWhere(() => Promise.resolve(file)), "No file was uploaded.")).resolves.toBe(file);
  });
});

describe("AskDtoSchema", () => {
  it("rejects a missing question — the case that crashed GraphService.resolveEntityForQuery", () => {
    expect(AskDtoSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty question, which previously returned 201 and spent a daily Ask quota", () => {
    expect(AskDtoSchema.safeParse({ question: "" }).success).toBe(false);
  });

  it("rejects a non-string question", () => {
    expect(AskDtoSchema.safeParse({ question: 42 }).success).toBe(false);
    expect(AskDtoSchema.safeParse({ question: ["a", "b"] }).success).toBe(false);
  });

  it("bounds the question, since this is an AI path where length is a real cost lever", () => {
    expect(AskDtoSchema.safeParse({ question: "A".repeat(4001) }).success).toBe(false);
  });

  it("accepts a real question", () => {
    expect(AskDtoSchema.safeParse({ question: "what bills are due this month" }).success).toBe(true);
  });
});

/** Fastify errors are plain Errors with a `code`; this just gives the tests a named constructor. */
class FastifyLikeError extends Error {}
