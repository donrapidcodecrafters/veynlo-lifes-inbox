package expo.modules.veynlonotificationcapture

import android.content.Context
import android.content.SharedPreferences
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * §32 messaging capture boundaries — deliberately scoped to SMS/RCS messaging apps ONLY, never
 * WhatsApp/Signal/Telegram or any other app's notifications, matching the spec's own rule that those
 * channels stay share/manual-only. The system grants this service access to every notification on the
 * device once the user turns on Notification Access in Settings; everything outside ALLOWED_PACKAGES is
 * ignored immediately in onNotificationPosted and never touches storage.
 *
 * A NotificationListenerService and this module's JS-facing Module class are different Android
 * components with independent lifecycles (the service can be running with no app process alive at all),
 * so they can't share an in-memory reference — captured notifications are queued into SharedPreferences
 * instead, and the JS side drains the queue on next app foreground (see VeynloNotificationCaptureModule's
 * getPendingCaptures/clearCaptures). Same "extract, don't retain more than needed" shape as this app's
 * email evidence storage: only title/text/timestamp are kept, never anything else the notification carries.
 */
class VeynloNotificationListenerService : NotificationListenerService() {
    companion object {
        private val ALLOWED_PACKAGES = setOf(
            "com.google.android.apps.messaging", // Google Messages
            "com.samsung.android.messaging", // Samsung Messages
            "com.android.mms", // AOSP default SMS app on some builds
        )
        private const val PREFS_NAME = "veynlo_notification_capture"
        private const val KEY_QUEUE = "pending_captures"
        private const val MAX_QUEUE_SIZE = 200

        fun readQueue(context: Context): JSONArray {
            val prefs = prefs(context)
            val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
            return try {
                JSONArray(raw)
            } catch (e: Exception) {
                JSONArray()
            }
        }

        fun clearQueue(context: Context) {
            prefs(context).edit().putString(KEY_QUEUE, "[]").apply()
        }

        private fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in ALLOWED_PACKAGES) return

        val extras = sbn.notification.extras
        val title = extras.getCharSequence("android.title")?.toString() ?: return
        val text = extras.getCharSequence("android.text")?.toString() ?: return
        if (title.isBlank() || text.isBlank()) return

        val entry = JSONObject().apply {
            put("title", title)
            put("text", text)
            put("postedAt", sbn.postTime)
        }

        val queue = readQueue(applicationContext)
        queue.put(entry)
        // Bounded — a runaway queue (app never opened for a long time) shouldn't grow forever; drop the
        // oldest entries rather than the newest, since a user re-opening after a long gap cares most about
        // what just happened.
        val trimmed = if (queue.length() > MAX_QUEUE_SIZE) {
            JSONArray().apply {
                for (i in (queue.length() - MAX_QUEUE_SIZE) until queue.length()) put(queue.get(i))
            }
        } else {
            queue
        }
        prefs(applicationContext).edit().putString(KEY_QUEUE, trimmed.toString()).apply()
    }
}
