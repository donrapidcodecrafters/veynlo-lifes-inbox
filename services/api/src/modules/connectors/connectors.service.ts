import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class ConnectorsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
    // Deletion-of-derived-data workflow (facts/purchases/documents originating from this connection) is a
    // durable, resumable job — see PRIV-002 in the roadmap. `deleteDerivedData` is threaded through once
    // that workflow exists; for now the flag is accepted and recorded but not yet destructive.
    if (deleteDerivedData) {
      // TODO(privacy-workflow): enqueue durable deletion-by-connection job.
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
