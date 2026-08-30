ALTER TABLE "bills" ADD COLUMN "linked_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "linked_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "linked_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;