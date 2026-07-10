// turnstileBridge.js
//
// Cloudflare Turnstileの読み込み・描画だけをMAIN world（ページ本来の
// 実行コンテキスト）で行うための橋渡し役。
//
// content.js (isolated world) は拡張機能専用のCSPで動いており、
// そこから document.head に <script src="https://challenges.cloudflare.com/..."> を
// 追加しても、そのscript要素はisolated world側のCSP
// (script-src 'self' ... chrome-extension://<id>/) に縛られてブロックされる
// (Chrome公式ドキュメント: "When a content script is injected into the main world,
//  the CSP of the page applies." の裏返しで、isolated worldではページのCSPが
//  適用されないため)。
//
// そのため、Turnstileのスクリプト読み込みとウィジェット描画だけを
// MAIN world（ページ本来の実行コンテキスト。atten.win自身のCSPに従う）で
// 動かすこのファイルに分離する。isolated world側(content.js)とは
// window.postMessage ではなく、ページのwindowオブジェクトを介した
// CustomEvent(document上のイベント)で連携する
// (postMessageはページ自身のJSからも傍受・偽装されうるため、
//  対象を document 上の非公開イベント名に絞り、詳細はdetailに限定する)。
//
// このファイルはページのグローバルスコープ(window.turnstile等)に
// アクセスできるが、chrome.*系APIには一切アクセスできない
// (MAIN worldなのでextension APIは使えない。これは意図された制約)。

(function () {
  "use strict";

  const REQUEST_EVENT = "nyatten:mw:turnstile-render-request";
  const RESULT_EVENT = "nyatten:mw:turnstile-result";
  const REMOVE_EVENT = "nyatten:mw:turnstile-remove-request";

  let scriptPromise = null;

  function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve();
    if (scriptPromise) return scriptPromise;

    scriptPromise = new Promise((resolve, reject) => {
      // atten.win自身が同じ id ("cf-turnstile-script" 相当)でTurnstileスクリプトを
      // 読み込んでいる場合は使い回す
      const existing = document.getElementById("cf-turnstile-script");
      if (existing) {
        if (window.turnstile) {
          resolve();
          return;
        }
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("turnstile script failed")));
        return;
      }
      const script = document.createElement("script");
      script.id = "nyatten-cf-turnstile-script";
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => resolve());
      script.addEventListener("error", () => reject(new Error("turnstile script failed")));
      document.head.appendChild(script);
    });

    return scriptPromise;
  }

  // requestId ごとにウィジェットIDを保持し、削除要求に応えられるようにする
  const widgetsByRequestId = new Map();

  document.addEventListener(REQUEST_EVENT, async (event) => {
    const { requestId, sitekey, hostSelector, action } = event.detail || {};
    if (!requestId || !sitekey || !hostSelector) return;

    const dispatchResult = (payload) => {
      document.dispatchEvent(
        new CustomEvent(RESULT_EVENT, { detail: { requestId, ...payload } }),
      );
    };

    try {
      await loadTurnstileScript();
    } catch (e) {
      dispatchResult({ type: "error" });
      return;
    }

    const host = document.querySelector(hostSelector);
    if (!host) {
      // hostが消えている(ダイアログが閉じられた等)場合は何もしない
      return;
    }

    try {
      const renderOptions = {
        sitekey,
        callback: (token) => dispatchResult({ type: "token", token }),
        "error-callback": () => dispatchResult({ type: "error" }),
        "expired-callback": () => dispatchResult({ type: "expired" }),
      };
      // atten.win本家UIも同様にactionを付与しており(login/register/sudo/report)、
      // サーバー側のsiteverify検証がactionの一致を見ている可能性があるため、
      // 呼び出し元から指定された場合はそのまま渡す。
      if (action) renderOptions.action = action;

      const widgetId = window.turnstile.render(host, renderOptions);
      widgetsByRequestId.set(requestId, widgetId);
    } catch (e) {
      dispatchResult({ type: "error" });
    }
  });

  document.addEventListener(REMOVE_EVENT, (event) => {
    const { requestId } = event.detail || {};
    const widgetId = widgetsByRequestId.get(requestId);
    if (widgetId !== undefined && window.turnstile) {
      try {
        window.turnstile.remove(widgetId);
      } catch (e) {
        // 既に消えている場合などは無視
      }
    }
    widgetsByRequestId.delete(requestId);
  });
})();
