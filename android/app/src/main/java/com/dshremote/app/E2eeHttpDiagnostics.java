package com.dshremote.app;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;

/** Bounded, in-memory HTTP facts for the diagnostics export. */
final class E2eeHttpDiagnostics {
  private static final int LIMIT = 64;
  private static final int HEADER_LIMIT = 16 * 1024;
  private static final long MAX_AGE_MS = 15 * 60 * 1000;
  private static final ArrayDeque<Trace> traces = new ArrayDeque<>();

  private E2eeHttpDiagnostics() {}

  static synchronized Trace classify(Trace trace, String method, String target) {
    int query = target.indexOf('?');
    String path = query < 0 ? target : target.substring(0, query);
    if ("OPTIONS".equals(method) || "POST".equals(method)) {
      if ("/api/session.list".equals(path)) return trace.route(method, "session.list");
      if ("/api/session.history".equals(path)) return trace.route(method, "session.history");
      if ("/api/ws-ticket".equals(path)) return trace.route(method, "ws-ticket");
    }
    if ("/api/operations".equals(path) && ("OPTIONS".equals(method) || "POST".equals(method) || "GET".equals(method))) {
      return trace.route(method, "operations");
    }
    traces.remove(trace);
    return null;
  }

  static Trace accepted(long proxyId, long acceptNumber) {
    return add(new Trace(proxyId, acceptNumber, "accepted"));
  }

  static void listenerClosed(long proxyId) { add(new Trace(proxyId, 0, "listener-closed")).fail("listener-closed", 0); }

  private static synchronized Trace add(Trace trace) {
    while (traces.size() >= LIMIT) traces.removeFirst();
    traces.addLast(trace);
    return trace;
  }

  static synchronized String snapshot() {
    long now = System.currentTimeMillis();
    StringBuilder json = new StringBuilder("[");
    for (Trace trace : traces) {
      if (now - trace.at > MAX_AGE_MS) continue;
      if (json.length() > 1) json.append(',');
      trace.append(json);
    }
    return json.append(']').toString();
  }

  static synchronized void clear() { traces.clear(); }

  static final class Trace {
    final long at = System.currentTimeMillis();
    private final long start = System.nanoTime();
    private final long proxyId, acceptNumber;
    private String method = "", route = "", stage, cors = "";
    private long duration = -1;
    private int status;
    private boolean forwarded, bodyForwarded;

    private Trace(long proxyId, long acceptNumber, String stage) {
      this.proxyId = proxyId;
      this.acceptNumber = acceptNumber;
      this.stage = stage;
    }
    synchronized Trace route(String method, String route) {
      this.method = method;
      this.route = route;
      stage = "received";
      return this;
    }
    synchronized void advance(String value) { if (duration < 0) stage = value; }
    synchronized void forwarded() { forwarded = true; advance("waiting-response"); }
    synchronized void bodyForwarded() { bodyForwarded = true; }

    synchronized void fail(String value, int localStatus) {
      if (duration >= 0) return;
      stage = value;
      status = localStatus;
      duration = elapsed();
    }

    synchronized void response(int httpStatus, String corsResult) {
      if (duration >= 0) return;
      stage = "response";
      status = httpStatus;
      cors = corsResult;
      duration = elapsed();
    }

    private long elapsed() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start); }

    synchronized void append(StringBuilder json) {
      // All strings here are constants selected by the parser, never header values.
      json.append("{\"at\":").append(at).append(",\"relayStage\":\"").append(stage).append('"')
          .append(",\"durationMs\":").append(duration < 0 ? elapsed() : duration)
          .append(",\"relayProxyId\":").append(proxyId)
          .append(",\"relayForwarded\":").append(forwarded);
      if (acceptNumber != 0) json.append(",\"relayAcceptNumber\":").append(acceptNumber);
      if (bodyForwarded) json.append(",\"relayBodyForwarded\":true");
      if (!method.isEmpty()) json.append(",\"httpMethod\":\"").append(method).append('"');
      if (!route.isEmpty()) json.append(",\"relayRoute\":\"").append(route).append('"');
      if (!cors.isEmpty()) json.append(",\"relayCors\":\"").append(cors).append('"');
      if (status != 0) json.append(",\"httpStatus\":").append(status);
      json.append('}');
    }
  }

  private static String headerValue(String headers, String name) {
    for (String line : headers.split("\\r\\n")) {
      int colon = line.indexOf(':');
      if (colon == name.length() && name.regionMatches(true, 0, line, 0, colon)) return line.substring(colon + 1).trim();
    }
    return null;
  }

  static long contentLength(String requestHeaders) {
    String value = headerValue(requestHeaders, "Content-Length");
    if (value == null) return -1;
    try { return Long.parseLong(value); } catch (NumberFormatException ignored) { return -1; }
  }

  /** Observes a response header across transport reads without consuming any bytes. */
  static final class Response {
    private static final byte[] END = {13, 10, 13, 10};
    private final Trace trace;
    private final String origin;
    private ByteArrayOutputStream header = new ByteArrayOutputStream(512);
    private int matched;

    Response(Trace trace, String requestHeaders) {
      this.trace = trace;
      origin = headerValue(requestHeaders, "Origin");
    }

    void observe(byte[] data, int length) {
      for (int i = 0; header != null && i < length; i++) {
        byte value = data[i];
        header.write(value);
        matched = value == END[matched] ? matched + 1 : value == 13 ? 1 : 0;
        if (matched == END.length) {
          String raw = new String(header.toByteArray(), StandardCharsets.ISO_8859_1);
          int status = 0;
          if (raw.length() >= 13 && raw.startsWith("HTTP/1.") && raw.charAt(8) == ' ') {
            try { status = Integer.parseInt(raw.substring(9, 12)); } catch (NumberFormatException ignored) {}
          }
          if (status >= 100 && status < 200 && status != 101) {
            header.reset();
            matched = 0;
            continue;
          }
          String allow = origin == null ? null : headerValue(raw, "Access-Control-Allow-Origin");
          String cors = origin == null ? "" : allow == null ? "missing" : origin.equals(allow) || "*".equals(allow) ? "allowed" : "mismatch";
          if (status >= 100 && status <= 599) trace.response(status, cors);
          else trace.fail("response-invalid", 0);
          header = null;
        } else if (header.size() >= HEADER_LIMIT) {
          trace.fail("response-header-limit", 0);
          header = null;
        }
      }
    }
  }
}
