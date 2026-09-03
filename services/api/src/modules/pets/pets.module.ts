import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { SearchIndexModule } from "../search/search-index.module";
import { PetsController } from "./pets.controller";
import { PetsService } from "./pets.service";

@Module({
  imports: [HouseholdModule, SharingModule, SearchIndexModule],
  controllers: [PetsController],
  providers: [PetsService],
  exports: [PetsService],
})
export class PetsModule {}
