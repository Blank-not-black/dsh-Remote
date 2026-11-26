package com.dshremote.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;
import java.net.URL;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;

/** Pairing data is imported locally and remains in app-private preferences. */
public final class E2eeBridge {
  private static final int DISCLOSURE_VERSION = 1;
  // Runtime plan gating is enforced by the host relay status and the WebUI controls.
  private static final boolean DISABLED = false;
  private static boolean encrypted(JSONObject pair) {
    return pair == null || pair.optBoolean("encrypted", true) || pair.optInt("disclosureVersion", 0) != DISCLOSURE_VERSION;
  }
  private static volatile E2eeBridge instance;
  private final SharedPreferences preferences;
  private final Map<String, E2eeProxy> proxies = new HashMap<>();
  private final Set<java.net.HttpURLConnection> requests = new HashSet<>();
  private static final Pattern SESSION_LIST_PATH = Pattern.compile("/api/session\\.list");
  private static final Pattern SESSION_HISTORY_PATH = Pattern.compile("/api/session\\.history");
  private static final Pattern WS_TICKET_PATH = Pattern.compile("/api/ws-ticket");
  private static final Pattern OPERATION_PATH = Pattern.compile("/api/operations\\?id=[A-Za-z0-9_-]{16,80}");
  private final Map<Integer, RelayCall> relayCalls = new HashMap<>();
  private final ThreadPoolExecutor relayWorkers = new ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(4), work -> new Thread(work, "DSH-relay-http"));
  private int relaySequence;
  private static final class RelayCall {
    final long started = System.nanoTime();
    FutureTask<RelayHttpRequest.Result> job;
    HttpURLConnection connection;
  }
  private interface RelayRequest { RelayHttpRequest.Result run(HttpURLConnection connection); }
  private final Set<String> clearedOrigins = new HashSet<>();
  private JSONObject pairs;
  private String lastOrigin = "";
  private boolean unreadable;
  private E2eeBridge(Context context) {
    relayWorkers.allowCoreThreadTimeOut(true);
    preferences = context.getApplicationContext().getSharedPreferences("dsh-e2ee", Context.MODE_PRIVATE);
    try { pairs = new JSONObject(preferences.getString("pairs", "{}")); } catch (Exception error) { pairs = new JSONObject(); unreadable = true; }
    try { lastOrigin = preferences.getString("lastOrigin", ""); } catch (Exception ignored) { lastOrigin = ""; }
  }
  public static synchronized E2eeBridge get(Context context) {
    if (instance == null) instance = new E2eeBridge(context); return instance;
  }
  private static String origin(URI url) throws Exception {
    String scheme = url.getScheme(); if ("wss".equals(scheme)) scheme = "https";
    if (!"https".equals(scheme) || url.getHost() == null || url.getRawUserInfo() != null) return "";
    return "https://" + url.getHost().toLowerCase(java.util.Locale.ROOT) + (url.getPort() < 0 || url.getPort() == 443 ? "" : ":" + url.getPort());
  }
  private static byte[] certificate(JSONObject pair) throws Exception { return certificate(pair, true); }
  private static byte[] certificate(JSONObject pair, boolean checkIdentity) throws Exception {
    String protocol = pair.getString("protocol");
    if (!("dsh-remote-native-tls13-prototype-v1".equals(protocol) || "dsh-remote-native-tls13-v2".equals(protocol)) || !E2eeTls.NAME.equals(pair.getString("hostname"))) throw new Exception("INVALID_E2EE_PAIRING");
    if ("dsh-remote-native-tls13-v2".equals(protocol) && (!pair.getString("deviceId").matches("[a-f0-9]{32}") || !pair.getString("deviceSecret").matches("[A-Za-z0-9_-]{43}") || pair.getLong("expiresAt") <= System.currentTimeMillis())) throw new Exception("E2EE_DEVICE_EXPIRED");
    String pem = pair.getString("certificate");
    if (pem.length() > 8192) throw new Exception("INVALID_E2EE_PAIRING");
    byte[] der = Base64.decode(pem.replace("-----BEGIN CERTIFICATE-----", "").replace("-----END CERTIFICATE-----", "").replaceAll("\\s", ""), Base64.DEFAULT);
    if (checkIdentity) E2eeTls.certificate(der, pair.getString("fingerprint")); return der;
  }
  private static E2eeProxy proxy(JSONObject pair, boolean encrypted) throws Exception {
    boolean device = "dsh-remote-native-tls13-v2".equals(pair.optString("protocol"));
    return new E2eeProxy(new URI(pair.getString("relayUrl")), pair.getString("routeToken"), certificate(pair, encrypted), pair.getString("fingerprint"), encrypted,
      device ? pair.getString("deviceId") + "." + pair.getString("deviceSecret") : "", device ? pair.getLong("expiresAt") : Long.MAX_VALUE);
  }
  @JavascriptInterface public boolean supported() {
    if (DISABLED) return false;
    try { return java.util.Arrays.asList(javax.net.ssl.SSLContext.getDefault().createSSLEngine().getSupportedProtocols()).contains("TLSv1.3"); }
    catch (Exception error) { return false; }
  }

  @JavascriptInterface public String httpDiagnostics() { return E2eeHttpDiagnostics.snapshot(); }

  @JavascriptInterface public void clearHttpDiagnostics() { E2eeHttpDiagnostics.clear(); }

  @JavascriptInterface public synchronized String localHttpState(String mapped) {
    try {
      if (mapped != null) for (E2eeProxy proxy : proxies.values()) {
        if (!mapped.startsWith(proxy.base() + "/")) continue;
        return new JSONObject().put("relayProxyId", proxy.diagnosticId)
          .put("relayAcceptCount", proxy.diagnosticAcceptCount())
          .put("relayBusyCount", proxy.diagnosticBusyCount())
          .put("relaySlotLimit", proxy.diagnosticSlotLimit())
          .put("relaySlotsUsed", proxy.diagnosticSlotsUsed())
          .put("relayListener", proxy.diagnosticListenerOpen() ? "open" : "closed").toString();
      }
    } catch (Exception ignored) {}
    return "{\"relayListener\":\"missing\"}";
  }

  @JavascriptInterface public synchronized int startListProbe(String mapped, String authorization, String clientId, String rpcId) {
    if (DISABLED) return 0;
    if (!validRelayHeaders(authorization, clientId) || rpcId == null || !rpcId.matches("[A-Za-z0-9_-]{1,128}")) return 0;
    E2eeProxy proxy = relayProxy(mapped, SESSION_LIST_PATH);
    return startRelayCall(mapped, proxy, connection -> RelayHttpRequest.list(connection, authorization, clientId, rpcId));
  }

  @JavascriptInterface public synchronized int startHistoryRequest(String mapped, String authorization, String clientId, String body) {
    if (DISABLED) return 0;
    if (!validRelayHeaders(authorization, clientId) || body == null || body.length() > 8192) return 0;
    E2eeProxy proxy = relayProxy(mapped, SESSION_HISTORY_PATH);
    return startRelayCall(mapped, proxy, connection -> RelayHttpRequest.history(connection, authorization, clientId, body));
  }

  @JavascriptInterface public synchronized int startTicketRequest(String mapped, String authorization, String clientId) {
    if (DISABLED) return 0;
    if (!validRelayHeaders(authorization, clientId)) return 0;
    E2eeProxy proxy = relayProxy(mapped, WS_TICKET_PATH);
    return startRelayCall(mapped, proxy, connection -> RelayHttpRequest.ticket(connection, authorization, clientId));
  }

  @JavascriptInterface public synchronized int startOperationRequest(String mapped, String method,
      String authorization, String clientId, String body) {
    if (DISABLED) return 0;
    if (!validRelayHeaders(authorization, clientId)) return 0;
    if ("POST".equals(method)) {
      if (body == null || body.length() > RelayHttpRequest.MAX_OPERATION_BODY) return 0;
    } else if (!"GET".equals(method) || body != null) return 0;
    E2eeProxy proxy = relayProxy(mapped, OPERATION_PATH);
    return startRelayCall(mapped, proxy, connection -> RelayHttpRequest.operation(connection, method, authorization, clientId, body));
  }

  private static boolean validRelayHeaders(String authorization, String clientId) {
    return authorization != null && authorization.matches("Bearer [ -~]{1,2048}")
      && clientId != null && clientId.matches("[A-Za-z0-9_-]{0,128}");
  }

  private E2eeProxy relayProxy(String mapped, Pattern path) {
    if (mapped == null) return null;
    for (E2eeProxy proxy : proxies.values()) {
      String base = proxy.base();
      if (proxy.usesEncryption() && proxy.diagnosticListenerOpen() && mapped.startsWith(base)
          && path.matcher(mapped.substring(base.length())).matches()) return proxy;
    }
    return null;
  }

  private int startRelayCall(String mapped, E2eeProxy proxy, RelayRequest request) {
    long now = System.nanoTime();
    for (Iterator<RelayCall> it = relayCalls.values().iterator(); it.hasNext();) {
      RelayCall old = it.next();
      if (now - old.started > TimeUnit.SECONDS.toNanos(20)) { it.remove(); cancelRelayCall(old); }
    }
    if (proxy == null || relayCalls.size() >= 8) return 0;
    RelayCall call = new RelayCall();
    call.job = new FutureTask<>(() -> {
      HttpURLConnection connection;
      synchronized (E2eeBridge.this) {
        if (call.job.isCancelled() || !proxies.containsValue(proxy) || !proxy.diagnosticListenerOpen()) {
          return new RelayHttpRequest.Result(0, "native-unavailable", "");
        }
        connection = (HttpURLConnection) new URL(mapped).openConnection(Proxy.NO_PROXY);
        requests.add(connection);
        call.connection = connection;
      }
      try { return request.run(connection); }
      finally {
        synchronized (E2eeBridge.this) { call.connection = null; requests.remove(connection); }
        connection.disconnect();
      }
    });
    try {
      relayWorkers.execute(call.job);
      int id = ++relaySequence;
      relayCalls.put(id, call);
      return id;
    } catch (RejectedExecutionException error) { return 0; }
  }

  @JavascriptInterface public synchronized String pollHttpRequest(int id) {
    RelayCall call = relayCalls.get(id);
    if (call == null) return "{\"outcome\":\"native-unavailable\"}";
    if (!call.job.isDone()) return "";
    relayCalls.remove(id);
    try {
      RelayHttpRequest.Result result = call.job.get();
      return new JSONObject().put("status", result.status).put("outcome", result.outcome).put("body", result.body).toString();
    } catch (Exception error) { return "{\"outcome\":\"native-network\"}"; }
  }

  @JavascriptInterface public synchronized void cancelHttpRequest(int id) {
    RelayCall call = relayCalls.remove(id);
    if (call != null) cancelRelayCall(call);
  }

  private void cancelRelayCall(RelayCall call) {
    call.job.cancel(true);
    relayWorkers.remove(call.job);
    HttpURLConnection connection = call.connection;
    if (connection != null) new Thread(connection::disconnect, "DSH-relay-http-cancel").start();
  }
  @JavascriptInterface public synchronized String info(String base) {
    if (DISABLED) return "{}";
    try { String key = origin(new URI(base)); JSONObject pair = pairs.optJSONObject(key);
      if (pairs.has(key) && pair == null) throw new Exception("E2EE_STATE_UNAVAILABLE");
      return new JSONObject().put("configured", pair != null && !pair.optBoolean("required", false)).put("required", pair != null)
        .put("encrypted", encrypted(pair)).put("fingerprint", pair == null ? "" : pair.getString("fingerprint"))
        .put("deviceId", pair == null ? "" : pair.optString("deviceId")).put("expiresAt", pair == null ? 0 : pair.optLong("expiresAt"))
        .put("error", unreadable ? "E2EE_STORAGE_UNAVAILABLE" : pair != null && pair.optLong("expiresAt", Long.MAX_VALUE) <= System.currentTimeMillis() ? "E2EE_DEVICE_EXPIRED" : "").toString();
    } catch (Exception error) { return "{\"error\":\"E2EE_STATE_UNAVAILABLE\"}"; }
  }
  @JavascriptInterface public synchronized String configure(String json, String expectedFingerprint) {
    if (DISABLED) return "{\"error\":\"E2EE_DISABLED\"}";
    try {
      if (unreadable || json == null || json.length() > 16384) throw new Exception("E2EE_STORAGE_UNAVAILABLE");
      JSONObject pair = new JSONObject(json); byte[] cert = certificate(pair); URI relay = new URI(pair.getString("relayUrl")); String key = origin(relay);
      if (key.isEmpty() || !"https".equals(relay.getScheme()) || !"/relay/v1/e2ee".equals(relay.getRawPath()) || relay.getRawQuery() != null || relay.getRawFragment() != null
          || !pair.getString("routeToken").matches("[A-Za-z0-9_-]{43}")) throw new Exception("INVALID_E2EE_PAIRING");
      JSONObject old = pairs.optJSONObject(key);
      if (!(old == null ? "" : old.getString("fingerprint")).equals(expectedFingerprint)) throw new Exception("E2EE_PAIRING_CHANGED");
      if (old == null && pairs.length() >= 8) throw new Exception("E2EE_HOST_LIMIT");
      pair.put("encrypted", encrypted(old));
      if (!encrypted(old)) pair.put("disclosureVersion", DISCLOSURE_VERSION); else pair.remove("disclosureVersion");
      JSONObject next = new JSONObject(pairs.toString()); next.put(key, pair);
      E2eeProxy proxy = proxy(pair, encrypted(pair));
      if (!preferences.edit().putString("pairs", next.toString()).commit()) { proxy.close(); throw new Exception("E2EE_STORAGE_UNAVAILABLE"); }
      pairs = next; clearedOrigins.remove(key); E2eeProxy previous = proxies.put(key, proxy); if (previous != null) previous.close(); cancelRequests();
      return new JSONObject().put("origin", key).put("fingerprint", pair.getString("fingerprint")).toString();
    } catch (Exception error) { return "{\"error\":\"E2EE_IMPORT_FAILED\"}"; }
  }
  @JavascriptInterface public synchronized String setEncryption(String base, boolean enabled, String expectedFingerprint, boolean acknowledged) {
    if (DISABLED) return "{\"error\":\"E2EE_DISABLED\"}";
    try {
      String key = origin(new URI(base)); JSONObject pair = pairs.optJSONObject(key);
      if (unreadable || pair == null || pair.optBoolean("required", false) || !pair.getString("fingerprint").equals(expectedFingerprint)) throw new Exception("E2EE_PAIRING_CHANGED");
      if (!enabled && !acknowledged || enabled && !supported()) throw new Exception("E2EE_MODE_REJECTED");
      byte[] cert = certificate(pair, enabled);
      JSONObject updated = new JSONObject(pair.toString()); updated.put("encrypted", enabled);
      if (!enabled) updated.put("disclosureVersion", DISCLOSURE_VERSION); else updated.remove("disclosureVersion");
      JSONObject next = new JSONObject(pairs.toString()); next.put(key, updated);
      E2eeProxy proxy = proxy(updated, enabled);
      if (!preferences.edit().putString("pairs", next.toString()).commit()) { proxy.close(); throw new Exception("E2EE_STORAGE_UNAVAILABLE"); }
      pairs = next; E2eeProxy old = proxies.put(key, proxy); if (old != null) old.close(); cancelRequests();
      return new JSONObject().put("encrypted", enabled).put("origin", key).toString();
    } catch (Exception error) { return "{\"error\":\"E2EE_MODE_CHANGE_FAILED\"}"; }
  }
  @JavascriptInterface public synchronized String resolve(String input) {
    try {
      if (DISABLED) return new JSONObject().put("url", input).put("secure", false).toString();
      URI url = new URI(input); String key = origin(url); JSONObject pair = pairs.optJSONObject(key);
      if (("http".equals(url.getScheme()) || "ws".equals(url.getScheme())) && url.getHost() != null) {
        String secureOrigin = "https://" + url.getHost().toLowerCase(java.util.Locale.ROOT)
          + (url.getPort() < 0 || url.getPort() == 80 || url.getPort() == 443 ? "" : ":" + url.getPort());
        if (pairs.has(secureOrigin) || clearedOrigins.contains(secureOrigin)) throw new Exception("E2EE_DOWNGRADE_REFUSED");
      }
      if (unreadable) throw new Exception("E2EE_STORAGE_UNAVAILABLE");
      if (clearedOrigins.contains(key)) throw new Exception("E2EE_PAIRING_CLEARED");
      if (pairs.has(key) && pair == null) throw new Exception("E2EE_STATE_UNAVAILABLE");
      if (pair == null) return new JSONObject().put("url", input).put("secure", false).toString();
      if (pair.optLong("expiresAt", Long.MAX_VALUE) <= System.currentTimeMillis()) throw new Exception("E2EE_DEVICE_EXPIRED");
      rememberOrigin(key);
      E2eeProxy proxy = proxies.get(key);
      if (proxy == null) {
        boolean encrypted = encrypted(pair);
        proxy = proxy(pair, encrypted); proxies.put(key, proxy); proxy.warm();
      }
      String path = url.getRawPath(); if (path == null || path.isEmpty()) path = "/";
      String mapped = proxy.base() + path + (url.getRawQuery() == null ? "" : "?" + url.getRawQuery());
      if ("wss".equals(url.getScheme())) mapped = mapped.replaceFirst("^http:", "ws:");
      return new JSONObject().put("url", mapped).put("secure", encrypted(pair)).put("paired", true).toString();
    } catch (Exception error) { return "{\"error\":\"E2EE_TRANSPORT_UNAVAILABLE\"}"; }
  }
  public static String rewrite(Context context, String input) throws Exception {
    JSONObject result = new JSONObject(get(context).resolve(input)); if (result.has("error")) throw new java.io.IOException("E2EE_TRANSPORT_UNAVAILABLE"); return result.getString("url");
  }
  public static java.net.HttpURLConnection open(Context context, String input) throws Exception {
    E2eeBridge bridge = get(context);
    synchronized (bridge) {
      java.net.HttpURLConnection request = (java.net.HttpURLConnection) new java.net.URL(rewrite(context, input)).openConnection();
      bridge.requests.add(request); return request;
    }
  }
  /** Remember the paired host the UI used last, so a cold start can warm it before the page loads. */
  private void rememberOrigin(String key) {
    if (key.isEmpty() || key.equals(lastOrigin)) return;
    lastOrigin = key;
    try { preferences.edit().putString("lastOrigin", key).apply(); } catch (Exception ignored) { }
  }
  /** Warm the last used host before the WebView loads, so the first screen does not pay a handshake. */
  public static void warmLast(Context context) {
    if (DISABLED || context == null) return;
    E2eeBridge bridge;
    try { bridge = get(context); } catch (Throwable ignored) { return; }
    synchronized (bridge) {
      String key = bridge.lastOrigin;
      if (key == null || key.isEmpty()) return;
      JSONObject pair = bridge.pairs.optJSONObject(key);
      if (pair == null || pair.optLong("expiresAt", Long.MAX_VALUE) <= System.currentTimeMillis()) return;
      E2eeProxy proxy = bridge.proxies.get(key);
      if (proxy == null) {
        try {
          boolean encrypted = encrypted(pair);
          proxy = proxy(pair, encrypted);
          bridge.proxies.put(key, proxy);
        } catch (Exception error) { return; }
      }
      proxy.warm();
    }
  }
  /** Called when the app becomes visible: warm the pools so the first interaction skips the handshake. */
  public static void warm() {
    if (DISABLED) return;
    E2eeBridge bridge = instance; if (bridge == null) return;
    synchronized (bridge) { for (E2eeProxy proxy : bridge.proxies.values()) proxy.warm(); }
  }
  public static void release(java.net.HttpURLConnection request) {
    E2eeBridge bridge = instance; if (bridge == null || request == null) return;
    synchronized (bridge) { bridge.requests.remove(request); }
  }
  private void cancelRequests() {
    for (RelayCall call : relayCalls.values()) { call.job.cancel(true); relayWorkers.remove(call.job); }
    relayCalls.clear();
    java.net.HttpURLConnection[] old = requests.toArray(new java.net.HttpURLConnection[0]); requests.clear();
    new Thread(() -> { for (java.net.HttpURLConnection request : old) request.disconnect(); }, "DSH-e2ee-transport-change").start();
  }
  @JavascriptInterface public synchronized boolean remove(String base) {
    if (DISABLED) return true;
    try {
      String key = origin(new URI(base)); JSONObject old = pairs.optJSONObject(key); if (old == null) return !pairs.has(key);
      JSONObject next = new JSONObject(pairs.toString()); next.put(key, new JSONObject().put("fingerprint", old.getString("fingerprint")).put("required", true));
      if (!preferences.edit().putString("pairs", next.toString()).commit()) return false;
      pairs = next; E2eeProxy proxy = proxies.remove(key); if (proxy != null) proxy.close(); cancelRequests(); return true;
    } catch (Exception error) { return false; }
  }
  @JavascriptInterface public synchronized boolean clear() {
    if (!preferences.edit().clear().commit()) return false;
    Iterator<String> keys = pairs.keys(); while (keys.hasNext()) clearedOrigins.add(keys.next());
    for (E2eeProxy proxy : proxies.values()) proxy.close(); proxies.clear(); cancelRequests(); pairs = new JSONObject(); unreadable = false; return true;
  }
}
