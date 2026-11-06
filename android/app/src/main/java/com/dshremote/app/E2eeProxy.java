package com.dshremote.app;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

/**
 * Per-process loopback adapter for the packaged WebUI and background services.
 *
 * <p>Each HTTP request still gets its own fully handshaken channel, so every request keeps
 * fresh session keys and a fresh outer/inner TLS handshake. The only optimisation is that the
 * handshake happens ahead of time: a small pool of ready channels is kept warm while the app is
 * active, and a request takes one of them instead of paying the outer TLS + upgrade + inner TLS
 * 1.3 round trips on its critical path. Pooled channels are used exactly once and then closed.</p>
 */
final class E2eeProxy implements Closeable {
  /** Concurrent in-flight requests. Bursts above the old limit of 8 used to be reset instead of answered. */
  private static final int SLOTS = 32;
  /** Ready channels kept for the next burst. Each one consumes one relay work channel on the host. */
  private static final int READY_TARGET = 4;
  /** The host E2eeEndpoint closes connections whose HTTP headers never arrive within 15s. */
  private static final long READY_TTL_MS = 12000;
  /** Keep the full stock only while requests keep arriving; a lone background poll tops up one. */
  private static final long BURST_GAP_MS = 2000;
  private static final long BURST_HOLD_MS = 5000;
  private static final int READY_SINGLE = 1;
  /** Warm a couple of channels when the app returns to the foreground, before the first tap. */
  private static final int READY_WARM = 2;
  private static final long WARM_HOLD_MS = 8000;
  private static final long DEMAND_WINDOW_MS = 15000;
  private static final long REFILL_IDLE_MS = 200;
  private static final long REFILL_RETRY_MS = 750;
  private static final long SLOT_WAIT_MS = 250;

  private final ServerSocket listener;
  private final ExecutorService tunnels;
  private final ExecutorService readers;
  private final Semaphore slots = new Semaphore(SLOTS);
  private final Set<Closeable> sockets = Collections.synchronizedSet(new HashSet<Closeable>());
  private final Deque<Ready> ready = new ArrayDeque<>();
  private final Object readyLock = new Object();
  private final URI relay;
  private final String route, pin, prefix, deviceHeader;
  private final long expiresAt;
  private final byte[] certificate;
  private final boolean encrypted;
  private final Thread pooler;
  private volatile boolean closed;
  private volatile long lastRequestAt;
  private volatile long activeUntil;
  private volatile long warmUntil;

  private static final class Ready {
    final E2eeTls.Transport transport;
    final long at;
    Ready(E2eeTls.Transport transport, long at) { this.transport = transport; this.at = at; }
  }

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
    listener = new ServerSocket(); listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 64);
    tunnels = cached(SLOTS, "DSH-e2ee-tunnel");
    readers = cached(SLOTS + 8, "DSH-e2ee-reader");
    pooler = new Thread(this::poolLoop, "DSH-e2ee-pool"); pooler.setDaemon(true); pooler.start();
    Thread thread = new Thread(this::accept, "DSH-e2ee-loopback"); thread.setDaemon(true); thread.start();
  }
  private static ExecutorService cached(int max, String name) {
    return new ThreadPoolExecutor(0, max, 60L, TimeUnit.SECONDS, new SynchronousQueue<Runnable>(), task -> {
      Thread thread = new Thread(task, name); thread.setDaemon(true); return thread;
    });
  }
  String base() { return "http://127.0.0.1:" + listener.getLocalPort() + prefix; }

  /** Keep a small stock of handshaken channels. Channels that idle past the host's header deadline are dropped. */
  private void poolLoop() {
    while (!closed) {
      long now = System.currentTimeMillis();
      List<E2eeTls.Transport> stale = new ArrayList<>();
      int want;
      synchronized (readyLock) {
        for (Iterator<Ready> it = ready.iterator(); it.hasNext(); ) {
          Ready item = it.next();
          if (now - item.at > READY_TTL_MS) { it.remove(); stale.add(item.transport); }
        }
        int target = now <= activeUntil ? READY_TARGET
          : now <= warmUntil ? READY_WARM
          : lastRequestAt != 0 && now - lastRequestAt <= DEMAND_WINDOW_MS ? READY_SINGLE : 0;
        want = target - ready.size();
      }
      closeAll(stale);
      if (want <= 0) { sleep(REFILL_IDLE_MS); continue; }
      E2eeTls.Transport channel;
      try { channel = E2eeTls.open(relay, route, certificate, pin, encrypted); }
      catch (Exception error) { sleep(REFILL_RETRY_MS); continue; }
      synchronized (readyLock) {
        if (closed) { closeQuietly(channel); break; }
        ready.addLast(new Ready(channel, System.currentTimeMillis()));
      }
    }
    List<E2eeTls.Transport> left = new ArrayList<>();
    synchronized (readyLock) { for (Ready item : ready) left.add(item.transport); ready.clear(); }
    closeAll(left);
  }

  /** Take one ready channel, discarding any that aged past the TTL. Never blocks on a handshake. */
  private E2eeTls.Transport takeReady() {
    long now = System.currentTimeMillis();
    List<E2eeTls.Transport> stale = new ArrayList<>();
    E2eeTls.Transport taken = null;
    synchronized (readyLock) {
      while (!ready.isEmpty()) {
        Ready item = ready.pollFirst();
        if (now - item.at > READY_TTL_MS) stale.add(item.transport);
        else { taken = item.transport; break; }
      }
      long previous = lastRequestAt;
      lastRequestAt = now;
      if (previous != 0 && now - previous <= BURST_GAP_MS) activeUntil = now + BURST_HOLD_MS;
    }
    closeAll(stale);
    return taken;
  }

  /** Warm a couple of channels when the app comes back to the foreground, before the first tap. */
  void warm() { warmUntil = System.currentTimeMillis() + WARM_HOLD_MS; }

  private void accept() {
    while (!closed) {
      Socket socket = null;
      try {
        socket = listener.accept();
        if (!slots.tryAcquire(SLOT_WAIT_MS, TimeUnit.MILLISECONDS)) { busy(socket); continue; }
        sockets.add(socket);
        final Socket accepted = socket;
        try { tunnels.execute(() -> tunnel(accepted)); }
        catch (RejectedExecutionException error) { slots.release(); sockets.remove(socket); closeQuietly(socket); }
      } catch (InterruptedException error) {
        closeQuietly(socket); Thread.currentThread().interrupt(); break;
      } catch (IOException error) {
        closeQuietly(socket); if (!closed) close();
      }
    }
  }
  /** Answer with a retryable HTTP error instead of resetting the connection, so App retries stay meaningful. */
  private static void busy(Socket socket) {
    try {
      socket.getOutputStream().write("HTTP/1.1 503 E2EE Busy\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
    } catch (IOException ignored) { }
    closeQuietly(socket);
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
      channel = takeReady();
      if (channel == null) channel = E2eeTls.open(relay, route, certificate, pin, encrypted);
      if (closed) throw new IOException("E2EE_PROXY_CLOSED");
      sockets.add(channel); final E2eeTls.Transport connected = channel;
      // Open the authenticated inner stream before forwarding any HTTP header.
      byte[] headers = request.toString().getBytes(StandardCharsets.ISO_8859_1); channel.write(headers, 0, headers.length); forwarded = true;
      try {
        readers.execute(() -> {
          try {
            byte[] data = new byte[16384]; int n;
            while ((n = connected.read(data)) >= 0) { local.getOutputStream().write(data, 0, n); local.getOutputStream().flush(); }
          } catch (IOException ignored) { /* Connection loss is handled by the app's existing recovery. */ }
          finally { try { local.close(); connected.close(); } catch (IOException ignored) {} }
        });
      } catch (RejectedExecutionException error) {
        closeQuietly(connected);
        throw new IOException("E2EE_READER_BUSY");
      }
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
  private static void closeQuietly(Closeable closeable) { if (closeable == null) return; try { closeable.close(); } catch (IOException ignored) { } }
  private static void closeAll(List<E2eeTls.Transport> channels) { for (E2eeTls.Transport channel : channels) closeQuietly(channel); }
  private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } }
  @Override public void close() {
    closed = true;
    pooler.interrupt();
    try { listener.close(); } catch (IOException ignored) {}
    List<E2eeTls.Transport> pooled = new ArrayList<>();
    synchronized (readyLock) { for (Ready item : ready) pooled.add(item.transport); ready.clear(); }
    closeAll(pooled);
    synchronized (sockets) { for (Closeable socket : sockets) closeQuietly(socket); sockets.clear(); }
    tunnels.shutdownNow();
    readers.shutdownNow();
  }
}
