import { describe, expect, it } from "vitest";
import { addMoney, formatMoney, money, subtractMoney } from "./money";

describe("money", () => {
  it("represents amounts as integer minor units, never floats", () => {
    expect(money(19.99).minorUnits).toBe(1999);
    expect(Number.isInteger(money(19.99).minorUnits)).toBe(true);
  });

  it("adds only matching currencies", () => {
    expect(addMoney(money(10), money(5)).minorUnits).toBe(1500);
    expect(() => addMoney(money(10, "USD"), money(5, "EUR"))).toThrow(/mismatched currencies/);
  });

  it("subtracts only matching currencies", () => {
    expect(subtractMoney(money(10), money(3)).minorUnits).toBe(700);
    expect(() => subtractMoney(money(10, "USD"), money(3, "GBP"))).toThrow(/mismatched currencies/);
  });

  it("formats using the currency's locale symbol", () => {
    expect(formatMoney(money(1299.5, "USD"))).toBe("$1,299.50");
  });
});
