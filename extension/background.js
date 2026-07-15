// background.js
//
// content_script (Nyatten.js) は atten.win 上で動作しており、
// scratch.mit.edu への fetch はここ(service worker)で行う。
// service worker はページのオリジンを持たないため、
// content_script側でのfetchと違いCORSプリフライトの制約を受けずに
// Cookieセッション付きでリクエストできる。
//
// 意図的にやらないこと:
// - Scratchのユーザー名/パスワードは一切扱わない
// - scratchsessionsid (セッション本体の値) を読み取ったり保存したりしない
// - Cookie値やレスポンス本体をログ出力・永続化しない
// - CSRFトークン取得以外の目的で chrome.cookies を使わない

async function getScratchCsrfToken() {
    return new Promise((resolve) => {
        chrome.cookies.get(
            { url: 'https://scratch.mit.edu', name: 'scratchcsrftoken' },
            (cookie) => {
                if (chrome.runtime.lastError || !cookie) {
                    resolve(null);
                    return;
                }
                resolve(cookie.value);
            },
        );
    });
}

let cachedSession = null;
let cachedSessionTime = 0;
let activeSessionPromise = null;

/** 既存のログイン済みセッションから、ログイン中のユーザー名だけを読み取る */
async function getScratchSession() {
    const now = Date.now();
    if (cachedSession && now - cachedSessionTime < 10000) {
        return cachedSession;
    }

    if (activeSessionPromise) {
        return activeSessionPromise;
    }

    activeSessionPromise = (async () => {
        try {
            const res = await fetch('https://scratch.mit.edu/session/', {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!res.ok) return { ok: false, username: null };
            const data = await res.json();
            const username = data?.user?.username ?? null;
            const result = { ok: !!username, username };

            cachedSession = result;
            cachedSessionTime = Date.now();
            return result;
        } catch (e) {
            return { ok: false, username: null };
        } finally {
            activeSessionPromise = null;
        }
    })();

    return activeSessionPromise;
}

/**
 * scratch.mit.edu の site-api/comments/user/<username>/<action>/ に
 * CSRFトークン付きでPOSTする共通ヘルパー。
 * postProfileComment と deleteProfileComment はエンドポイント名とbodyが
 * 違うだけなので、CSRF取得・fetchオプション・エラーハンドリングをここに集約する。
 */
async function postScratchCommentAction(username, action, body) {
    const csrfToken = await getScratchCsrfToken();
    if (!csrfToken) return { ok: false, reason: 'no_csrf_token' };

    const profileUrl = `https://scratch.mit.edu/users/${encodeURIComponent(username)}/`;

    try {
        const res = await fetch(
            `https://scratch.mit.edu/site-api/comments/user/${encodeURIComponent(username)}/${action}/`,
            {
                method: 'POST',
                credentials: 'include',
                // 実測の結果、service workerからのfetchでは referrer オプションを指定しても
                // 実際のリクエストにRefererヘッダーが載らないことを確認した
                // (sec-fetch-site: none になり、Scratch側のCSRF検証で弾かれる)。
                // そのため Referer の付与は declarative_net_request のルール(rules.json)側で
                // 強制的に付ける方式に切り替えている。ここでの指定は保険として残す。
                referrer: profileUrl,
                referrerPolicy: 'strict-origin-when-cross-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify(body),
            },
        );
        return { ok: res.ok, res };
    } catch (e) {
        return { ok: false, reason: 'network_error' };
    }
}

/**
 * Scratchプロフィールのコメント欄に認証コードを投稿する。
 * レスポンスはJSONではなくHTML断片("data-comment-id"属性を持つdiv)なので、
 * 削除時に使うcomment_idを正規表現で抜き出しておく。
 */
async function postProfileComment(username, code) {
    const result = await postScratchCommentAction(username, 'add', {
        content: code,
        parent_id: '',
        commentee_id: '',
    });
    if (!result.ok) return { ok: false, reason: result.reason };

    const html = await result.res.text();
    const match = html.match(/data-comment-id="(\d+)"/);
    const commentId = match ? match[1] : null;

    return { ok: true, commentId };
}

/** 投稿済みのプロフィールコメントを削除する（自分自身のプロフィールへの投稿のみ想定） */
async function deleteProfileComment(username, commentId) {
    const result = await postScratchCommentAction(username, 'del', {
        id: commentId,
    });
    return { ok: result.ok, reason: result.reason };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
        case 'nyatten:get-scratch-session': {
            getScratchSession().then(sendResponse);
            return true;
        }
        case 'nyatten:post-scratch-profile-comment': {
            const { username, code } = message;
            if (!username || !code) {
                sendResponse({ ok: false, reason: 'invalid_args' });
                return false;
            }
            postProfileComment(username, code).then(sendResponse);
            return true;
        }
        case 'nyatten:delete-scratch-profile-comment': {
            const { username, commentId } = message;
            if (!username || !commentId) {
                sendResponse({ ok: false, reason: 'invalid_args' });
                return false;
            }
            deleteProfileComment(username, commentId).then(sendResponse);
            return true;
        }
        default:
            return false;
    }
});
