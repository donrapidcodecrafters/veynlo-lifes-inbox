import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { MemoriesModule } from "../memories/memories.module";
import { ListsController } from "./lists.controller";
import { ListsService } from "./lists.service";

// MemoriesModule imported here (not the reverse) so a smart list's query criteria can be evaluated against
// `saved_memories` — see schema/lists.ts's `smartListQuery` column doc comment for why this extends the
// existing Lists table rather than a parallel `smart_lists` table.
@Module({
  imports: [HouseholdModule, SharingModule, MemoriesModule],
  controllers: [ListsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}
