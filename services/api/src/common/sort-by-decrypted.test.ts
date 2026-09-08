import { describe, expect, it } from "vitest";
import { byDecryptedText } from "./sort-by-decrypted";

/**
 * These columns are encrypted at rest with a fresh random IV per write, so SQL `ORDER BY label` sorted
 * ciphertext: measured against the seeded database, pets came back `Biscuit | Marmalade | Biscuit` with the
 * two Biscuits at opposite ends. The comparator has to put the list in the order the user actually reads,
 * and hold that order across writes.
 */
describe("byDecryptedText", () => {
  const sort = <T extends { label: string | null; id: string }>(rows: T[]) =>
    [...rows].sort(byDecryptedText((r) => r.label, (r) => r.id));

  it("orders by the text the user sees, not the order the rows arrived in", () => {
    const rows = [
      { label: "Marmalade", id: "pet_2" },
      { label: "Biscuit", id: "pet_1" },
      { label: "Alfie", id: "pet_3" },
    ];
    expect(sort(rows).map((r) => r.label)).toEqual(["Alfie", "Biscuit", "Marmalade"]);
  });

  it("keeps two rows with the SAME label adjacent and in a stable order", () => {
    // The real case: a household with two pets both called Biscuit. Under ciphertext ordering they landed
    // at opposite ends of the list.
    const rows = [
      { label: "Biscuit", id: "pet_zzz" },
      { label: "Marmalade", id: "pet_mmm" },
      { label: "Biscuit", id: "pet_aaa" },
    ];
    expect(sort(rows).map((r) => `${r.label}:${r.id}`)).toEqual(["Biscuit:pet_aaa", "Biscuit:pet_zzz", "Marmalade:pet_mmm"]);
  });

  it("gives the same order regardless of the order the database returned the rows in", () => {
    // A fresh random IV per write means the SQL order is a new permutation after any edit. The sorted
    // result must not depend on it.
    const base = [
      { label: "The Subaru", id: "veh_3" },
      { label: "Jordan's Civic", id: "veh_1" },
      { label: "Subaru Outback", id: "veh_2" },
    ];
    const shuffles = [base, [base[2], base[0], base[1]], [base[1], base[2], base[0]], [...base].reverse()];
    const orders = shuffles.map((rows) => sort(rows).map((r) => r.id).join(","));
    expect(new Set(orders).size).toBe(1);
    expect(orders[0]).toBe("veh_1,veh_2,veh_3"); // Jordan's Civic, Subaru Outback, The Subaru
  });

  it("sorts case-insensitively, so casing does not split a name away from its neighbours", () => {
    const rows = [
      { label: "the subaru", id: "b" },
      { label: "Alfie", id: "a" },
      { label: "The Subaru", id: "c" },
    ];
    expect(sort(rows).map((r) => r.label)).toEqual(["Alfie", "the subaru", "The Subaru"]);
  });

  it("does not throw on a null label (nullable encrypted columns exist) and sorts it first", () => {
    const rows = [
      { label: "Alfie", id: "a" },
      { label: null, id: "b" },
    ];
    expect(sort(rows).map((r) => r.id)).toEqual(["b", "a"]);
  });
});
