package com.dshremote.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.view.Gravity;
import android.view.MenuItem;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
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
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.List;

public class CloudRelayActivity extends AppCompatActivity {
  static final String PORTAL_BASE = "https://relay-pilot.blankalwaysgoeson.site/sponsor/";
  static final String EXTRA_MANAGE = "manage";
  private static final Uri PORTAL = Uri.parse(PORTAL_BASE + "?app=1");
  private static final List<String> IMAGE_TYPES = java.util.Arrays.asList("image/png", "image/jpeg", "image/webp");
  private WebView webView;
  private LinearLayout offline;
  private ValueCallback<Uri[]> fileResult;
  private final ActivityResultLauncher<Intent> picker = registerForActivityResult(
      new ActivityResultContracts.StartActivityForResult(), result -> {
        Intent data = result.getData();
        Uri uri = result.getResultCode() == RESULT_OK && data != null ? data.getData() : null;
        finishPicker(allowedImage(uri) ? uri : null);
      });

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setTitle(R.string.cloud_relay_title);
    if (getSupportActionBar() != null) getSupportActionBar().setDisplayHomeAsUpEnabled(true);

    FrameLayout layout = new FrameLayout(this);
    ViewCompat.setOnApplyWindowInsetsListener(layout, (view, insets) -> {
      androidx.core.graphics.Insets edges = insets.getInsets(WindowInsetsCompat.Type.navigationBars() | WindowInsetsCompat.Type.ime());
      view.setPadding(edges.left, 0, edges.right, edges.bottom);
      return insets;
    });
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
    setContentView(layout);

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
    return PORTAL.equals(uri.buildUpon().fragment(null).build());
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
    offline.setVisibility(View.GONE);
    webView.setVisibility(View.VISIBLE);
    webView.loadUrl(getIntent().getBooleanExtra(EXTRA_MANAGE, false) ? PORTAL.buildUpon().fragment("manage").build().toString() : PORTAL.toString());
  }

  private void showUnavailable() {
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
    if (webView != null) {
      ((FrameLayout) webView.getParent()).removeView(webView);
      webView.destroy();
    }
    super.onDestroy();
  }
}
