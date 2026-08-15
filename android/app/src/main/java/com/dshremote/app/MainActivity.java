package com.dshremote.app;

import android.content.Intent;
import android.net.Uri;
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
    try {
      bridge.getWebView().addJavascriptInterface(new UpdateBridge(), "NativeUpdate");
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
}
