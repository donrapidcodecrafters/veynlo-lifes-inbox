import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SmartHomeService } from "./smart-home.service";
import { ConnectHomeAssistantDtoSchema, SelectDevicesDtoSchema, type ConnectHomeAssistantDto, type SelectDevicesDto } from "./dto";

/** §31 "Smart Home & Connected Devices" — SMART-001/002. */
@Controller("v1/smart-home")
@UseGuards(AuthGuard)
export class SmartHomeController {
  constructor(@Inject(SmartHomeService) private readonly smartHome: SmartHomeService) {}

  @Get("connections")
  listConnections(@CurrentUser() user: AuthenticatedUser) {
    return this.smartHome.listConnections(user.userId);
  }

  @Post("connections/home-assistant")
  @UsePipes(new ZodValidationPipe(ConnectHomeAssistantDtoSchema))
  connectHomeAssistant(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConnectHomeAssistantDto) {
    return this.smartHome.connectHomeAssistant(user.userId, dto);
  }

  @Get("connections/:id/devices")
  listDevices(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.smartHome.listAvailableDevices(id, user.userId);
  }

  @Put("connections/:id/devices")
  @UsePipes(new ZodValidationPipe(SelectDevicesDtoSchema))
  selectDevices(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SelectDevicesDto) {
    return this.smartHome.setSelectedDevices(id, user.userId, dto.providerDeviceIds);
  }

  @Post("connections/:id/sync")
  sync(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.smartHome.sync(id, user.userId);
  }

  @Delete("connections/:id")
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.smartHome.disconnect(id, user.userId);
  }

  @Get("signals")
  listSignals(@CurrentUser() user: AuthenticatedUser, @Query("limit") limit?: string) {
    const parsed = Number(limit);
    return this.smartHome.listSignals(user.userId, Number.isFinite(parsed) && parsed > 0 ? parsed : 50);
  }
}
