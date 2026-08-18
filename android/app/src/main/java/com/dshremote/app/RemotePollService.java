package com.dshremote.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 前台服务：App 退后台后定时轮询网关事件。
 *
 * Doze 说明：灭屏后系统会冻结后台任务，实际轮询间隔可能被拉长。
 * 这是 Android 平台限制，不是本服务的 bug。
 */
public class RemotePollService extends Service {

  private static final String PREFS = "dsh_remote_bg";
  private static final String KEY_ENABLED = "enabled";
  private static final String KEY_INTERVAL_MIN = "interval_min";
  private static final String KEY_BASE = "base";
  private static final String KEY_TOKEN = "token";
  private static final String KEY_LOGIN_EXPIRED = "login_expired";
  private static final String KEY_SEQ_MUX = "seq_mux";
  private static final String KEY_SEQ_HOST = "seq_host";
  private static final String KEY_NOTIFY_TASK_DONE = "notify_task_done";

  private static final String CHANNEL_ID = "dsh_remote_background";
  private static final int NOTIFICATION_ID = 1001;
  private static final int EVENT_NOTIFICATION_ID = 1002;
  private static final int TASK_DONE_NOTIFICATION_ID = 1003;
  private static final String[] KINDS = {"mux", "host"};

  private HandlerThread thread;
  private Handler handler;
  private volatile boolean stopped = false;
  private int authFailures = 0;

  @Override
  public void onCreate() {
    super.onCreate();
    createChannel();
    thread = new HandlerThread("RemotePollService");
    thread.start();
    handler = new Handler(thread.getLooper());
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    stopped = false;
    startForegroundWithNotification();
    if (handler != null) {
      handler.removeCallbacksAndMessages(null);
      handler.post(pollRunnable);
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopped = true;
    if (handler != null) handler.removeCallbacksAndMessages(null);
    if (thread != null) thread.quitSafely();
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        getString(R.string.bg_channel_name),
        NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(getString(R.string.bg_channel_desc));
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm != null) nm.createNotificationChannel(channel);
  }

  private void startForegroundWithNotification() {
    Notification notification = buildNotification(
        getString(R.string.bg_notification_title),
        getString(R.string.bg_notification_text),
        true);
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }
  }

  private Notification buildNotification(String title, String text, boolean ongoing) {
    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(
        this, 0, open,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= 26
        ? new Notification.Builder(this, CHANNEL_ID)
        : new Notification.Builder(this);
    builder.setSmallIcon(android.R.drawable.stat_notify_chat)
        .setContentTitle(title)
        .setContentText(text)
        .setContentIntent(pi)
        .setOngoing(ongoing);
    return builder.build();
  }

  private void showEventNotification(int count) {
    Notification notification = buildNotification(
        getString(R.string.bg_events_title, count),
        getString(R.string.bg_events_text),
        true);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm != null) nm.notify(EVENT_NOTIFICATION_ID, notification);
  }

  private void showTaskDoneNotification(String sessionLabel) {
    String text = (sessionLabel == null || sessionLabel.isEmpty())
        ? getString(R.string.bg_task_done_text)
        : getString(R.string.bg_task_done_session, sessionLabel);
    Notification notification = buildNotification(
        getString(R.string.bg_task_done_title),
        text,
        false);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm != null) nm.notify(TASK_DONE_NOTIFICATION_ID, notification);
  }

  private boolean isTaskDoneEvent(JSONObject full) {
    if (full == null) return false;
    JSONObject payload = full.optJSONObject("payload");
    if (payload == null) return false;
    String type = payload.optString("type", "");
    if ("host/agent-error".equals(type)) return true;
    JSONObject ev = payload.optJSONObject("event");
    if (ev == null) return false;
    String etype = ev.optString("type", "");
    if ("goal/completed".equals(etype) || "goal/cleared".equals(etype)) return true;
    if ("agent/status".equals(etype)) {
      JSONObject data = ev.optJSONObject("data");
      return data != null && !data.optBoolean("running", true);
    }
    return false;
  }

  private boolean isAssistantMessage(JSONObject full) {
    if (full == null) return false;
    JSONObject payload = full.optJSONObject("payload");
    if (payload == null) return false;
    if ("assistant/message".equals(payload.optString("type", ""))) return true;
    JSONObject ev = payload.optJSONObject("event");
    return ev != null && "assistant/message".equals(ev.optString("type", ""));
  }

  private String resolveSessionLabel(JSONObject full) {
    if (full == null) return "";
    JSONObject payload = full.optJSONObject("payload");
    if (payload == null) return "";
    String sid = payload.optString("sessionId", "");
    JSONObject ev = payload.optJSONObject("event");
    if (ev != null) {
      JSONObject data = ev.optJSONObject("data");
      if (data != null) {
        String title = data.optString("title", "");
        if (!title.isEmpty()) return title;
        if (sid.isEmpty()) sid = data.optString("sessionId", "");
      }
      if (sid.isEmpty()) sid = ev.optString("sessionId", "");
    }
    if (sid.isEmpty()) return "";
    return sid.length() > 8 ? "…" + sid.substring(sid.length() - 8) : sid;
  }

  private final Runnable pollRunnable = new Runnable() {
    @Override
    public void run() {
      if (stopped) return;
      pollOnce();
      if (stopped) return;
      handler.postDelayed(this, readIntervalMs());
    }
  };

  private void pollOnce() {
    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!prefs.getBoolean(KEY_ENABLED, false)) {
      stopped = true;
      stopSelf();
      return;
    }
    String base = prefs.getString(KEY_BASE, "");
    String token = prefs.getString(KEY_TOKEN, "");
    if (base.isEmpty() || token.isEmpty()) {
      stopped = true;
      stopSelf();
      return;
    }
    for (String kind : KINDS) {
      int since = prefs.getInt(seqKey(kind), 0);
      int result = pollKind(base, token, kind, since);
      if (result == 401) {
        authFailures++;
        if (authFailures >= 3) {
          prefs.edit().putBoolean(KEY_LOGIN_EXPIRED, true).apply();
          stopped = true;
          stopSelf();
          return;
        }
      } else {
        authFailures = 0;
      }
    }
  }

  private int pollKind(String base, String token, String kind, int since) {
    HttpURLConnection conn = null;
    try {
      String url = base.replaceAll("/+$", "")
          + "/api/events.poll?kind=" + kind + "&since=" + since;
      conn = (HttpURLConnection) new URL(url).openConnection();
      conn.setRequestMethod("GET");
      conn.setConnectTimeout(10000);
      conn.setReadTimeout(10000);
      conn.setRequestProperty("Authorization", "Bearer " + token);

      int code = conn.getResponseCode();
      if (code == 401) return 401;
      if (code != 200) return 0;

      String body = readAll(conn.getInputStream());
      JSONObject obj = new JSONObject(body);
      JSONArray events = obj.optJSONArray("events");
      int latestSeq = obj.optInt("latestSeq", since);
      int newCount = 0;
      boolean taskDone = false;
      String taskSession = "";
      if (events != null) {
        for (int i = 0; i < events.length(); i++) {
          JSONObject ev = events.optJSONObject(i);
          if (ev == null) continue;
          if (ev.optInt("seq", 0) > since) {
            JSONObject full = ev.optJSONObject("event");
            if (isTaskDoneEvent(full)) {
              taskDone = true;
              if (taskSession.isEmpty()) taskSession = resolveSessionLabel(full);
            }
            if (isAssistantMessage(full)) newCount++;
          }
        }
      }
      SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
      if (taskDone && prefs.getBoolean(KEY_NOTIFY_TASK_DONE, true)) {
        showTaskDoneNotification(taskSession);
      } else if (newCount > 0) {
        showEventNotification(newCount);
      }

      int nextSeq = latestSeq;
      if (nextSeq < since) nextSeq = 0;
      if (nextSeq > since || nextSeq == 0) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putInt(seqKey(kind), nextSeq)
            .apply();
      }
      return 0;
    } catch (Exception e) {
      return 0;
    } finally {
      if (conn != null) conn.disconnect();
    }
  }

  private String seqKey(String kind) {
    return "mux".equals(kind) ? KEY_SEQ_MUX : KEY_SEQ_HOST;
  }

  private long readIntervalMs() {
    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    double minutes = prefs.getFloat(KEY_INTERVAL_MIN, 1f);
    if (minutes <= 0) minutes = 1;
    return (long) (minutes * 60_000L);
  }

  private static String readAll(InputStream in) throws Exception {
    StringBuilder sb = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) sb.append(line);
    }
    return sb.toString();
  }
}
