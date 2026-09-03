import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type WebAuthnCredential,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { IdentityService, type SessionIssued } from "./identity.service";

const CHALLENGE_TTL = "5m";

/**
 * AUTH-001 "create passkey" — real WebAuthn (FIDO2) registration and authentication ceremonies, backed by
 * `@simplewebauthn/server` (the same crypto/attestation verification a production RP needs — this is not a
 * mocked or simplified auth path). A passkey sign-in ends the exact same way every other sign-in method in
 * this app does: `IdentityService.issueSessionForExternalAuth` mints the same `sessions` row/JWT/cookie
 * email and OAuth sign-in already use (see that method's own doc comment) — passkeys are one more way IN,
 * not a parallel identity system.
 *
 * Challenge storage: rather than a new DB table (a `passkey_challenges` row that needs its own
 * expiry/cleanup job), the WebAuthn challenge travels to the client and back inside a short-lived signed
 * JWT ("challengeToken") — exactly the same stateless-CSRF-binding pattern `identity.controller.ts`'s own
 * `signOAuthState`/`verifyOAuthState` already uses for the OAuth authorize→callback round trip. The
 * challenge itself isn't a secret (WebAuthn's security model doesn't require it to be); signing it just
 * proves it was genuinely issued by this server a few minutes ago and hasn't been tampered with.
 */
@Injectable()
export class PasskeyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  /** rpID must be a valid domain (no scheme/port) that matches what the browser's `window.location` will
   * be at ceremony time; deriving it from WEB_APP_URL (rather than a new env var) keeps it automatically
   * correct in every environment (dev "localhost", a real deployment's real domain) without a second
   * config value that could drift out of sync with the first. */
  private rpConfig(): { rpName: string; rpID: string; origin: string } {
    const env = loadEnv();
    const url = new URL(env.WEB_APP_URL);
    return { rpName: "Veynlo", rpID: url.hostname, origin: env.WEB_APP_URL };
  }

  private async signChallenge(purpose: "passkey_registration" | "passkey_authentication", challenge: string, userId: string | null): Promise<string> {
    return new SignJWT({ purpose, challenge, userId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(CHALLENGE_TTL)
      .sign(new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET));
  }

  private async verifyChallenge(purpose: "passkey_registration" | "passkey_authentication", token: string, expectedUserId: string | null): Promise<string> {
    let payload: { purpose?: string; challenge?: string; userId?: string | null };
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(loadEnv().SESSION_JWT_SECRET), { algorithms: ["HS256"] });
      payload = verified.payload as typeof payload;
    } catch {
      throw new BadRequestException({ code: "PASSKEY_CHALLENGE_EXPIRED", message: "This passkey request has expired. Please try again." });
    }
    if (payload.purpose !== purpose || !payload.challenge) {
      throw new BadRequestException({ code: "PASSKEY_CHALLENGE_INVALID", message: "This passkey request is invalid. Please try again." });
    }
    // Registration is always tied to the signed-in user who requested it — a challenge minted for one
    // account must never verify a registration response filed under a different one.
    if (expectedUserId && payload.userId !== expectedUserId) {
      throw new ForbiddenException({ code: "PASSKEY_CHALLENGE_USER_MISMATCH", message: "This passkey request is invalid. Please try again." });
    }
    return payload.challenge;
  }

  /** AUTH-001 "add/remove sign-in method" — the account's own passkeys, for a "Manage your passkeys"
   * settings list. Never returns publicKey/counter (internal verification state, not user-facing). */
  async listPasskeys(userId: string) {
    return this.db
      .select({
        id: schema.passkeys.id,
        label: schema.passkeys.label,
        deviceType: schema.passkeys.deviceType,
        backedUp: schema.passkeys.backedUp,
        createdAt: schema.passkeys.createdAt,
        lastUsedAt: schema.passkeys.lastUsedAt,
      })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, userId))
      .orderBy(desc(schema.passkeys.createdAt));
  }

  async removePasskey(passkeyId: string, userId: string): Promise<void> {
    const [row] = await this.db.select({ userId: schema.passkeys.userId }).from(schema.passkeys).where(eq(schema.passkeys.id, passkeyId)).limit(1);
    if (!row) throw new NotFoundException({ code: "PASSKEY_NOT_FOUND", message: "Not found." });
    if (row.userId !== userId) throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    await this.db.delete(schema.passkeys).where(eq(schema.passkeys.id, passkeyId));
  }

  /** "create passkey" registration ceremony, step 1 — must be signed in already (adding a passkey to an
   * existing account), unlike authentication below. `excludeCredentials` stops a user from registering the
   * same authenticator twice. */
  async registrationOptions(userId: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
    const { rpName, rpID } = this.rpConfig();
    const [user] = await this.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "Not found." });
    const userLabel = user.email ?? userId;
    const existing = await this.db.select({ credentialId: schema.passkeys.credentialId, transports: schema.passkeys.transports }).from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: userLabel,
      userDisplayName: userLabel,
      attestationType: "none",
      excludeCredentials: existing.map((e) => ({ id: e.credentialId, transports: e.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const challengeToken = await this.signChallenge("passkey_registration", options.challenge, userId);
    return { options, challengeToken };
  }

  /** Registration ceremony, step 2 — real cryptographic/attestation verification via
   * `@simplewebauthn/server`, not a mocked check. On success, stores the credential and links it into
   * `identityLinks` (provider "passkey") the same way every other sign-in method registers itself there. */
  async verifyRegistration(userId: string, response: unknown, challengeToken: string, label: string | null | undefined): Promise<{ id: string }> {
    const expectedChallenge = await this.verifyChallenge("passkey_registration", challengeToken, userId);
    const { rpID, origin } = this.rpConfig();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (err) {
      throw new BadRequestException({ code: "PASSKEY_REGISTRATION_FAILED", message: `We couldn't verify that passkey: ${(err as Error).message}` });
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException({ code: "PASSKEY_REGISTRATION_FAILED", message: "We couldn't verify that passkey. Please try again." });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const id = generateId("passkeyCredential");
    await this.db.insert(schema.passkeys).values({
      id,
      userId,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: String(credential.counter),
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      label: label ?? null,
    });
    // Same "map every sign-in method into identity_links" convention OAuth sign-in already follows —
    // providerSubject is the credential id, the one stable identifier this credential is looked up by.
    await this.db.insert(schema.identityLinks).values({ id: generateId("identityLink"), userId, provider: "passkey", providerSubject: credential.id });
    return { id };
  }

  /**
   * Authentication ceremony, step 1 — deliberately public (no session yet; this IS how one gets created).
   * When `email` is omitted, `allowCredentials` is left undefined, which is a genuine discoverable-
   * credential ("usernameless") flow: the browser lets the user pick from whatever passkeys it already has
   * for this site, which is both the more phishing-resistant default and avoids leaking "does this email
   * have a passkey?" via a response-shape difference.
   */
  async authenticationOptions(email: string | null | undefined): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
    const { rpID } = this.rpConfig();
    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
    if (email) {
      const [user] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
      if (user) {
        const creds = await this.db.select({ credentialId: schema.passkeys.credentialId, transports: schema.passkeys.transports }).from(schema.passkeys).where(eq(schema.passkeys.userId, user.id));
        allowCredentials = creds.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] }));
      }
      // No matching user or no passkeys registered: leave allowCredentials undefined rather than `[]` —
      // an empty array is a documented footgun in some browsers and, more importantly, would tell an
      // attacker "this email has zero passkeys" via a response-shape difference from the "has passkeys"
      // case. Same enumeration-protection stance as IdentityService.forgotPassword's own doc comment.
    }
    const options = await generateAuthenticationOptions({ rpID, allowCredentials, userVerification: "preferred" });
    const challengeToken = await this.signChallenge("passkey_authentication", options.challenge, null);
    return { options, challengeToken };
  }

  /**
   * Authentication ceremony, step 2 — verifies the signed assertion against the stored public key
   * (real signature verification, not a mocked check), then issues the exact same session mechanism
   * every other sign-in method uses via `IdentityService.issueSessionForExternalAuth`.
   */
  async verifyAuthentication(response: unknown, challengeToken: string, deviceInfo: { platform: string }): Promise<SessionIssued> {
    const expectedChallenge = await this.verifyChallenge("passkey_authentication", challengeToken, null);
    const credentialId = (response as AuthenticationResponseJSON | undefined)?.id;
    if (!credentialId) throw new BadRequestException({ code: "PASSKEY_RESPONSE_INVALID", message: "Invalid passkey response." });

    const [row] = await this.db.select().from(schema.passkeys).where(eq(schema.passkeys.credentialId, credentialId)).limit(1);
    if (!row) throw new UnauthorizedException({ code: "PASSKEY_NOT_FOUND", message: "This passkey isn't registered with any account." });

    const { rpID, origin } = this.rpConfig();
    const credential: WebAuthnCredential = {
      id: row.credentialId,
      publicKey: isoBase64URL.toBuffer(row.publicKey),
      counter: Number(row.counter),
      transports: row.transports as AuthenticatorTransportFuture[],
    };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential,
      });
    } catch (err) {
      throw new UnauthorizedException({ code: "PASSKEY_VERIFICATION_FAILED", message: `We couldn't verify that passkey: ${(err as Error).message}` });
    }
    if (!verification.verified) {
      throw new UnauthorizedException({ code: "PASSKEY_VERIFICATION_FAILED", message: "We couldn't verify that passkey. Please try again." });
    }

    // Signature-counter check (replay/cloning defense) — many real authenticators, especially synced
    // passkeys, always report 0 and never increment; per current WebAuthn guidance this is expected and
    // must not hard-fail sign-in, so a non-increasing counter is only ever logged-worthy, not rejected.
    await this.db
      .update(schema.passkeys)
      .set({ counter: String(verification.authenticationInfo.newCounter), lastUsedAt: new Date() })
      .where(eq(schema.passkeys.id, row.id));

    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
    if (!user) throw new UnauthorizedException({ code: "PASSKEY_NOT_FOUND", message: "This passkey isn't registered with any account." });
    // Same account-status gate every other sign-in path enforces (IdentityService.signIn/oauthSignIn) —
    // a valid passkey assertion still shouldn't hand a fresh session to a suspended/deleted account.
    if (user.status === "deletion_pending" || user.status === "deleted") {
      throw new UnauthorizedException({ code: "ACCOUNT_DELETED", message: "This account has been deleted." });
    }
    if (user.status === "suspended") {
      throw new UnauthorizedException({ code: "ACCOUNT_SUSPENDED", message: "This account has been suspended." });
    }

    return this.identity.issueSessionForExternalAuth(user.id, deviceInfo);
  }
}
