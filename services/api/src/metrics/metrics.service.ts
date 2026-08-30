import { Injectable } from "@nestjs/common";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * §Observability — structured JSON logging (nestjs-pino) has always been real; nothing exposed real
 * metrics (request rates, latency, error rates) at all. A `Registry` scoped to this service instance
 * (not the module-level default registry `prom-client` also offers) so a second instance created in a
 * test wouldn't silently share/duplicate metrics with a running process.
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    // Tuned for a JSON API: most requests should land well under 1s, with a few buckets past that to
    // still distinguish a slow AI-backed call (Ask, OCR) from a genuinely stuck one.
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status_code"],
    registers: [this.registry],
  });

  constructor() {
    // Process-level metrics (heap, event loop lag, CPU, open handles) — free once the registry exists,
    // and exactly what "is this instance healthy" needs beyond per-request numbers.
    collectDefaultMetrics({ register: this.registry });
  }

  recordRequest(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = { method, route, status_code: String(statusCode) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
