import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { FeatureFlagsService } from "./feature-flags.service";

/** Read-only for ordinary signed-in clients — flipping a flag is an admin-console action (see AdminController). */
@Controller("v1/feature-flags")
@UseGuards(AuthGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  async list(): Promise<Record<string, boolean>> {
    const rows = await this.flags.list();
    return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
  }
}
