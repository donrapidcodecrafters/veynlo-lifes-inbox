import { Module } from "@nestjs/common";
import { SharingService } from "./sharing.service";

/**
 * Generic grant/share-link mechanics (see SharingService's own doc comment) — imported by every
 * resource-owning module that exposes sharing (documents, lists, commerce, assets) plus PublicShareModule,
 * which dispatches a resolved share-link token to whichever of those owns the resource it points to.
 * Deliberately has no controllers of its own and no dependency on any resource module, so it sits at the
 * bottom of the sharing dependency graph with nothing to cycle against.
 */
@Module({
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
