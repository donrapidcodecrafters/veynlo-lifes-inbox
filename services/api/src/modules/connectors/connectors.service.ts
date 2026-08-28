import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QueueProducerService } from "../../queue/queue-producer.service";

@Injectable()
export class ConnectorsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queueProducer: QueueProducerService,
  ) {}

  async listForUser(userId: string) {
    return this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, userId));
  }

  async getOwned(connectionId: string, userId: string) {
    const [connection] = await this.db
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.ownerUserId, userId)))
      .limit(1);
    if (!connection) throw new NotFoundException({ code: "CONNECTION_NOT_FOUND", message: "Connection not found." });
    return connection;
  }

  async disconnect(connectionId: string, userId: string, deleteDerivedData: boolean) {
    await this.getOwned(connectionId, userId);
    await this.db
      .update(schema.connections)
      .set({ health: "disconnected", disconnectedAt: new Date() })
      .where(eq(schema.connections.id, connectionId));
    // PRIV-002 — the actual deletion runs as a durable, resumable background job (worker-main.ts's
    // connectionDataDeletionWorker), same split as account deletion: this call only needs to enqueue it,
    // not block the request on however much data this connection produced.
    if (deleteDerivedData) {
      await this.queueProducer.enqueueConnectionDataDeletion({ connectionId, ownerUserId: userId });
    }
  }

  async assertOwnership(connectionId: string, userId: string) {
    const connection = await this.getOwned(connectionId, userId);
    if (connection.ownerUserId !== userId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You do not own this connection." });
    }
    return connection;
  }
}
