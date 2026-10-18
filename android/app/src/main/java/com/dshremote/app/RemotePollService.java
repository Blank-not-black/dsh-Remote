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
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.zip.GZIPInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * 前台服务：App 退后台后定时轮询网关事件。
 *
 * Doze 说明：灭屏后系统会冻结后台任务，实际轮询间隔可能被拉长。
 * 返回前台会恢复已启用的服务；启动失败与系统时限会保留可诊断状态。
 */
public class RemotePollService extends Service {

  private static final String PREFS = "dsh_remote_bg";
  private static final String KEY_ENABLED = "enabled";
  private static final String KEY_INTERVAL_MIN = "interval_min";
  private static final String KEY_BASE = "base";
  private static final String KEY_TOKEN = "token";
  private static final String KEY_CLIENT_ID = "client_id";
  private static final String KEY_LOGIN_EXPIRED = "login_expired";
  private static final String KEY_SEQ_MUX = "seq_mux";
  private static final String KEY_SEQ_HOST = "seq_host";
  private static final String KEY_NOTIFY_TASK_DONE = "notify_task_done";

  private static final String CHANNEL_ID = "dsh_remote_background";
  private static final int NOTIFICATION_ID = 1001;
  private static final int EVENT_NOTIFICATION_ID = 1002;
  private static final int TASK_DONE_NOTIFICATION_ID = 1003;
  private static final String[] KINDS = {"mux", "host"};
  private static volatile boolean running = false;
  private static long startingAt = 0;

  public static boolean isRunning() { return running; }

  public static synchronized boolean restoreIfEnabled(Context context, boolean refresh) {
    SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    if (!prefs.getBoolean(KEY_ENABLED, false) || prefs.getBoolean(KEY_LOGIN_EXPIRED, false)
        || prefs.getString(KEY_BASE, "").isEmpty() || prefs.getString(KEY_TOKEN, "").isEmpty()) return false;
    long now = android.os.SystemClock.elapsedRealtime();
    if (!refresh && (running || startingAt > 0 && now - startingAt < 10000)) return true;
    startingAt = now;
    prefs.edit().putString("service_state", "starting").remove("service_error").apply();
    try {
      Intent intent = new Intent(context, RemotePollService.class);
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
      else context.startService(intent);
      return true;
    } catch (RuntimeException error) {
      startingAt = 0;
      prefs.edit().putString("service_state", "start-failed").putString("service_error", error.getClass().getSimpleName()).apply();
      android.util.Log.w("DshRemotePoll", "Unable to start background receiver: " + error.getClass().getSimpleName());
      return false;
    }
  }

  private HandlerThread thread;
  private Handler handler;
  private ExecutorService pollExecutor;
  private ConnectivityManager connectivityManager;
  private volatile boolean longPollSupported = false;
  private volatile boolean stopped = false;
  private int authFailures = 0;
  private volatile int generation = 0;
  private String pollingIdentity = "";

  @Override
  public void onCreate() {
    super.onCreate();
    createChannel();
    thread = new HandlerThread("RemotePollService");
    thread.start();
    handler = new Handler(thread.getLooper());
    pollExecutor = Executors.newFixedThreadPool(2);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      connectivityManager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
      try {
        if (connectivityManager != null) connectivityManager.registerDefaultNetworkCallback(networkCallback);
      } catch (Exception ignored) {}
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    generation++;
    stopped = false;
    try {
      startForegroundWithNotification();
      running = true;
      startingAt = 0;
      getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("service_state", "running").remove("service_error").apply();
    } catch (RuntimeException error) {
      running = false;
      startingAt = 0;
      stopped = true;
      getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("service_state", "start-failed").putString("service_error", error.getClass().getSimpleName()).apply();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (handler != null) {
      handler.removeCallbacksAndMessages(null);
      handler.post(pollRunnable);
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopped = true;
    running = false;
    startingAt = 0;
    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    if ("running".equals(prefs.getString("service_state", ""))) prefs.edit().putString("service_state", "stopped").apply();
    if (handler != null) handler.removeCallbacksAndMessages(null);
    if (pollExecutor != null) pollExecutor.shutdownNow();
    if (connectivityManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      try { connectivityManager.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) {}
    }
    if (thread != null) thread.quitSafely();
    super.onDestroy();
  }

  @Override
  public void onTimeout(int startId, int foregroundServiceType) {
    // Android 15 dataSync budget is finite. Stop cleanly instead of crashing;
    // a later visible Activity can restore the user's enabled receiver.
    stopped = true;
    running = false;
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("service_state", "system-timeout").apply();
    stopForeground(true);
    stopSelf();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
    @Override
    public void onAvailable(Network network) {
      if (handler == null) return;
      handler.post(() -> {
        if (stopped) return;
        handler.removeCallbacks(pollRunnable);
        handler.post(pollRunnable);
      });
    }
  };

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
    if ("host/session-status".equals(type)) return !payload.optBoolean("running", true);
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
      int currentGeneration = generation;
      boolean healthy = pollOnce();
      if (stopped || generation != currentGeneration) return;
      handler.postDelayed(this, healthy && longPollSupported ? 250L : readIntervalMs());
    }
  };

  private boolean pollOnce() {
    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!prefs.getBoolean(KEY_ENABLED, false)) {
      stopped = true;
      stopSelf();
      return false;
    }
    String base = prefs.getString(KEY_BASE, "");
    String token = prefs.getString(KEY_TOKEN, "");
    String clientId = prefs.getString(KEY_CLIENT_ID, "");
    String identity = base + "\n" + token;
    if (!identity.equals(pollingIdentity)) { pollingIdentity = identity; authFailures = 0; longPollSupported = false; }
    if (base.isEmpty() || token.isEmpty()) {
      stopped = true;
      stopSelf();
      return false;
    }
    List<Future<Integer>> futures = new ArrayList<>();
    for (String kind : KINDS) {
      int since = prefs.getInt(seqKey(kind), 0);
      futures.add(pollExecutor.submit(() -> pollKind(base, token, clientId, kind, since)));
    }
    boolean authFailed = false;
    boolean healthy = true;
    try {
      for (Future<Integer> future : futures) {
        int result = future.get();
        authFailed |= result == 401;
        healthy &= result == 200;
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return false;
    } catch (Exception ignored) {
      // 单个通道失败不应阻塞另一个通道；下一轮继续增量拉取。
      healthy = false;
    }
    if (stopped || !base.equals(prefs.getString(KEY_BASE, "")) || !token.equals(prefs.getString(KEY_TOKEN, ""))) return false;
    if (authFailed) {
      authFailures++;
      if (authFailures >= 3) {
        prefs.edit().putBoolean(KEY_LOGIN_EXPIRED, true).putString("service_state", "auth-expired").apply();
        stopped = true;
        stopSelf();
        return false;
      }
    } else {
      authFailures = 0;
    }
    return healthy;
  }

  private int pollKind(String base, String token, String clientId, String kind, int since) {
    HttpURLConnection conn = null;
    try {
      String epoch = getSharedPreferences(PREFS, MODE_PRIVATE).getString("epoch_" + kind, "");
      String url = base.replaceAll("/+$", "")
          + "/api/events.poll?kind=" + kind + "&since=" + since + "&wait=25000&epoch=" + epoch.replaceAll("[^A-Za-z0-9_-]", "");
      conn = (HttpURLConnection) new URL(url).openConnection();
      conn.setRequestMethod("GET");
      conn.setConnectTimeout(10000);
      conn.setReadTimeout(45000);
      conn.setRequestProperty("Accept-Encoding", "gzip");
      conn.setRequestProperty("Authorization", "Bearer " + token);
      conn.setRequestProperty("X-Dsh-Remote-Client", "app");
      if (clientId != null && !clientId.isEmpty()) {
        conn.setRequestProperty("X-Dsh-Remote-Client-Id", clientId);
      }

      int code = conn.getResponseCode();
      getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("last_http_status", code).apply();
      if (code == 401) return 401;
      if (code != 200) return 0;

      InputStream stream = conn.getInputStream();
      if ("gzip".equalsIgnoreCase(conn.getContentEncoding())) stream = new GZIPInputStream(stream);
      String body = readAll(stream);
      JSONObject obj = new JSONObject(body);
      synchronized (PendingNotifications.class) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (stopped || !prefs.getBoolean(KEY_ENABLED, false) || !base.equals(prefs.getString(KEY_BASE, "")) || !token.equals(prefs.getString(KEY_TOKEN, ""))) return 0;
        prefs.edit().putLong("last_success_at", System.currentTimeMillis()).apply();
        if (obj.optBoolean("waitSupported", false)) longPollSupported = true;
        JSONArray events = obj.optJSONArray("events");
        int latestSeq = obj.optInt("latestSeq", since);
        String currentEpoch = obj.optString("epoch", "");
        boolean reset = obj.optBoolean("reset", false) || (!epoch.isEmpty() && !currentEpoch.isEmpty() && !epoch.equals(currentEpoch))
            || obj.optBoolean("truncated", false) || latestSeq < since;
        JSONArray baseline = obj.optJSONArray("baseline");
        if (baseline != null) for (int i = 0; i < baseline.length(); i++) {
          JSONObject full = baseline.optJSONObject(i);
          if (full != null) PendingNotifications.handle(this, base, token, full, prefs.getBoolean("notify_pending", false));
        }
        int effectiveSince = reset ? 0 : since;
        int newCount = 0;
        boolean taskDone = false;
        String taskSession = "";
        if (events != null) {
          for (int i = 0; i < events.length(); i++) {
            JSONObject ev = events.optJSONObject(i);
            if (ev == null) continue;
            if (ev.optInt("seq", 0) > effectiveSince) {
              JSONObject full = ev.optJSONObject("event");
              if (full != null) PendingNotifications.handle(this, base, token, full, prefs.getBoolean("notify_pending", false));
              if (isTaskDoneEvent(full)) {
                taskDone = true;
                if (taskSession.isEmpty()) taskSession = resolveSessionLabel(full);
              }
              if (isAssistantMessage(full)) newCount++;
            }
          }
        }
        if (taskDone && prefs.getBoolean(KEY_NOTIFY_TASK_DONE, true)) {
          showTaskDoneNotification(taskSession);
        } else if (newCount > 0) {
          showEventNotification(newCount);
        }

        int nextSeq = latestSeq;
        if (nextSeq > since || nextSeq == 0 || reset) {
          getSharedPreferences(PREFS, MODE_PRIVATE)
              .edit()
              .putInt(seqKey(kind), nextSeq)
              .putString("epoch_" + kind, currentEpoch)
              .apply();
        }
        return 200;
      }
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
    double minutes = prefs.getFloat(KEY_INTERVAL_MIN, 0.5f);
    if (minutes <= 0) minutes = 0.5;
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
