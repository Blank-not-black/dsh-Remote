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
        async function activation(record, order) {
          const ticket = window.dshRegistrationTicket;
          if (!/^[a-f0-9]{32}$/.test(ticket || '') || ticket !== record.automaticTicket || order?.status !== 'approved') return null;
          const key = 'dsh-relay-sponsor-auto-file-v1';
          let cached;
          try { cached = JSON.parse(localStorage.getItem(key)); } catch {}
          if (cached?.ticket === ticket) return cached.file?.expiresAt > Date.now() ? cached.file : null;
          try {
            const response = await fetch('/sponsor/api/applications/' + record.id + '/activation', {
              method: 'POST', headers: {authorization: 'Bearer ' + record.token, 'content-type': 'application/json'},
              body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error'
            });
            if (!response.ok) return null;
            const file = await response.json();
            localStorage.setItem(key, JSON.stringify({ticket, file}));
            return file;
          } catch { return null; }
        }
        const serviceExpiry = order => {
          if (!order || order.order?.kind === 'packs') return 0;
          const expiresAt = order.serviceExpiresAt ?? (order.status === 'approved' || order.renewable ? order.expiresAt : 0);
          return Number.isSafeInteger(expiresAt) && expiresAt > 0 && expiresAt <= 8640000000000000 ? expiresAt : 0;
        };
        (async () => {
          const raw = localStorage.getItem('dsh-relay-sponsor-application-v1');
          if (raw === null) return {status: 'none', unread: -1};
          const record = JSON.parse(raw);
          if (!valid(record)) return {status: 'unavailable', unread: -1};
          const parent = valid(record.parent) ? record.parent : null;
          const inbox = valid(record.inbox) ? record.inbox : parent || record;
          const reads = new Map();
          const readOnce = item => {
            const key = item.id + '.' + item.token;
            if (!reads.has(key)) reads.set(key, read(item));
            return reads.get(key);
          };
          const [order, messageThread, original] = await Promise.all([readOnce(record), readOnce(inbox), parent && readOnce(parent)]);
          const pending = ['draft', 'submitted'].includes(order?.status);
          const service = order && (serviceExpiry(order) || order.renewable ? order : original);
          const state = pending ? order.status : service?.renewable === true ? 'renewable'
            : serviceExpiry(service) > (service?.serverTime ?? Date.now()) ? 'approved' : order?.status;
          const status = ['draft', 'submitted', 'approved', 'renewable', 'expired', 'rejected', 'revoked'].includes(state) ? state : 'unavailable';
          const count = messageThread?.unreadMessages;
          const auto = await activation(record, order);
          const expiresAt = serviceExpiry(service);
          const addon = !pending && !!(service?.orderOptions?.addPacks || service?.orderOptions?.addonPending);
          return {status, unread: messageThread ? (Number.isSafeInteger(count) && count >= 0 ? Math.min(count, 50) : 0) : -1,
            ...(expiresAt ? {expiresAt} : {}), ...(addon ? {addon: true} : {}),
            ...(auto ? {activation: auto} : {})};
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
  private volatile long expiresAt;
  private volatile boolean addonAvailable;
  private record Activation(String ticket, String file) {}
  private volatile Activation automaticActivation;

  CloudRelayRegistration(Context context, Runnable onResult) {
    this.context = context;
    this.onResult = onResult;
  }

  String status() { return status; }
  int unreadMessages() { return unreadMessages; }
  long expiresAt() { return expiresAt; }
  boolean addonAvailable() { return addonAvailable; }
  String activation(String ticket) {
    Activation result = automaticActivation;
    return result != null && result.ticket().equals(ticket) ? result.file() : null;
  }

  void invalidate() {
    dispose();
    status = "idle";
    unreadMessages = -1;
    expiresAt = 0;
    addonAvailable = false;
    automaticActivation = null;
  }

  void refresh() { refresh(null); }

  void refresh(String ticket) {
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
        String script = ticket == null ? READ_STATUS : "window.dshRegistrationTicket='" + ticket + "';\n" + READ_STATUS;
        web.evaluateJavascript(script, ignored -> poll(web, ticket));
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

  private void poll(WebView view, String ticket) {
    if (probe != view) return;
    if (!PROBE_URL.equals(view.getUrl())) { finish(view, "unavailable"); return; }
    view.evaluateJavascript("window.dshRegistrationProbe", json -> {
      if (probe != view) return;
      if ("\"loading\"".equals(json)) handler.postDelayed(() -> poll(view, ticket), 300);
      else {
        if (json == null) { finish(view, "unavailable"); return; }
        try {
          JSONObject result = new JSONObject(json);
          String state = result.optString("status");
          int unread = result.optInt("unread", -1);
          if (ticket != null && result.optJSONObject("activation") != null) {
            String file = CloudRelayActivity.validateActivation(result.optJSONObject("activation").toString());
            if (file != null) automaticActivation = new Activation(ticket, file);
          }
          long expiry = result.optLong("expiresAt", 0);
          finish(view, RESULTS.contains(state) ? state : "unavailable", unread >= 0 && unread <= 50 ? unread : -1,
              expiry > 0 && expiry <= 8640000000000000L ? expiry : 0, result.optBoolean("addon"));
        } catch (JSONException error) { finish(view, "unavailable"); }
      }
    });
  }

  private void finish(WebView view, String result) {
    finish(view, result, -1, 0, false);
  }

  private void finish(WebView view, String result, int unread, long expiry, boolean addon) {
    if (probe != view) return;
    expiresAt = expiry;
    addonAvailable = addon;
    unreadMessages = unread;
    status = result;
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
