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

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 峰谷计费提醒前台服务。
 *
 * 用前台服务进程内定时代替 AlarmManager/LocalNotifications：
 * MIUI/HyperOS 后台限制会掐掉 setRepeating 的本地通知，
 * 前台服务常驻后不依赖“自启动/省电无限制”等 ROM 设置。
 */
public class PeakReminderService extends Service {

  private static final String CHANNEL_ID = "peak_remind";
  private static final int FOREGROUND_NOTIFICATION_ID = 8810;
  private static final String PREFS = "dsh_remote_peak";
  private static final String KEY_LAST_PREFIX = "last_fired_";
  private static final long CHECK_INTERVAL_MS = 30_000L;
  // 服务被 Doze/系统调度延迟后，仍允许补发最近一次切换提醒。
  private static final int CATCH_UP_WINDOW_SECONDS = 30 * 60;
  private static final TimeZone BEIJING_TIME_ZONE = TimeZone.getTimeZone("Asia/Shanghai");

  private static final Object[][] SLOTS = {
      {8801, 9, 0, "进入峰时 9:00-12:00"},
      {8802, 12, 0, "进入谷时 12:00-14:00"},
      {8803, 14, 0, "进入峰时 14:00-18:00"},
      {8804, 18, 0, "进入谷时 18:00-次日 9:00"},
  };

  private HandlerThread thread;
  private Handler handler;
  private volatile boolean stopped = false;

  @Override
  public void onCreate() {
    super.onCreate();
    createChannel();
    thread = new HandlerThread("PeakReminderService");
    thread.start();
    handler = new Handler(thread.getLooper());
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    stopped = false;
    startForegroundWithNotification();
    if (handler != null) {
      handler.removeCallbacksAndMessages(null);
      handler.post(checkRunnable);
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
        "峰谷提醒",
        NotificationManager.IMPORTANCE_HIGH);
    channel.setDescription("峰谷计费时段切换提醒");
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm != null) nm.createNotificationChannel(channel);
  }

  private void startForegroundWithNotification() {
    Notification notification = buildNotification(
        "DSH Remote",
        "峰谷提醒运行中",
        true);
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(FOREGROUND_NOTIFICATION_ID, notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(FOREGROUND_NOTIFICATION_ID, notification);
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

  private final Runnable checkRunnable = new Runnable() {
    @Override
    public void run() {
      if (stopped) return;
      long nextDelay = checkAndNotify();
      if (!stopped) handler.postDelayed(this, nextDelay);
    }
  };

  private long checkAndNotify() {
    Calendar now = Calendar.getInstance(BEIJING_TIME_ZONE);
    int hour = now.get(Calendar.HOUR_OF_DAY);
    int minute = now.get(Calendar.MINUTE);
    int second = now.get(Calendar.SECOND);
    int nowSeconds = hour * 3600 + minute * 60 + second;
    SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
    dateFormat.setTimeZone(BEIJING_TIME_ZONE);
    String today = dateFormat.format(new Date(now.getTimeInMillis()));
    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

    for (Object[] slot : SLOTS) {
      int id = (Integer) slot[0];
      int target = (Integer) slot[1] * 3600 + (Integer) slot[2] * 60;
      if (nowSeconds < target || nowSeconds >= target + CATCH_UP_WINDOW_SECONDS) continue;
      String key = KEY_LAST_PREFIX + id;
      if (today.equals(prefs.getString(key, ""))) continue;
      if (notifyPeak(id, (String) slot[3])) {
        prefs.edit().putString(key, today).apply();
      }
    }
    return nextCheckDelayMs(now);
  }

  /**
   * 临近切换点时保持 30 秒检查；距离较远时只需等到下一个切换点。
   * 即使系统把任务延后，下一次执行仍会通过补发窗口兜底。
   */
  private long nextCheckDelayMs(Calendar now) {
    long nowMs = now.getTimeInMillis();
    long nearestMs = Long.MAX_VALUE;
    for (int dayOffset = 0; dayOffset <= 1; dayOffset++) {
      for (Object[] slot : SLOTS) {
        Calendar target = (Calendar) now.clone();
        target.add(Calendar.DAY_OF_YEAR, dayOffset);
        target.set(Calendar.HOUR_OF_DAY, (Integer) slot[1]);
        target.set(Calendar.MINUTE, (Integer) slot[2]);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        long targetMs = target.getTimeInMillis();
        if (targetMs > nowMs && targetMs < nearestMs) nearestMs = targetMs;
      }
    }
    if (nearestMs == Long.MAX_VALUE) return CHECK_INTERVAL_MS;
    return Math.max(1_000L, Math.min(CHECK_INTERVAL_MS, nearestMs - nowMs));
  }

  private boolean notifyPeak(int id, String text) {
    Notification notification = buildNotification("DSH Remote", text, false);
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return false;
    if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return false;
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel channel = nm.getNotificationChannel(CHANNEL_ID);
      if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
    }
    try {
      nm.notify(id, notification);
      return true;
    } catch (SecurityException ignored) {
      return false;
    }
  }
}
