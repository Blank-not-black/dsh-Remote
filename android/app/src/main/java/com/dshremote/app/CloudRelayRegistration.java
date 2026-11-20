package com.dshremote.app;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Arrays;
import java.util.List;

final class CloudRelayRegistration {
  private static final String PROBE_URL = CloudRelayActivity.PORTAL_BASE + "?app=probe";
  private static final List<String> RESULTS = Arrays.asList("none", "unavailable", "draft", "submitted", "approved", "renewable", "expired", "rejected", "revoked");
  private static final String READ_STATUS = """
      (() => {
        window.dshRegistrationProbe = 'loading';
        (async () => {
          try {
            const raw = localStorage.getItem('dsh-relay-sponsor-application-v1');
            if (raw === null) return 'none';
            const record = JSON.parse(raw);
            if (typeof record?.id !== 'string' || !/^R[A-F0-9]{16}$/.test(record.id)
                || typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.token)) return 'unavailable';
            const result = await fetch('/sponsor/api/applications/' + record.id, {
              headers: {authorization: 'Bearer ' + record.token}, credentials: 'omit', cache: 'no-store', redirect: 'error'
            });
            if (!result.ok) return 'unavailable';
            const status = await result.json();
            if (status.id !== record.id) return 'unavailable';
            if (status.renewable === true) return 'renewable';
            return ['draft', 'submitted', 'approved', 'expired', 'rejected', 'revoked'].includes(status.status) ? status.status : 'unavailable';
          } catch { return 'unavailable'; }
        })().then(state => { window.dshRegistrationProbe = state; });
      })()
      """;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Context context;
  private WebView probe;
  private volatile String status = "idle";

  CloudRelayRegistration(Context context) { this.context = context; }

  String status() { return status; }

  void invalidate() {
    dispose();
    status = "idle";
  }

  void refresh() {
    if (probe != null) return;
    status = "loading";
    WebView view = new WebView(context);
    probe = view;
    view.getSettings().setDomStorageEnabled(true);
    view.getSettings().setAllowFileAccess(false);
    view.getSettings().setAllowContentAccess(false);
    view.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    view.setWebViewClient(new WebViewClient() {
      private boolean started;

      @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
        return !request.isForMainFrame() || !PROBE_URL.equals(request.getUrl().toString());
      }

      @Override public void onPageFinished(WebView web, String url) {
        if (probe != web || started) return;
        if (!PROBE_URL.equals(url) || !PROBE_URL.equals(web.getUrl())) { finish(web, "unavailable"); return; }
        started = true;
        web.getSettings().setJavaScriptEnabled(true);
        web.evaluateJavascript(READ_STATUS, ignored -> poll(web));
      }

      @Override public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) finish(web, "unavailable");
      }

      @Override public void onReceivedHttpError(WebView web, WebResourceRequest request, WebResourceResponse error) {
        if (request.isForMainFrame()) finish(web, "unavailable");
      }
    });
    handler.postDelayed(() -> finish(view, "unavailable"), 12000);
    view.loadUrl(PROBE_URL);
  }

  private void poll(WebView view) {
    if (probe != view) return;
    if (!PROBE_URL.equals(view.getUrl())) { finish(view, "unavailable"); return; }
    view.evaluateJavascript("window.dshRegistrationProbe", json -> {
      if (probe != view) return;
      if ("\"loading\"".equals(json)) handler.postDelayed(() -> poll(view), 300);
      else {
        String value = json != null && json.startsWith("\"") && json.endsWith("\"") ? json.substring(1, json.length() - 1) : "";
        finish(view, RESULTS.contains(value) ? value : "unavailable");
      }
    });
  }

  private void finish(WebView view, String result) {
    if (probe != view) return;
    status = result;
    dispose();
  }

  void dispose() {
    handler.removeCallbacksAndMessages(null);
    WebView view = probe;
    probe = null;
    if (view != null) { view.stopLoading(); view.destroy(); }
  }
}
