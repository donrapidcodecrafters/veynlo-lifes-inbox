import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { OnboardingGoal, OnboardingStep, UpdateOnboardingStateDto } from "./dto";

/**
 * Maps an ONB-001 onboarding goal to which connector family to recommend on the "connect" step. Not a
 * literal connector `provider` value — several goals recommend "email", and the app has two email
 * connectors (Gmail/Outlook) with no way to know which one a given user has, so the frontend uses this to
 * highlight the right family of connector cards rather than picking a single provider for the user.
 */
const GOAL_RECOMMENDATIONS: Record<OnboardingGoal, "email" | "calendar" | "household"> = {
  important_dates: "calendar",
  purchases_returns: "email",
  bills_subscriptions: "email",
  family: "household",
  travel: "email",
  things_i_own: "email",
};

export interface OnboardingStateResponse {
  goal: OnboardingGoal | null;
  step: OnboardingStep;
  recommendedProvider: "email" | "calendar" | "household" | null;
  completedAt: string | null;
  skippedAt: string | null;
}

@Injectable()
export class OnboardingService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Null means "no row" — either a pre-existing account from before this feature shipped, or (in
   * principle) a row that was somehow never created. Either way, the caller's job is to treat null as
   * "already onboarded, don't show the wizard," never to retroactively force an existing user through it.
   */
  async getState(userId: string): Promise<OnboardingStateResponse | null> {
    const [row] = await this.db.select().from(schema.onboardingState).where(eq(schema.onboardingState.userId, userId)).limit(1);
    if (!row) return null;
    return this.toResponse(row);
  }

  async updateState(userId: string, dto: UpdateOnboardingStateDto): Promise<OnboardingStateResponse> {
    const [existing] = await this.db.select().from(schema.onboardingState).where(eq(schema.onboardingState.userId, userId)).limit(1);
    if (!existing) throw new NotFoundException({ code: "ONBOARDING_NOT_FOUND", message: "No onboarding in progress for this account." });

    const goal = dto.goal ?? (existing.goal as OnboardingGoal | null);
    const recommendedProvider = goal ? GOAL_RECOMMENDATIONS[goal] : null;

    const [updated] = await this.db
      .update(schema.onboardingState)
      .set({
        ...(dto.goal ? { goal: dto.goal, recommendedProvider } : {}),
        ...(dto.step ? { step: dto.step } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.onboardingState.userId, userId))
      .returning();
    if (!updated) throw new NotFoundException({ code: "ONBOARDING_NOT_FOUND", message: "No onboarding in progress for this account." });

    return this.toResponse(updated);
  }

  async complete(userId: string): Promise<OnboardingStateResponse> {
    const [updated] = await this.db
      .update(schema.onboardingState)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId))
      .returning();
    if (!updated) throw new NotFoundException({ code: "ONBOARDING_NOT_FOUND", message: "No onboarding in progress for this account." });
    return this.toResponse(updated);
  }

  async skip(userId: string): Promise<OnboardingStateResponse> {
    const [updated] = await this.db
      .update(schema.onboardingState)
      .set({ skippedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId))
      .returning();
    if (!updated) throw new NotFoundException({ code: "ONBOARDING_NOT_FOUND", message: "No onboarding in progress for this account." });
    return this.toResponse(updated);
  }

  private toResponse(row: typeof schema.onboardingState.$inferSelect): OnboardingStateResponse {
    return {
      goal: row.goal as OnboardingGoal | null,
      step: row.step as OnboardingStep,
      recommendedProvider: row.recommendedProvider as "email" | "calendar" | "household" | null,
      completedAt: row.completedAt?.toISOString() ?? null,
      skippedAt: row.skippedAt?.toISOString() ?? null,
    };
  }
}
