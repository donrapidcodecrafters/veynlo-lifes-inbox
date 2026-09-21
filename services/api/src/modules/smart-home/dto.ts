import { z } from "zod";

/**
 * §31 SMART-001. Only Home Assistant is accepted, because only Home Assistant is built — see
 * `home-assistant.service.ts` for why the other eight named vendors are not, and
 * `smart-home-adapter.interface.ts` for the shape they would arrive in.
 *
 * The provider is still taken as a field rather than assumed, so that adding the second one is a change
 * to a list rather than a change to the route's shape.
 */
export const SmartHomeProviderSchema = z.enum(["home_assistant"]);

export const ConnectHomeAssistantDtoSchema = z.object({
  /**
   * The address of the user's own server. Length-capped because it lands in a database column and is
   * echoed back; the real validation is `homeAssistantOrigin`, which decides whether it is an address
   * this deployment is willing to call at all.
   */
  baseUrl: z.string().min(1).max(500),
  /**
   * A Long-Lived Access Token from the user's own Home Assistant profile. These are JWTs and run to a few
   * hundred characters; the ceiling is generous rather than tight so a legitimate token is never refused
   * for being long.
   */
  token: z.string().min(1).max(4000),
  /** Optional — which property in this household the server belongs to. */
  propertyProfileId: z.string().max(100).nullish(),
});
export type ConnectHomeAssistantDto = z.infer<typeof ConnectHomeAssistantDtoSchema>;

export const SelectDevicesDtoSchema = z.object({
  /**
   * The complete set of selected devices, not a delta — the same shape the notification-capture app
   * picker uses, for the same reason: a client that sends "add this one" and loses the response leaves
   * the two sides disagreeing about what is selected, and neither can tell.
   *
   * Capped so one request cannot select a large installation's entire entity list.
   */
  providerDeviceIds: z.array(z.string().min(1).max(300)).max(200),
});
export type SelectDevicesDto = z.infer<typeof SelectDevicesDtoSchema>;
