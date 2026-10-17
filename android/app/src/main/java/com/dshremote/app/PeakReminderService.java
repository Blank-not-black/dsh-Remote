package com.dshremote.app;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** Retired: reminders are managed by dsh-cost-meter in DSH. */
public class PeakReminderService extends Service {
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    stopForeground(true);
    stopSelf();
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) { return null; }
}
