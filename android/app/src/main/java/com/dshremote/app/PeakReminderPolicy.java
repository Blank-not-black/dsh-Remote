package com.dshremote.app;

/** Timestamp policy shared by the receiver and dependency-free JVM tests. */
public final class PeakReminderPolicy {
  private PeakReminderPolicy() {}
  public static boolean isDue(long now, long notifyAt, long at, long validUntil, long lastFiredAt) {
    return now > 0 && notifyAt > 0 && at >= notifyAt && at - notifyAt <= 30L * 60000
        && at > lastFiredAt && now >= notifyAt && now <= at + 30L * 60000 && now <= validUntil;
  }
  /** Only replay the host's complete timeline; alert filtering must not determine current phase. */
  public static int phaseAt(long now, long generatedAt, long validUntil, boolean initialPeak, long[] times, boolean[] peaks) {
    if (generatedAt <= 0 || now < generatedAt || now > validUntil || times == null || peaks == null || times.length != peaks.length || times.length > 512) return -1;
    int phase = initialPeak ? 1 : 0;
    long previous = generatedAt;
    for (int i = 0; i < times.length; i++) {
      if (times[i] <= previous || times[i] > validUntil) return -1;
      if (times[i] <= now) phase = peaks[i] ? 1 : 0;
      previous = times[i];
    }
    return phase;
  }
  public static String phaseLabel(int phase) { return phase == 1 ? "当前峰时" : phase == 0 ? "当前谷时" : "峰谷状态未知"; }
}
