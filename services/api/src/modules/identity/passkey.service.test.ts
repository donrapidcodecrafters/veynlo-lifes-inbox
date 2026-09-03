import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PasskeyService } from "./passkey.service";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * AUTH-001 "create passkey" / "Sign in with a passkey" — real integration tests against real Postgres for
 * PasskeyService, covering everything EXCEPT the WebAuthn ceremony's own cryptographic/attestation
 * verification, which genuinely requires a real authenticator (a physical security key, a platform
 * authenticator behind a real browser's Face-ID/Touch-ID prompt, or a Chrome DevTools Protocol virtual
 * authenticator — none of which a plain Vitest process can drive). That verification WAS exercised for
 * real, end to end, via Playwright's CDP `WebAuthn.addVirtualAuthenticator` against a live dev server: a
 * real credential was registered through the actual "Add a passkey" UI and a real sign-in was completed
 * through the actual "Sign in with a passkey" UI, both against `@simplewebauthn/server`'s genuine
 * `verifyRegistrationResponse`/`verifyAuthenticationResponse` crypto path (see
 * docs/PHASE2_PENDING_CREDENTIALS.md's AUTH-001 entry).
 *
 * Here, `verifyRegistrationResponse`/`verifyAuthenticationResponse` are mocked (real DB, real challenge-
 * JWT signing/verification, real session issuance — only the one step that needs physical/virtual hardware
 * is stubbed) to test everything PasskeyService itself is responsible for: challenge binding (a challenge
 * minted for user A must reject a registration response submitted as user B), credential persistence,
 * identity_links bookkeeping, counter/lastUsedAt updates, unknown-credential rejection, and — importantly —
 * that a verified passkey assertion issues the exact same session mechanism (a real `sessions` row via
 * `IdentityService.issueSessionForExternalAuth`) every other sign-in method uses.
 */
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  };
});

import { verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

function fakePublicKey(): Uint8Array {
  const bytes = new Uint8Array(65);
  crypto.getRandomValues(bytes);
  return bytes;
}

describe("PasskeyService — AUTH-001", () => {
  let db: Database;
  let passkeys: PasskeyService;
  let identity: IdentityService;
  let userId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    passkeys = new PasskeyService(db, identity);
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `passkey-test-${userId}@example.com`, displayName: "Passkey Test User" });
      otherUserId = generateId("user");
      await db.insert(schema.users).values({ id: otherUserId, email: `passkey-test-other-${otherUserId}@example.com`, displayName: "Passkey Test Other" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PasskeyService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.passkeys).where(eq(schema.passkeys.userId, userId));
    await db.delete(schema.identityLinks).where(eq(schema.identityLinks.userId, userId));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await db.delete(schema.devices).where(eq(schema.devices.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it("registrationOptions returns a real challenge bound to the requesting user, and rejects verification under a different user's identity", async () => {
    if (!dbAvailable) return;
    const { options, challengeToken } = await passkeys.registrationOptions(userId);
    expect(options.challenge).toBeTruthy();
    expect(options.rp.name).toBe("Veynlo");

    // A challenge minted for `userId` must never verify a registration response submitted as `otherUserId`
    // — this is enforced entirely by PasskeyService's own challenge-JWT check, before verifyRegistrationResponse
    // (mocked here) is ever consulted.
    await expect(passkeys.verifyRegistration(otherUserId, {}, challengeToken, null)).rejects.toMatchObject({
      response: { code: "PASSKEY_CHALLENGE_USER_MISMATCH" },
    });
  });

  it("verifyRegistration persists a real passkeys row + identity_links row on a verified response", async () => {
    if (!dbAvailable) return;
    const { challengeToken } = await passkeys.registrationOptions(userId);
    const publicKey = fakePublicKey();
    const credentialId = `cred-${generateId("passkeyCredential")}`;

    (verifyRegistrationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: credentialId, publicKey, counter: 0, transports: ["internal"] },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });

    const result = await passkeys.verifyRegistration(userId, { fake: "response" }, challengeToken, "Test Device");
    expect(result.id).toBeTruthy();

    const [row] = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, result.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBe(userId);
    expect(row?.credentialId).toBe(credentialId);
    expect(row?.counter).toBe("0");
    expect(row?.deviceType).toBe("singleDevice");
    expect(row?.backedUp).toBe(false);
    expect(row?.label).toBe("Test Device");

    const [link] = await db
      .select()
      .from(schema.identityLinks)
      .where(eq(schema.identityLinks.providerSubject, credentialId));
    expect(link?.userId).toBe(userId);
    expect(link?.provider).toBe("passkey");
  });

  it("verifyRegistration rejects and does not persist anything when the ceremony fails verification", async () => {
    if (!dbAvailable) return;
    const { challengeToken } = await passkeys.registrationOptions(userId);
    (verifyRegistrationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ verified: false });

    const beforeCount = (await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId))).length;
    await expect(passkeys.verifyRegistration(userId, {}, challengeToken, null)).rejects.toMatchObject({
      response: { code: "PASSKEY_REGISTRATION_FAILED" },
    });
    const afterCount = (await db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId))).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("verifyAuthentication rejects an unknown credentialId (never registered)", async () => {
    if (!dbAvailable) return;
    const { challengeToken } = await passkeys.authenticationOptions(null);
    await expect(passkeys.verifyAuthentication({ id: "totally-unknown-credential-id" }, challengeToken, { platform: "web" })).rejects.toMatchObject({
      response: { code: "PASSKEY_NOT_FOUND" },
    });
  });

  it("verifyAuthentication, on a verified assertion, updates the counter/lastUsedAt and issues a real session via the SAME mechanism as every other sign-in method", async () => {
    if (!dbAvailable) return;
    // Register a credential first (mocked verification, real persistence — same as the test above).
    const regChallenge = await passkeys.registrationOptions(userId);
    const publicKey = fakePublicKey();
    const credentialId = `cred-auth-${generateId("passkeyCredential")}`;
    (verifyRegistrationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: credentialId, publicKey, counter: 0, transports: ["internal"] }, credentialDeviceType: "multiDevice", credentialBackedUp: true },
    });
    await passkeys.verifyRegistration(userId, {}, regChallenge.challengeToken, "Auth Test Device");

    const { challengeToken } = await passkeys.authenticationOptions(null);
    (verifyAuthenticationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 7, credentialDeviceType: "multiDevice", credentialBackedUp: true },
    });

    const session = await passkeys.verifyAuthentication({ id: credentialId }, challengeToken, { platform: "web" });
    expect(session.token).toBeTruthy();
    expect(session.userId).toBe(userId);

    // Real sessions row, exactly the mechanism IdentityService.signIn/oauthSignIn use.
    const [sessionRow] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId)).orderBy(schema.sessions.createdAt);
    expect(sessionRow).toBeDefined();

    const [credRow] = await db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, credentialId));
    expect(credRow?.counter).toBe("7");
    expect(credRow?.lastUsedAt).not.toBeNull();
  });

  it("verifyAuthentication rejects a suspended account even with a valid assertion", async () => {
    if (!dbAvailable) return;
    const suspendedUserId = generateId("user");
    await db.insert(schema.users).values({ id: suspendedUserId, email: `passkey-suspended-${suspendedUserId}@example.com`, displayName: "Suspended", status: "suspended" });
    const regChallenge = await passkeys.registrationOptions(suspendedUserId);
    const publicKey = fakePublicKey();
    const credentialId = `cred-suspended-${generateId("passkeyCredential")}`;
    (verifyRegistrationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: credentialId, publicKey, counter: 0, transports: [] }, credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    await passkeys.verifyRegistration(suspendedUserId, {}, regChallenge.challengeToken, null);

    const { challengeToken } = await passkeys.authenticationOptions(null);
    (verifyAuthenticationResponse as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 1, credentialDeviceType: "singleDevice", credentialBackedUp: false },
    });
    await expect(passkeys.verifyAuthentication({ id: credentialId }, challengeToken, { platform: "web" })).rejects.toMatchObject({
      response: { code: "ACCOUNT_SUSPENDED" },
    });

    await db.delete(schema.passkeys).where(eq(schema.passkeys.userId, suspendedUserId));
    await db.delete(schema.identityLinks).where(eq(schema.identityLinks.userId, suspendedUserId));
    await db.delete(schema.users).where(eq(schema.users.id, suspendedUserId));
  });

  it("listPasskeys/removePasskey: lists only the caller's own passkeys and rejects removing someone else's", async () => {
    if (!dbAvailable) return;
    const list = await passkeys.listPasskeys(userId);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => "publicKey" in p === false)).toBe(true); // never leaks the raw public key/counter

    const [somePasskey] = list;
    await expect(passkeys.removePasskey(somePasskey!.id, otherUserId)).rejects.toMatchObject({ response: { code: "NOT_AUTHORIZED" } });
    await expect(passkeys.removePasskey("pky_does_not_exist", userId)).rejects.toMatchObject({ response: { code: "PASSKEY_NOT_FOUND" } });

    await passkeys.removePasskey(somePasskey!.id, userId);
    const afterRemoval = await db.select().from(schema.passkeys).where(eq(schema.passkeys.id, somePasskey!.id));
    expect(afterRemoval).toHaveLength(0);
  });
});
