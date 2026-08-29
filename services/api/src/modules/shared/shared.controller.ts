import { Controller, Get, Param } from "@nestjs/common";
import { SharedService } from "./shared.service";

/** No AuthGuard — the caller is an anonymous link visitor, not a signed-in user (see SharedService). */
@Controller("v1/shared")
export class SharedController {
  constructor(private readonly shared: SharedService) {}

  @Get(":token")
  resolve(@Param("token") token: string) {
    return this.shared.resolve(token);
  }
}
