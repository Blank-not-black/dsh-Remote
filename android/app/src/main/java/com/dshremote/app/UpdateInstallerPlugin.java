package com.dshremote.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * App 内更新: 下载 APK 到应用私有外部目录, 用系统安装器打开。
 * JS 侧: Capacitor.Plugins.UpdateInstaller.downloadAndInstall({ url })
 */
@CapacitorPlugin(name = "UpdateInstaller")
public class UpdateInstallerPlugin extends Plugin {

  @PluginMethod
  public void downloadAndInstall(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("url is required");
      return;
    }
    call.resolve();

    final String apkUrl = url;
    new Thread(() -> {
      Handler main = new Handler(Looper.getMainLooper());
      main.post(() -> Toast.makeText(getContext(), "开始下载 DSH Remote 更新…", Toast.LENGTH_SHORT).show());
      try {
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IllegalStateException("download dir unavailable");
        File apk = new File(dir, "dsh-remote-update.apk");

        HttpURLConnection conn = (HttpURLConnection) new URL(apkUrl).openConnection();
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
            getContext(), getContext().getPackageName() + ".fileprovider", apk);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(intent);
        main.post(() -> Toast.makeText(getContext(), "下载完成，请在安装页确认", Toast.LENGTH_SHORT).show());
      } catch (Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        main.post(() -> Toast.makeText(getContext(), "更新下载失败：" + msg, Toast.LENGTH_LONG).show());
      }
    }).start();
  }
}
