import { NativeModule, requireNativeModule } from "expo";
import type { CapturedNotification, InstalledApp } from "./VeynloNotificationCapture.types";

declare class VeynloNotificationCaptureModule extends NativeModule<{}> {
  isListenerEnabled(): boolean;
  openNotificationAccessSettings(): void;
  getPendingCaptures(): CapturedNotification[];
  clearCaptures(): void;

  /** Apps with a launcher entry, excluding Veynlo itself, sorted by label. */
  getInstalledApps(): InstalledApp[];
  /** The packages the user chose — NOT including the always-on SMS defaults. */
  getAllowedPackages(): string[];
  setAllowedPackages(packages: string[]): void;
  /** The SMS packages read regardless of the user's list, so the UI can show them as already on. */
  getDefaultAllowedPackages(): string[];
}

export default requireNativeModule<VeynloNotificationCaptureModule>("VeynloNotificationCapture");
