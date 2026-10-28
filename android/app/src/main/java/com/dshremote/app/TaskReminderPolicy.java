package com.dshremote.app;

/** Per-session turn state, shared by foreground events and background polling. */
final class TaskReminderPolicy {
  static final int NONE = 0, TURN = 1, GOAL = 2, ERROR = 3;
  long run;
  boolean running;
  boolean hostKnown;
  int posted;

  int accept(String type, Boolean active, boolean replay) {
    if ("goal/cleared".equals(type)) return NONE;
    // Only the global host stream owns lifecycle boundaries. Session logs may
    // arrive after the corresponding host cycle (or before it); counting both
    // streams manufactures extra runs. Goals/errors can refine a known run.
    boolean hostStatus = "host/session-status".equals(type);
    if (hostStatus && active != null && active) {
      // Old RCs counted session events too. Adopt their existing first cycle
      // quietly instead of recounting a delayed host start after an upgrade.
      if (!running && (hostKnown || run == 0)) { run++; posted = NONE; }
      hostKnown = true;
      running = true;
      return NONE;
    }
    int result = "host/agent-error".equals(type) || "agent/error".equals(type) ? ERROR
        : "goal/completed".equals(type) ? GOAL
        : hostStatus && active != null && !active ? TURN : NONE;
    if (result == NONE) return NONE;
    if (!hostStatus && !"host/agent-error".equals(type)) {
      if (replay || run == 0 || result == GOAL && !running) return NONE;
    }
    boolean observedRun = running || run > 0;
    if (hostStatus || "host/agent-error".equals(type)) { running = false; hostKnown = true; }
    // A snapshot saying "idle" is not evidence of a newly finished task.
    if (replay || !observedRun && result == TURN) { posted = Math.max(posted, result); return NONE; }
    return result > posted ? result : NONE;
  }

  void delivered(int result) { posted = Math.max(posted, result); }
}
