import { NativeModule, requireNativeModule } from "expo";
import type { CapturedNotification } from "./VeynloNotificationCapture.types";

declare class VeynloNotificationCaptureModule extends NativeModule<{}> {
  isListenerEnabled(): boolean;
  openNotificationAccessSettings(): void;
  getPendingCaptures(): CapturedNotification[];
  clearCaptures(): void;
}

export default requireNativeModule<VeynloNotificationCaptureModule>("VeynloNotificationCapture");
