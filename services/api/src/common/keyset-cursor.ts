import { BadRequestException } from "@nestjs/common";

/**
 * Opaque cursors for keyset pagination.
 *
 * Keyset, not OFFSET, and the difference matters on exactly the lists this app has. `OFFSET 200` makes
 * Postgres walk and discard 200 rows to return the next 50, so the deeper a user scrolls the slower it
 * gets; and because these lists are ordered by a column the user's own actions rewrite, a row inserted or
 * updated between two OFFSET pages shifts everything after it — the reader silently skips a row or sees
 * one twice. A cursor naming the last row seen has neither problem.
 *
 * The payload is base64 of "<sort value>|<id>" — encoded rather than plain so it reads as an opaque token
 * a client passes back unchanged, not a pair of values it is invited to construct. It carries no secret,
 * so this is not encryption and is not treated as any: every cursor is validated on the way in, because a
 * value that arrives from a client is input no matter where the client got it.
 */
export type KeysetCursor = { sortValue: string; id: string };

export function encodeCursor(sortValue: Date | string | number, id: string): string {
  const value = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue);
  return Buffer.from(`${value}|${id}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor, or throws with a code the client can act on.
 *
 * A malformed cursor is a 400, not a silent fall back to the first page: quietly restarting pagination
 * would make a client that mangles its cursor loop forever over page one, returning rows it has already
 * shown, and would look like data corruption from the outside rather than like a bug in the caller.
 */
export function decodeCursor(cursor: string | undefined | null): KeysetCursor | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (cursor.length > 512) throw badCursor();
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw badCursor();
  }
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0 || separator === decoded.length - 1) throw badCursor();
  const sortValue = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!sortValue || !id) throw badCursor();
  return { sortValue, id };
}

/** A cursor whose sort key is a timestamp, rejected if it is not a real one. */
export function decodeTimestampCursor(cursor: string | undefined | null): { at: Date; id: string } | null {
  const parsed = decodeCursor(cursor);
  if (!parsed) return null;
  const at = new Date(parsed.sortValue);
  if (Number.isNaN(at.getTime())) throw badCursor();
  return { at, id: parsed.id };
}

/**
 * Clamps a caller-supplied page size.
 *
 * The maximum is the point of this: without one, `?limit=100000` puts the unbounded query straight back,
 * which is the defect pagination was added to close rather than a way around it.
 */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

const badCursor = () =>
  new BadRequestException({ code: "INVALID_CURSOR", message: "That page cursor isn't valid. Try loading the list again." });
