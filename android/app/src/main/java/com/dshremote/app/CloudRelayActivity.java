package com.dshremote.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.view.Gravity;
import android.view.MenuItem;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.List;
import org.json.JSONObject;

public class CloudRelayActivity extends AppCompatActivity {
  static final String PORTAL_BASE = "https://relay-pilot.blankalwaysgoeson.site/sponsor/";
  static final String EXTRA_MANAGE = "manage";
  static final String EXTRA_AUTOMATIC_TICKET = "automaticTicket";
  static final String EXTRA_INBOX = "inbox";
  static final String RESULT_ACTIVATION = "relayActivation";
  private static final Uri PORTAL = Uri.parse(PORTAL_BASE + "?app=1");
  private static final Uri PORTAL_ORIGIN = PORTAL.buildUpon().path("").clearQuery().build();
  private static final List<String> IMAGE_TYPES = java.util.Arrays.asList("image/png", "image/jpeg", "image/webp");
  private WebView webView;
  private LinearLayout offline;
  private ValueCallback<Uri[]> fileResult;
  private WebMessagePort activationPort;
  private final ActivityResultLauncher<Intent> picker = registerForActivityResult(
      new ActivityResultContracts.StartActivityForResult(), result -> {
        Intent data = result.getData();
        Uri uri = result.getResultCode() == RESULT_OK && data != null ? data.getData() : null;
        finishPicker(allowedImage(uri) ? uri : null);
      });

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    WindowCompat.enableEdgeToEdge(getWindow());
    setContentView(R.layout.activity_cloud_relay);
    View root = findViewById(R.id.cloud_relay_root);
    View header = findViewById(R.id.cloud_relay_header);
    Toolbar toolbar = findViewById(R.id.cloud_relay_toolbar);
    toolbar.setTitle(R.string.cloud_relay_title);
    setSupportActionBar(toolbar);
    if (getSupportActionBar() != null) getSupportActionBar().setDisplayHomeAsUpEnabled(true);
    WindowCompat.getInsetsController(getWindow(), root).setAppearanceLightStatusBars(false);

    ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
      Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
      header.setPadding(0, safe.top, 0, 0);
      view.setPadding(safe.left, 0, safe.right, Math.max(safe.bottom, keyboard.bottom));
      return WindowInsetsCompat.CONSUMED;
    });
    ViewCompat.requestApplyInsets(root);
    FrameLayout layout = findViewById(R.id.cloud_relay_content);
    webView = new WebView(this);
    layout.addView(webView, new FrameLayout.LayoutParams(-1, -1));
    offline = new LinearLayout(this);
    offline.setGravity(Gravity.CENTER);
    offline.setOrientation(LinearLayout.VERTICAL);
    TextView error = new TextView(this);
    error.setText(R.string.cloud_relay_unavailable);
    Button retry = new Button(this);
    retry.setText(R.string.cloud_relay_retry);
    retry.setOnClickListener(view -> loadPortal());
    offline.addView(error);
    offline.addView(retry);
    layout.addView(offline, new FrameLayout.LayoutParams(-1, -1));

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri target = request.getUrl();
        if (request.isForMainFrame() && isPortal(target)) return false;
        if (request.isForMainFrame() && request.hasGesture() && "mailto".equals(target.getScheme())) {
          try { startActivity(new Intent(Intent.ACTION_SENDTO, target)); }
          catch (ActivityNotFoundException ignored) { Toast.makeText(CloudRelayActivity.this, R.string.cloud_relay_no_mail, Toast.LENGTH_SHORT).show(); }
        }
        return true;
      }

      @Override
      public void onPageStarted(WebView view, String url, Bitmap favicon) {
        closeActivationPort();
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        if (view == webView && view.getVisibility() == View.VISIBLE && url != null && isPortal(Uri.parse(url))) offerActivationPort(view);
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) showUnavailable();
      }

      @Override
      public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
        if (request.isForMainFrame()) showUnavailable();
      }
    });
    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (view.getUrl() == null || !isPortal(Uri.parse(view.getUrl())) || params.getMode() != FileChooserParams.MODE_OPEN) {
          callback.onReceiveValue(null);
          return true;
        }
        if (fileResult != null) {
          callback.onReceiveValue(null);
          return true;
        }
        fileResult = callback;
        Intent select = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("image/*").putExtra(Intent.EXTRA_MIME_TYPES, IMAGE_TYPES.toArray(new String[0]));
        try { picker.launch(select); }
        catch (ActivityNotFoundException ignored) { finishPicker(null); }
        return true;
      }
    });
    loadPortal();
  }

  private static boolean isPortal(Uri uri) {
    return uri != null && PORTAL.equals(uri.buildUpon().fragment(null).build());
  }

  private void offerActivationPort(WebView view) {
    if (activationPort != null || view.getUrl() == null || !isPortal(Uri.parse(view.getUrl()))) return;
    WebMessagePort[] channel = view.createWebMessageChannel();
    activationPort = channel[0];
    activationPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
      @Override public void onMessage(WebMessagePort port, WebMessage message) {
        if (port != activationPort || view != webView || view.getUrl() == null || !isPortal(Uri.parse(view.getUrl()))) return;
        String payload = validateActivation(message.getData());
        if (payload == null) return;
        closeActivationPort();
        setResult(RESULT_OK, new Intent().putExtra(RESULT_ACTIVATION, payload));
        finish();
      }
    });
    view.postWebMessage(new WebMessage("dsh-relay-activation-port", new WebMessagePort[] { channel[1] }), PORTAL_ORIGIN);
  }

  static String validateActivation(String raw) {
    if (raw == null || raw.length() > 1024) return null;
    try {
      JSONObject file = new JSONObject(raw);
      String code = file.getString("code");
      long expiresAt = file.getLong("expiresAt");
      if (file.length() != 4 || !"dsh-remote-relay-activation".equals(file.getString("type")) ||
          file.getInt("version") != 1 || !code.matches("dsra_[a-f0-9]{16}\\.[A-Za-z0-9_-]{43}") ||
          expiresAt <= System.currentTimeMillis()) return null;
      return new JSONObject().put("type", "dsh-remote-relay-activation").put("version", 1)
          .put("code", code).put("expiresAt", expiresAt).toString();
    } catch (Exception invalidActivation) {
      return null;
    }
  }

  private void closeActivationPort() {
    if (activationPort != null) {
      activationPort.close();
      activationPort = null;
    }
  }

  private boolean allowedImage(Uri uri) {
    if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null || uri.getAuthority().contains("@")
        || uri.getAuthority().startsWith(getPackageName() + ".")
        || checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return false;
    try { return IMAGE_TYPES.contains(getContentResolver().getType(uri)); }
    catch (RuntimeException ignored) { return false; }
  }

  private void finishPicker(Uri uri) {
    ValueCallback<Uri[]> callback = fileResult;
    fileResult = null;
    if (callback != null) callback.onReceiveValue(uri == null ? null : new Uri[]{uri});
  }

  private void loadPortal() {
    closeActivationPort();
    offline.setVisibility(View.GONE);
    webView.setVisibility(View.VISIBLE);
    String ticket = getIntent().getStringExtra(EXTRA_AUTOMATIC_TICKET);
    String fragment = getIntent().getBooleanExtra(EXTRA_INBOX, false) ? "inbox"
        : ticket != null && ticket.matches("[a-f0-9]{32}") ? "activate-" + ticket
        : getIntent().getBooleanExtra(EXTRA_MANAGE, false) ? "manage" : null;
    webView.loadUrl(PORTAL.buildUpon().fragment(fragment).build().toString());
  }

  private void showUnavailable() {
    closeActivationPort();
    webView.setVisibility(View.GONE);
    offline.setVisibility(View.VISIBLE);
  }

  @Override
  public boolean onOptionsItemSelected(MenuItem item) {
    if (item.getItemId() != android.R.id.home) return super.onOptionsItemSelected(item);
    finish();
    return true;
  }

  @Override
  protected void onDestroy() {
    finishPicker(null);
    closeActivationPort();
    if (webView != null) {
      ((FrameLayout) webView.getParent()).removeView(webView);
      webView.destroy();
    }
    super.onDestroy();
  }
}
