import { describe, expect, it } from "vitest";
import { flattenExpected, getAtPath, valuesMatch, scoreCase } from "./score";

describe("flattenExpected", () => {
  it("flattens nested objects to dot-paths", () => {
    expect(flattenExpected({ a: { b: 1, c: 2 } })).toEqual([
      ["a.b", 1],
      ["a.c", 2],
    ]);
  });

  it("flattens arrays to index-based dot-paths", () => {
    expect(flattenExpected({ items: [{ x: 1 }, { x: 2 }] })).toEqual([
      ["items.0.x", 1],
      ["items.1.x", 2],
    ]);
  });

  it("treats null as its own leaf rather than descending into it", () => {
    expect(flattenExpected({ returnDeadline: null })).toEqual([["returnDeadline", null]]);
  });

  it("treats an empty array/object as its own leaf", () => {
    expect(flattenExpected({ tags: [] })).toEqual([["tags", []]]);
  });
});

describe("getAtPath", () => {
  const actual = { purchaseDate: { iso_date: "2026-03-04", approximate_text: null }, lineItems: [{ quantity: 2 }] };

  it("reads a nested path", () => {
    expect(getAtPath(actual, "purchaseDate.iso_date")).toBe("2026-03-04");
  });

  it("reads an array-index path", () => {
    expect(getAtPath(actual, "lineItems.0.quantity")).toBe(2);
  });

  it("returns undefined for a missing path rather than throwing", () => {
    expect(getAtPath(actual, "lineItems.5.quantity")).toBeUndefined();
    expect(getAtPath(actual, "nonexistent.field")).toBeUndefined();
  });
});

describe("valuesMatch", () => {
  it("requires exact equality for numbers", () => {
    expect(valuesMatch(4599, 4599)).toBe(true);
    expect(valuesMatch(4599, 4600)).toBe(false);
  });

  it("requires exact equality for booleans and null", () => {
    expect(valuesMatch(true, true)).toBe(true);
    expect(valuesMatch(true, false)).toBe(false);
    expect(valuesMatch(null, null)).toBe(true);
    expect(valuesMatch(null, "something")).toBe(false);
  });

  it("matches strings case-insensitively and tolerates minor wording differences", () => {
    expect(valuesMatch("Northwind Outfitters", "northwind outfitters")).toBe(true);
    expect(valuesMatch("StreamVerse", "Your StreamVerse Standard plan")).toBe(true);
  });

  it("rejects a genuinely wrong string value", () => {
    expect(valuesMatch("Northwind Outfitters", "Riverside Hardware")).toBe(false);
  });

  it("rejects a string compared against a non-string", () => {
    expect(valuesMatch("129.00", 129)).toBe(false);
  });
});

describe("scoreCase", () => {
  it("passes when every expected field matches", () => {
    const result = scoreCase("case_1", "receipt", { merchantName: "Northwind Outfitters", totalAmountMinorUnits: 13932 }, { merchantName: "Northwind Outfitters", totalAmountMinorUnits: 13932 });
    expect(result.pass).toBe(true);
    expect(result.fields).toHaveLength(2);
  });

  it("fails when any expected field mismatches, and reports which one", () => {
    const result = scoreCase("case_2", "receipt", { merchantName: "Northwind Outfitters", totalAmountMinorUnits: 13932 }, { merchantName: "Northwind Outfitters", totalAmountMinorUnits: 9999 });
    expect(result.pass).toBe(false);
    const failedField = result.fields.find((f) => !f.pass);
    expect(failedField?.field).toBe("totalAmountMinorUnits");
    expect(failedField?.expected).toBe(13932);
    expect(failedField?.actual).toBe(9999);
  });

  it("fails when an expected nested-date field is missing from the actual output entirely", () => {
    const result = scoreCase("case_3", "bill", { dueDate: { iso_date: "2026-05-15", approximate_text: null } }, {});
    expect(result.pass).toBe(false);
    expect(result.fields.some((f) => f.field === "dueDate.iso_date" && !f.pass)).toBe(true);
  });
});
