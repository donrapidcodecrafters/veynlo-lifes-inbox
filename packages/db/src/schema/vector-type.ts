import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector column via a custom type so we aren't coupled to a specific
 * drizzle-orm minor version's native vector helper. Stored/queried as the
 * pgvector text literal format `[0.1,0.2,...]`.
 */
export const vector = (name: string, { dimensions }: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .slice(1, -1)
        .split(",")
        .filter(Boolean)
        .map(Number);
    },
  })(name);
