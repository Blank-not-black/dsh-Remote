package com.dshremote.app;

/** Timestamp policy shared by the receiver and dependency-free JVM tests. */
public final class PeakReminderPolicy {
  private PeakReminderPolicy() {}
  public static boolean isDue(long now, long notifyAt, long at, long validUntil, long lastFiredAt) {
    return now > 0 && notifyAt > 0 && at >= notifyAt && at - notifyAt <= 30L * 60000
        && at > lastFiredAt && now >= notifyAt && now <= at + 30L * 60000 && now <= validUntil;
  }
}
