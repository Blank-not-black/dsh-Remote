package com.dshremote.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

  private static final int SPEECH_PERMISSION_REQ = 4101;

  private final Handler main = new Handler(Looper.getMainLooper());
  private SpeechBridge speechBridge;

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
      speechBridge = new SpeechBridge();
      bridge.getWebView().addJavascriptInterface(speechBridge, "NativeSpeech");
    } catch (Throwable ignored) {
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode == SPEECH_PERMISSION_REQ && speechBridge != null) {
      boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
      speechBridge.onPermissionResult(granted);
    }
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
    if (speechBridge != null) speechBridge.destroyRecognizer();
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

    /** 下载 SenseVoice-Small 离线语言包到 App 私有目录(零依赖: HttpURLConnection 系统 API)。
     *  进度经 window.__offlinePackBridge({type:'progress'|'done'|'error', ...}) 回传 JS。 */
    @JavascriptInterface
    public void downloadOfflinePack(String url, String fileName) {
      if (url == null || url.isEmpty()) return;
      final String safeName = safeFileName(fileName == null || fileName.trim().isEmpty() ? "sensevoice-small.zip" : fileName);
      new Thread(() -> {
        try {
          File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
          if (dir == null) throw new IllegalStateException("app private dir unavailable");
          File packDir = new File(dir, "dsh-remote-offline");
          if (!packDir.exists() && !packDir.mkdirs()) throw new IllegalStateException("mkdir failed");
          final File target = new File(packDir, safeName);
          HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
          conn.setConnectTimeout(15000);
          conn.setReadTimeout(30000);
          conn.setInstanceFollowRedirects(true);
          conn.setRequestProperty("User-Agent", "dsh-remote/" + getPackageName());
          try {
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
            long total = conn.getContentLengthLong();
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
              byte[] buf = new byte[65536];
              int n, written = 0;
              long lastEmit = 0;
              while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                written += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 250 && total > 0) {
                  lastEmit = now;
                  sendOfflineEvent("progress", String.valueOf(Math.min(99, Math.round(written * 100f / total))), "");
                }
              }
            }
            if (target.length() < 1024) throw new IllegalStateException("downloaded content too small");
            sendOfflineEvent("done", String.valueOf(target.length()), target.getAbsolutePath());
          } finally {
            conn.disconnect();
          }
        } catch (Exception e) {
          String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
          sendOfflineEvent("error", "", msg);
        }
      }).start();
    }

    /** 离线包下载进度/结果回传 JS(主线程 evaluateJavascript, 与语音桥同一模式)。 */
    private void sendOfflineEvent(String type, String value, String extra) {
      try {
        JSONObject o = new JSONObject();
        o.put("type", type);
        o.put("value", value == null ? "" : value);
        o.put("extra", extra == null ? "" : extra);
        String js = "window.__offlinePackBridge && window.__offlinePackBridge(" + o.toString() + ")";
        js = js.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        final String code = js;
        main.post(() -> {
          try {
            bridge.getWebView().evaluateJavascript(code, null);
          } catch (Throwable ignored) {
          }
        });
      } catch (Throwable ignored) {
      }
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
        double intervalMin = o.optDouble("intervalMin", 1.0);
        String base = o.optString("base", "");
        String token = o.optString("token", "");
        boolean notifyTaskDone = o.optBoolean("notifyTaskDone", true);
        SharedPreferences prefs = getSharedPreferences("dsh_remote_bg", MODE_PRIVATE);
        prefs.edit()
            .putBoolean("enabled", enabled)
            .putFloat("interval_min", (float) intervalMin)
            .putString("base", base == null ? "" : base)
            .putString("token", token == null ? "" : token)
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
        o.put("intervalMin", prefs.getFloat("interval_min", 1f));
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

  /** 语音输入桥: android.speech.SpeechRecognizer 系统识别(WebView 不支持 Web Speech API)。
   *  JS 侧 window.NativeSpeech.start()/stop()/cancel(), 回调经 evaluateJavascript 走
   *  window.__speechBridge({type:'partial'|'final'|'error', text, error})。 */
  private class SpeechBridge {
    private static final int ERROR_INSUFFICIENT_PERMISSIONS = 9;
    private SpeechRecognizer recognizer;
    private boolean active = false;
    // JS 会话是否仍想识别: start() 置 true, stop()/cancel() 置 false。
    // 授权回调后只有 pendingStart 仍为 true 才真正启动, 避免"按一下松手后授权回来才识别"的孤儿会话。
    private boolean pendingStart = false;
    private boolean retriedError9 = false;
    // RMS 实时波形节流(约 10 次/秒), 避免刷爆 evaluateJavascript
    private long lastRmsAt = 0;

    @JavascriptInterface
    public boolean isAvailable() {
      try {
        return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
      } catch (Throwable t) {
        return false;
      }
    }

    @JavascriptInterface
    public boolean hasPermission() {
      try {
        return Build.VERSION.SDK_INT < 23
            || ActivityCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
      } catch (Throwable t) {
        return false;
      }
    }

    /** 仅申请麦克风权限(不启动识别), 供 JS 在点语音图标/进功能测试页时提前申请, 避免打断按住手势。 */
    @JavascriptInterface
    public void requestPermission() {
      main.post(() -> {
        if (hasPermission()) return;
        ActivityCompat.requestPermissions(MainActivity.this,
            new String[]{android.Manifest.permission.RECORD_AUDIO}, SPEECH_PERMISSION_REQ);
      });
    }

    /** 开始识别。权限未授予时先弹授权框, 授权回调后若会话仍有效(pendingStart)才真正 start。 */
    @JavascriptInterface
    public void start() {
      main.post(() -> {
        if (active) return;
        pendingStart = true;
        if (!hasPermission()) {
          ActivityCompat.requestPermissions(MainActivity.this,
              new String[]{android.Manifest.permission.RECORD_AUDIO}, SPEECH_PERMISSION_REQ);
          return;
        }
        startRecognizer();
      });
    }

    void onPermissionResult(boolean granted) {
      if (granted) {
        if (pendingStart) startRecognizer();
      } else {
        sendEvent("error", "", "permission");
      }
    }

    /** 松手结束: 停止监听, onResults 会回调最终文本。 */
    @JavascriptInterface
    public void stop() {
      pendingStart = false;
      main.post(() -> {
        if (recognizer == null) return;
        try {
          recognizer.stopListening();
        } catch (Throwable t) {
          sendEvent("error", "", "4"); // ERROR_CLIENT
          destroyRecognizer();
        }
      });
    }

    /** 上移取消: 直接取消, 不产生结果回调。 */
    @JavascriptInterface
    public void cancel() {
      pendingStart = false;
      main.post(() -> {
        try {
          if (recognizer != null) recognizer.cancel();
        } catch (Throwable ignored) {
        }
        destroyRecognizer();
      });
    }

    private void startRecognizer() {
      destroyRecognizer();
      retriedError9 = false;
      try {
        SpeechRecognizer rec;
        if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(MainActivity.this)) {
          // 优先离线识别: 不依赖网络服务, 多数 ROM 更稳定
          rec = SpeechRecognizer.createOnDeviceSpeechRecognizer(MainActivity.this);
        } else {
          rec = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
        }
        recognizer = rec;
        recognizer.setRecognitionListener(new RecognitionListener() {
          @Override public void onReadyForSpeech(Bundle params) {}
          @Override public void onBeginningOfSpeech() {}
          @Override public void onRmsChanged(float rmsdB) {
            // 实时音量 → JS 波形动画(归一化 0~1, 节流 ~10 次/秒)
            long now = System.currentTimeMillis();
            if (now - lastRmsAt < 100) return;
            lastRmsAt = now;
            float level = Math.max(0f, Math.min(1f, rmsdB / 10f));
            sendEvent("rms", String.valueOf(level), "");
          }
          @Override public void onBufferReceived(byte[] buffer) {}
          @Override public void onEndOfSpeech() {}
          @Override public void onError(int error) {
            active = false;
            destroyRecognizer();
            // 部分 ROM 首次调用会误报 ERROR_INSUFFICIENT_PERMISSIONS, 会话仍有效时重试一次
            if (error == ERROR_INSUFFICIENT_PERMISSIONS && pendingStart && !retriedError9) {
              retriedError9 = true;
              main.postDelayed(() -> {
                if (pendingStart && !active) startRecognizer();
              }, 300);
              return;
            }
            sendEvent("error", "", String.valueOf(error));
          }
          @Override public void onResults(Bundle results) {
            active = false;
            String text = firstResult(results);
            sendEvent("final", text, "");
            destroyRecognizer();
          }
          @Override public void onPartialResults(Bundle partialResults) {
            String text = firstResult(partialResults);
            if (text != null && !text.isEmpty()) sendEvent("partial", text, "");
          }
          @Override public void onEvent(int eventType, Bundle params) {}
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        recognizer.startListening(intent);
        active = true;
      } catch (Throwable t) {
        sendEvent("error", "", "4"); // ERROR_CLIENT
        destroyRecognizer();
      }
    }

    private String firstResult(Bundle b) {
      try {
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (list != null && !list.isEmpty()) ? list.get(0) : "";
      } catch (Throwable t) {
        return "";
      }
    }

    void destroyRecognizer() {
      try {
        if (recognizer != null) {
          recognizer.setRecognitionListener(null);
          recognizer.destroy();
        }
      } catch (Throwable ignored) {
      }
      recognizer = null;
      active = false;
    }

    /** 统一把事件送回 JS(主线程 evaluateJavascript)。 */
    private void sendEvent(String type, String text, String error) {
      try {
        JSONObject o = new JSONObject();
        o.put("type", type);
        o.put("text", text == null ? "" : text);
        o.put("error", error == null ? "" : error);
        String js = "window.__speechBridge && window.__speechBridge(" + o.toString() + ")";
        // U+2028/2029 在旧 JS 引擎字符串字面量里是非法字符, 手动转义
        js = js.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        final String code = js;
        main.post(() -> {
          try {
            bridge.getWebView().evaluateJavascript(code, null);
          } catch (Throwable ignored) {
          }
        });
      } catch (Throwable ignored) {
      }
    }
  }
}
