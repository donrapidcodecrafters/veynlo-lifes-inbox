import IORedis from "ioredis";
import { loadEnv } from "../config/env";

let sharedConnection: IORedis | null = null;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it's given
 * (otherwise blocking commands used internally can fail under load) — this
 * is the one place that connection gets created so every Queue/Worker uses
 * an identically-configured client.
 */
export function getRedisConnection(): IORedis {
  if (!sharedConnection) {
    sharedConnection = new IORedis(loadEnv().REDIS_URL, { maxRetriesPerRequest: null });
  }
  return sharedConnection;
}
