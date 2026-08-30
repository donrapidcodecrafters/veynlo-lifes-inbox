import { Global, Module } from "@nestjs/common";
import { createDbClient, type Database } from "@veynlo/db";
import { loadEnv } from "../config/env";

export const DATABASE = Symbol("DATABASE");

/**
 * Global module so every feature module can `@Inject(DATABASE)` without
 * re-importing DatabaseModule everywhere. The pool is created once per
 * process; Nest's app shutdown hooks close it (see main.ts).
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => createDbClient(loadEnv().DATABASE_URL, { poolMax: loadEnv().DATABASE_POOL_MAX }),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
