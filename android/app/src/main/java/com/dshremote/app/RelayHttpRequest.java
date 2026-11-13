package com.dshremote.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** HTTP requests through the paired Android loopback proxy. */
final class RelayHttpRequest {
  static final int MAX_OPERATION_BODY = 4 * 1024 * 1024;

  static final class Result {
    final int status;
    final String outcome, body;
    Result(int status, String outcome, String body) { this.status = status; this.outcome = outcome; this.body = body; }
  }

  static Result list(HttpURLConnection request, String authorization, String clientId, String rpcId) {
    // rpcId is validated by the bridge. The caller cannot change the method or payload.
    String body = "{\"type\":\"client-request\",\"rpcId\":\"" + rpcId
      + "\",\"method\":\"session.list\",\"payload\":{}}";
    return execute(request, "POST", authorization, clientId, body, 5000, 4 * 1024 * 1024, true);
  }

  static Result operation(HttpURLConnection request, String method, String authorization, String clientId, String body) {
    return execute(request, method, authorization, clientId, body, 14000, 1024 * 1024, false);
  }

  static Result history(HttpURLConnection request, String authorization, String clientId, String body) {
    return execute(request, "POST", authorization, clientId, body, 12000, 4 * 1024 * 1024, true);
  }

  static Result ticket(HttpURLConnection request, String authorization, String clientId) {
    return execute(request, "POST", authorization, clientId, "", 5000, 16 * 1024, false);
  }

  private static Result execute(HttpURLConnection request, String method, String authorization, String clientId,
      String body, int timeout, int responseLimit, boolean compressible) {
    int status = 0;
    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
    try {
      if (Thread.currentThread().isInterrupted()) return new Result(0, "native-aborted", "");
      request.setConnectTimeout(timeout);
      request.setReadTimeout(timeout);
      request.setInstanceFollowRedirects(false);
      request.setRequestMethod(method);
      request.setUseCaches(false);
      request.setRequestProperty("Connection", "close");
      // Android decodes gzip transparently when the caller leaves Accept-Encoding unset.
      if (!compressible) request.setRequestProperty("Accept-Encoding", "identity");
      request.setRequestProperty("Content-Type", "application/json");
      request.setRequestProperty("Authorization", authorization);
      request.setRequestProperty("X-DSH-Remote-Client", "app");
      if (!clientId.isEmpty()) request.setRequestProperty("X-DSH-Remote-Client-Id", clientId);
      if (body != null) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_OPERATION_BODY) return new Result(413, "native-response", "{\"error\":\"body-too-large\"}");
        request.setDoOutput(true);
        request.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = request.getOutputStream()) { out.write(bytes); }
      }
      status = request.getResponseCode();
      if (request.getContentLengthLong() > responseLimit) return new Result(status, "native-too-large", "");
      try (InputStream input = status >= 400 ? request.getErrorStream() : request.getInputStream();
          ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        if (input == null) return new Result(status, "native-response", "");
        byte[] chunk = new byte[8192];
        for (int size; (size = input.read(chunk)) != -1;) {
          if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline) throw new SocketTimeoutException();
          if (output.size() + size > responseLimit) return new Result(status, "native-too-large", "");
          output.write(chunk, 0, size);
        }
        return new Result(status, "native-response", output.toString("UTF-8"));
      }
    } catch (SocketTimeoutException error) {
      return new Result(status, "native-timeout", "");
    } catch (IOException error) {
      return new Result(status, "native-network", "");
    }
  }
}
