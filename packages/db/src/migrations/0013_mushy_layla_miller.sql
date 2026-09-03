ALTER TABLE "purchase_lines" DROP CONSTRAINT "purchase_lines_owner_asset_entity_id_canonical_entities_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_owner_asset_entity_id_canonical_entities_id_fk" FOREIGN KEY ("owner_asset_entity_id") REFERENCES "public"."canonical_entities"("id") ON DELETE set null ON UPDATE no action;