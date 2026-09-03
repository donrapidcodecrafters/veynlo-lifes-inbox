import { Injectable } from "@nestjs/common";
import { getRedisConnection } from "../queue/redis-connection";
import type { Cache } from "./cache.interface";

@Injectable()
export class RedisCacheService implements Cache {
  async incr(key: string): Promise<number> {
    return getRedisConnection().incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await getRedisConnection().expire(key, ttlSeconds);
  }
}
