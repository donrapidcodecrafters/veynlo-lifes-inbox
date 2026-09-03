import { Module } from "@nestjs/common";
import { SharingModule } from "./sharing.module";
import { DocumentsModule } from "../documents/documents.module";
import { ListsModule } from "../lists/lists.module";
import { CommerceModule } from "../commerce/commerce.module";
import { AssetsModule } from "../assets/assets.module";
import { PetsModule } from "../pets/pets.module";
import { TripsModule } from "../trips/trips.module";
import { MemoriesModule } from "../memories/memories.module";
import { PublicShareController } from "./public-share.controller";
import { PublicShareService } from "./public-share.service";
import { SharingHubController } from "./sharing-hub.controller";
import { SharingHubService } from "./sharing-hub.service";

/**
 * Sits at the TOP of the sharing dependency graph, not inside SharingModule itself — SharingModule (the
 * generic grant/link mechanics) is imported BY DocumentsModule/ListsModule/CommerceModule/AssetsModule,
 * so if the unauthenticated redemption controller lived inside SharingModule and SharingModule also had
 * to import those same four modules to dispatch a resolved token to the right one, that would be a
 * circular import (DocumentsModule → SharingModule → DocumentsModule). This module breaks that cycle by
 * being the one thing that depends on everything, with nothing depending on it back.
 */
@Module({
  imports: [SharingModule, DocumentsModule, ListsModule, CommerceModule, AssetsModule, PetsModule, TripsModule, MemoriesModule],
  controllers: [PublicShareController, SharingHubController],
  providers: [PublicShareService, SharingHubService],
})
export class PublicShareModule {}
