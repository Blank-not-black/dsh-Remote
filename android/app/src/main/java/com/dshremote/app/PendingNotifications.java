package com.dshremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

/** Shared by the WebView and poll service: one reminder per host, credential and request. */
final class PendingNotifications {
  private static final String CHANNEL = "dsh_remote_attention";
  private static final String PREFS = "dsh_remote_attention";
  static final String ACTION_OPEN = "com.dshremote.app.OPEN_PENDING";

  static String identity(String base, String token) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest((base.replaceAll("/+$", "") + "\n" + token).getBytes(StandardCharsets.UTF_8));
      StringBuilder text = new StringBuilder();
      for (byte b : digest) text.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
      return text.toString();
    } catch (Exception e) { throw new IllegalStateException(e); }
  }

  static synchronized boolean handle(Context context, String base, String token, JSONObject frame, boolean enabled) {
    JSONObject payload = frame.optJSONObject("payload");
    if (payload == null) return false;
    String type = payload.optString("type");
    boolean approval = type.startsWith("approval/");
    if (!approval && !type.startsWith("question/")) return false;
    boolean requested = type.endsWith("/requested"), resolved = type.endsWith("/resolved");
    if (!requested && !resolved) return false;
    String id = approval ? payload.optString("approvalId") : requested ? frame.optString("rpcId") : payload.optString("questionRpcId");
    if (id.isEmpty() || id.length() > 1000) return false;
    String host = identity(base, token), tag = host + ":" + (approval ? "a:" : "q:") + id;
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null) return false;
    if (resolved) {
      manager.cancel(tag, 1);
      // Keep a tombstone so a delayed replay cannot resurrect a resolved request.
      SharedPreferences.Editor edit = prefs.edit();
      prune(prefs, manager, edit);
      edit.putLong("seen:" + tag, System.currentTimeMillis()).remove("active:" + tag).apply();
      return true;
    }
    if (!enabled || prefs.contains("seen:" + tag)) return false;
    if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = new NotificationChannel(CHANNEL, context.getString(R.string.attention_channel), NotificationManager.IMPORTANCE_HIGH);
      manager.createNotificationChannel(channel);
      if (manager.getNotificationChannel(CHANNEL).getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
    }
    Intent open = new Intent(context, MainActivity.class).setAction(ACTION_OPEN)
        .setData(android.net.Uri.parse("dshremote://attention/" + identity(tag, "")))
        .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
        .putExtra("pending_base", base).putExtra("pending_identity", host).putExtra("pending_session", payload.optString("sessionId"));
    PendingIntent intent = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    String title = context.getString(approval ? R.string.attention_approval : R.string.attention_question);
    String body = payload.optString("toolName");
    JSONArray questions = payload.optJSONArray("questions");
    if (!approval && questions != null && questions.optJSONObject(0) != null) body = questions.optJSONObject(0).optString("question");
    if (body.isEmpty()) body = context.getString(R.string.bg_events_text);
    if (body.length() > 240) body = body.substring(0, 240) + "…";
    Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
    Notification notification = builder.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title)
        .setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setContentIntent(intent)
        .setAutoCancel(true).setOnlyAlertOnce(true).setPriority(Notification.PRIORITY_HIGH).build();
    try {
      manager.notify(tag, 1, notification);
      SharedPreferences.Editor edit = prefs.edit();
      prune(prefs, manager, edit);
      edit.putLong("seen:" + tag, System.currentTimeMillis()).putBoolean("active:" + tag, true).apply();
      return true;
    } catch (SecurityException ignored) { return false; /* Permission may be revoked after the check. */ }
  }

  /** Resolve the whole delivered batch before posting any requested reminders. */
  static synchronized void handleBatch(Context context, String base, String token, JSONArray frames, boolean enabled) {
    if (frames == null) return;
    for (int pass = 0; pass < 2; pass++) for (int i = 0; i < frames.length(); i++) {
      JSONObject frame = frames.optJSONObject(i);
      JSONObject payload = frame == null ? null : frame.optJSONObject("payload");
      if (payload == null) continue;
      boolean resolved = payload.optString("type").endsWith("/resolved");
      if (resolved == (pass == 0)) handle(context, base, token, frame, enabled);
    }
  }

  private static void prune(SharedPreferences prefs, NotificationManager manager, SharedPreferences.Editor edit) {
    if (prefs.getAll().size() >= 1024) {
      String oldestKey = null; long oldest = Long.MAX_VALUE;
      for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
        if (entry.getKey().startsWith("seen:") && entry.getValue() instanceof Long && (Long) entry.getValue() < oldest) {
          oldestKey = entry.getKey(); oldest = (Long) entry.getValue();
        }
      }
      if (oldestKey != null) { String oldTag = oldestKey.substring(5); manager.cancel(oldTag, 1); edit.remove(oldestKey).remove("active:" + oldTag); }
    }
  }

  static synchronized void clear(Context context) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    SharedPreferences.Editor edit = prefs.edit();
    for (String key : prefs.getAll().keySet()) if (key.startsWith("active:")) {
      if (manager != null) manager.cancel(key.substring(7), 1);
      edit.remove(key);
    }
    edit.apply();
  }
}
