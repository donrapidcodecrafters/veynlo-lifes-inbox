import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, inArray, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly households: HouseholdService,
  ) {}

  /**
   * FAM-006 enforcement, mirroring CommerceService.ownerOrDelegatedHousehold. Unlike commerce, a
   * delegated household's rows additionally exclude `visibility: "private"` when a visibility column is
   * given (calendar_events only — tasks has none) so a member's explicitly private event doesn't leak to
   * a caregiver just because they hold a household-wide grant; the owner's own rows are never filtered by
   * visibility.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn, visibilityCol?: AnyPgColumn) {
    const householdIds = await this.households.delegatedHouseholdIds(userId, "schedule:read");
    if (householdIds.length === 0) return eq(ownerCol, userId);
    const householdCondition = visibilityCol ? and(inArray(householdCol, householdIds), ne(visibilityCol, "private"))! : inArray(householdCol, householdIds);
    return or(eq(ownerCol, userId), householdCondition)!;
  }

  async upcomingEvents(userId: string) {
    return this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          await this.ownerOrDelegatedHousehold(userId, schema.calendarEvents.ownerUserId, schema.calendarEvents.householdId, schema.calendarEvents.visibility),
          gte(schema.calendarEvents.startSort, new Date()),
        ),
      )
      .orderBy(asc(schema.calendarEvents.startSort));
  }

  async tasks(userId: string) {
    return this.db
      .select()
      .from(schema.tasks)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.tasks.ownerUserId, schema.tasks.householdId))
      .orderBy(asc(schema.tasks.dueSort));
  }

  async completeTask(id: string, userId: string) {
    await this.db
      .update(schema.tasks)
      .set({ state: "completed", updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.ownerUserId, userId)));
  }
}
