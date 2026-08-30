import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { gmail_v1 } from "googleapis";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { IngestionService } from "./ingestion.service";
import type { GraphMessage } from "./outlook-message-parser";
import { CommerceService } from "../commerce/commerce.service";

/**
 * MAIL-007 "open in original provider" — rawContentRef has existed on source_events since it shipped but
 * was never actually written at ingest time, so the evidence view never had a working "open in Gmail/
 * Outlook" link. Real DB-backed proof both ingestGmailMessage and ingestOutlookMessage now persist a
 * working link, and that CommerceService.purchaseDetail's evidence view (evidenceForSourceEvent — the
 * same shape ScheduleService's own evidence view uses) actually surfaces it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
// Only db-touching dependencies matter here: both messages are deliberately kept irrelevant (no matched
// keyword) so ingestParsedEmail short-circuits at evaluateRelevance and never reaches the AI/documents/
// search-index/feature-flags/risk-policy collaborators.
const ingestion = new IngestionService(db, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
const commerce = new CommerceService(db, {} as never); // HouseholdService — unreached (strict-ownership purchaseDetail)

const ownerId = generateId("user");
const gmailConnectionId = generateId("connection");
const outlookConnectionId = generateId("connection");
const gmailIdempotencyKey = "gmail:mail-007-gmail-msg-1";
const outlookIdempotencyKey = "outlook:mail-007-outlook-msg-1";
const gmailPurchaseId = generateId("purchase");
const outlookPurchaseId = generateId("purchase");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "MAIL-007 rawContentRef test user" });
  await db.insert(schema.connections).values([
    { id: gmailConnectionId, ownerUserId: ownerId, provider: "gmail", feasibilityClass: "a" },
    { id: outlookConnectionId, ownerUserId: ownerId, provider: "outlook", feasibilityClass: "a" },
  ]);

  const gmailMessage = {
    id: "mail-007-gmail-msg-1",
    snippet: "Just checking in, how are you?",
    payload: { headers: [{ name: "Subject", value: "Hello there" }, { name: "From", value: "friend@example.com" }] },
  } as gmail_v1.Schema$Message;
  await ingestion.ingestGmailMessage({ ownerUserId: ownerId, householdId: null, connectionId: gmailConnectionId, message: gmailMessage });

  const outlookMessage: GraphMessage = {
    id: "mail-007-outlook-msg-1",
    subject: "Hello there",
    from: { emailAddress: { address: "friend@example.com" } },
    bodyPreview: "Just checking in, how are you?",
    webLink: "https://outlook.office.com/mail/deeplink/read/mail-007-outlook-msg-1",
  };
  await ingestion.ingestOutlookMessage({ ownerUserId: ownerId, householdId: null, connectionId: outlookConnectionId, message: outlookMessage });
});

afterAll(async () => {
  await db.delete(schema.purchases).where(inArray(schema.purchases.id, [gmailPurchaseId, outlookPurchaseId]));
  await db.delete(schema.sourceEvents).where(inArray(schema.sourceEvents.idempotencyKey, [gmailIdempotencyKey, outlookIdempotencyKey]));
  await db.delete(schema.connections).where(inArray(schema.connections.id, [gmailConnectionId, outlookConnectionId]));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("IngestionService rawContentRef persistence", () => {
  it("ingestGmailMessage writes a working Gmail deep link to source_events.rawContentRef", async () => {
    const [row] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, gmailIdempotencyKey)).limit(1);
    expect(row?.rawContentRef).toBe("https://mail.google.com/mail/u/0/#all/mail-007-gmail-msg-1");
  });

  it("ingestOutlookMessage writes the message's own Graph webLink to source_events.rawContentRef", async () => {
    const [row] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, outlookIdempotencyKey)).limit(1);
    expect(row?.rawContentRef).toBe("https://outlook.office.com/mail/deeplink/read/mail-007-outlook-msg-1");
  });

  it("CommerceService.purchaseDetail's evidence surfaces rawContentRef for a Gmail-sourced item", async () => {
    const [source] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, gmailIdempotencyKey)).limit(1);
    await db.insert(schema.purchases).values({
      id: gmailPurchaseId,
      ownerUserId: ownerId,
      state: "candidate",
      confidenceBand: "needs_review",
      purchaseDate: { date: "2026-08-01", precision: "date", instantUtc: null, timezone: null, sourceText: null },
      sourceEventId: source!.id,
    });
    const detail = await commerce.purchaseDetail(gmailPurchaseId, ownerId);
    expect(detail?.evidence?.rawContentRef).toBe("https://mail.google.com/mail/u/0/#all/mail-007-gmail-msg-1");
  });

  it("CommerceService.purchaseDetail's evidence surfaces rawContentRef for an Outlook-sourced item", async () => {
    const [source] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, outlookIdempotencyKey)).limit(1);
    await db.insert(schema.purchases).values({
      id: outlookPurchaseId,
      ownerUserId: ownerId,
      state: "candidate",
      confidenceBand: "needs_review",
      purchaseDate: { date: "2026-08-01", precision: "date", instantUtc: null, timezone: null, sourceText: null },
      sourceEventId: source!.id,
    });
    const detail = await commerce.purchaseDetail(outlookPurchaseId, ownerId);
    expect(detail?.evidence?.rawContentRef).toBe("https://outlook.office.com/mail/deeplink/read/mail-007-outlook-msg-1");
  });
});
