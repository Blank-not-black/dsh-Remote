package com.dshremote.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Arrays;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

final class CloudRelayRegistration {
  private static final String PROBE_URL = CloudRelayActivity.PORTAL_BASE + "?app=probe";
  private static final List<String> RESULTS = Arrays.asList("none", "unavailable", "draft", "submitted", "approved", "renewable", "expired", "rejected", "revoked");
  private static final String READ_STATUS = """
      (() => {
        window.dshRegistrationProbe = 'loading';
        const valid = value => typeof value?.id === 'string' && /^R[A-F0-9]{16}$/.test(value.id)
          && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token);
        async function read(record) {
          try {
            const response = await fetch('/sponsor/api/applications/' + record.id, {
              headers: {authorization: 'Bearer ' + record.token}, credentials: 'omit', cache: 'no-store', redirect: 'error'
            });
            if (!response.ok) return null;
            const result = await response.json();
            return result?.id === record.id ? result : null;
          } catch { return null; }
        }
        (async () => {
          const raw = localStorage.getItem('dsh-relay-sponsor-application-v1');
          if (raw === null) return {status: 'none', unread: -1};
          const record = JSON.parse(raw);
          if (!valid(record)) return {status: 'unavailable', unread: -1};
          const inbox = valid(record.inbox) ? record.inbox : valid(record.parent) ? record.parent : record;
          const current = read(record);
          const [order, messageThread] = await Promise.all([current, inbox.id === record.id ? current : read(inbox)]);
          const status = order?.renewable === true ? 'renewable'
            : ['draft', 'submitted', 'approved', 'expired', 'rejected', 'revoked'].includes(order?.status) ? order.status : 'unavailable';
          const count = messageThread?.unreadMessages;
          return {status, unread: messageThread ? (Number.isSafeInteger(count) && count >= 0 ? Math.min(count, 50) : 0) : -1};
        })().then(value => { window.dshRegistrationProbe = value; }, () => {
          window.dshRegistrationProbe = {status: 'unavailable', unread: -1};
        });
      })()
      """;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Context context;
  private final Runnable onResult;
  private WebView probe;
  private volatile String status = "idle";
  private volatile int unreadMessages = -1;

  CloudRelayRegistration(Context context, Runnable onResult) {
    this.context = context;
    this.onResult = onResult;
  }

  String status() { return status; }
  int unreadMessages() { return unreadMessages; }

  void invalidate() {
    dispose();
    status = "idle";
    unreadMessages = -1;
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
        if (json == null) { finish(view, "unavailable"); return; }
        try {
          JSONObject result = new JSONObject(json);
          String state = result.optString("status");
          int unread = result.optInt("unread", -1);
          finish(view, RESULTS.contains(state) ? state : "unavailable", unread >= 0 && unread <= 50 ? unread : -1);
        } catch (JSONException error) { finish(view, "unavailable"); }
      }
    });
  }

  private void finish(WebView view, String result) {
    finish(view, result, -1);
  }

  private void finish(WebView view, String result, int unread) {
    if (probe != view) return;
    status = result;
    unreadMessages = unread;
    dispose();
    onResult.run();
  }

  void dispose() {
    handler.removeCallbacksAndMessages(null);
    WebView view = probe;
    probe = null;
    if (view != null) { view.stopLoading(); view.destroy(); }
  }
}
