/**
 * Shared between passkey.native.ts and passkey.web.ts — see the latter for why this is a separate file
 * (same reasoning as plaid-link.types.ts).
 *
 * `RegistrationOptionsJSON`/`AuthenticationOptionsJSON` mirror the exact JSON shape
 * `@simplewebauthn/server`'s `generateRegistrationOptions`/`generateAuthenticationOptions` return from
 * `POST /v1/auth/passkeys/registration-options` / `.../authentication-options` (the mobile app has no
 * dependency on `@simplewebauthn/server` itself — these are just the minimal fields this app's own code
 * touches, not a full re-implementation of the WebAuthn spec's type surface). `RegistrationResponseJSON`/
 * `AuthenticationResponseJSON` are the shapes `verifyRegistrationResponse`/`verifyAuthenticationResponse`
 * expect back via `.../registration-verify` / `.../authentication-verify` — matching web's `@simplewebauthn/
 * browser` output field-for-field so the API's verify endpoints don't need any platform-specific branching.
 */
export interface PasskeyCredentialDescriptorJSON {
  id: string;
  type: "public-key";
  transports?: string[];
}

export interface RegistrationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  excludeCredentials?: PasskeyCredentialDescriptorJSON[];
  authenticatorSelection?: { authenticatorAttachment?: string; residentKey?: string; requireResidentKey?: boolean; userVerification?: string };
  attestation?: string;
}

export interface AuthenticationOptionsJSON {
  challenge: string;
  rpId: string;
  timeout?: number;
  allowCredentials?: PasskeyCredentialDescriptorJSON[];
  userVerification?: string;
}

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
  clientExtensionResults?: Record<string, unknown>;
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults?: Record<string, unknown>;
}

export type PasskeyRegistrationResult = { status: "success"; response: RegistrationResponseJSON } | { status: "cancelled" } | { status: "error"; message: string };
export type PasskeyAuthenticationResult = { status: "success"; response: AuthenticationResponseJSON } | { status: "cancelled" } | { status: "error"; message: string };
