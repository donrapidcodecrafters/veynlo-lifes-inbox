import { Module } from "@nestjs/common";
import { StorageService } from "../documents/storage.service";
import { SharedController } from "./shared.controller";
import { SharedService } from "./shared.service";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

// StorageService is provided directly here (not via DocumentsModule) — DocumentsModule imports
// SharedModule (for SharingService), so importing DocumentsModule back would be circular.
// StorageService itself has no injected dependencies, so it's safe to instantiate a second time here.
@Module({
  controllers: [SharedController, SharingController],
  providers: [SharedService, SharingService, StorageService],
  exports: [SharingService],
})
export class SharedModule {}
