import { describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { IdentityController } from "./identity.controller";
import type { IdentityService } from "./identity.service";
import type { AuthenticatedUser } from "../../common/auth.guard";

/**
 * Regression cover for "revoking a session reported success when nothing was revoked".
 *
 * `POST /v1/auth/sessions/:sessionId/revoke` is the sign-my-lost-phone-out control. Its scoping was always
 * correct — `revokeSessionById` filters on `userId = requestingUserId`, so one user physically cannot
 * revoke another's session, and a live cross-account attempt confirmed the victim's session survived. The
 * defect was that the controller discarded the outcome and always returned `{ success: true }`, so a
 * request matching NOTHING was indistinguishable from one that killed a device.
 *
 * That matters here more than on a typical endpoint: telling someone their lost phone is signed out when
 * it is not is a safety claim, not a cosmetic one. The web and mobile Security screens already had a
 * `catch` branch showing "Couldn't sign out that device" — it simply could never fire.
 *
 * The controller is exercised directly; what regresses is the controller ignoring the boolean, and a stub
 * service pins exactly that without needing a database or a Nest bootstrap.
 */
describe("POST /v1/auth/sessions/:id/revoke", () => {
  const user = { userId: "usr_caller", sessionId: "ses_current" } as AuthenticatedUser;

  function controllerWhereRevokeReturns(revoked: boolean) {
    const calls: Array<{ sessionId: string; userId: string }> = [];
    const service = {
      revokeSessionById: async (sessionId: string, userId: string) => {
        calls.push({ sessionId, userId });
        return revoked;
      },
    } as unknown as IdentityService;
    return { controller: new IdentityController(service), calls };
  }

  it("reports success when a session was actually revoked", async () => {
    const { controller } = controllerWhereRevokeReturns(true);
    await expect(controller.revokeSession(user, "ses_other_device")).resolves.toEqual({ success: true });
  });

  it("throws 404 when nothing was revoked, instead of claiming success", async () => {
    const { controller } = controllerWhereRevokeReturns(false);
    await expect(controller.revokeSession(user, "ses_not_mine")).rejects.toThrow(NotFoundException);
  });

  it("does not distinguish 'no such session' from 'not yours' — no cross-account existence oracle", async () => {
    // Both cases reach revokeSessionById and come back false, and both must surface identically. A 403 for
    // "exists but belongs to someone else" would confirm to one account that another's session id is real.
    const { controller } = controllerWhereRevokeReturns(false);
    let thrown: unknown;
    try {
      await controller.revokeSession(user, "ses_belonging_to_someone_else");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getResponse()).toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("always scopes the revoke to the CALLING user, never to a caller-supplied id", async () => {
    // The security property itself: the service is handed the authenticated user's id, so its WHERE clause
    // can never match another account's row regardless of what session id was passed in.
    const { controller, calls } = controllerWhereRevokeReturns(true);
    await controller.revokeSession(user, "ses_target");
    expect(calls).toEqual([{ sessionId: "ses_target", userId: "usr_caller" }]);
  });
});
