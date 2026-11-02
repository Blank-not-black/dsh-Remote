package com.dshremote.app;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/** System TLS over an outer HTTPS stream. No platform-specific descriptor layering. */
public final class E2eeTls {
  private E2eeTls() {}
  public static final String NAME = "dsh-remote-e2ee.local";
  private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(task -> {
    Thread thread = new Thread(task, "DSH-e2ee-handshake-deadline"); thread.setDaemon(true); return thread;
  });

  public static X509Certificate certificate(byte[] der, String pin) throws Exception {
    if (der.length > 8192 || !pin.matches("[a-f0-9]{64}")) throw new IOException("INVALID_E2EE_PAIRING");
    X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    if (!fingerprint(cert).equals(pin)) throw new IOException("E2EE_PIN_MISMATCH");
    verify(cert, pin);
    return cert;
  }
  static String fingerprint(X509Certificate cert) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
    StringBuilder out = new StringBuilder(); for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString();
  }
  static void verify(X509Certificate cert, String pin) throws Exception {
    cert.checkValidity();
    if (!MessageDigest.isEqual(fingerprint(cert).getBytes(StandardCharsets.US_ASCII), pin.getBytes(StandardCharsets.US_ASCII))) throw new CertificateException("E2EE_PIN_MISMATCH");
    boolean named = false;
    Collection<List<?>> names = cert.getSubjectAlternativeNames();
    if (names != null) for (List<?> name : names) if (Integer.valueOf(2).equals(name.get(0)) && NAME.equalsIgnoreCase(String.valueOf(name.get(1)))) named = true;
    if (!named) throw new CertificateException("E2EE_HOSTNAME_MISMATCH");
  }
  public static Channel connect(URI relay, String routeToken, byte[] der, String pin) throws Exception {
    return connect(relay, routeToken, der, pin, (SSLSocketFactory) SSLSocketFactory.getDefault());
  }
  // Test-only package overload can trust a local fixture CA. The Android bridge
  // always calls the public overload using the system outer HTTPS trust store.
  static Channel connect(URI relay, String routeToken, byte[] der, String pin, SSLSocketFactory outerFactory) throws Exception {
    return (Channel) connectTransport(relay, routeToken, der, pin, true, outerFactory);
  }
  public static Transport open(URI relay, String routeToken, byte[] der, String pin, boolean encrypted) throws Exception {
    return connectTransport(relay, routeToken, der, pin, encrypted, (SSLSocketFactory) SSLSocketFactory.getDefault());
  }
  private static Transport connectTransport(URI relay, String routeToken, byte[] der, String pin, boolean encrypted, SSLSocketFactory outerFactory) throws Exception {
    if (encrypted) certificate(der, pin); // No automatic fallback on validation failure.
    if (!"https".equals(relay.getScheme()) || relay.getHost() == null || relay.getRawUserInfo() != null
        || !"/relay/v1/e2ee".equals(relay.getRawPath()) || relay.getRawQuery() != null || relay.getRawFragment() != null
        || !routeToken.matches("[A-Za-z0-9_-]{43}")) throw new IOException("INVALID_E2EE_PAIRING");
    SSLSocket outer = (SSLSocket) outerFactory.createSocket();
    ScheduledFuture<?> deadline = DEADLINES.schedule(() -> { try { outer.close(); } catch (IOException ignored) {} }, 10000, TimeUnit.MILLISECONDS);
    try {
      int port = relay.getPort() < 0 ? 443 : relay.getPort();
      outer.connect(new InetSocketAddress(relay.getHost(), port), 10000); outer.setSoTimeout(10000);
      SSLParameters params = outer.getSSLParameters(); params.setEndpointIdentificationAlgorithm("HTTPS"); outer.setSSLParameters(params); outer.startHandshake();
      String host = relay.getHost() + (port == 443 ? "" : ":" + port);
      String upgrade = encrypted ? "dsh-e2ee-v1" : "dsh-relay-plain-v1";
      outer.getOutputStream().write(("GET " + (encrypted ? "/relay/v1/e2ee" : "/relay/v1/plain") + " HTTP/1.1\r\nHost: " + host
          + "\r\nConnection: Upgrade\r\nUpgrade: " + upgrade + "\r\nAuthorization: DSHRelay " + routeToken + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      String header = readHeader(outer.getInputStream(), 16384);
      if (!header.startsWith("HTTP/1.1 101 ") || !header.toLowerCase(java.util.Locale.ROOT).contains("\r\nupgrade: " + upgrade + "\r\n")) throw new IOException("E2EE_RELAY_REJECTED");
      if (!encrypted) { outer.setSoTimeout(120000); return new PlainChannel(outer); }
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(null, new TrustManager[]{new X509TrustManager() {
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("CLIENT_NOT_SUPPORTED"); }
        public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
          try { if (chain.length == 0) throw new CertificateException("EMPTY_CHAIN"); verify(chain[0], pin); }
          catch (Exception error) { throw new CertificateException("E2EE_PEER_REJECTED", error); }
        }
      }}, new SecureRandom());
      SSLEngine engine = context.createSSLEngine(NAME, 443); engine.setUseClientMode(true);
      if (!Arrays.asList(engine.getSupportedProtocols()).contains("TLSv1.3")) throw new IOException("E2EE_TLS13_UNAVAILABLE");
      engine.setEnabledProtocols(new String[]{"TLSv1.3"});
      Channel channel = new Channel(outer, engine); channel.handshake();
      if (!"TLSv1.3".equals(engine.getSession().getProtocol())) throw new IOException("E2EE_TLS13_REQUIRED");
      verify((X509Certificate) engine.getSession().getPeerCertificates()[0], pin);
      outer.setSoTimeout(120000); return channel;
    } catch (Exception error) { outer.close(); throw error; }
    finally { deadline.cancel(false); }
  }
  static String readHeader(InputStream in, int max) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(); int state = 0; long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    byte[] end = new byte[]{13,10,13,10};
    while (out.size() < max) {
      if (System.nanoTime() > deadline) throw new IOException("E2EE_HEADER_TIMEOUT");
      int b = in.read(); if (b < 0) throw new EOFException("E2EE_HEADER_CLOSED"); out.write(b);
      state = b == end[state] ? state + 1 : b == 13 ? 1 : 0;
      if (state == 4) return out.toString("ISO-8859-1");
    }
    throw new IOException("E2EE_HEADER_TOO_LARGE");
  }

  public interface Transport extends Closeable { void write(byte[] data, int offset, int length) throws IOException; int read(byte[] data) throws IOException; }
  private static final class PlainChannel implements Transport {
    private final Socket socket;
    PlainChannel(Socket socket) { this.socket = socket; }
    public void write(byte[] data, int offset, int length) throws IOException { socket.getOutputStream().write(data, offset, length); socket.getOutputStream().flush(); }
    public int read(byte[] data) throws IOException { return socket.getInputStream().read(data); }
    public void close() throws IOException { socket.close(); }
  }
  public static final class Channel implements Transport {
    private final Socket socket;
    private final SSLEngine engine;
    private final InputStream in;
    private final OutputStream out;
    private final Object writeLock = new Object(), readLock = new Object();
    private final ByteBuffer network = ByteBuffer.allocate(65536), plain = ByteBuffer.allocate(65536);
    private volatile boolean closed;
    Channel(Socket socket, SSLEngine engine) throws IOException {
      this.socket = socket; this.engine = engine; in = socket.getInputStream(); out = socket.getOutputStream(); network.flip(); plain.flip();
    }
    private void tasks() { synchronized (engine) { Runnable task; while ((task = engine.getDelegatedTask()) != null) task.run(); } }
    private SSLEngineResult.HandshakeStatus status() { synchronized (engine) { return engine.getHandshakeStatus(); } }
    private SSLEngineResult wrap(ByteBuffer source) throws IOException {
      synchronized (writeLock) {
        ByteBuffer packet = ByteBuffer.allocate(65536); SSLEngineResult result;
        synchronized (engine) { result = engine.wrap(source, packet); }
        if (result.getStatus() == SSLEngineResult.Status.BUFFER_OVERFLOW) throw new SSLException("E2EE_RECORD_TOO_LARGE");
        out.write(packet.array(), 0, packet.position()); out.flush(); return result;
      }
    }
    private int unwrap() throws IOException {
      plain.clear();
      while (!closed) {
        SSLEngineResult result;
        synchronized (engine) { result = engine.unwrap(network, plain); }
        tasks();
        if (result.getStatus() == SSLEngineResult.Status.BUFFER_OVERFLOW) throw new SSLException("E2EE_RECORD_TOO_LARGE");
        if (result.getStatus() == SSLEngineResult.Status.BUFFER_UNDERFLOW) {
          network.compact();
          if (!network.hasRemaining()) throw new SSLException("E2EE_RECORD_TOO_LARGE");
          int n = in.read(network.array(), network.position(), network.remaining());
          if (n < 0) throw new EOFException("E2EE_TLS_TRUNCATED");
          network.position(network.position() + n); network.flip(); continue;
        }
        plain.flip();
        if (result.getStatus() == SSLEngineResult.Status.CLOSED && !plain.hasRemaining()) return -1;
        return plain.remaining();
      }
      throw new IOException("E2EE_CHANNEL_CLOSED");
    }
    void handshake() throws IOException {
      engine.beginHandshake();
      while (!closed) {
        switch (status()) {
          case NEED_TASK: tasks(); break;
          case NEED_WRAP: wrap(ByteBuffer.allocate(0)); break;
          case NEED_UNWRAP:
            if (unwrap() < 0) throw new EOFException("E2EE_HANDSHAKE_CLOSED"); break;
          case FINISHED: case NOT_HANDSHAKING: return;
          default: throw new SSLException("E2EE_HANDSHAKE_STATE");
        }
      }
      throw new IOException("E2EE_CHANNEL_CLOSED");
    }
    public void write(byte[] data, int offset, int length) throws IOException {
      synchronized (writeLock) {
        ByteBuffer source = ByteBuffer.wrap(data, offset, length);
        while (source.hasRemaining()) {
          if (closed) throw new IOException("E2EE_CHANNEL_CLOSED");
          SSLEngineResult result = wrap(source); tasks();
          if (result.getStatus() == SSLEngineResult.Status.CLOSED) throw new IOException("E2EE_CHANNEL_CLOSED");
          if (result.bytesConsumed() == 0 && result.bytesProduced() == 0) throw new SSLException("E2EE_WRITE_STALLED");
        }
      }
    }
    public int read(byte[] data) throws IOException {
      synchronized (readLock) {
        while (!closed) {
          if (plain.hasRemaining()) { int n = Math.min(data.length, plain.remaining()); plain.get(data, 0, n); return n; }
          if (status() == SSLEngineResult.HandshakeStatus.NEED_WRAP) wrap(ByteBuffer.allocate(0));
          if (unwrap() < 0) return -1;
        }
        throw new IOException("E2EE_CHANNEL_CLOSED");
      }
    }
    public void close() throws IOException { closed = true; socket.close(); }
  }
}
