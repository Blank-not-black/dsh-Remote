package com.dshremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import org.json.JSONObject;
import java.util.Map;

/** Task outcomes have their own audible channel; the foreground-service channel stays quiet. */
final class TaskNotifications {
  static final String CHANNEL = "dsh_remote_task_results";
  private static final String PREFS = "dsh_remote_task_results";

  static void channel(Context context) {
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationManager manager = context.getSystemService(NotificationManager.class);
      if (manager != null) {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL, context.getString(R.string.task_result_channel), NotificationManager.IMPORTANCE_HIGH);
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
      }
    }
  }

  static synchronized void handle(Context context, String base, String token, JSONObject frame,
      boolean enabled, boolean replay) {
    JSONObject payload = frame.optJSONObject("payload");
    if (payload == null) return;
    JSONObject event = payload.optJSONObject("event");
    if (event == null) event = payload;
    JSONObject data = event.optJSONObject("data");
    if (data == null) data = event;
    String type = event.optString("type");
    if ("turn/end".equals(type)) {
      JSONObject reason = data.optJSONObject("reason");
      if (reason != null && "error".equals(reason.optString("kind"))) type = "agent/error";
    }
    String sid = payload.optString("sessionId", event.optString("sessionId", data.optString("sessionId")));
    if (sid.isEmpty() || sid.length() > 1000) return;
    Boolean active = null;
    if ("turn/start".equals(type)) active = true;
    if ("agent/status".equals(type) || "host/session-status".equals(type)) {
      Object value = data.opt("running");
      if (value instanceof Boolean) active = (Boolean) value;
      else return;
    }
    if (active == null && !"turn/end".equals(type) && !"goal/completed".equals(type)
        && !"host/agent-error".equals(type) && !"agent/error".equals(type)) return;
    String key = PendingNotifications.identity(PendingNotifications.identity(base, token), sid);
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    TaskReminderPolicy policy = new TaskReminderPolicy();
    policy.run = prefs.getLong("run:" + key, 0);
    policy.running = prefs.getBoolean("running:" + key, false);
    policy.posted = prefs.getInt("posted:" + key, 0);
    int result = policy.accept(type, active, replay || payload.optBoolean("replay", false));
    if (result != TaskReminderPolicy.NONE && enabled) {
      String label = data.optString("title");
      if (label.isEmpty()) label = sid.length() > 8 ? "…" + sid.substring(sid.length() - 8) : sid;
      if (label.length() > 240) label = label.substring(0, 240) + "…";
      if (post(context, base, token, sid, key + ":" + policy.run, result, label)) policy.delivered(result);
    } else if (!enabled && result != TaskReminderPolicy.NONE) policy.delivered(result);
    SharedPreferences.Editor edit = prefs.edit().putLong("run:" + key, policy.run)
        .putBoolean("running:" + key, policy.running).putInt("posted:" + key, policy.posted)
        .putLong("time:" + key, System.currentTimeMillis());
    // Bound persisted session state. Never include tokens or message bodies.
    if (prefs.getAll().size() >= 1024) {
      String oldest = null; long at = Long.MAX_VALUE;
      for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
        if (entry.getKey().startsWith("time:") && !entry.getKey().equals("time:" + key)
            && entry.getValue() instanceof Long && (Long) entry.getValue() < at) {
          oldest = entry.getKey().substring(5); at = (Long) entry.getValue();
        }
      }
      if (oldest != null) for (String prefix : new String[]{"run:", "running:", "posted:", "time:"}) edit.remove(prefix + oldest);
    }
    edit.apply();
  }

  private static boolean post(Context context, String base, String token, String sid, String tag, int result, String label) {
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null || Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
    channel(context);
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
    Intent open = new Intent(context, MainActivity.class)
        .setData(android.net.Uri.parse("dshremote://result/" + tag))
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
        .putExtra("pending_base", base).putExtra("pending_identity", PendingNotifications.identity(base, token))
        .putExtra("pending_session", sid);
    if (!sid.isEmpty()) open.setAction(PendingNotifications.ACTION_OPEN);
    PendingIntent target = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    int title = result == TaskReminderPolicy.ERROR ? R.string.task_result_error
        : result == TaskReminderPolicy.GOAL ? R.string.task_result_goal : R.string.task_result_turn;
    Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
    Notification notification = builder.setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(context.getString(title)).setContentText(label).setContentIntent(target)
        .setAutoCancel(true).setOnlyAlertOnce(true).setPriority(Notification.PRIORITY_HIGH).build();
    try { manager.notify("result:" + tag, 1, notification); return true; }
    catch (SecurityException ignored) { return false; }
  }

  static boolean test(Context context, String base, String token, String kind) {
    if ("approval".equals(kind)) {
      try {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
          NotificationChannel channel = manager.getNotificationChannel("dsh_remote_attention");
          if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        JSONObject payload = new JSONObject().put("type", "approval/requested")
            .put("approvalId", "notification-test-" + System.currentTimeMillis()).put("toolName", "通知测试 / Notification test");
        PendingNotifications.handle(context, base, token, new JSONObject().put("payload", payload), true);
        return true;
      } catch (Exception ignored) { return false; }
    }
    int result = "error".equals(kind) ? TaskReminderPolicy.ERROR : TaskReminderPolicy.TURN;
    return post(context, base, token, "", "test:" + kind, result, context.getString(R.string.task_result_test));
  }
}
