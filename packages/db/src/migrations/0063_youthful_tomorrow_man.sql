ALTER TABLE "webhook_subscriptions" ALTER COLUMN "channel_secret_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "provider" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_provider_external_idx" ON "webhook_subscriptions" USING btree ("provider","external_id");