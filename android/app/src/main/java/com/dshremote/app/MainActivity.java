package com.dshremote.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
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

  private final Handler main = new Handler(Looper.getMainLooper());

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
    } catch (Throwable ignored) {
    }
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
    public void startPeakReminder() {
      try {
        Intent intent = new Intent(MainActivity.this, PeakReminderService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
      } catch (Throwable ignored) {
      }
    }

    @JavascriptInterface
    public void stopPeakReminder() {
      try {
        stopService(new Intent(MainActivity.this, PeakReminderService.class));
      } catch (Throwable ignored) {
      }
    }
  }
}
