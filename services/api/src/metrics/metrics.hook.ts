import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { MetricsService } from "./metrics.service";

// Deliberately not importing FastifyRequest/FastifyReply from "fastify" directly — this monorepo resolves
// that package to more than one instance (Next.js/other workspace packages pull their own copy), and an
// explicitly-typed hook callback then fails to structurally match whatever `getInstance()` actually
// returns here. A minimal duck-typed shape of just the two fields this hook reads sidesteps that entirely
// — the same reason main.ts's existing `preParsing` hook leaves its own callback params untyped.
interface MinimalRequest {
  method: string;
  url: string;
  routeOptions?: { url?: string };
}
interface MinimalReply {
  statusCode: number;
  elapsedTime: number;
}

/** Route TEMPLATE (`/v1/documents/:id`), not the resolved URL (`/v1/documents/doc_abc123`) — using the raw
 * path would give every distinct resource id its own metric series (unbounded cardinality, the classic
 * Prometheus footgun), defeating the whole point of aggregating by endpoint. */
function routeLabel(request: MinimalRequest): string {
  return request.routeOptions?.url ?? request.url.split("?")[0] ?? "unknown";
}

/**
 * A Fastify `onResponse` hook, not a Nest interceptor — same reasoning as the Stripe raw-body `preParsing`
 * hook already registered in main.ts: this needs to run after Nest's own exception-filter pipeline has
 * actually finalized the response, so `reply.statusCode` reflects the real outcome (a thrown exception
 * mapped to a 4xx/5xx by `GlobalExceptionFilter`, not whatever default status existed while the exception
 * was still propagating through the interceptor chain). `onResponse` fires once the response has genuinely
 * been sent, for both success and error paths, with no such ordering ambiguity.
 */
export function registerMetricsHook(app: NestFastifyApplication): void {
  const metrics = app.get(MetricsService);
  app.getHttpAdapter()
    .getInstance()
    .addHook("onResponse", async (request: MinimalRequest, reply: MinimalReply) => {
      metrics.recordRequest(request.method, routeLabel(request), reply.statusCode, reply.elapsedTime / 1000);
    });
}
