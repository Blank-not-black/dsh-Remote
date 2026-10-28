package com.dshremote.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Six-second, user-initiated Wi-Fi search. No subnet sweeping and no persistent discovery service. */
final class LanDiscovery {
  private final Context context;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Map<String, JSONObject> hosts = new LinkedHashMap<>();
  private int generation = 0;
  private DatagramSocket socket;
  private Network wifi;
  private String phase = "idle", error = "", paired = "";

  LanDiscovery(Context context) { this.context = context; }
  @JavascriptInterface public synchronized String getState() {
    try {
      JSONArray entries = new JSONArray();
      for (JSONObject host : hosts.values()) entries.put(host);
      return new JSONObject().put("phase", phase).put("error", error).put("hosts", entries).toString();
    } catch (Exception ignored) { return "{}"; }
  }
  @JavascriptInterface public synchronized String takePairResult() { String value = paired; paired = ""; return value; }
  @JavascriptInterface public synchronized void cancel() {
    generation++; paired = ""; phase = "idle";
    if (socket != null) socket.close(); socket = null;
  }
  synchronized void destroy() { cancel(); worker.shutdownNow(); }
  @JavascriptInterface public synchronized boolean search() {
    cancel(); hosts.clear(); error = ""; phase = "searching";
    final int current = generation;
    worker.execute(() -> discover(current));
    return true;
  }
  private synchronized void failure(int current, String code) {
    if (generation == current) { phase = "error"; error = code; }
  }
  private void discover(int current) {
    DatagramSocket transport = null;
    try {
      ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
      Network selected = null; LinkAddress address = null;
      if (manager != null) for (Network network : manager.getAllNetworks()) {
        NetworkCapabilities caps = manager.getNetworkCapabilities(network);
        LinkProperties properties = manager.getLinkProperties(network);
        if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || properties == null) continue;
        for (LinkAddress candidate : properties.getLinkAddresses()) if (candidate.getAddress() instanceof Inet4Address) {
          selected = network; address = candidate; break;
        }
        if (selected != null) break;
      }
      if (selected == null || address == null) { failure(current, "WIFI_REQUIRED"); return; }
      transport = new DatagramSocket(null);
      selected.bindSocket(transport);
      transport.setBroadcast(true); transport.setSoTimeout(500);
      transport.bind(new InetSocketAddress(address.getAddress(), 0));
      synchronized (this) {
        if (generation != current) return;
        socket = transport; wifi = selected;
      }
      byte[] random = new byte[16]; new SecureRandom().nextBytes(random);
      String nonce = LanPairCrypto.hex(random);
      byte[] request = new JSONObject().put("type", "dsh-remote-discover").put("version", 1).put("nonce", nonce)
          .put("padding", new String(new char[320]).replace('\0', ' ')).toString().getBytes(StandardCharsets.UTF_8);
      byte[] ip = address.getAddress().getAddress(), broadcast = ip.clone();
      int prefix = address.getPrefixLength();
      for (int bit = prefix; bit < 32; bit++) broadcast[bit / 8] |= (byte)(1 << (7 - bit % 8));
      InetAddress target = InetAddress.getByAddress(broadcast);
      long deadline = android.os.SystemClock.elapsedRealtime() + 6000, nextSend = 0;
      while (android.os.SystemClock.elapsedRealtime() < deadline) {
        synchronized (this) { if (generation != current) return; }
        if (android.os.SystemClock.elapsedRealtime() >= nextSend) {
          transport.send(new DatagramPacket(request, request.length, target, 8788));
          nextSend = android.os.SystemClock.elapsedRealtime() + 1500;
        }
        DatagramPacket packet = new DatagramPacket(new byte[513], 513);
        try { transport.receive(packet); } catch (SocketTimeoutException ignored) { continue; }
        if (packet.getLength() > 512 || !(packet.getAddress() instanceof Inet4Address)) continue;
        byte[] source = packet.getAddress().getAddress(); boolean sameSubnet = true;
        for (int bit = 0; bit < prefix; bit++) if ((source[bit / 8] & (1 << (7 - bit % 8))) != (ip[bit / 8] & (1 << (7 - bit % 8)))) { sameSubnet = false; break; }
        if (!sameSubnet) continue;
        JSONObject reply;
        try { reply = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8)); } catch (Exception ignored) { continue; }
        String instance = reply.optString("instanceId"); int port = reply.optInt("port");
        if (!"dsh-remote-host".equals(reply.optString("type")) || reply.optInt("version") != 1
            || !nonce.equals(reply.optString("nonce")) || !instance.matches("[a-f0-9]{32}") || port < 1 || port > 65535) continue;
        String server = "http://" + packet.getAddress().getHostAddress() + ":" + port, id = instance + "@" + server;
        String name = reply.optString("name", "DSH Remote"); if (name.length() > 40) name = name.substring(0, 40);
        synchronized (this) {
          if (generation == current && hosts.size() < 32) hosts.put(id, new JSONObject().put("id", id)
              .put("instanceId", instance).put("name", name).put("server", server));
        }
      }
      synchronized (this) { if (generation == current) phase = "done"; }
    } catch (SecurityException ignored) { failure(current, "NETWORK_PERMISSION_REQUIRED"); }
    catch (Exception ignored) { failure(current, "DISCOVERY_FAILED"); }
    finally {
      if (transport != null) transport.close();
      synchronized (this) { if (socket == transport) socket = null; }
    }
  }
  @JavascriptInterface public synchronized boolean pair(String id, String code) {
    JSONObject host = hosts.get(id);
    if (host == null || "pairing".equals(phase) || !code.replaceAll("[\\s-]", "").matches("(?i)[A-F0-9]{20}")) return false;
    generation++; if (socket != null) socket.close(); socket = null;
    final int current = generation; final Network selected = wifi;
    phase = "pairing"; error = ""; paired = "";
    worker.execute(() -> exchange(current, selected, host, code));
    return true;
  }
  private JSONObject post(Network network, String server, JSONObject body) throws Exception {
    HttpURLConnection connection = (HttpURLConnection) network.openConnection(new URL(server + "/api/lan-pair"));
    try {
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
      connection.setRequestMethod("POST"); connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
      connection.setFixedLengthStreamingMode(bytes.length);
      try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      if (connection.getResponseCode() != 200) throw new SecurityException(connection.getResponseCode() == 410 ? "PAIRING_CLOSED" : "PAIRING_FAILED");
      try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] buffer = new byte[1024]; int length;
        while ((length = input.read(buffer)) != -1) {
          if (output.size() + length > 4096) throw new SecurityException("PAIRING_RESPONSE_INVALID");
          output.write(buffer, 0, length);
        }
        return new JSONObject(output.toString("UTF-8"));
      }
    } finally { connection.disconnect(); }
  }
  private void exchange(int current, Network network, JSONObject host, String code) {
    try {
      LanPairCrypto crypto = new LanPairCrypto();
      byte[] random = new byte[16]; new SecureRandom().nextBytes(random);
      String nonce = LanPairCrypto.hex(random), publicKey = Base64.encodeToString(crypto.publicKey(), Base64.NO_WRAP);
      String server = host.getString("server"), instance = host.getString("instanceId");
      JSONObject hello = post(network, server, new JSONObject().put("step", "hello").put("instanceId", instance)
          .put("nonce", nonce).put("clientPublic", publicKey));
      String serverPublic = hello.getString("serverPublic"), id = hello.getString("challengeId");
      String transcript = "dsh-lan-v1\n" + instance + "\n" + id + "\n" + nonce + "\n" + publicKey + "\n" + serverPublic;
      String proof = crypto.authenticate(code, transcript, hello.getString("serverProof"));
      synchronized (this) { if (generation != current) return; }
      JSONObject encrypted = post(network, server, new JSONObject().put("step", "finish").put("challengeId", id).put("proof", proof));
      JSONObject result = new JSONObject(crypto.decrypt(Base64.decode(serverPublic, Base64.DEFAULT),
          Base64.decode(encrypted.getString("iv"), Base64.DEFAULT), Base64.decode(encrypted.getString("ciphertext"), Base64.DEFAULT), Base64.decode(encrypted.getString("tag"), Base64.DEFAULT)));
      if (!result.optString("token").matches("[A-Za-z0-9_-]{16,256}")) throw new SecurityException("PAIRING_RESPONSE_INVALID");
      result.put("server", server).put("name", host.optString("name"));
      synchronized (this) { if (generation == current) { paired = result.toString(); phase = "paired"; } }
    } catch (SecurityException error) { failure(current, error.getMessage()); }
    catch (Exception ignored) { failure(current, "PAIRING_FAILED"); }
  }
}
