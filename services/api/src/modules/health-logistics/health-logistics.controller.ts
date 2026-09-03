import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto } from "../sharing/dto";
import { HealthLogisticsService } from "./health-logistics.service";
import {
  CreateHealthAppointmentDtoSchema,
  type CreateHealthAppointmentDto,
  CreateRefillReminderDtoSchema,
  type CreateRefillReminderDto,
  LinkBillToAppointmentDtoSchema,
  type LinkBillToAppointmentDto,
  LinkTaskToAppointmentDtoSchema,
  type LinkTaskToAppointmentDto,
  LinkDocumentToAppointmentDtoSchema,
  type LinkDocumentToAppointmentDto,
  OpenHealthDocumentDtoSchema,
  type OpenHealthDocumentDto,
  ExportHealthPacketDtoSchema,
  type ExportHealthPacketDto,
} from "./dto";

/** §27 "Health Logistics (Non-Diagnostic)" (HLTH-001..005) — see HealthLogisticsService's own doc comment
 * for the access-control model this controller is a thin HTTP wrapper over. */
@Controller("v1/health")
@UseGuards(AuthGuard)
export class HealthLogisticsController {
  constructor(@Inject(HealthLogisticsService) private readonly health: HealthLogisticsService) {}

  @Get("appointments")
  listAppointments(@CurrentUser() user: AuthenticatedUser) {
    return this.health.listAppointments(user.userId);
  }

  @Get("appointments/:id")
  appointmentDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.health.appointmentDetail(id, user.userId);
  }

  @Post("appointments")
  @UsePipes(new ZodValidationPipe(CreateHealthAppointmentDtoSchema))
  createAppointment(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateHealthAppointmentDto) {
    return this.health.createAppointment(user.userId, dto);
  }

  @Put("appointments/:id/visibility")
  async setVisibility(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("visibility") visibility: "private" | "household") {
    await this.health.setAppointmentVisibility(id, user.userId, visibility);
    return { success: true };
  }

  @Delete("appointments/:id")
  async deleteAppointment(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.health.deleteAppointment(id, user.userId);
    return { success: true };
  }

  // HLTH-005 — same generic grants/share-links route shape every other shareable resource uses (see
  // DocumentsController), so the web/mobile ShareResourcePanel component works unmodified against
  // "/v1/health/appointments" as its collectionPath.
  @Post("appointments/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.health.createAppointmentGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays);
  }

  @Get("appointments/:id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.health.listAppointmentGrants(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.health.revokeAppointmentGrant(grantId, user.userId);
    return { success: true };
  }

  // Always rejects (see HealthLogisticsService.createAppointmentShareLink's own doc comment) — kept as a
  // real endpoint rather than omitted so the generic sharing UI gets a clean error, not a 404.
  @Post("appointments/:id/share-links")
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.health.createAppointmentShareLink(id, user.userId);
  }

  @Get("appointments/:id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.health.listAppointmentShareLinks(id, user.userId);
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant. */
  @Get("appointments/:id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.health.listAppointmentAccessEvents(id, user.userId);
  }

  @Get("refill-reminders")
  listRefillReminders(@CurrentUser() user: AuthenticatedUser) {
    return this.health.listRefillReminders(user.userId);
  }

  @Post("refill-reminders")
  @UsePipes(new ZodValidationPipe(CreateRefillReminderDtoSchema))
  createRefillReminder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRefillReminderDto) {
    return this.health.createRefillReminder(user.userId, dto);
  }

  @Post("refill-reminders/:id/picked-up")
  async markPickedUp(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.health.markRefillPickedUp(id, user.userId);
    return { success: true };
  }

  @Delete("refill-reminders/:id")
  async deleteRefillReminder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.health.deleteRefillReminder(id, user.userId);
    return { success: true };
  }

  @Post("bills/:billId/link-appointment")
  @UsePipes(new ZodValidationPipe(LinkBillToAppointmentDtoSchema))
  linkBillToAppointment(@CurrentUser() user: AuthenticatedUser, @Param("billId") billId: string, @Body() dto: LinkBillToAppointmentDto) {
    return this.health.linkBillToAppointment(billId, user.userId, dto.healthAppointmentId);
  }

  @Post("bills/:billId/clear-amount-review")
  async clearAmountReview(@CurrentUser() user: AuthenticatedUser, @Param("billId") billId: string) {
    await this.health.clearBillAmountReview(billId, user.userId);
    return { success: true };
  }

  // HLTH-001 "forms/tasks" linkage — mirrors the bills.../link-appointment route pair exactly.
  @Post("tasks/:taskId/link-appointment")
  @UsePipes(new ZodValidationPipe(LinkTaskToAppointmentDtoSchema))
  async linkTaskToAppointment(@CurrentUser() user: AuthenticatedUser, @Param("taskId") taskId: string, @Body() dto: LinkTaskToAppointmentDto) {
    await this.health.linkTaskToAppointment(taskId, user.userId, dto.healthAppointmentId);
    return { success: true };
  }

  @Post("tasks/:taskId/unlink-appointment")
  async unlinkTaskFromAppointment(@CurrentUser() user: AuthenticatedUser, @Param("taskId") taskId: string) {
    await this.health.unlinkTaskFromAppointment(taskId, user.userId);
    return { success: true };
  }

  // HLTH-001/002 "attach form/card/bill" — links an insurance-card/EOB document to an appointment.
  @Post("documents/:documentId/link-appointment")
  @UsePipes(new ZodValidationPipe(LinkDocumentToAppointmentDtoSchema))
  async linkDocumentToAppointment(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string, @Body() dto: LinkDocumentToAppointmentDto) {
    await this.health.linkDocumentToAppointment(documentId, user.userId, dto.healthAppointmentId);
    return { success: true };
  }

  @Post("documents/:documentId/unlink-appointment")
  @UsePipes(new ZodValidationPipe(LinkDocumentToAppointmentDtoSchema))
  async unlinkDocumentFromAppointment(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string, @Body() dto: LinkDocumentToAppointmentDto) {
    await this.health.unlinkDocumentFromAppointment(documentId, user.userId, dto.healthAppointmentId);
    return { success: true };
  }

  @Post("documents/:id/unlock")
  @UsePipes(new ZodValidationPipe(OpenHealthDocumentDtoSchema))
  openDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: OpenHealthDocumentDto) {
    return this.health.openHealthDocument(id, user.userId, dto.password);
  }

  // HLTH-001 "export selected packet" — §28.9 step-up-gated, same PASSWORD_REQUIRED/INVALID_CREDENTIALS
  // error shape as every other step-up action in this app (DataExportController.request, EmergencyBinderController).
  @Post("export")
  @UsePipes(new ZodValidationPipe(ExportHealthPacketDtoSchema))
  exportPacket(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExportHealthPacketDto) {
    return this.health.exportHealthPacket(user.userId, dto.password, dto.appointmentId);
  }
}
