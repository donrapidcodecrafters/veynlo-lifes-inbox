import { Module } from "@nestjs/common";
import { SavedItemsController } from "./saved-items.controller";
import { SavedItemsService } from "./saved-items.service";

@Module({
  controllers: [SavedItemsController],
  providers: [SavedItemsService],
  exports: [SavedItemsService],
})
export class SavedItemsModule {}
