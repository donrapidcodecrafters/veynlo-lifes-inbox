package expo.modules.veynlonotificationcapture

import android.content.Intent
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
        )
      }
    }

    Function("clearCaptures") {
      appContext.reactContext?.let { context -> VeynloNotificationListenerService.clearQueue(context) }
    }
  }
}
