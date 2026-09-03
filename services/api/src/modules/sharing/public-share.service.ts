import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { SharingService } from "./sharing.service";
import { DocumentsService } from "../documents/documents.service";
import { ListsService } from "../lists/lists.service";
import { CommerceService } from "../commerce/commerce.service";
import { AssetsService } from "../assets/assets.service";
import { PetsService } from "../pets/pets.service";
import { TripsService } from "../trips/trips.service";
import { MemoriesService } from "../memories/memories.service";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-002) — dispatches a validated share-link token to whichever
 * resource-owning service actually knows how to render it. Lives above every domain module in the
 * dependency graph (see PublicShareModule's own doc comment) precisely so it CAN import all of them
 * without creating a cycle: SharingService has no idea what a document/list/purchase/property/vehicle
 * looks like, and each domain service has no idea about any other resource type — this is the one place
 * that's allowed to know about all of them at once.
 */
@Injectable()
export class PublicShareService {
  constructor(
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(ListsService) private readonly lists: ListsService,
    @Inject(CommerceService) private readonly commerce: CommerceService,
    @Inject(AssetsService) private readonly assets: AssetsService,
    @Inject(PetsService) private readonly pets: PetsService,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(MemoriesService) private readonly memories: MemoriesService,
  ) {}

  async access(token: string, passcode: string | undefined) {
    const { resourceType, resourceId } = await this.sharing.resolveShareLink(token, passcode);
    try {
      return { resourceType, ...(await this.contentFor(resourceType, resourceId)) };
    } catch {
      // Normalizes any resource-specific NotFoundException (e.g. the document/list/purchase/property/
      // vehicle the link pointed to was since hard-deleted) to the same generic message every other
      // invalid-link case uses — see SharingService.resolveShareLink's own doc comment on never revealing
      // WHY access failed.
      throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    }
  }

  /**
   * The actual per-resource-type dispatch, factored out of `access` so §35 SHARE-007's Sharing Hub
   * (SharingHubService, this same module) can reuse it for a lightweight display label instead of
   * duplicating a second switch over every resource type this app can share. Deliberately takes a raw
   * (resourceType, resourceId) pair with no token/authorization check of its own — the caller is
   * responsible for having already decided the requester may see this (either a validated share-link
   * token via `access` above, or the Sharing Hub only ever calling this for a resource the current user
   * already owns or holds a grant on).
   */
  async contentFor(resourceType: string, resourceId: string): Promise<Record<string, unknown>> {
    switch (resourceType) {
      case "document":
        return this.documents.publicShareContent(resourceId);
      case "list":
        return this.lists.publicShareContent(resourceId);
      case "purchase":
        return this.commerce.publicShareContent(resourceId);
      case "property":
        return this.assets.publicPropertyContent(resourceId);
      case "vehicle":
        return this.assets.publicVehicleContent(resourceId);
      case "pet":
        return this.pets.publicPetContent(resourceId);
      case "trip":
        return this.trips.publicShareContent(resourceId);
      case "saved_memory":
        return this.memories.publicShareContent(resourceId);
      default:
        // Shouldn't happen — every write path that creates a shareLinks row uses one of the resource
        // types above — but a token pointing at an unrecognized/future resourceType degrades to the
        // same "not found" the recipient sees for any other invalid link, not a 500.
        throw new NotFoundException();
    }
  }

  /**
   * §35 SHARE-007 "Shared by me / Shared with me" — a short, human-readable label for one shared resource,
   * used only for display (never as an authorization decision). Returns null rather than throwing for a
   * resourceType this dispatch doesn't recognize (e.g. "person"/"identity_record"/"health_appointment" —
   * shared via a direct grant only, with no `publicShareContent`-shaped method to reuse) or a resource
   * that's since been hard-deleted, so the Hub can fall back to a generic "resourceType" label instead of
   * failing to load the whole list over one stale row.
   */
  async labelFor(resourceType: string, resourceId: string): Promise<string | null> {
    try {
      const content = await this.contentFor(resourceType, resourceId);
      const label = content.title ?? content.name ?? content.label ?? content.destinationLabel;
      return typeof label === "string" ? label : null;
    } catch {
      return null;
    }
  }
}
