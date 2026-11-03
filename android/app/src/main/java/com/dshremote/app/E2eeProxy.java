package com.dshremote.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

/** Per-process loopback adapter for the packaged WebUI and background services. */
final class E2eeProxy implements Closeable {
  private final ServerSocket listener;
  private final ExecutorService workers = Executors.newFixedThreadPool(16);
  private final Semaphore slots = new Semaphore(8);
  private final Set<Closeable> sockets = Collections.synchronizedSet(new HashSet<Closeable>());
  private final URI relay;
  private final String route, pin, prefix, deviceHeader;
  private final long expiresAt;
  private final byte[] certificate;
  private final boolean encrypted;
  private volatile boolean closed;

  E2eeProxy(URI relay, String route, byte[] certificate, String pin) throws Exception {
    this(relay, route, certificate, pin, true);
  }
  E2eeProxy(URI relay, String route, byte[] certificate, String pin, boolean encrypted) throws Exception {
    this(relay, route, certificate, pin, encrypted, "", Long.MAX_VALUE);
  }
  E2eeProxy(URI relay, String route, byte[] certificate, String pin, boolean encrypted, String deviceHeader, long expiresAt) throws Exception {
    if (encrypted) E2eeTls.certificate(certificate, pin);
    this.encrypted = encrypted;
    if (!deviceHeader.isEmpty() && !deviceHeader.matches("[a-f0-9]{32}\\.[A-Za-z0-9_-]{43}")) throw new IOException("INVALID_E2EE_DEVICE_PAIRING");
    this.deviceHeader = deviceHeader; this.expiresAt = expiresAt;
    this.relay = relay; this.route = route; this.certificate = certificate.clone(); this.pin = pin;
    byte[] secret = new byte[24]; new SecureRandom().nextBytes(secret);
    StringBuilder value = new StringBuilder("/e2ee-"); for (byte b : secret) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); prefix = value.toString();
    listener = new ServerSocket(); listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 8);
    Thread thread = new Thread(this::accept, "DSH-e2ee-loopback"); thread.setDaemon(true); thread.start();
  }
  String base() { return "http://127.0.0.1:" + listener.getLocalPort() + prefix; }
  private void accept() {
    while (!closed) {
      try {
        Socket socket = listener.accept();
        if (!slots.tryAcquire()) { socket.close(); continue; }
        sockets.add(socket);
        try { workers.execute(() -> tunnel(socket)); } catch (RejectedExecutionException e) { slots.release(); sockets.remove(socket); socket.close(); }
      } catch (IOException error) { if (!closed) close(); }
    }
  }
  private void tunnel(Socket local) {
    E2eeTls.Transport channel = null;
    boolean forwarded = false;
    try {
      local.setSoTimeout(120000); local.setTcpNoDelay(true);
      String header = E2eeTls.readHeader(local.getInputStream(), 32768);
      int end = header.indexOf("\r\n"); String[] first = header.substring(0, end).split(" ", -1);
      if (first.length != 3 || !first[0].matches("GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS")
          || !"HTTP/1.1".equals(first[2]) || !first[1].startsWith(prefix + "/") || first[1].indexOf('#') >= 0) throw new IOException("E2EE_LOCAL_CAPABILITY_REQUIRED");
      if (System.currentTimeMillis() >= expiresAt) throw new IOException("E2EE_DEVICE_EXPIRED");
      StringBuilder request = new StringBuilder(first[0] + " " + first[1].substring(prefix.length()) + " HTTP/1.1\r\n");
      for (String line : header.substring(end + 2).split("\r\n")) {
        if (line.isEmpty()) continue;
        int colon = line.indexOf(':');
        if (colon < 1 || Character.isWhitespace(line.charAt(0))) throw new IOException("INVALID_HTTP_HEADER");
        if (!line.substring(0, colon).equalsIgnoreCase("x-dsh-relay-device")) request.append(line).append("\r\n");
      }
      if (!deviceHeader.isEmpty()) request.append("X-DSH-Relay-Device: ").append(deviceHeader).append("\r\n");
      request.append("\r\n");
      channel = E2eeTls.open(relay, route, certificate, pin, encrypted);
      if (closed) throw new IOException("E2EE_PROXY_CLOSED");
      sockets.add(channel); final E2eeTls.Transport connected = channel;
      // Open the authenticated inner stream before forwarding any HTTP header.
      byte[] headers = request.toString().getBytes(StandardCharsets.ISO_8859_1); channel.write(headers, 0, headers.length); forwarded = true;
      workers.execute(() -> {
        try {
          byte[] data = new byte[16384]; int n;
          while ((n = connected.read(data)) >= 0) { local.getOutputStream().write(data, 0, n); local.getOutputStream().flush(); }
        } catch (IOException ignored) { /* Connection loss is handled by the app's existing recovery. */ }
        finally { try { local.close(); connected.close(); } catch (IOException ignored) {} }
      });
      byte[] data = new byte[16384]; int n;
      while ((n = local.getInputStream().read(data)) >= 0) channel.write(data, 0, n);
    } catch (Exception error) {
      if (!forwarded) try { local.getOutputStream().write("HTTP/1.1 503 E2EE Connection Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); } catch (IOException ignored) {}
    } finally {
      try { local.close(); } catch (IOException ignored) {}
      if (channel != null) { sockets.remove(channel); try { channel.close(); } catch (IOException ignored) {} }
      sockets.remove(local); slots.release();
    }
  }
  public void close() {
    closed = true;
    try { listener.close(); } catch (IOException ignored) {}
    synchronized (sockets) { for (Closeable socket : sockets) try { socket.close(); } catch (IOException ignored) {} sockets.clear(); }
    workers.shutdownNow();
  }
}
