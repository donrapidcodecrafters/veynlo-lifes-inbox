import { Injectable, Logger } from "@nestjs/common";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { PushDeepLink, PushProvider } from "./notification-provider.interface";

/**
 * Expo's push service accepts classic sends with no API credential at all — unlike Gmail/Outlook/Stripe,
 * there's no "not configured" deployment state here. The real per-user gap is simply "no device has
 * registered a push token yet", which the caller (NotificationDeliveryService) checks before calling this.
 */
@Injectable()
export class PushService implements PushProvider {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo();

  async send(pushToken: string, title: string, body: string, data?: PushDeepLink): Promise<boolean> {
    if (!Expo.isExpoPushToken(pushToken)) {
      this.logger.warn("Skipping push delivery to a malformed Expo push token");
      return false;
    }
    // `data` is what makes a tap land somewhere useful — expo-notifications hands it to the app's
    // response listener for both a warm tap and a cold launch. Omitted entirely when there is no target,
    // rather than sent as an empty object, so the device can tell "no destination" from "bad payload".
    const message: ExpoPushMessage = { to: pushToken, title, body, sound: "default", ...(data ? { data } : {}) };
    try {
      const tickets = await this.expo.sendPushNotificationsAsync([message]);
      const ticket = tickets[0];
      if (!ticket || ticket.status === "error") {
        this.logger.warn(`Push delivery ticket error: ${ticket && "message" in ticket ? ticket.message : "no ticket returned"}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Push delivery request failed: ${String(err)}`);
      return false;
    }
  }
}
