package com.dshremote.app;

/** Per-session turn state, shared by foreground events and background polling. */
final class TaskReminderPolicy {
  static final int NONE = 0, TURN = 1, GOAL = 2, ERROR = 3;
  long run;
  boolean running;
  int posted;

  int accept(String type, Boolean active, boolean replay) {
    if ("goal/cleared".equals(type)) return NONE;
    if (active != null && active) {
      if (!running) { run++; posted = NONE; }
      running = true;
      return NONE;
    }
    int result = "host/agent-error".equals(type) || "agent/error".equals(type) ? ERROR
        : "goal/completed".equals(type) ? GOAL
        : "turn/end".equals(type) || active != null && !active ? TURN : NONE;
    if (result == NONE) return NONE;
    boolean observedRun = running || run > 0;
    // A goal may finish before the enclosing turn. Keep that turn active so a
    // later host "running" snapshot cannot manufacture a second run.
    if (result != GOAL) running = false;
    // A snapshot saying "idle" is not evidence of a newly finished task.
    if (replay || !observedRun && result == TURN) { posted = Math.max(posted, result); return NONE; }
    return result > posted ? result : NONE;
  }

  void delivered(int result) { posted = Math.max(posted, result); }
}
