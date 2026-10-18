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
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** Android delivery only. All transition times come from dsh-cost-meter on the host. */
public class PeakReminderService extends Service {
  static final String PREFS = "dsh_remote_peak";
  private static final String FOREGROUND_CHANNEL = "dsh_remote_peak_receiver";
  private static final String ALERT_CHANNEL = "dsh_remote_peak_events";
  private static final int FOREGROUND_ID = 8810;
  private static volatile boolean running = false;
  private static long startingAt = 0;
  private HandlerThread thread;
  private Handler handler;
  private volatile boolean stopped;
  private volatile HttpURLConnection connection;
  private long nextFetchAt;

  public static boolean isRunning() { return running; }
  public static synchronized boolean restoreIfEnabled(Context context, boolean refresh) {
    SharedPreferences p = context.getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!p.getBoolean("enabled", false) || p.getString("base", "").isEmpty() || p.getString("token", "").isEmpty()) return false;
    long now = android.os.SystemClock.elapsedRealtime();
    if (!refresh && (running || startingAt > 0 && now - startingAt < 10000)) return true;
    startingAt = now;
    try {
      Intent intent = new Intent(context, PeakReminderService.class);
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
      return true;
    } catch (RuntimeException error) {
      startingAt = 0;
      p.edit().putString("status", "start-failed").apply();
      return false;
    }
  }

  @Override public void onCreate() {
    super.onCreate();
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= 26 && nm != null) {
      nm.createNotificationChannel(new NotificationChannel(FOREGROUND_CHANNEL, "峰谷提醒后台接收", NotificationManager.IMPORTANCE_LOW));
      nm.createNotificationChannel(new NotificationChannel(ALERT_CHANNEL, "峰谷计费提醒", NotificationManager.IMPORTANCE_HIGH));
    }
    thread = new HandlerThread("DshPeakReminders"); thread.start(); handler = new Handler(thread.getLooper());
  }
  private Notification notification(String channel, String title, String body, boolean ongoing) {
    Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(this, 8810, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
    return b.setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(body).setContentIntent(pi).setOngoing(ongoing).setAutoCancel(!ongoing).build();
  }
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!p.getBoolean("enabled", false)) { stopSelf(); return START_NOT_STICKY; }
    try {
      Notification note = notification(FOREGROUND_CHANNEL, "DSH Remote · 峰谷提醒", "使用 dsh-cost-meter 的时间与提醒规则", true);
      if (Build.VERSION.SDK_INT >= 29) startForeground(FOREGROUND_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC); else startForeground(FOREGROUND_ID, note);
      running = true; stopped = false; startingAt = 0; nextFetchAt = 0;
      handler.removeCallbacksAndMessages(null); handler.post(check);
      return START_STICKY;
    } catch (RuntimeException error) {
      p.edit().putString("status", "start-failed").apply(); running = false; startingAt = 0; stopSelf(); return START_NOT_STICKY;
    }
  }
  private final Runnable check = new Runnable() { @Override public void run() {
    if (stopped) return;
    SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
    if (!p.getBoolean("enabled", false)) { stopSelf(); return; }
    long now = System.currentTimeMillis();
    if (now >= nextFetchAt) { nextFetchAt = now + 5 * 60000; refresh(p); }
    if (!stopped) { deliver(p, System.currentTimeMillis()); handler.postDelayed(this, 30000); }
  }};
  private void refresh(SharedPreferences p) {
    String base = p.getString("base", ""), token = p.getString("token", "");
    HttpURLConnection c = null;
    try {
      URL url = new URL(base.replaceAll("/+$", "") + "/remote/api/insights/peak-reminders");
      if (!"http".equals(url.getProtocol()) && !"https".equals(url.getProtocol())) throw new Exception("scheme");
      c = (HttpURLConnection) url.openConnection(); connection = c;
      c.setInstanceFollowRedirects(false); c.setConnectTimeout(10000); c.setReadTimeout(10000);
      c.setRequestProperty("Authorization", "Bearer " + token); c.setRequestProperty("X-Dsh-Remote-Client", "app");
      c.setRequestProperty("X-Dsh-Remote-Client-Id", p.getString("client_id", ""));
      if (c.getResponseCode() != 200) throw new Exception("http");
      byte[] bytes;
      try (InputStream in = c.getInputStream(); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
        byte[] buffer = new byte[4096]; int n;
        while ((n = in.read(buffer)) != -1) { if (out.size() + n > 131072) throw new Exception("large"); out.write(buffer,0,n); }
        bytes = out.toByteArray();
      }
      JSONObject data = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      synchronized (PeakReminderService.class) {
        if (stopped || !base.equals(p.getString("base", "")) || !token.equals(p.getString("token", ""))) return;
        storeSchedule(p, data);
      }
    } catch (Exception error) { if (!stopped && base.equals(p.getString("base", "")) && token.equals(p.getString("token", ""))) p.edit().putString("status", "offline").apply(); }
    finally { if (c != null) c.disconnect(); if (connection == c) connection = null; }
  }
  static boolean storeSchedule(SharedPreferences p, JSONObject data) {
    long now = System.currentTimeMillis(), generated = data.optLong("generatedAt",0), validUntil = data.optLong("validUntil",0);
    JSONArray events = data.optJSONArray("events");
    if (!data.optBoolean("ok") || data.optInt("schema") != 1 || !"dsh-cost-meter".equals(data.optString("source")) || !data.optBoolean("available")) {
      p.edit().remove("schedule").putString("status", "plugin-unavailable").apply(); return false;
    }
    if (generated > now + 5*60000 || generated < now - 86400000 || validUntil <= now || validUntil > generated + 8*86400000L || events == null || events.length() > 64) return false;
    for (int i=0;i<events.length();i++) {
      JSONObject e=events.optJSONObject(i);
      if (e == null || e.optLong("at",0) <= 0 || e.optLong("at",0) > validUntil || !e.has("intoPeak") || e.optLong("notifyAt",0) <= 0 || e.optLong("notifyAt",0) > e.optLong("at",0) || e.optLong("at",0)-e.optLong("notifyAt",0) > 30*60000) return false;
    }
    p.edit().putString("schedule", data.toString()).putLong("last_sync_at",now).putString("status",data.optBoolean("enabled")?"ready":"plugin-disabled").apply(); return true;
  }
  private void deliver(SharedPreferences p, long now) {
    synchronized (PeakReminderService.class) {
      if (stopped || !p.getBoolean("enabled",false)) return;
      try {
        JSONObject schedule = new JSONObject(p.getString("schedule", "{}"));
        if (!schedule.optBoolean("enabled")) return;
        JSONArray events = schedule.optJSONArray("events"); if (events == null) return;
        for (int i=0;i<events.length();i++) {
          JSONObject e=events.optJSONObject(i); if(e==null) continue;
          long at=e.optLong("at"), notifyAt=e.optLong("notifyAt");
          if (!PeakReminderPolicy.isDue(now,notifyAt,at,schedule.optLong("validUntil"),p.getLong("last_fired_at",0))) continue;
          NotificationManager nm=getSystemService(NotificationManager.class);
          if(nm==null || Build.VERSION.SDK_INT>=24 && !nm.areNotificationsEnabled()) return;
          if(Build.VERSION.SDK_INT>=26 && nm.getNotificationChannel(ALERT_CHANNEL)!=null && nm.getNotificationChannel(ALERT_CHANNEL).getImportance()==NotificationManager.IMPORTANCE_NONE) return;
          SimpleDateFormat format=new SimpleDateFormat("MM-dd HH:mm",Locale.CHINA); format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
          boolean peak=e.optBoolean("intoPeak"); String phase=peak?"峰时":"谷时";
          nm.notify(peak?8811:8812,notification(ALERT_CHANNEL,"DSH Remote · "+(now<at?"即将进入":"已进入")+phase,
              format.format(new Date(at))+"（北京时间）· dsh-cost-meter",false));
          p.edit().putLong("last_fired_at",at).apply();
        }
      } catch(Exception ignored) {}
    }
  }
  @Override public void onTimeout(int startId,int type) { stopped=true;running=false;getSharedPreferences(PREFS,MODE_PRIVATE).edit().putString("status","system-timeout").apply();stopForeground(true);stopSelf(); }
  @Override public void onDestroy() { stopped=true;running=false;startingAt=0;if(handler!=null)handler.removeCallbacksAndMessages(null);if(connection!=null)connection.disconnect();if(thread!=null)thread.quitSafely();super.onDestroy(); }
  @Override public IBinder onBind(Intent intent) { return null; }
}
