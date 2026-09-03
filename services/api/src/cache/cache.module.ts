import { Global, Module } from "@nestjs/common";
import { RedisCacheService } from "./redis-cache.service";
import { CACHE } from "./cache.interface";

@Global()
@Module({
  providers: [RedisCacheService, { provide: CACHE, useExisting: RedisCacheService }],
  exports: [RedisCacheService, CACHE],
})
export class CacheModule {}
