import { Injectable, Logger } from "@nestjs/common";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";

/**
 * Expo's push service accepts classic sends with no API credential at all — unlike Gmail/Outlook/Stripe,
 * there's no "not configured" deployment state here. The real per-user gap is simply "no device has
 * registered a push token yet", which the caller (NotificationDeliveryService) checks before calling this.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo = new Expo();

  async send(pushToken: string, title: string, body: string): Promise<boolean> {
    if (!Expo.isExpoPushToken(pushToken)) {
      this.logger.warn("Skipping push delivery to a malformed Expo push token");
      return false;
    }
    const message: ExpoPushMessage = { to: pushToken, title, body, sound: "default" };
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
