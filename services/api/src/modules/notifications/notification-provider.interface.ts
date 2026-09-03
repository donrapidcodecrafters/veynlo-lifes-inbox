/**
 * §37 "Create Queue, ObjectStorage, Cache, ModelProvider, NotificationProvider... interfaces so local
 * mocks can be replaced by AWS/provider implementations." Two genuinely separate swappable channels exist
 * today — email (`MailerService`, SMTP against Mailhog locally, a real provider like SES/Postmark in
 * production) and push (`PushService`, Expo's push service) — so this is two narrow interfaces rather than
 * one artificial "NotificationProvider" umbrella that would just wrap two unrelated transports behind a
 * shared name. `NotificationDeliveryService` (the actual "single chokepoint every part of the product goes
 * through to notify a user" — see its own doc comment) depends on both by token, not by concrete class.
 */
export interface EmailProvider {
  send(params: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

export interface PushProvider {
  /** Returns whether delivery was accepted — false covers both a malformed token and a provider-side error. */
  send(pushToken: string, title: string, body: string): Promise<boolean>;
}

/** See queue-producer.interface.ts's identical doc comment for why explicit tokens are needed. */
export const EMAIL_PROVIDER = Symbol("EMAIL_PROVIDER");
export const PUSH_PROVIDER = Symbol("PUSH_PROVIDER");
