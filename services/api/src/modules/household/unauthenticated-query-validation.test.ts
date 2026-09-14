import { describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { HouseholdController } from "./household.controller";
import type { HouseholdService } from "./household.service";
import { WidgetDeepLinkController } from "../widgets/widgets.controller";

/**
 * Regression cover for the "unauthenticated endpoint answers 500" defect class.
 *
 * Three routes in this app are deliberately reachable with no session, because the caller genuinely has no
 * account yet and a token in the query string IS the credential:
 *
 *   GET /v1/households/invite
 *   GET /v1/households/dependent-transition-invite
 *   GET /v1/widgets/resolve
 *
 * All three took their token straight off `@Query("token")`. The shared ZodValidationPipe deliberately
 * ignores anything whose `metadata.type` isn't "body", so the param arrived as `undefined` when omitted —
 * and omitting it is the most obvious way anyone probes an unguarded route. The handlers then reached
 * `hashOpaqueToken(undefined)` / a bare `.parse()`, and Nest maps neither a raw TypeError nor a raw
 * ZodError to a status, so an ANONYMOUS caller got a 500.
 *
 * `/v1/widgets/resolve` was found first (DEF-012) and fixed without a test. The other two were found by
 * calling all 560 live routes unauthenticated during the R3 sweep — the same defect, in code written the
 * same way, six weeks apart. This test exists so the third instance is caught by the suite rather than by
 * another sweep.
 *
 * The controllers are exercised directly rather than over HTTP: this suite has no Nest bootstrap harness,
 * and the thing that regresses is the handler signature — someone reverting `@Query()` back to
 * `@Query("token") token: string` and dropping the safeParse. A direct call catches exactly that, and the
 * live 400s were confirmed with curl against a running API besides.
 */
describe("unauthenticated token endpoints reject a missing query param with 400, not 500", () => {
  // Throws if reached: a validation failure must be decided BEFORE any service call. If the guard is ever
  // removed, the handler falls through to here and the test fails loudly instead of silently passing on a
  // service that happens to tolerate undefined.
  const serviceMustNotBeCalled = {
    getInviteByToken: () => {
      throw new Error("service was called — validation did not run first");
    },
    getDependentTransitionInviteByToken: () => {
      throw new Error("service was called — validation did not run first");
    },
  } as unknown as HouseholdService;

  const households = new HouseholdController(serviceMustNotBeCalled);
  const widgets = new WidgetDeepLinkController();

  const cases: Array<[string, (q: unknown) => unknown]> = [
    ["GET /v1/households/invite", (q) => households.peekInvite(q)],
    ["GET /v1/households/dependent-transition-invite", (q) => households.peekDependentTransitionInvite(q)],
    ["GET /v1/widgets/resolve", (q) => widgets.resolveDeepLink(q)],
  ];

  for (const [route, call] of cases) {
    it(`${route} — no token at all`, () => {
      // `{}` is what Nest hands the handler for a request with no query string.
      expect(() => call({})).toThrow(BadRequestException);
    });

    it(`${route} — empty token`, () => {
      expect(() => call({ token: "" })).toThrow(BadRequestException);
    });

    it(`${route} — token of the wrong type`, () => {
      // Query values are strings, but an array arrives for a repeated param (?token=a&token=b).
      expect(() => call({ token: ["a", "b"] })).toThrow(BadRequestException);
    });

    it(`${route} — reports the failure as VALIDATION_FAILED, matching ZodValidationPipe's shape`, () => {
      try {
        call({});
        expect.unreachable("expected a BadRequestException");
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
      }
    });
  }

  it("a well-formed token is passed through to the service rather than rejected", async () => {
    // Guards against over-correcting into rejecting everything: only the malformed cases must throw.
    const calls: string[] = [];
    const recording = {
      getInviteByToken: (token: string) => {
        calls.push(token);
        return null;
      },
    } as unknown as HouseholdService;
    // Awaited: unawaited, this asserted only that the synchronous part ran, and an async rejection from
    // peekInvite would have surfaced as an unhandled rejection rather than a failing test — the assertion
    // below would still have passed, because `calls` is pushed to before the promise settles.
    await new HouseholdController(recording).peekInvite({ token: "a-real-looking-opaque-token" });
    expect(calls).toEqual(["a-real-looking-opaque-token"]);
  });
});
