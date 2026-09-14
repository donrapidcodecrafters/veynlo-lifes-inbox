import { z } from "zod";

/**
 * Body schema for `POST /v1/ask`.
 *
 * The handler took `@Body("question") question: string` with no validation pipe at all, so omitting the
 * field entirely handed `undefined` to SearchService.ask and crashed in GraphService.resolveEntityForQuery
 * with "Cannot read properties of undefined (reading 'toLowerCase')" — a 500 for any authenticated
 * caller. Found by calling all 560 routes with a malformed body during the R3 sweep.
 *
 * `min(1)` also closes a smaller hole found in the same probe: an EMPTY question returned 201 and ran the
 * full Ask pipeline, spending a request against the per-plan daily quota EntitlementsService.assertAskQuota
 * exists to protect (§28.8) for a question that cannot be answered.
 *
 * `max(4000)` bounds what reaches the model. Ask is an AI path, so an unbounded string is a real cost
 * and latency lever, not just a hygiene concern.
 */
export const AskDtoSchema = z.object({
  question: z.string().min(1).max(4000),
});
export type AskDto = z.infer<typeof AskDtoSchema>;
