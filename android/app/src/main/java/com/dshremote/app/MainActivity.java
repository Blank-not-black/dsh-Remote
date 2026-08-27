package com.dshremote.app;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

  private final Handler main = new Handler(Looper.getMainLooper());
  private AsrTestBridge asrTestBridge;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // DSH Remote 走局域网 http 网关: 显式允许混合内容(https 壳加载 http API)
    try {
      WebSettings settings = bridge.getWebView().getSettings();
      settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    } catch (Throwable ignored) {
    }
    // JS 桥: 下载 APK 并打开系统安装器(不依赖 Capacitor 插件路由)
    // 同一桥再以 NativeFile 暴露: 文件页下载到系统 Downloads(Android 10+ 无需存储权限)
    try {
      UpdateBridge updateBridge = new UpdateBridge();
      bridge.getWebView().addJavascriptInterface(updateBridge, "NativeUpdate");
      bridge.getWebView().addJavascriptInterface(updateBridge, "NativeFile");
      BackgroundBridge backgroundBridge = new BackgroundBridge();
      bridge.getWebView().addJavascriptInterface(backgroundBridge, "NativeBackground");
      asrTestBridge = new AsrTestBridge();
      bridge.getWebView().addJavascriptInterface(asrTestBridge, "NativeAsrTest");
    } catch (Throwable ignored) {
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == AsrTestBridge.AUDIO_PERMISSION_REQUEST && asrTestBridge != null) {
      asrTestBridge.onAudioPermissionResult(grantResults.length > 0
          && grantResults[0] == PackageManager.PERMISSION_GRANTED);
    }
  }

  @Override
  public void onDestroy() {
    if (asrTestBridge != null) asrTestBridge.shutdown();
    super.onDestroy();
  }

  private class UpdateBridge {
    /** 把系统栏真实 inset(dp) 交给前端, 处理刘海/状态栏/手势条 */
    @JavascriptInterface
    public String getInsets() {
      try {
        float d = getResources().getDisplayMetrics().density;
        int top = 0, bottom = 0;
        android.view.WindowInsets ins = getWindow().getDecorView().getRootWindowInsets();
        if (ins != null) {
          top = (int) Math.ceil(ins.getInsets(android.view.WindowInsets.Type.statusBars()).top / d);
          bottom = (int) Math.ceil(ins.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom / d);
        }
        if (top == 0) {
          int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
          top = id > 0 ? (int) Math.ceil(getResources().getDimensionPixelSize(id) / d) : 0;
        }
        return "{\"top\":" + top + ",\"bottom\":" + bottom + "}";
      } catch (Throwable t) {
        return "{\"top\":0,\"bottom\":0}";
      }
    }

    @JavascriptInterface
    public void downloadToDownloads(String url, String filename, String token) {
      if (url == null || url.isEmpty()) return;
      final String safeName = safeFileName(filename);
      main.post(() -> Toast.makeText(MainActivity.this, "开始下载：" + safeName, Toast.LENGTH_SHORT).show());
      new Thread(() -> {
        try {
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
        } catch (Exception e) {
          String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
          main.post(() -> Toast.makeText(MainActivity.this, "文件下载失败：" + msg, Toast.LENGTH_LONG).show());
        }
      }).start();
    }

    private String safeFileName(String name) {
      if (name == null || name.trim().isEmpty()) name = "download-" + System.currentTimeMillis();
      return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    @JavascriptInterface
    public void downloadAndInstall(String url) {
      if (url == null || url.isEmpty()) return;
      main.post(() -> Toast.makeText(MainActivity.this, "开始下载更新…", Toast.LENGTH_SHORT).show());
      new Thread(() -> {
        try {
          File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
          if (dir == null) throw new IllegalStateException("download dir unavailable");
          File apk = new File(dir, "dsh-remote-update.apk");

          HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
          conn.setConnectTimeout(15000);
          conn.setReadTimeout(60000);
          conn.setInstanceFollowRedirects(true);
          conn.setRequestProperty("Accept", "application/vnd.android.package-archive");
          try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
          } finally {
            conn.disconnect();
          }
          if (!apk.exists() || apk.length() < 1024) throw new IllegalStateException("下载内容为空");

          Intent intent = new Intent(Intent.ACTION_VIEW);
          Uri uri = FileProvider.getUriForFile(
              MainActivity.this, getPackageName() + ".fileprovider", apk);
          intent.setDataAndType(uri, "application/vnd.android.package-archive");
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
          main.post(() -> {
            startActivity(intent);
            Toast.makeText(MainActivity.this, "下载完成，请在安装页确认", Toast.LENGTH_SHORT).show();
          });
        } catch (Exception e) {
          String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
          main.post(() -> Toast.makeText(MainActivity.this, "更新下载失败：" + msg, Toast.LENGTH_LONG).show());
        }
      }).start();
    }
  }

  private class BackgroundBridge {
    /** JS 开关变化时保存后台轮询配置，并启动/停止前台服务。 */
    @JavascriptInterface
    public void saveBackgroundConfig(String json) {
      try {
        JSONObject o = new JSONObject(json == null ? "{}" : json);
        boolean enabled = o.optBoolean("enabled", false);
        double intervalMin = o.optDouble("intervalMin", 0.5);
        String base = o.optString("base", "");
        String token = o.optString("token", "");
        String clientId = o.optString("clientId", "");
        boolean notifyTaskDone = o.optBoolean("notifyTaskDone", true);
        SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
        prefs.edit()
            .putBoolean("enabled", enabled)
            .putFloat("interval_min", (float) intervalMin)
            .putString("base", base == null ? "" : base)
            .putString("token", token == null ? "" : token)
            .putString("client_id", clientId == null ? "" : clientId)
            .putBoolean("login_expired", false)
            .putBoolean("notify_task_done", notifyTaskDone)
            .apply();
        Intent intent = new Intent(MainActivity.this, RemotePollService.class);
        if (enabled) {
          if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
          else startService(intent);
        } else {
          stopService(intent);
        }
      } catch (Throwable ignored) {
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
        return o.toString();
      } catch (Throwable t) {
        return "{\"enabled\":false,\"intervalMin\":1,\"loginExpired\":false,\"notifyTaskDone\":true}";
      }
    }

    /** 峰谷提醒：启动/停止前台服务（进程内定时，绕开 MIUI 后台限制）。 */
    @JavascriptInterface
    public boolean startPeakReminder() {
      try {
        Intent intent = new Intent(MainActivity.this, PeakReminderService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }

    @JavascriptInterface
    public boolean stopPeakReminder() {
      try {
        stopService(new Intent(MainActivity.this, PeakReminderService.class));
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }
  }

  /**
   * Android 系统 ASR 诊断桥。
   *
   * 这是设置页的短时能力测试，不是会议录音实现：SpeechRecognizer 独占麦克风，
   * 每次 onResults/onError 后销毁并重建，用于观察小米/系统云端识别服务的 partial、
   * 最终结果、连续 session 和恢复表现。测试结果只回传当前 WebView，不上传报告。
   */
  private class AsrTestBridge {
    private static final int AUDIO_PERMISSION_REQUEST = 9101;
    private static final long TEST_DURATION_MS = 60_000L;
    private static final long RESTART_DELAY_MS = 500L;
    private static final int MAX_RESTARTS = 12;

    private SpeechRecognizer recognizer;
    private boolean running;
    private boolean permissionPending;
    private boolean restartPending;
    private long startedAt;
    private long sessionStartedAt;
    private int sessionGeneration;
    private int activeSession = -1;
    private int terminalSession = -1;
    private int sessionCount;
    private int restartCount;
    private int partialCount;
    private int finalCount;
    private int errorCount;
    private int rmsCallbackCount;
    private long firstPartialMs = -1L;
    private long firstFinalMs = -1L;
    private Runnable deadlineTask;

    @JavascriptInterface
    public boolean startAsrTest() {
      main.post(this::startOnMain);
      return true;
    }

    @JavascriptInterface
    public boolean stopAsrTest() {
      main.post(() -> finishAsrTest("user-stopped"));
      return true;
    }

    @JavascriptInterface
    public boolean openAsrPermissionSettings() {
      main.post(() -> {
        try {
          Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
          intent.setData(Uri.parse("package:" + getPackageName()));
          startActivity(intent);
        } catch (Throwable error) {
          emitError(-1, "open-permission-settings", error);
        }
      });
      return true;
    }

    @JavascriptInterface
    public boolean openAsrEngineSettings() {
      main.post(() -> {
        if (openPackage("com.miui.voiceassist")) return;
        try {
          startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS));
          return;
        } catch (Throwable ignored) {
        }
        if (openPackageDetails("com.xiaomi.mibrain.speech")) return;
        emitError(-1, "open-asr-engine-settings", new IllegalStateException("voice input settings unavailable"));
      });
      return true;
    }

    private boolean openPackage(String packageName) {
      try {
        Intent intent = getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent == null) return false;
        startActivity(intent);
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }

    private boolean openPackageDetails(String packageName) {
      try {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + packageName));
        startActivity(intent);
        return true;
      } catch (Throwable ignored) {
        return false;
      }
    }

    private void startOnMain() {
      if (running || permissionPending) {
        emitStatus("busy", "已有 ASR 测试正在运行");
        return;
      }
      if (Build.VERSION.SDK_INT >= 23
          && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        permissionPending = true;
        emitStatus("permission-requesting", "正在请求麦克风权限");
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
        return;
      }
      beginOnMain();
    }

    private void beginOnMain() {
      running = true;
      permissionPending = false;
      restartPending = false;
      startedAt = SystemClock.elapsedRealtime();
      sessionStartedAt = 0L;
      sessionGeneration = 0;
      activeSession = -1;
      terminalSession = -1;
      sessionCount = 0;
      restartCount = 0;
      partialCount = 0;
      finalCount = 0;
      errorCount = 0;
      rmsCallbackCount = 0;
      firstPartialMs = -1L;
      firstFinalMs = -1L;
      emit("meta", buildDeviceMeta());
      emitStatus("starting", "开始测试 Android 系统云端 ASR");
      boolean available;
      try {
        available = SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
      } catch (Throwable error) {
        emitError(-1, "availability-check", error);
        finishAsrTest("availability-check-failed");
        return;
      }
      if (!available) {
        emitStatus("unsupported", "当前设备没有可用的 SpeechRecognizer");
        finishAsrTest("recognition-unavailable");
        return;
      }
      deadlineTask = () -> finishAsrTest("test-duration-reached");
      main.postDelayed(deadlineTask, TEST_DURATION_MS);
      startRecognizer("initial");
    }

    private JSONObject buildDeviceMeta() {
      JSONObject value = new JSONObject();
      try {
        value.put("brand", Build.BRAND == null ? "" : Build.BRAND);
        value.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        value.put("model", Build.MODEL == null ? "" : Build.MODEL);
        value.put("androidVersion", Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE);
        value.put("apiLevel", Build.VERSION.SDK_INT);
        value.put("recordAudioPermission", hasRecordAudioPermission());
        value.put("recordAudioAppOp", recordAudioAppOp());
        value.put("microphoneMuted", microphoneMuted());
        value.put("recognitionAvailable", SpeechRecognizer.isRecognitionAvailable(MainActivity.this));
        boolean onDevice = false;
        try {
          onDevice = Build.VERSION.SDK_INT >= 31
              && SpeechRecognizer.isOnDeviceRecognitionAvailable(MainActivity.this);
        } catch (Throwable ignored) {
        }
        value.put("onDeviceAvailable", onDevice);
        value.put("networkPath", "system-default-recognition-service");
        value.put("recognitionServices", listRecognitionServices());
      } catch (Throwable error) {
        try { value.put("metaError", error.toString()); } catch (Throwable ignored) { }
      }
      return value;
    }

    private JSONArray listRecognitionServices() {
      JSONArray services = new JSONArray();
      try {
        Intent query = new Intent(RecognitionService.SERVICE_INTERFACE);
        List<ResolveInfo> matches = getPackageManager().queryIntentServices(query, 0);
        for (ResolveInfo match : matches) {
          if (match.serviceInfo == null) continue;
          JSONObject item = new JSONObject();
          item.put("packageName", match.serviceInfo.packageName);
          item.put("serviceName", match.serviceInfo.name);
          String packageName = match.serviceInfo.packageName.toLowerCase(Locale.ROOT);
          item.put("xiaomiLike", packageName.contains("xiaomi") || packageName.contains("miui"));
          services.put(item);
        }
      } catch (Throwable ignored) {
      }
      return services;
    }

    private void startRecognizer(String reason) {
      if (!running) return;
      restartPending = false;
      activeSession = -1;
      destroyRecognizer();
      final int session = ++sessionGeneration;
      activeSession = session;
      terminalSession = -1;
      sessionCount++;
      sessionStartedAt = SystemClock.elapsedRealtime();
      try {
        recognizer = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
        recognizer.setRecognitionListener(new RecognitionListener() {
          @Override public void onReadyForSpeech(Bundle params) { callback(session, "onReadyForSpeech"); }
          @Override public void onBeginningOfSpeech() { callback(session, "onBeginningOfSpeech"); }
          @Override public void onRmsChanged(float rmsdB) { rmsCallbackCount++; }
          @Override public void onBufferReceived(byte[] buffer) {
            callback(session, "onBufferReceived", buffer == null ? 0 : buffer.length);
          }
          @Override public void onEndOfSpeech() { callback(session, "onEndOfSpeech"); }
          @Override public void onError(int error) {
            if (!isActive(session) || terminalSession == session) return;
            terminalSession = session;
            errorCount++;
            JSONObject data = new JSONObject();
            try {
              data.put("session", session);
              data.put("code", error);
              data.put("name", errorName(error));
              data.put("message", errorName(error));
              data.put("elapsedMs", elapsedSinceSession());
            } catch (Throwable ignored) { }
            emit("error", data);
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
              emitStatus("permission-error", permissionDiagnosticMessage());
              finishAsrTest("permission-error");
              return;
            }
            scheduleRestart("error:" + errorName(error));
          }
          @Override public void onResults(Bundle results) {
            if (!isActive(session) || terminalSession == session) return;
            terminalSession = session;
            finalCount++;
            String text = firstResult(results);
            if (firstFinalMs < 0) firstFinalMs = elapsedSinceStart();
            emitText("final", session, text, elapsedSinceSession(), finalCount);
            scheduleRestart("final");
          }
          @Override public void onPartialResults(Bundle results) {
            if (!isActive(session)) return;
            partialCount++;
            if (firstPartialMs < 0) firstPartialMs = elapsedSinceStart();
            emitText("partial", session, firstResult(results), elapsedSinceSession(), partialCount);
          }
          @Override public void onEvent(int eventType, Bundle params) { callback(session, "onEvent:" + eventType); }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "zh-CN");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "DSH Remote ASR 测试");
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        emitStatus("listening", "正在监听，请朗读中文测试内容", session, reason);
        recognizer.startListening(intent);
      } catch (Throwable error) {
        emitError(-1, "start-listening", error, session);
        scheduleRestart("start-failed");
      }
    }

    private void scheduleRestart(String reason) {
      if (!running || restartPending) return;
      if (elapsedSinceStart() >= TEST_DURATION_MS || restartCount >= MAX_RESTARTS) {
        finishAsrTest(restartCount >= MAX_RESTARTS ? "restart-limit-reached" : "session-ended");
        return;
      }
      restartPending = true;
      restartCount++;
      emitStatus("restarting", "识别 session 结束，准备重建", activeSession, reason);
      main.postDelayed(() -> startRecognizer(reason), RESTART_DELAY_MS);
    }

    private void finishAsrTest(String reason) {
      if (!running && !permissionPending) return;
      running = false;
      permissionPending = false;
      restartPending = false;
      activeSession = -1;
      if (deadlineTask != null) {
        main.removeCallbacks(deadlineTask);
        deadlineTask = null;
      }
      destroyRecognizer();
      emit("summary", buildSummary(reason));
      emitStatus("stopped", "ASR 测试结束", -1, reason);
    }

    private JSONObject buildSummary(String reason) {
      JSONObject value = new JSONObject();
      try {
        value.put("reason", reason);
        value.put("durationMs", elapsedSinceStart());
        value.put("sessionCount", sessionCount);
        value.put("restartCount", restartCount);
        value.put("partialCount", partialCount);
        value.put("finalCount", finalCount);
        value.put("errorCount", errorCount);
        value.put("rmsCallbackCount", rmsCallbackCount);
        value.put("firstPartialMs", firstPartialMs < 0 ? JSONObject.NULL : firstPartialMs);
        value.put("firstFinalMs", firstFinalMs < 0 ? JSONObject.NULL : firstFinalMs);
        value.put("usable", finalCount > 0);
      } catch (Throwable ignored) { }
      return value;
    }

    private boolean isActive(int session) {
      return running && activeSession == session;
    }

    private String firstResult(Bundle results) {
      if (results == null) return "";
      ArrayList<String> values = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
      return values == null || values.isEmpty() || values.get(0) == null ? "" : values.get(0);
    }

    private long elapsedSinceStart() {
      return startedAt <= 0 ? 0 : Math.max(0, SystemClock.elapsedRealtime() - startedAt);
    }

    private long elapsedSinceSession() {
      return sessionStartedAt <= 0 ? 0 : Math.max(0, SystemClock.elapsedRealtime() - sessionStartedAt);
    }

    private void callback(int session, String name) { callback(session, name, -1); }

    private void callback(int session, String name, int bytes) {
      if (!isActive(session)) return;
      JSONObject data = new JSONObject();
      try {
        data.put("session", session);
        data.put("name", name);
        data.put("elapsedMs", elapsedSinceSession());
        if (bytes >= 0) data.put("bytes", bytes);
      } catch (Throwable ignored) { }
      emit("callback", data);
    }

    private void emitText(String type, int session, String text, long elapsedMs, int count) {
      JSONObject data = new JSONObject();
      try {
        data.put("session", session);
        data.put("text", text == null ? "" : text);
        data.put("elapsedMs", elapsedMs);
        data.put("count", count);
      } catch (Throwable ignored) { }
      emit(type, data);
    }

    private void emitStatus(String status, String message) { emitStatus(status, message, -1, ""); }

    private void emitStatus(String status, String message, int session, String reason) {
      JSONObject data = new JSONObject();
      try {
        data.put("status", status);
        data.put("message", message);
        if (session >= 0) data.put("session", session);
        if (reason != null && !reason.isEmpty()) data.put("reason", reason);
      } catch (Throwable ignored) { }
      emit("status", data);
    }

    private void emitError(int code, String stage, Throwable error) { emitError(code, stage, error, activeSession); }

    private void emitError(int code, String stage, Throwable error, int session) {
      JSONObject data = new JSONObject();
      try {
        data.put("code", code);
        data.put("name", stage);
        data.put("message", error == null ? "" : String.valueOf(error.getMessage()));
        data.put("exception", error == null ? "" : error.getClass().getName());
        if (session >= 0) data.put("session", session);
        data.put("elapsedMs", elapsedSinceStart());
      } catch (Throwable ignored) { }
      emit("error", data);
    }

    private void emit(String type, JSONObject data) {
      try {
        JSONObject event = new JSONObject();
        event.put("type", type);
        event.put("atMs", elapsedSinceStart());
        if (data != null) event.put("data", data);
        String script = "window.__dshAsrEvent && window.__dshAsrEvent(" + event + ")";
        main.post(() -> {
          try { bridge.getWebView().evaluateJavascript(script, null); } catch (Throwable ignored) { }
        });
      } catch (Throwable ignored) {
      }
    }

    private void destroyRecognizer() {
      if (recognizer == null) return;
      try { recognizer.cancel(); } catch (Throwable ignored) { }
      try { recognizer.destroy(); } catch (Throwable ignored) { }
      recognizer = null;
    }

    private void onAudioPermissionResult(boolean granted) {
      main.post(() -> {
        if (!permissionPending) return;
        permissionPending = false;
        if (granted) beginOnMain();
        else emitStatus("permission-denied", "未授予麦克风权限，可打开系统设置后重试");
      });
    }

    private boolean hasRecordAudioPermission() {
      return Build.VERSION.SDK_INT < 23
          || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private String recordAudioAppOp() {
      if (Build.VERSION.SDK_INT < 23) return "not-applicable";
      try {
        AppOpsManager appOps = (AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
        if (appOps == null) return "unknown";
        int mode = appOps.noteOpNoThrow(AppOpsManager.OPSTR_RECORD_AUDIO, getApplicationInfo().uid, getPackageName());
        switch (mode) {
          case AppOpsManager.MODE_ALLOWED: return "allowed";
          case AppOpsManager.MODE_IGNORED: return "ignored";
          case AppOpsManager.MODE_ERRORED: return "errored";
          case AppOpsManager.MODE_DEFAULT: return "default";
          default: return String.valueOf(mode);
        }
      } catch (Throwable ignored) {
        return "unknown";
      }
    }

    private boolean microphoneMuted() {
      try {
        android.media.AudioManager audio = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
        return audio != null && audio.isMicrophoneMute();
      } catch (Throwable ignored) {
        return false;
      }
    }

    private String permissionDiagnosticMessage() {
      return "系统语音识别服务拒绝了麦克风访问；请允许 DSH Remote 使用麦克风，并确认系统隐私设置中的麦克风开关已开启";
    }

    private void shutdown() {
      main.post(() -> finishAsrTest("activity-destroyed"));
    }

    private String errorName(int error) {
      switch (error) {
        case SpeechRecognizer.ERROR_AUDIO: return "ERROR_AUDIO";
        case SpeechRecognizer.ERROR_CLIENT: return "ERROR_CLIENT";
        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "ERROR_INSUFFICIENT_PERMISSIONS";
        case SpeechRecognizer.ERROR_NETWORK: return "ERROR_NETWORK";
        case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "ERROR_NETWORK_TIMEOUT";
        case SpeechRecognizer.ERROR_NO_MATCH: return "ERROR_NO_MATCH";
        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "ERROR_RECOGNIZER_BUSY";
        case SpeechRecognizer.ERROR_SERVER: return "ERROR_SERVER";
        case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "ERROR_SPEECH_TIMEOUT";
        default: return "ERROR_" + error;
      }
    }
  }
}
