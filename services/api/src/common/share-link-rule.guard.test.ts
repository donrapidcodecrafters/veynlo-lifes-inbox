import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The rule about which sensitivity tiers may have an unauthenticated public link lives in exactly one
 * place: `canCreateShareLink` in @veynlo/core (Appendix C). It has been consolidated twice now and both
 * times a copy survived.
 *
 * The first pass moved DocumentsService onto the shared rule and its test comment recorded that the other
 * domains had "restated it … or hardcoded a blanket refusal … All three were correct". Two were missed
 * entirely: `AssetsService.assertPublicLinkAllowed` and `PetsService.assertPublicLinkAllowed` each carried
 * their own `sensitivity === "highly_sensitive" || sensitivity === "secret"`. They agreed with the rule,
 * which is precisely why nothing surfaced them — a duplicated rule is invisible until the day it disagrees.
 *
 * So this is a build-failing guard rather than another round of fixing copies. A comparison against a
 * restricted tier name, anywhere outside the canonical rule and this file, fails here.
 *
 * Blanket refusals (health-logistics, identity-records) are unaffected: they never name a tier, they
 * refuse unconditionally, which is a different and legitimate answer.
 */
const RESTRICTED_TIER_COMPARISON = /(?:===|!==|==)\s*["'`](?:highly_sensitive|secret)["'`]|["'`](?:highly_sensitive|secret)["'`]\s*(?:===|!==|==)/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

describe("the share-link sensitivity rule has exactly one implementation", () => {
  it("no service compares a sensitivity value against a restricted tier by hand", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, "..", "modules"))) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        // Comments explaining the rule are fine and encouraged; code deciding it is not.
        const withoutComment = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (RESTRICTED_TIER_COMPARISON.test(withoutComment)) {
          offenders.push(`${file.split(String.fromCharCode(92)).join("/").split("/src/")[1]}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(
      offenders,
      `These decide the public-link rule themselves instead of asking canCreateShareLink().\n` +
        `A copy that agrees today is the problem — it will not follow when the rule changes.\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
