import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedAdmin } from "./admin.guard";

export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
  const request = ctx.switchToHttp().getRequest();
  return request.adminUser as AuthenticatedAdmin;
});
