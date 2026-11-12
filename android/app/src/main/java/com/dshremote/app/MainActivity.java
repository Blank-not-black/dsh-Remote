package com.dshremote.app;

import android.app.DownloadManager;
import android.database.Cursor;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
  @Override
  protected void load() {
    // Clear only the resource cache, before Capacitor starts loading the page.
    // SharedPreferences, cookies, localStorage and IndexedDB are not touched.
    android.webkit.WebView cacheView = null;
    try (InputStream input = getAssets().open("public/build.json")) {
      java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[1024]; int count;
      while ((count = input.read(buffer)) >= 0) {
        bytes.write(buffer, 0, count);
        if (bytes.size() > 4096) throw new java.io.IOException("INVALID_BUILD_METADATA");
      }
      String build = new JSONObject(bytes.toString("UTF-8")).getString("buildId");
      if (!build.matches("[a-f0-9]{64}")) throw new java.io.IOException("INVALID_BUILD_METADATA");
      SharedPreferences state = getSharedPreferences("dsh-resource-build", Context.MODE_PRIVATE);
      if (!build.equals(state.getString("loaded", ""))) {
        cacheView = new android.webkit.WebView(this);
        cacheView.clearCache(true);
        state.edit().putString("loaded", build).commit();
      }
    } catch (Exception ignored) {
      // Missing metadata is not permission to clear application data.
    } finally { if (cacheView != null) cacheView.destroy(); }
    super.load();
  }

  private final Handler main = new Handler(Looper.getMainLooper());
  private volatile String overlapInsets = "{\"top\":0,\"bottom\":0,\"mode\":\"overlap\"}";
  private volatile String pendingNavigation = "";
  private LanDiscovery lanDiscovery;
  private static final int DIAGNOSTIC_EXPORT_REQUEST = 0x4453;
  private volatile String pendingDiagnosticExport = "";
  private volatile String diagnosticExportStatus = "idle";

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode != DIAGNOSTIC_EXPORT_REQUEST) {
      super.onActivityResult(requestCode, resultCode, data);
      return;
    }
    final String json = pendingDiagnosticExport;
    pendingDiagnosticExport = "";
    if (resultCode != RESULT_OK || data == null || data.getData() == null || json.isEmpty()) {
      diagnosticExportStatus = "cancelled";
      return;
    }
    final Uri destination = data.getData();
    new Thread(() -> {
      try (java.io.OutputStream output = getContentResolver().openOutputStream(destination)) {
        if (output == null) throw new java.io.IOException("Unable to open export destination");
        output.write(json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        diagnosticExportStatus = "saved";
      } catch (Exception error) {
        diagnosticExportStatus = "error";
      }
    }, "DSH-diagnostic-export").start();
  }

  private void rememberPendingNavigation(Intent intent) {
    if (intent == null || !PendingNotifications.ACTION_OPEN.equals(intent.getAction())) return;
    if (intent.getStringExtra("pending_session") == null || intent.getStringExtra("pending_session").isEmpty()) return;
    try {
      JSONObject value = new JSONObject();
      value.put("base", intent.getStringExtra("pending_base"));
      value.put("identity", intent.getStringExtra("pending_identity"));
      value.put("sessionId", intent.getStringExtra("pending_session"));
      pendingNavigation = value.toString();
      if (bridge != null) main.post(() -> bridge.getWebView().evaluateJavascript("window.dispatchEvent(new Event('dsh-pending-navigation'))", null));
    } catch (Exception ignored) {}
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    rememberPendingNavigation(intent);
  }

  private void updateOverlapInsets() {
    try {
      android.view.View decor = getWindow().getDecorView(), web = bridge.getWebView();
      android.view.WindowInsets ins = decor.getRootWindowInsets();
      if (ins == null || web.getHeight() == 0) return;
      int top, bottom;
      if (Build.VERSION.SDK_INT >= 30) {
        android.graphics.Insets bars = ins.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
        top = bars.top; bottom = bars.bottom;
      } else {
        top = ins.getSystemWindowInsetTop(); bottom = ins.getStableInsetBottom();
      }
      int[] windowPosition = new int[2], webPosition = new int[2];
      decor.getLocationOnScreen(windowPosition); web.getLocationOnScreen(webPosition);
      float density = getResources().getDisplayMetrics().density;
      int remainingTop = Math.max(0, windowPosition[1] + top - webPosition[1]);
      int remainingBottom = Math.max(0, webPosition[1] + web.getHeight() - (windowPosition[1] + decor.getHeight() - bottom));
      String next = "{\"top\":" + (int)Math.ceil(remainingTop / density) + ",\"bottom\":" + (int)Math.ceil(remainingBottom / density)
          + ",\"systemTop\":" + (int)Math.ceil(top / density) + ",\"webTop\":" + (int)Math.ceil((webPosition[1]-windowPosition[1]) / density) + ",\"mode\":\"overlap\"}";
      if (next.equals(overlapInsets)) return;
      overlapInsets = next;
      bridge.getWebView().evaluateJavascript("window.dispatchEvent(new Event('dsh-native-insets'))", null);
    } catch (Throwable ignored) {}
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // Warm the paired host before the WebView starts loading, so the first screen's
    // requests can take ready E2EE channels instead of waiting for a handshake.
    try { E2eeBridge.warmLast(getApplicationContext()); } catch (Throwable ignored) {}
    super.onCreate(savedInstanceState);
    new Thread(() -> EncryptedDownloads.cleanup(getApplicationContext()), "DSH-download-cleanup").start();
    rememberPendingNavigation(getIntent());
    // DSH Remote 走局域网 http 网关: 显式允许混合内容(https 壳加载 http API)
    try {
      WebSettings settings = bridge.getWebView().getSettings();
      settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    } catch (Throwable ignored) {
    }
    bridge.getWebView().getViewTreeObserver().addOnGlobalLayoutListener(this::updateOverlapInsets);
    main.post(this::updateOverlapInsets);
    // JS 桥: 下载 APK 并打开系统安装器(不依赖 Capacitor 插件路由)
    // 同一桥再以 NativeFile 暴露: 文件页下载到系统 Downloads(Android 10+ 无需存储权限)
    try {
      UpdateBridge updateBridge = new UpdateBridge();
      bridge.getWebView().addJavascriptInterface(updateBridge, "NativeUpdate");
      bridge.getWebView().addJavascriptInterface(updateBridge, "NativeFile");
      BackgroundBridge backgroundBridge = new BackgroundBridge();
      bridge.getWebView().addJavascriptInterface(backgroundBridge, "NativeBackground");
      lanDiscovery = new LanDiscovery(this);
      bridge.getWebView().addJavascriptInterface(lanDiscovery, "NativeLan");
      bridge.getWebView().addJavascriptInterface(E2eeBridge.get(this), "NativeE2ee");
    } catch (Throwable ignored) {
    }
  }

  @Override
  public void onStart() {
    super.onStart();
    // Restore the user's existing choice after an upgrade/process recreation.
    // Start while the Activity is visible, before WebView JavaScript can freeze.
    RemotePollService.restoreIfEnabled(this, false);
    PeakReminderService.restoreIfEnabled(this, false);
  }

  @Override
  public void onResume() {
    super.onResume();
    E2eeBridge.warm();
  }

  @Override
  public void onPause() {
    if (lanDiscovery != null) lanDiscovery.cancel();
    RemotePollService.restoreIfEnabled(this, false);
    PeakReminderService.restoreIfEnabled(this, false);
    super.onPause();
  }

  @Override public void onDestroy() {
    if (lanDiscovery != null) lanDiscovery.destroy();
    super.onDestroy();
  }

  private class UpdateBridge {
    /** Local JSON export uses the system picker, including while offline. */
    @JavascriptInterface
    public synchronized boolean exportDiagnostics(String json) {
      if ("picking".equals(diagnosticExportStatus) || json == null || json.length() > 256 * 1024) return false;
      try {
        JSONObject report = new JSONObject(json);
        if (report.optInt("schema", 0) != 1 || report.optJSONArray("events") == null || report.getJSONArray("events").length() > 160) return false;
      } catch (Exception error) { return false; }
      pendingDiagnosticExport = json;
      diagnosticExportStatus = "picking";
      main.post(() -> {
        try {
          Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT);
          picker.addCategory(Intent.CATEGORY_OPENABLE);
          picker.setType("application/json");
          picker.putExtra(Intent.EXTRA_TITLE, "dsh-diagnostics-" + System.currentTimeMillis() + ".json");
          startActivityForResult(picker, DIAGNOSTIC_EXPORT_REQUEST);
        } catch (RuntimeException error) {
          pendingDiagnosticExport = "";
          diagnosticExportStatus = "error";
        }
      });
      return true;
    }

    @JavascriptInterface
    public String getDiagnosticExportStatus() { return diagnosticExportStatus; }

    private volatile String downloadStatus = "{\"phase\":\"idle\"}";
    private volatile String officialReleaseStatus = "{\"phase\":\"idle\"}";
    private boolean downloading;

    @JavascriptInterface
    public String getDownloadStatus() { return downloadStatus; }

    @JavascriptInterface
    public synchronized void checkOfficialRelease() {
      if (officialReleaseStatus.equals("{\"phase\":\"checking\"}")) return;
      officialReleaseStatus = "{\"phase\":\"checking\"}";
      new Thread(() -> {
        try { officialReleaseStatus = OfficialAndroidRelease.latest().toString(); }
        catch (Exception error) { officialReleaseStatus = "{\"phase\":\"error\"}"; }
      }, "DSH-official-update-check").start();
    }

    @JavascriptInterface
    public String getOfficialReleaseStatus() { return officialReleaseStatus; }

    @JavascriptInterface
    public String getInstalledVersion() {
      try {
        return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
      } catch (android.content.pm.PackageManager.NameNotFoundException error) {
        return "";
      }
    }

    private void progress(String phase, long received, long total) {
      updateStatus(phase, received, total, "", "");
    }

    private void updateStatus(String phase, long received, long total, String code, String error) {
      try {
        JSONObject value = new JSONObject();
        value.put("phase", phase);
        value.put("received", received);
        value.put("total", total);
        value.put("code", code);
        value.put("error", error);
        downloadStatus = value.toString();
      } catch (Exception ignored) {}
    }

    private synchronized void finishDownload(String phase, long received, long total, String code, String error) {
      updateStatus(phase, received, total, code, error);
      downloading = false;
    }
    /** 把系统栏真实 inset(dp) 交给前端, 处理刘海/状态栏/手势条 */
    @JavascriptInterface
    public String getInsets() {
      return overlapInsets;
    }

    @JavascriptInterface
    public String downloadToDownloads(String url, String filename, String token) {
      if (url == null || !url.matches("(?i)^https?://.+")) return "";
      String safeName = safeFileName(filename);
      File destination = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "dsh-remote/" + safeName);
      if (destination.exists()) {
        int dot = safeName.lastIndexOf('.');
        String suffix = "-" + System.currentTimeMillis();
        safeName = dot > 0 ? safeName.substring(0, dot) + suffix + safeName.substring(dot) : safeName + suffix;
      }
      try {
        // DownloadManager persists requests beyond our process. Never give it
        // an ephemeral local proxy URL which another app could later bind.
        if (!url.equals(E2eeBridge.rewrite(MainActivity.this, url))) return EncryptedDownloads.enqueue(MainActivity.this,url,safeName,token);
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) throw new IllegalStateException("DownloadManager unavailable");
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle(safeName);
        request.setDescription("DSH Remote 文件传输");
        // 统一放到 Downloads/dsh-remote/ 子目录, 方便用户在系统下载里找到
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "dsh-remote/" + safeName);
        if (token != null && !token.isEmpty()) request.addRequestHeader("Authorization", "Bearer " + token);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(true);
        long id = dm.enqueue(request);
        if (id < 0) throw new IllegalStateException("enqueue 失败");
        SharedPreferences downloads = getSharedPreferences("dsh_remote_downloads", MODE_PRIVATE);
        SharedPreferences.Editor edit = downloads.edit();
        // Keep ownership metadata across Activity recreation, without retaining credentials.
        if (downloads.getAll().size() >= 200) {
          long oldest = Long.MAX_VALUE; String oldestKey = null;
          for (String key : downloads.getAll().keySet()) {
            try { long value = Long.parseLong(key); if (value < oldest) { oldest = value; oldestKey = key; } } catch (Exception ignored) {}
          }
          if (oldestKey != null) edit.remove(oldestKey);
        }
        edit.putString(String.valueOf(id), safeName).apply();
        return String.valueOf(id);
      } catch (Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        main.post(() -> Toast.makeText(MainActivity.this, "文件下载失败：" + msg, Toast.LENGTH_LONG).show());
        return "";
      }
    }

    @JavascriptInterface
    public String getFileDownloadStatus(String id) {
      if (id != null && id.startsWith("e2ee-")) return EncryptedDownloads.status(MainActivity.this,id);
      JSONObject result = new JSONObject();
      try {
        String name = getSharedPreferences("dsh_remote_downloads", MODE_PRIVATE).getString(id, null);
        result.put("phase", "unknown");
        if (name == null) return result.toString();
        result.put("name", name);
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) throw new IllegalStateException("系统下载服务不可用");
        try (Cursor cursor = dm.query(new DownloadManager.Query().setFilterById(Long.parseLong(id)))) {
          if (cursor != null && cursor.moveToFirst()) {
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            result.put("phase", status == DownloadManager.STATUS_SUCCESSFUL ? "complete" : status == DownloadManager.STATUS_FAILED ? "error" : status == DownloadManager.STATUS_PAUSED ? "paused" : "downloading");
            if (status == DownloadManager.STATUS_FAILED) {
              String message = reason == 401 || reason == 403 ? "下载鉴权失败，请重新连接服务器后重试" : reason == 404 ? "主机文件不存在" : reason == DownloadManager.ERROR_INSUFFICIENT_SPACE ? "手机存储空间不足" : reason == DownloadManager.ERROR_FILE_ALREADY_EXISTS ? "同名文件已存在，请重试" : "系统下载失败（" + reason + "），请重试";
              result.put("error", message);
            }
          }
        }
      } catch (Exception e) {
        try { result.put("phase", "error"); result.put("error", e.getMessage()); } catch (Exception ignored) {}
      }
      return result.toString();
    }

    private String safeFileName(String name) {
      if (name == null || name.trim().isEmpty()) name = "download-" + System.currentTimeMillis();
      String safe = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
      return safe.isEmpty() || safe.equals(".") || safe.equals("..") ? "download-" + System.currentTimeMillis() : safe;
    }

    @JavascriptInterface
    public boolean downloadOfficialRelease(String version, String expectedHash) {
      try { return downloadUpdate(OfficialAndroidRelease.apkUrl(version), expectedHash, true); }
      catch (IllegalArgumentException error) { return false; }
    }

    @JavascriptInterface
    public boolean downloadVerifiedAndInstall(String url, String expectedHash) {
      return downloadUpdate(url, expectedHash, false);
    }

    private synchronized boolean downloadUpdate(String url, String expectedHash, boolean official) {
      if (url == null || !url.matches("(?i)^https?://.+")
          || expectedHash == null || !expectedHash.matches("(?i)[a-f0-9]{64}")
          || downloading) return false;
      downloading = true;
      progress("downloading", 0, 0);
      new Thread(() -> {
        File apk = null;
        HttpURLConnection conn = null;
        long received = 0, total = 0;
        String failure = "storage", detail = "";
        try {
          File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
          if (dir == null) throw new IllegalStateException("download dir unavailable");
          apk = new File(dir, "dsh-remote-update.apk");

          failure = "unavailable";
          String transportUrl = official ? url : E2eeBridge.rewrite(MainActivity.this, url);
          conn = official ? (HttpURLConnection) new URL(url).openConnection() : E2eeBridge.open(MainActivity.this, url);
          conn.setConnectTimeout(15000);
          conn.setReadTimeout(60000);
          conn.setInstanceFollowRedirects(transportUrl.equals(url));
          conn.setRequestProperty("Accept", "application/vnd.android.package-archive");
          int status = conn.getResponseCode();
          if (status != 200) {
            if (status >= 300 && status < 500 && status != 404 && status != 408 && status != 429) failure = "http";
            if (status >= 100) detail = "HTTP " + status;
            throw new java.io.IOException("APK response unavailable");
          }
          total = Math.max(0, conn.getContentLengthLong());
          java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
          long lastUpdate = 0;
          try (InputStream in = conn.getInputStream()) {
            failure = "storage";
            try (FileOutputStream out = new FileOutputStream(apk)) {
              byte[] buf = new byte[65536];
              for (;;) {
                failure = "unavailable";
                int n = in.read(buf);
                failure = "storage";
                if (n == -1) break;
                out.write(buf, 0, n);
                digest.update(buf, 0, n);
                received += n;
                long now = SystemClock.elapsedRealtime();
                if (now - lastUpdate >= 200) {
                  progress("downloading", received, total);
                  lastUpdate = now;
                }
              }
            }
          }
          failure = "unavailable";
          if (total > 0 && received != total) throw new java.io.IOException("Incomplete APK");
          failure = "verify";
          if (!apk.exists() || apk.length() < 1024) throw new IllegalStateException("下载内容为空");
          progress("verifying", received, total);
          StringBuilder actual = new StringBuilder();
          for (byte b : digest.digest()) actual.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
          if (!actual.toString().equalsIgnoreCase(expectedHash)) throw new IllegalStateException("APK checksum mismatch");

          failure = "installer";
          Intent intent = new Intent(Intent.ACTION_VIEW);
          Uri uri = FileProvider.getUriForFile(
              MainActivity.this, getPackageName() + ".fileprovider", apk);
          intent.setDataAndType(uri, "application/vnd.android.package-archive");
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
          long size = received;
          main.post(() -> {
            try {
              startActivity(intent);
              finishDownload("installer", size, size, "", "");
            } catch (Exception error) {
              finishDownload("error", size, size, "installer", "");
            }
          });
        } catch (Exception error) {
          if (apk != null) apk.delete();
          finishDownload("error", received, total, failure, detail);
        } finally {
          if (conn != null) {
            if (!official) E2eeBridge.release(conn);
            conn.disconnect();
          }
        }
      }, "DSH-apk-download").start();
      return true;
    }
  }

  private class BackgroundBridge {
    @JavascriptInterface
    public void handleTaskEvent(String base, String token, String json, boolean replay) {
      try {
        synchronized (PendingNotifications.class) {
          SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
          if (!base.equals(prefs.getString("base", "")) || !token.equals(prefs.getString("token", ""))) return;
          TaskNotifications.handle(MainActivity.this, base, token, new JSONObject(json), prefs.getBoolean("notify_task_done", true), replay);
        }
      } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public boolean testNotification(String kind) {
      SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
      return TaskNotifications.test(MainActivity.this, prefs.getString("base", ""), prefs.getString("token", ""), kind);
    }

    @JavascriptInterface
    public void handlePendingEvent(String base, String token, String json, boolean enabled) {
      try { PendingNotifications.handle(MainActivity.this, base, token, new JSONObject(json), enabled); } catch (Exception ignored) {}
    }

    @JavascriptInterface
    public void setPendingNotificationsEnabled(boolean enabled) {
      synchronized (PendingNotifications.class) {
        getSharedPreferences("dsh_remote_bg", MODE_PRIVATE).edit().putBoolean("notify_pending", enabled).apply();
        if (!enabled) PendingNotifications.clear(MainActivity.this);
      }
    }

    @JavascriptInterface
    public String getPendingNavigation() { return pendingNavigation; }

    @JavascriptInterface
    public boolean matchesPendingNavigation(String base, String token, String identity) {
      return PendingNotifications.identity(base, token).equals(identity);
    }

    @JavascriptInterface
    public void acknowledgePendingNavigation(String value) {
      if (pendingNavigation.equals(value)) pendingNavigation = "";
    }

    /** JS 开关变化时保存后台轮询配置，并启动/停止前台服务。 */
    @JavascriptInterface
    public boolean saveBackgroundConfig(String json) {
      try {
        JSONObject o = new JSONObject(json == null ? "{}" : json);
        boolean enabled = o.optBoolean("enabled", false);
        double intervalMin = o.optDouble("intervalMin", 0.5);
        String base = o.optString("base", "");
        String token = o.optString("token", "");
        String clientId = o.optString("clientId", "");
        boolean notifyTaskDone = o.optBoolean("notifyTaskDone", true);
        SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
        synchronized (PendingNotifications.class) {
          boolean changed = !base.equals(prefs.getString("base", "")) || !token.equals(prefs.getString("token", ""));
          if (changed) {
            PendingNotifications.clear(MainActivity.this);
            prefs.edit().remove("seq_mux").remove("seq_host").remove("epoch_mux").remove("epoch_host").remove("seeded_mux").remove("seeded_host").apply();
          }
          SharedPreferences.Editor editor = prefs.edit()
              .putBoolean("enabled", enabled)
              .putFloat("interval_min", (float) intervalMin)
              .putString("base", base == null ? "" : base)
              .putString("token", token == null ? "" : token)
              .putString("client_id", clientId == null ? "" : clientId)
              .putBoolean("notify_task_done", notifyTaskDone);
          if (changed || enabled && !prefs.getBoolean("enabled", false)) editor.putBoolean("login_expired", false);
          editor.apply();
        }
        Intent intent = new Intent(MainActivity.this, RemotePollService.class);
        if (enabled) {
          return RemotePollService.restoreIfEnabled(MainActivity.this, true);
        } else {
          stopService(intent);
          prefs.edit().putString("service_state", "disabled").remove("service_error").apply();
        }
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }

    /** 设置页初始化/恢复时读取后台轮询状态。 */
    @JavascriptInterface
    public String getBackgroundConfig() {
      try {
        SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
        JSONObject o = new JSONObject();
        o.put("enabled", prefs.getBoolean("enabled", false));
        o.put("intervalMin", prefs.getFloat("interval_min", 0.5f));
        o.put("loginExpired", prefs.getBoolean("login_expired", false));
        o.put("notifyTaskDone", prefs.getBoolean("notify_task_done", true));
        o.put("serviceRunning", RemotePollService.isRunning());
        o.put("serviceState", prefs.getString("service_state", "stopped"));
        o.put("serviceError", prefs.getString("service_error", ""));
        o.put("lastSuccessAt", prefs.getLong("last_success_at", 0));
        o.put("lastHttpStatus", prefs.getInt("last_http_status", 0));
        o.put("apiLevel", android.os.Build.VERSION.SDK_INT);
        android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
          o.put("powerSave", power.isPowerSaveMode());
          o.put("ignoreBatteryOptimizations", power.isIgnoringBatteryOptimizations(getPackageName()));
        }
        android.app.NotificationManager notifications = (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (notifications != null && android.os.Build.VERSION.SDK_INT >= 24) o.put("notificationsEnabled", notifications.areNotificationsEnabled());
        TaskNotifications.channel(MainActivity.this);
        if (notifications != null && android.os.Build.VERSION.SDK_INT >= 26) {
          android.app.NotificationChannel attention = notifications.getNotificationChannel("dsh_remote_attention");
          android.app.NotificationChannel results = notifications.getNotificationChannel(TaskNotifications.CHANNEL);
          o.put("attentionChannelEnabled", attention == null || attention.getImportance() != android.app.NotificationManager.IMPORTANCE_NONE);
          o.put("taskChannelEnabled", results != null && results.getImportance() != android.app.NotificationManager.IMPORTANCE_NONE);
        }
        return o.toString();
      } catch (Throwable t) {
        return "{\"enabled\":false,\"intervalMin\":1,\"loginExpired\":false,\"notifyTaskDone\":true}";
      }
    }

    @JavascriptInterface
    public boolean savePeakReminderConfig(String json) {
      try {
        JSONObject value = new JSONObject(json == null ? "{}" : json);
        boolean enabled = value.optBoolean("enabled", false);
        SharedPreferences p = getSharedPreferences(PeakReminderService.PREFS, MODE_PRIVATE);
        synchronized (PeakReminderService.class) {
          String base = value.optString("base", ""), token = value.optString("token", "");
          boolean changed = !base.equals(p.getString("base", "")) || !token.equals(p.getString("token", ""));
          SharedPreferences.Editor e = p.edit().putBoolean("enabled", enabled).putString("base", base).putString("token", token).putString("client_id",value.optString("clientId", ""));
          if (changed || !enabled) e.remove("schedule").remove("last_fired_at");
          e.apply();
          if (value.optJSONObject("policy") != null) PeakReminderService.storeSchedule(p,value.optJSONObject("policy"));
        }
        if (enabled) return PeakReminderService.restoreIfEnabled(MainActivity.this, false);
        stopService(new Intent(MainActivity.this,PeakReminderService.class));
        android.app.NotificationManager nm=getSystemService(android.app.NotificationManager.class);
        if(nm!=null) { nm.cancel(8811);nm.cancel(8812); }
        return true;
      } catch (Exception error) { return false; }
    }

    @JavascriptInterface
    public String getPeakReminderConfig() {
      try {
        SharedPreferences p = getSharedPreferences(PeakReminderService.PREFS, MODE_PRIVATE);
        return new JSONObject().put("enabled",p.getBoolean("enabled",false)).put("running",PeakReminderService.isRunning())
            .put("status",p.getString("status","stopped")).put("lastSyncAt",p.getLong("last_sync_at",0)).toString();
      } catch(Exception error) { return "{}"; }
    }

    /** Cached pages can only restore a configured plugin-backed receiver. */
    @JavascriptInterface
    public boolean startPeakReminder() {
      return PeakReminderService.restoreIfEnabled(MainActivity.this, false);
    }

    @JavascriptInterface
    public boolean stopPeakReminder() {
      try {
        getSharedPreferences(PeakReminderService.PREFS, MODE_PRIVATE).edit().putBoolean("enabled",false).remove("schedule").apply();
        stopService(new Intent(MainActivity.this, PeakReminderService.class));
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }
  }

}
