import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";

export interface AuditEventInput {
  actorType: "user" | "system" | "service" | "support_agent" | "anonymous";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  result?: "success" | "failure" | "denied";
  beforeJson?: unknown;
  afterJson?: unknown;
}

/** Immutable audit-trail insert (§ "AUDIT LOG"), shared by every module that writes one. */
export async function recordAuditEvent(db: Database, input: AuditEventInput): Promise<void> {
  await db.insert(schema.auditEvents).values({
    id: generateId("auditEvent"),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    result: input.result ?? "success",
    beforeJson: input.beforeJson,
    afterJson: input.afterJson,
  });
}
