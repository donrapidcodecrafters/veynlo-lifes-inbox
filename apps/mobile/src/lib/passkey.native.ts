import { Passkey } from "react-native-passkey";
import type {
  RegistrationOptionsJSON,
  AuthenticationOptionsJSON,
  PasskeyRegistrationResult,
  PasskeyAuthenticationResult,
} from "./passkey.types";

/**
 * Native (iOS/Android) implementation, backed by the real `react-native-passkey` — see `passkey.web.ts`
 * for why this file is split from that one rather than gated with a runtime `Platform.OS` check inside a
 * single module (same reasoning `plaid-link.native.ts`/`plaid-link.web.ts` already established this
 * session for `react-native-plaid-link-sdk`).
 *
 * `react-native-passkey`'s own request/response types (`PasskeyCreateRequest`/`PasskeyCreateResult`,
 * `PasskeyGetRequest`/`PasskeyGetResult`) already follow the W3C WebAuthn JSON dictionaries field-for-field
 * (challenge/rp/user/pubKeyCredParams/authenticatorSelection/attestation on the create side; challenge/
 * rpId/allowCredentials/userVerification on the get side), which is the exact same shape
 * `@simplewebauthn/server`'s `generateRegistrationOptions`/`generateAuthenticationOptions` produce on the
 * API side — so the mapping below is close to a pass-through, not a real protocol translation.
 */
export const passkeyAvailable = true;

/** Whether THIS device's OS version actually supports passkeys (iOS 16+/a recent Android with Google Play
 * services credential manager) — checked at call time, not import time, since merely linking the native
 * module doesn't guarantee OS-level support. UI code should call this before showing a passkey button. */
export function isPasskeySupported(): boolean {
  try {
    return Passkey.isSupported();
  } catch {
    return false;
  }
}

function isUserCancellation(err: unknown): boolean {
  // react-native-passkey throws a `PasskeyError` with a `.error` code on both platforms; the exact
  // cancellation code name isn't pinned to a specific SDK version here (unverified without a real device —
  // see docs/PHASE2_PENDING_CREDENTIALS.md), so this matches defensively on either the error name or
  // message rather than a single exact enum member.
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /cancel/i.test(message);
}

export async function registerPasskey(options: RegistrationOptionsJSON): Promise<PasskeyRegistrationResult> {
  try {
    const result = await Passkey.create({
      challenge: options.challenge,
      rp: options.rp,
      user: options.user,
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      excludeCredentials: options.excludeCredentials as never,
      authenticatorSelection: options.authenticatorSelection as never,
      attestation: options.attestation as never,
    });
    return {
      status: "success",
      response: {
        id: result.id,
        rawId: result.rawId,
        type: "public-key",
        authenticatorAttachment: result.authenticatorAttachment,
        response: {
          clientDataJSON: result.response.clientDataJSON,
          attestationObject: result.response.attestationObject,
          transports: result.response.transports as string[] | undefined,
        },
        clientExtensionResults: result.clientExtensionResults,
      },
    };
  } catch (err) {
    if (isUserCancellation(err)) return { status: "cancelled" };
    return { status: "error", message: err instanceof Error ? err.message : "Couldn't create a passkey. Please try again." };
  }
}

export async function authenticatePasskey(options: AuthenticationOptionsJSON): Promise<PasskeyAuthenticationResult> {
  try {
    const result = await Passkey.get({
      challenge: options.challenge,
      rpId: options.rpId,
      timeout: options.timeout,
      allowCredentials: options.allowCredentials as never,
      userVerification: options.userVerification as never,
    });
    return {
      status: "success",
      response: {
        id: result.id,
        rawId: result.rawId ?? result.id,
        type: "public-key",
        authenticatorAttachment: result.authenticatorAttachment,
        response: {
          clientDataJSON: result.response.clientDataJSON,
          authenticatorData: result.response.authenticatorData,
          signature: result.response.signature,
          userHandle: result.response.userHandle,
        },
        clientExtensionResults: result.clientExtensionResults,
      },
    };
  } catch (err) {
    if (isUserCancellation(err)) return { status: "cancelled" };
    return { status: "error", message: err instanceof Error ? err.message : "Couldn't sign in with a passkey. Please try again." };
  }
}
