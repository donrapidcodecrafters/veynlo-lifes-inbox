import { describe, expect, it } from "vitest";
import { parseVCard } from "./vcard";

/**
 * vCard parsing.
 *
 * The cases below are not invented — each is a real shape that real address books emit, and each one
 * breaks a naive `split(":")` parser in a different way. Line folding is the important one: a vCard line
 * over 75 octets is split with the continuation indented, and a parser that reads lines before unfolding
 * turns one long email address into two wrong values without erroring.
 */

const card = (...lines: string[]) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");

describe("parseVCard reads what address books actually send", () => {
  it("reads name, email, phone and organisation", () => {
    const parsed = parseVCard(
      card("FN:Dana Holloway", "EMAIL:dana@example.test", "TEL:+15555550100", "ORG:Northwind Traders"),
      "urn:test:1",
    );
    expect(parsed).toEqual({
      providerContactId: "urn:test:1",
      displayName: "Dana Holloway",
      emails: ["dana@example.test"],
      phones: ["+15555550100"],
      organizationName: "Northwind Traders",
      deleted: false,
    });
  });

  it("unfolds a folded line rather than splitting the value", () => {
    // RFC 6350 folding: a continuation begins with one space. Read naively, this address becomes
    // "a.very.long.address.that.needed" and "folding@example.test" — two values, both wrong.
    const folded = ["BEGIN:VCARD", "VERSION:3.0", "FN:Folded Person", "EMAIL:a.very.long.address.that.needed", " folding@example.test", "END:VCARD"].join("\r\n");
    const parsed = parseVCard(folded, "urn:test:2");
    expect(parsed?.emails).toEqual(["a.very.long.address.that.needed folding@example.test".replace(" ", "")]);
  });

  it("keeps the value when it contains its own colons", () => {
    // Splitting on every colon truncates this to "https".
    const parsed = parseVCard(card("FN:URL Person", "EMAIL:person@example.test", "URL:https://example.test/x:y"), "urn:test:3");
    expect(parsed?.emails).toEqual(["person@example.test"]);
    expect(parsed?.displayName).toBe("URL Person");
  });

  it("does not split inside a quoted parameter that contains a colon", () => {
    // This is what the quote tracking in the line parser exists for. A parameter value may be quoted and
    // may contain a colon; splitting on the first colon regardless yields the value "HOME\":work@...",
    // which is not an address and not detectable by eye in a log.
    //
    // Added after the falsifier showed the original colon test could not detect this: it used a URL
    // property, which this parser ignores entirely, so breaking the logic changed nothing it asserted.
    const parsed = parseVCard(card("FN:Quoted Param", "EMAIL;TYPE=\"WORK:HOME\":quoted@example.test"), "urn:test:17");
    expect(parsed?.emails).toEqual(["quoted@example.test"]);
  });

  it("ignores property parameters", () => {
    const parsed = parseVCard(
      card("FN:Param Person", "EMAIL;TYPE=work;PREF=1:work@example.test", "TEL;TYPE=CELL:+15555550111"),
      "urn:test:4",
    );
    expect(parsed?.emails).toEqual(["work@example.test"]);
    expect(parsed?.phones).toEqual(["+15555550111"]);
  });

  it("handles Apple's grouped properties", () => {
    // Apple Contacts writes "item1.EMAIL:..." with a matching "item1.X-ABLabel".
    const parsed = parseVCard(card("FN:Grouped Person", "item1.EMAIL:grouped@example.test", "item1.X-ABLabel:_$!<Home>!$_"), "urn:test:5");
    expect(parsed?.emails).toEqual(["grouped@example.test"]);
  });

  it("unescapes a comma inside an organisation name", () => {
    const parsed = parseVCard(card("FN:Escaped Person", "ORG:Smith\\, Jones & Co"), "urn:test:6");
    expect(parsed?.organizationName).toBe("Smith, Jones & Co");
  });

  it("takes only the company from a structured ORG", () => {
    // ORG is company;department;sub-department. The department is not the organisation's name.
    const parsed = parseVCard(card("FN:Dept Person", "ORG:Northwind Traders;Logistics;EMEA"), "urn:test:7");
    expect(parsed?.organizationName).toBe("Northwind Traders");
  });

  it("falls back to the structured name when FN is missing", () => {
    // N is Family;Given;Additional;Prefix;Suffix.
    const parsed = parseVCard(card("N:Okoro;Sam;;;", "EMAIL:sam@example.test"), "urn:test:8");
    expect(parsed?.displayName).toBe("Sam Okoro");
  });

  it("collects several emails and phones without duplicating them", () => {
    const parsed = parseVCard(
      card("FN:Many Person", "EMAIL:a@example.test", "EMAIL;TYPE=work:b@example.test", "EMAIL:a@example.test", "TEL:+1", "TEL:+1"),
      "urn:test:9",
    );
    expect(parsed?.emails).toEqual(["a@example.test", "b@example.test"]);
    expect(parsed?.phones).toEqual(["+1"]);
  });
});

describe("parseVCard refuses what it cannot use", () => {
  it("returns null for a card with no name and no way to reach anyone", () => {
    expect(parseVCard(card("NOTE:just a note"), "urn:test:10")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseVCard("", "urn:test:11")).toBeNull();
  });

  it("ignores an EMAIL value that is not an address", () => {
    // Some exports put a label in the email field. Storing it would create a bogus alias that
    // entity-resolution would then try to match people on.
    const parsed = parseVCard(card("FN:Bad Email", "EMAIL:not-an-address", "TEL:+15555550122"), "urn:test:12");
    expect(parsed?.emails).toEqual([]);
    expect(parsed?.phones).toEqual(["+15555550122"]);
  });

  it("refuses an oversized card instead of parsing it", () => {
    const huge = card("FN:Huge", `NOTE:${"x".repeat(300 * 1024)}`);
    expect(parseVCard(huge, "urn:test:13")).toBeNull();
  });

  it("clamps an absurdly long value rather than storing it", () => {
    const parsed = parseVCard(card(`FN:${"A".repeat(5000)}`), "urn:test:14");
    expect(parsed!.displayName.length).toBeLessThanOrEqual(512);
  });

  it("bounds how many values one card can contribute", () => {
    const emails = Array.from({ length: 100 }, (_, i) => `EMAIL:person${i}@example.test`);
    const parsed = parseVCard(card("FN:Many", ...emails), "urn:test:15");
    expect(parsed!.emails.length).toBeLessThanOrEqual(25);
  });

  it("survives a card that is not vCard at all", () => {
    expect(() => parseVCard("this is not a vcard", "urn:test:16")).not.toThrow();
  });
});
