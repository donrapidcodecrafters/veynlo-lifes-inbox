import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { HouseholdService } from "./household.service";
import {
  AcceptDependentTransitionDtoSchema,
  AcceptInviteDtoSchema,
  CreateDependentDtoSchema,
  CreateHouseholdDtoSchema,
  DeclineInviteDtoSchema,
  GrantDelegationDtoSchema,
  InviteDependentTransitionDtoSchema,
  InviteMemberDtoSchema,
  RenameHouseholdDtoSchema,
  SetMemberLabelDtoSchema,
  TransferOwnershipDtoSchema,
  type AcceptDependentTransitionDto,
  type AcceptInviteDto,
  type CreateDependentDto,
  type CreateHouseholdDto,
  type DeclineInviteDto,
  type GrantDelegationDto,
  type InviteDependentTransitionDto,
  type InviteMemberDto,
  type RenameHouseholdDto,
  type SetMemberLabelDto,
  type TransferOwnershipDto,
} from "./dto";

// Deliberately no class-level `@UseGuards(AuthGuard)` — the invite-peek route below must be reachable by
// someone who doesn't have an account/session yet (mirrors connectors.controller.ts's OAuth callbacks).
@Controller("v1/households")
export class HouseholdController {
  constructor(@Inject(HouseholdService) private readonly households: HouseholdService) {}

  @Post()
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(CreateHouseholdDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateHouseholdDto) {
    return this.households.create(user.userId, dto);
  }

  @Get()
  @UseGuards(AuthGuard)
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.households.getForUser(user.userId);
  }

  @Get(":householdId/members")
  @UseGuards(AuthGuard)
  members(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listMembers(householdId, user.userId);
  }

  @Patch(":householdId")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(RenameHouseholdDtoSchema))
  rename(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Body() dto: RenameHouseholdDto) {
    return this.households.rename(householdId, user.userId, dto);
  }

  @Post(":householdId/transfer-ownership")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(TransferOwnershipDtoSchema))
  transferOwnership(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string, @Body() dto: TransferOwnershipDto) {
    return this.households.transferOwnership(householdId, user.userId, dto);
  }

  @Patch(":householdId/members/:membershipId")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(SetMemberLabelDtoSchema))
  setMemberLabel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("membershipId") membershipId: string,
    @Body() dto: SetMemberLabelDto,
  ) {
    return this.households.setMemberLabel(householdId, membershipId, user.userId, dto);
  }

  @Post(":householdId/members/:membershipId/remove")
  @UseGuards(AuthGuard)
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("membershipId") membershipId: string,
  ) {
    return this.households.removeMember(householdId, membershipId, user.userId);
  }

  @Post(":householdId/members/:membershipId/resend-invite")
  @UseGuards(AuthGuard)
  resendInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("membershipId") membershipId: string,
  ) {
    return this.households.resendInvite(householdId, membershipId, user.userId);
  }

  @Post(":householdId/members/:membershipId/revoke-invite")
  @UseGuards(AuthGuard)
  revokeInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("membershipId") membershipId: string,
  ) {
    return this.households.revokeInvite(householdId, membershipId, user.userId);
  }

  /** Phase 2 §52.2 "family Today" — household-wide today view (events, tasks, attention items across every member). */
  @Get(":householdId/today")
  @UseGuards(AuthGuard)
  today(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.today(householdId, user.userId);
  }

  @Post(":householdId/invite")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(InviteMemberDtoSchema))
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: InviteMemberDto,
  ) {
    return this.households.invite(householdId, user.userId, dto);
  }

  // No guard — an invitee may not have an account/session yet. The token itself is the credential; the
  // response is intentionally minimal (household name + invited email only), not full household details.
  @Get("invite")
  peekInvite(@Query("token") token: string) {
    return this.households.getInviteByToken(token);
  }

  @Post("accept-invite")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(AcceptInviteDtoSchema))
  acceptInvite(@CurrentUser() user: AuthenticatedUser, @Body() dto: AcceptInviteDto) {
    return this.households.acceptInvite(dto.token, user.userId);
  }

  // No guard — mirrors peekInvite: the invitee may not have an account/session yet, and the token itself
  // is sufficient proof of intent to decline (a lower-stakes action than accepting).
  @Post("decline-invite")
  @UsePipes(new ZodValidationPipe(DeclineInviteDtoSchema))
  declineInvite(@Body() dto: DeclineInviteDto) {
    return this.households.declineInvite(dto.token);
  }

  @Post(":householdId/dependents")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(CreateDependentDtoSchema))
  addDependent(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: CreateDependentDto,
  ) {
    return this.households.addDependent(householdId, user.userId, dto);
  }

  @Get(":householdId/dependents")
  @UseGuards(AuthGuard)
  dependents(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listDependents(householdId, user.userId);
  }

  /** FAM-001 "later invite/transition path when appropriate" — starts a dependent's own-account transition. */
  @Post(":householdId/dependents/:dependentId/invite-transition")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(InviteDependentTransitionDtoSchema))
  inviteDependentTransition(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("dependentId") dependentId: string,
    @Body() dto: InviteDependentTransitionDto,
  ) {
    return this.households.inviteDependentTransition(householdId, dependentId, user.userId, dto);
  }

  @Post(":householdId/dependents/:dependentId/revoke-transition")
  @UseGuards(AuthGuard)
  revokeDependentTransition(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("dependentId") dependentId: string,
  ) {
    return this.households.revokeDependentTransitionInvite(householdId, dependentId, user.userId);
  }

  // No guard — mirrors peekInvite: the invited dependent may not have an account/session yet.
  @Get("dependent-transition-invite")
  peekDependentTransitionInvite(@Query("token") token: string) {
    return this.households.getDependentTransitionInviteByToken(token);
  }

  @Post("accept-dependent-transition")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(AcceptDependentTransitionDtoSchema))
  acceptDependentTransition(@CurrentUser() user: AuthenticatedUser, @Body() dto: AcceptDependentTransitionDto) {
    return this.households.acceptDependentTransition(dto.token, user.userId);
  }

  @Post(":householdId/leave")
  @UseGuards(AuthGuard)
  leave(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.leave(householdId, user.userId);
  }

  @Get(":householdId/delegations")
  @UseGuards(AuthGuard)
  delegations(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.households.listDelegations(householdId, user.userId);
  }

  @Post(":householdId/delegations")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(GrantDelegationDtoSchema))
  grantDelegation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Body() dto: GrantDelegationDto,
  ) {
    return this.households.grantDelegation(householdId, user.userId, dto);
  }

  @Post(":householdId/delegations/:delegationId/revoke")
  @UseGuards(AuthGuard)
  revokeDelegation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("householdId") householdId: string,
    @Param("delegationId") delegationId: string,
  ) {
    return this.households.revokeDelegation(householdId, delegationId, user.userId);
  }
}
