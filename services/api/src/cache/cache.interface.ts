/**
 * §37 "Create Queue, ObjectStorage, Cache, ModelProvider... interfaces so local mocks can be replaced by
 * AWS/provider implementations" / §16 "Use ElastiCache Valkey Serverless for ephemeral state... Distributed
 * rate-limit counters." `RedisCacheService` is the only implementation today (ioredis against the same
 * Redis instance BullMQ uses); a future Valkey/ElastiCache-backed implementation would satisfy this same
 * interface with no call-site changes. Deliberately narrow — `incr`/`expire` is the entire surface any call
 * site actually uses today (EntitlementsService's Ask-quota counter); this is not a generic Redis-command
 * passthrough, which would just move cache-specific knowledge out to call sites instead of behind this
 * boundary. Extend it only when a second real use case needs a different operation.
 *
 * `del` is that second use case: IdentityService's per-account sign-in throttle has to clear an account's
 * failure counter when a sign-in actually succeeds, or a user who mistyped their password a few times and
 * then got it right would keep carrying those failures for the rest of the window.
 */
export interface Cache {
  /** Atomically increments the counter at `key` and returns the new value, creating it at 1 if absent. */
  incr(key: string): Promise<number>;
  /** Sets (or refreshes) `key`'s time-to-live. A no-op if the key doesn't exist. */
  expire(key: string, ttlSeconds: number): Promise<void>;
  /** Removes `key`. A no-op if it doesn't exist. */
  del(key: string): Promise<void>;
}

/** See queue-producer.interface.ts's identical doc comment for why an explicit token is needed. */
export const CACHE = Symbol("CACHE");
