// emojiMartBridge.js
// world: "MAIN" で登録されるcontent script。
//
// content.js (isolated world) から <script src="chrome-extension://...">
// で直接EmojiMartを読み込んでも、そのスクリプトはisolated world側の
// window ではなく、ページのMAIN world側の window に window.EmojiMart を
// セットしてしまう。isolated worldとMAIN worldは document は共有するが
// window は別インスタンスのため、content.js側からは永久に
// window.EmojiMart が見えない(実際にdevtoolsコンソール上では見えるのに
// content.js からは undefined になる不具合の原因)。
//
// そのため、Turnstile連携(turnstileBridge.js)と同じパターンで、
// EmojiMartの読み込み・Pickerの生成・描画はすべてこのMAIN world側の
// スクリプトで行い、content.js とは document 上の CustomEvent 経由で
// やり取りする。

(() => {
    const SCRIPT_URL_ATTR = 'data-nyatten-emoji-mart-script-url';
    const DATA_URL_ATTR = 'data-nyatten-emoji-mart-data-url';

    let emojiMartPromise = null;

    function loadEmojiMart(scriptUrl) {
        if (window.EmojiMart) return Promise.resolve(window.EmojiMart);
        if (emojiMartPromise) return emojiMartPromise;

        emojiMartPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = scriptUrl;
            script.onload = () => {
                if (window.EmojiMart) {
                    resolve(window.EmojiMart);
                } else {
                    reject(
                        new Error(
                            'EmojiMartの読み込みに失敗しました(window.EmojiMartが見つかりません。vendor/emoji-mart/browser.jsが正しく配置されているか確認してください)',
                        ),
                    );
                }
            };
            script.onerror = () =>
                reject(
                    new Error(
                        'EmojiMartスクリプトの読み込みに失敗しました(' +
                            scriptUrl +
                            ')',
                    ),
                );
            document.head.appendChild(script);
        });

        emojiMartPromise = emojiMartPromise.catch((e) => {
            emojiMartPromise = null;
            throw e;
        });

        return emojiMartPromise;
    }

    async function fetchEmojiData(dataUrl) {
        const res = await fetch(dataUrl);
        if (!res.ok) {
            throw new Error('data.jsonの取得に失敗しました: ' + res.status);
        }
        return res.json();
    }

    /** requestId ごとに生成中/表示中のPickerを管理する */
    const activePickers = new Map();

    document.addEventListener('nyatten:mw:emoji-preload-request', (e) => {
        const { scriptUrl } = e.detail || {};
        if (!scriptUrl) return;
        loadEmojiMart(scriptUrl).catch(() => {
            // 先読みの失敗はここでは無視する(実際にPickerを開こうとした
            // タイミングで改めてエラーがcontent.js側に通知される)。
        });
    });

    document.addEventListener(
        'nyatten:mw:emoji-picker-open-request',
        async (e) => {
            const { requestId, scriptUrl, dataUrl, hostSelector, options } =
                e.detail || {};
            if (!requestId || !hostSelector) return;

            const notifyError = (message) => {
                document.dispatchEvent(
                    new CustomEvent('nyatten:mw:emoji-picker-error', {
                        detail: { requestId, message },
                    }),
                );
            };

            let EmojiMart;
            try {
                EmojiMart = await loadEmojiMart(scriptUrl);
            } catch (err) {
                notifyError(String(err && err.message ? err.message : err));
                return;
            }

            let data;
            try {
                data = await fetchEmojiData(dataUrl);
            } catch (err) {
                notifyError(String(err && err.message ? err.message : err));
                return;
            }

            const host = document.querySelector(hostSelector);
            if (!host) {
                notifyError('Pickerの表示先ホスト要素が見つかりませんでした');
                return;
            }

            try {
                const pickerOptions = {
                    data,
                    theme: options?.theme || 'auto',
                    locale: options?.locale || 'ja',
                    previewEmoji: options?.previewEmoji ?? 'none',
                    skinTonePosition: options?.skinTonePosition || 'search',
                    maxFrequentRows: options?.maxFrequentRows ?? 2,
                    onEmojiSelect: (emoji) => {
                        document.dispatchEvent(
                            new CustomEvent('nyatten:mw:emoji-picker-select', {
                                detail: {
                                    requestId,
                                    emoji: {
                                        id: emoji.id,
                                        native: emoji.native,
                                        unified: emoji.unified,
                                    },
                                },
                            }),
                        );
                    },
                };
                if (options?.custom) pickerOptions.custom = options.custom;
                if (options?.categoryIcons)
                    pickerOptions.categoryIcons = options.categoryIcons;

                const picker = new EmojiMart.Picker(pickerOptions);
                host.innerHTML = '';
                host.appendChild(picker);
                activePickers.set(requestId, { host, picker });

                document.dispatchEvent(
                    new CustomEvent('nyatten:mw:emoji-picker-ready', {
                        detail: { requestId },
                    }),
                );
            } catch (err) {
                notifyError(String(err && err.message ? err.message : err));
            }
        },
    );

    document.addEventListener('nyatten:mw:emoji-picker-close-request', (e) => {
        const { requestId } = e.detail || {};
        if (!requestId) return;
        const entry = activePickers.get(requestId);
        if (entry) {
            entry.host.innerHTML = '';
            activePickers.delete(requestId);
        }
    });
})();
