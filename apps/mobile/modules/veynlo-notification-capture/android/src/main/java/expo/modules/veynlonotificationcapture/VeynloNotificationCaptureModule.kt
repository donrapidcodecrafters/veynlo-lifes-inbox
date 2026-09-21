package expo.modules.veynlonotificationcapture

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VeynloNotificationCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VeynloNotificationCapture")

    // Notification access has no runtime-permission dialog — it's a system settings screen the user must
    // navigate to manually, same class of "high-trust capability" gate as accessibility services.
    Function("isListenerEnabled") {
      val context = appContext.reactContext ?: return@Function false
      val enabledListeners = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: ""
      enabledListeners.contains(context.packageName)
    }

    Function("openNotificationAccessSettings") {
      appContext.reactContext?.let { context ->
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
      }
    }

    Function("getPendingCaptures") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any?>>()
      val queue = VeynloNotificationListenerService.readQueue(context)
      (0 until queue.length()).map { i ->
        val entry = queue.getJSONObject(i)
        mapOf(
          "title" to entry.getString("title"),
          "text" to entry.getString("text"),
          "postedAt" to entry.getLong("postedAt"),
          // Optional: entries queued before the per-app list existed carry no package.
          "packageName" to entry.optString("packageName", ""),
        )
      }
    }

    Function("clearCaptures") {
      appContext.reactContext?.let { context -> VeynloNotificationListenerService.clearQueue(context) }
    }

    /**
     * The apps a user could plausibly want notifications read from.
     *
     * Filtered rather than "everything installed": a device lists well over a hundred packages, and almost
     * all of them are system components with no launcher entry that never post anything a household cares
     * about. Having a launch intent is the closest thing Android offers to "an app the person thinks of as
     * an app", so that is the filter — it keeps the picker to the couple of dozen apps someone recognises
     * instead of burying them under `com.android.*`.
     *
     * Veynlo itself is excluded: capturing our own notifications would feed the app its own output.
     *
     * Sorted by display label, so the list is stable between openings rather than in package-manager
     * order, which is arbitrary and shifts as apps are installed.
     */
    Function("getInstalledApps") {
      val context = appContext.reactContext ?: return@Function emptyList<Map<String, Any?>>()
      val pm: PackageManager = context.packageManager
      val ownPackage = context.packageName

      pm.getInstalledApplications(PackageManager.GET_META_DATA)
        .asSequence()
        .filter { info: ApplicationInfo -> info.packageName != ownPackage }
        .filter { info -> pm.getLaunchIntentForPackage(info.packageName) != null }
        // §32 messaging boundary — see EXCLUDED_MESSAGING_PACKAGES. Kept out of the picker so nobody is
        // invited to make a choice the capture path would refuse anyway.
        .filterNot { info -> info.packageName in VeynloNotificationListenerService.EXCLUDED_MESSAGING_PACKAGES }
        .map { info ->
          mapOf(
            "packageName" to info.packageName,
            "label" to (pm.getApplicationLabel(info)?.toString() ?: info.packageName),
            // Surfaced so the picker can mark them, NOT to exclude them: a preinstalled carrier or OEM app
            // can be exactly the one sending delivery or account notifications.
            "isSystemApp" to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
          )
        }
        .sortedBy { (it["label"] as String).lowercase() }
        .toList()
    }

    /** The packages the user chose. Excludes the always-on SMS defaults — this is their own list. */
    Function("getAllowedPackages") {
      val context = appContext.reactContext ?: return@Function emptyList<String>()
      VeynloNotificationListenerService.readAllowedPackages(context).sorted()
    }

    Function("setAllowedPackages") { packages: List<String> ->
      appContext.reactContext?.let { context ->
        VeynloNotificationListenerService.writeAllowedPackages(context, packages)
      }
    }

    /**
     * The SMS packages read regardless of the user's list, so the settings screen can show them as
     * already-on rather than letting someone believe SMS capture depends on finding their messaging app in
     * the picker.
     */
    Function("getDefaultAllowedPackages") {
      VeynloNotificationListenerService.DEFAULT_ALLOWED_PACKAGES.toList().sorted()
    }
  }
}
