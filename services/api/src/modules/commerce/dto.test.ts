import { describe, expect, it } from "vitest";
import { ResaleStatusSchema, UpdatePurchaseLineDtoSchema } from "./dto";

/**
 * RET-006 "Resale handoff" — `resaleStatus`'s only real invariant is "one of the three known enum values."
 * There is deliberately no state-machine validation on top of that (e.g. rejecting `sold` -> `listed`): a
 * user un-listing something they'd marked sold, or reverting a listing by mistake, is a legitimate manual
 * correction — the same permissive shape `serialNumber`/`giftFlag` already have on this same DTO, and the
 * same reasoning `resaleStatus`'s own schema-file doc comment gives for keeping this a plain patch rather
 * than a dedicated transition endpoint. This suite locks in both halves of that decision: garbage values
 * are rejected by the enum itself (the one thing that actually needs enforcing), and "backwards" transitions
 * are allowed on purpose (not an oversight).
 */
describe("ResaleStatusSchema / UpdatePurchaseLineDtoSchema", () => {
  it("accepts each of the three known resale states", () => {
    expect(ResaleStatusSchema.parse("not_listed")).toBe("not_listed");
    expect(ResaleStatusSchema.parse("listed")).toBe("listed");
    expect(ResaleStatusSchema.parse("sold")).toBe("sold");
  });

  it("rejects a nonsense resale status rather than silently accepting any string", () => {
    expect(() => ResaleStatusSchema.parse("pending_sale")).toThrow();
    expect(() => ResaleStatusSchema.parse("")).toThrow();
    expect(() => ResaleStatusSchema.parse("NOT_LISTED")).toThrow(); // case-sensitive, no normalization
    expect(() => UpdatePurchaseLineDtoSchema.parse({ resaleStatus: "garbage" })).toThrow();
  });

  it("allows every transition between valid states, including 'backwards' ones — a deliberate choice, not a gap", () => {
    // sold -> listed (un-listing after marking sold), listed -> not_listed (canceling a listing), etc. are
    // all legitimate manual corrections; the schema has no memory of the row's current state to validate
    // against, matching every other manual-correction field on this DTO.
    expect(UpdatePurchaseLineDtoSchema.parse({ resaleStatus: "sold" })).toEqual({ resaleStatus: "sold" });
    expect(UpdatePurchaseLineDtoSchema.parse({ resaleStatus: "listed" })).toEqual({ resaleStatus: "listed" });
    expect(UpdatePurchaseLineDtoSchema.parse({ resaleStatus: "not_listed" })).toEqual({ resaleStatus: "not_listed" });
  });

  it("resaleStatus stays optional so a serialNumber/giftFlag-only patch doesn't need to restate it", () => {
    expect(UpdatePurchaseLineDtoSchema.parse({ giftFlag: true })).toEqual({ giftFlag: true });
  });
});
