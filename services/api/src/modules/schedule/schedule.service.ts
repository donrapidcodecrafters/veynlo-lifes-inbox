import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class ScheduleService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  upcomingEvents(userId: string) {
    return this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.ownerUserId, userId), gte(schema.calendarEvents.startSort, new Date())))
      .orderBy(asc(schema.calendarEvents.startSort));
  }

  tasks(userId: string) {
    return this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.ownerUserId, userId)))
      .orderBy(asc(schema.tasks.dueSort));
  }

  async completeTask(id: string, userId: string) {
    await this.db
      .update(schema.tasks)
      .set({ state: "completed", updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.ownerUserId, userId)));
  }
}
