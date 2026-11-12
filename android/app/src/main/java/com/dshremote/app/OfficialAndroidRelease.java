package com.dshremote.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONObject;

final class OfficialAndroidRelease {
  private static final String RELEASES = "https://github.com/Blank-not-black/dsh-Remote/releases/";
  private static final Pattern STABLE_VERSION = Pattern.compile("[0-9]+\\.[0-9]+\\.[0-9]+");
  private static final Pattern APK_DIGEST = Pattern.compile("(?m)^([a-fA-F0-9]{64})[ \\t]+\\*?dsh-remote\\.apk\\r?$");

  private OfficialAndroidRelease() {}

  private static String assetBase(String version) {
    if (version == null || !STABLE_VERSION.matcher(version).matches()) {
      throw new IllegalArgumentException("Invalid stable release version");
    }
    return RELEASES + "download/v" + version + "/";
  }

  static String apkUrl(String version) {
    return assetBase(version) + "dsh-remote.apk";
  }

  static JSONObject latest() throws Exception {
    HttpURLConnection latest = connect(RELEASES + "latest");
    String version;
    try {
      latest.setInstanceFollowRedirects(false);
      int status = latest.getResponseCode();
      String location = latest.getHeaderField("Location");
      if (status < 300 || status >= 400 || location == null) throw new IOException("Latest release unavailable");
      String tag = new URL(latest.getURL(), location).toExternalForm();
      String prefix = RELEASES + "tag/v";
      if (!tag.startsWith(prefix)) throw new IOException("Unexpected release redirect");
      version = tag.substring(prefix.length());
    } finally {
      latest.disconnect();
    }

    HttpURLConnection sums = connect(assetBase(version) + "SHA256SUMS.txt");
    try {
      if (sums.getResponseCode() != 200) throw new IOException("Release checksum unavailable");
      try (InputStream input = sums.getInputStream()) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
          if (bytes.size() + count > 8192) throw new IOException("Release checksum file too large");
          bytes.write(buffer, 0, count);
        }
        Matcher match = APK_DIGEST.matcher(new String(bytes.toByteArray(), StandardCharsets.US_ASCII));
        if (!match.find()) throw new IOException("APK checksum missing");
        String hash = match.group(1).toLowerCase(Locale.ROOT);
        if (match.find()) throw new IOException("Duplicate APK checksum");
        return new JSONObject().put("phase", "complete").put("version", version).put("sha256", hash);
      }
    } finally {
      sums.disconnect();
    }
  }

  private static HttpURLConnection connect(String url) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setConnectTimeout(5000);
    connection.setReadTimeout(5000);
    return connection;
  }
}
