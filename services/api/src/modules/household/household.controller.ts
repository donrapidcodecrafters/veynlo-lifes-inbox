import { Body, Controller, Get, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { HouseholdService } from "./household.service";
import {
  CreateDependentDtoSchema,
  CreateHouseholdDtoSchema,
  GrantDelegationDtoSchema,
  InviteMemberDtoSchema,
  type CreateDependentDto,
  type CreateHouseholdDto,
  type GrantDelegationDto,
  type InviteMemberDto,
} from "./dto";

@Controller("v1/households")
@UseGuards(AuthGuard)
export class HouseholdController {
  constructor(private readonly households: HouseholdService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateHouseholdDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateHouseholdDto) {
    return this.households.create(user.userId, dto);
  }

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.households.getForUser(user.userId);
  }

  @Get(":householdId/members")
  members(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listMembers(householdId, user.userId);
  }

  @Post(":householdId/invite")
  @UsePipes(new ZodValidationPipe(InviteMemberDtoSchema))
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.households.invite(householdId, user.userId, dto);
  }

  @Post(":householdId/dependents")
  @UsePipes(new ZodValidationPipe(CreateDependentDtoSchema))
  addDependent(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: CreateDependentDto,
  ) {
    return this.households.addDependent(householdId, user.userId, dto);
  }

  @Get(":householdId/dependents")
  dependents(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listDependents(householdId, user.userId);
  }

  @Post(":householdId/leave")
  leave(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.leave(householdId, user.userId);
  }

  @Get(":householdId/delegations")
  delegations(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listDelegations(householdId, user.userId);
  }

  @Post(":householdId/delegations")
  @UsePipes(new ZodValidationPipe(GrantDelegationDtoSchema))
  grantDelegation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: GrantDelegationDto,
  ) {
    return this.households.grantDelegation(householdId, user.userId, dto);
  }

  @Post(":householdId/delegations/:delegationId/revoke")
  revokeDelegation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("delegationId") delegationId: string,
  ) {
    return this.households.revokeDelegation(householdId, delegationId, user.userId);
  }
}
