package expo.modules.veynlonotificationcapture

import android.content.Context
import android.content.SharedPreferences
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * Captures notifications from the apps the user has explicitly chosen, and nothing else.
 *
 * ---------------------------------------------------------------------------------------------------
 * What this reads, and why the list belongs to the user
 * ---------------------------------------------------------------------------------------------------
 * The system grants this service access to EVERY notification on the device once the user turns on
 * Notification Access in Settings. That is far more than this app has any business reading, so the grant
 * is not the authorization — the per-app list below is.
 *
 * This began as a hardcoded set of three SMS packages (§32 messaging capture boundaries). That covered
 * bill and appointment texts and missed the larger half of the same problem: an airline saying the gate
 * changed, a pharmacy saying a prescription is ready, a courier saying a parcel arrives today, a clinic
 * confirming tomorrow's appointment. Those arrive as app notifications and never as SMS, and they are
 * exactly what a household needs caught.
 *
 * So the allowlist is the SMS defaults plus whatever apps the user picked in Veynlo's own settings.
 * Nothing is read from an app they have not named. `readAllowedPackages` is consulted per notification
 * rather than cached: that costs one small SharedPreferences read and removes any window in which an app
 * the user just revoked is still being captured.
 *
 * ---------------------------------------------------------------------------------------------------
 * What is kept
 * ---------------------------------------------------------------------------------------------------
 * Title, text, timestamp, and the package it came from. Not the icon, not the actions, not the extras
 * bundle, not anything else the notification carries. The package is kept only so the app can show the
 * user what was captured and from where — the same "extract, don't retain more than needed" shape as this
 * app's email evidence storage.
 *
 * A NotificationListenerService and this module's JS-facing Module class are different Android components
 * with independent lifecycles (the service can run with no app process alive at all), so they cannot share
 * an in-memory reference — captures are queued into SharedPreferences and the JS side drains them on next
 * foreground.
 */
class VeynloNotificationListenerService : NotificationListenerService() {
    companion object {
        /**
         * Always allowed, because this is what the feature shipped as: a user who already had SMS capture
         * working must not silently lose it the moment a per-app list exists and starts out empty.
         */
        val DEFAULT_ALLOWED_PACKAGES = setOf(
            "com.google.android.apps.messaging", // Google Messages
            "com.samsung.android.messaging", // Samsung Messages
            "com.android.mms", // AOSP default SMS app on some builds
        )

        /**
         * Person-to-person messaging apps, which this app does not read no matter what any list says.
         *
         * §32's messaging capture boundary: those channels stay share-and-manual only. The per-app picker
         * broadens capture to service notifications — an airline, a pharmacy, a courier — and must not
         * quietly become a way to read someone's private conversations, which is precisely what selecting
         * WhatsApp here would be.
         *
         * Enforced in THREE places on purpose: they are kept out of the picker, rejected by
         * `writeAllowedPackages` if one arrives anyway, and skipped at capture time. Hiding a thing in the
         * UI is not the same as refusing to do it, and a list written by an older build — or by anything
         * other than this app's own screen — must not be able to turn one on.
         *
         * SMS/RCS is deliberately NOT here: a text message is the channel bills and appointment reminders
         * actually arrive on, which is the whole reason this feature exists.
         */
        val EXCLUDED_MESSAGING_PACKAGES = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.thoughtcrime.securesms", // Signal
            "org.telegram.messenger",
            "org.telegram.messenger.web",
            "com.facebook.orca", // Messenger
            "com.facebook.mlite", // Messenger Lite
            "com.discord",
            "com.Slack",
            "com.tencent.mm", // WeChat
            "com.viber.voip",
            "jp.naver.line.android",
            "com.kakao.talk",
            "ch.threema.app",
            "org.session.securesson",
            "im.vector.app", // Element / Matrix
            "com.signal.messenger",
        )

        private const val PREFS_NAME = "veynlo_notification_capture"
        private const val KEY_QUEUE = "pending_captures"
        private const val KEY_ALLOWED = "allowed_packages"
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

        /**
         * The packages the user chose. Deliberately NOT including the SMS defaults — this is their list.
         *
         * Excluded chat apps are filtered on the way OUT as well as on the way in. The write path already
         * refuses them, so a list containing one could only come from a build older than that rule or from
         * something editing the file directly — and in either case the honest answer to "which apps are
         * allowed" is the one this app would actually act on, not whatever the file happens to say. Without
         * this, a stale entry would be reported as allowed by `getAllowedPackages`, counted in the
         * settings screen, and then silently refused at capture time: three places disagreeing about one
         * fact.
         */
        fun readAllowedPackages(context: Context): Set<String> {
            val raw = prefs(context).getString(KEY_ALLOWED, "[]") ?: "[]"
            return try {
                val array = JSONArray(raw)
                (0 until array.length())
                    .map { i -> array.optString(i, "") }
                    .filter { it.isNotBlank() }
                    .filterNot { it in EXCLUDED_MESSAGING_PACKAGES }
                    .toSet()
            } catch (e: Exception) {
                // A corrupted list must mean "nothing extra is allowed", never "allow everything".
                emptySet()
            }
        }

        fun writeAllowedPackages(context: Context, packages: List<String>) {
            val array = JSONArray()
            for (pkg in packages.filter { it.isNotBlank() }.filterNot { it in EXCLUDED_MESSAGING_PACKAGES }.distinct()) {
                array.put(pkg)
            }
            prefs(context).edit().putString(KEY_ALLOWED, array.toString()).apply()
        }

        private fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        // Checked before the allowlist, so a stale or hand-edited list can never re-enable one.
        if (sbn.packageName in EXCLUDED_MESSAGING_PACKAGES) return

        val allowed = DEFAULT_ALLOWED_PACKAGES + readAllowedPackages(applicationContext)
        if (sbn.packageName !in allowed) return

        // An ongoing notification is a status indicator, not an event — a download in progress, a media
        // player, a "syncing" banner. A group summary is a roll-up of notifications already seen
        // individually. Both re-post on every update and neither carries a fact worth filing, so capturing
        // them would fill the queue with noise and file the same thing repeatedly.
        val flags = sbn.notification.flags
        if (flags and android.app.Notification.FLAG_ONGOING_EVENT != 0) return
        if (flags and android.app.Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = sbn.notification.extras
        val title = extras.getCharSequence("android.title")?.toString() ?: return
        val text = extras.getCharSequence("android.text")?.toString() ?: return
        if (title.isBlank() || text.isBlank()) return

        val entry = JSONObject().apply {
            put("title", title)
            put("text", text)
            put("postedAt", sbn.postTime)
            put("packageName", sbn.packageName)
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
