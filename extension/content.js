(function () {
	'use strict';

	/* ===========================================================================
	 * 0. ENV ADAPTER
	 * ========================================================================= */
	const ENV = (function () {
		const extensionStorage = globalThis.chrome?.storage?.local;

		return {
			async getValue(key, defaultValue) {
				if (extensionStorage?.get) {
					try {
						const result = await extensionStorage.get(key);
						return result?.[key] ?? defaultValue;
					} catch (e) {
						return defaultValue;
					}
				}

				try {
					const raw = window.localStorage.getItem(key);
					return raw === null ? defaultValue : JSON.parse(raw);
				} catch (e) {
					return defaultValue;
				}
			},

			async setValue(key, value) {
				if (extensionStorage?.set) {
					await extensionStorage.set({ [key]: value });
					return;
				}

				window.localStorage.setItem(key, JSON.stringify(value));
			},

			addStyle(css) {
				const style = document.createElement('style');
				style.textContent = css;
				document.documentElement.appendChild(style);
				return style;
			},
		};
	})();

	/* ===========================================================================
	 * 1. CORE
	 * ========================================================================= */
	const Nyatten = {
		name: 'Nyatten',
		env: ENV,
		config: {},
		_modules: [],
		icons: {},
		settingsGroups: [],

		/** 設定のデフォルト値。モジュールごとに config.<moduleId> にまとめる */
		defaultConfig: {
			core: {
				debug: false,
			},
		},

		log(...args) {
			if (this.config?.core?.debug) {
				console.log('[Nyatten]', ...args);
			}
		},

		warn(...args) {
			console.warn('[Nyatten]', ...args);
		},

		/**
		 * 機能モジュールを登録する。
		 * @param {Object} mod
		 * @param {string} mod.id - 一意なID (設定キーやCSSスコープに使う)
		 * @param {string} mod.name - 表示名
		 * @param {string} [mod.description] - モジュールの説明文（設定UIに表示）
		 * @param {Object} [mod.defaultConfig] - このモジュール用のデフォルト設定
		 * @param {string|Object} [mod.icon] - アイコンID（Nyatten.icons のキー）または {type, url?, svg?} 形式のアイコンデータ
		 * @param {boolean} [mod.locked] - true の場合、機能管理から無効化できない
		 * @param {(ctx: Object) => void} mod.init - 有効時に一度だけ呼ばれる初期化関数
		 * @param {(ctx: Object) => void} [mod.onRouteChange] - SPAのルート変化時に呼ばれる
		 */
		registerModule(mod) {
			if (!mod || !mod.id || typeof mod.init !== 'function') {
				this.warn('不正なモジュール登録をスキップしました', mod);
				return;
			}
			if (mod.icon) {
				if (
					typeof mod.icon === 'object' &&
					(mod.icon.type || mod.icon.svg || mod.icon.url)
				) {
					this.icons[mod.id] = mod.icon;
				} else if (
					typeof mod.icon === 'string' &&
					mod.icon.startsWith('<')
				) {
					this.icons[mod.id] = { type: 'svg', svg: mod.icon };
				}
				// 文字列のIDの場合はそのまま icons に参照として使う
			}
			this._modules.push(mod);
		},

		/** モジュールに渡す共通コンテキスト */
		getConfigFor(moduleId) {
			return this.config[moduleId] ?? {};
		},

		async setConfigFor(moduleId, patch) {
			this.config[moduleId] = {
				...(this.config[moduleId] ?? {}),
				...patch,
			};
			await this.env.setValue('nyatten:config', this.config);
			_configChanged = true;
		},

		_makeContext(mod) {
			return {
				nyatten: this,
				env: this.env,
				moduleId: mod.id,
				getConfig: () => this.getConfigFor(mod.id),
				setConfig: async (patch) => this.setConfigFor(mod.id, patch),
				log: (...args) => this.log(`[${mod.id}]`, ...args),
			};
		},

		async _loadConfig() {
			const merged = { ...this.defaultConfig };
			for (const mod of this._modules) {
				if (mod.defaultConfig)
					merged[mod.id] = { ...mod.defaultConfig };
			}
			const saved = await this.env.getValue('nyatten:config', {});
			// 保存値でデフォルトを上書き(浅いマージ)
			for (const key of Object.keys(saved)) {
				merged[key] = { ...merged[key], ...saved[key] };
			}
			this.config = merged;
		},

		/**
		 * SPAのURL変化を検知して 'routeChanged' を発火する。
		 * atten.win は詳細なフレームワークが未確認のため、
		 * pushState/replaceState フックと popstate + MutationObserver の
		 * 併用で頑健に検知する。
		 */
		_watchRouteChange() {
			let lastUrl = location.href;

			const notify = (force = false) => {
				if (location.href === lastUrl && !force) return;
				lastUrl = location.href;
				this.log('route changed ->', lastUrl);
				this._dispatchRouteChange();
			};

			// history API フック
			for (const fnName of ['pushState', 'replaceState']) {
				const original = history[fnName];
				history[fnName] = function (...args) {
					const ret = original.apply(this, args);
					window.dispatchEvent(new Event('nyatten:locationchange'));
					return ret;
				};
			}
			window.addEventListener('popstate', () =>
				window.dispatchEvent(new Event('nyatten:locationchange')),
			);
			window.addEventListener('hashchange', () =>
				window.dispatchEvent(new Event('nyatten:locationchange')),
			);
			window.addEventListener('nyatten:locationchange', notify);

			// SPA内部のDOM更新によるルート遷移も拾うフォールバック
			const fallbackObserver = new MutationObserver(
				this.util.debounce(() => {
					notify();
				}, 100),
			);
			fallbackObserver.observe(document.documentElement, {
				childList: true,
				subtree: true,
			});
		},

		_dispatchRouteChange() {
			const ctxCache = new Map();
			for (const mod of this._modules) {
				if (typeof mod.onRouteChange !== 'function') continue;
				if (!ctxCache.has(mod.id))
					ctxCache.set(mod.id, this._makeContext(mod));
				try {
					mod.onRouteChange(ctxCache.get(mod.id));
				} catch (e) {
					this.warn(
						`モジュール "${mod.id}" の onRouteChange でエラー`,
						e,
					);
				}
			}
		},

		async init() {
			await this._loadConfig();
			this.log(
				'起動',
				this._modules.map((m) => m.id),
			);

			this._watchRouteChange();

			for (const mod of this._modules) {
				const modConfig = this.config[mod.id] ?? {};
				if (!mod.locked && modConfig.enabled === false) {
					this.log(`モジュール "${mod.id}" は無効化されています`);
					continue;
				}
				const ctx = this._makeContext(mod);
				try {
					mod.init(ctx);
				} catch (e) {
					this.warn(`モジュール "${mod.id}" の init でエラー`, e);
				}
			}

			// 初回画面を通知（SPA初期状態でもonRouteChangeが動作するように）
			setTimeout(() => this._dispatchRouteChange(), 100);
		},
	};

	/* ===========================================================================
	 * 2. 共通ユーティリティ
	 *    モジュールから ctx.nyatten.util.xxx で使える小道具集。
	 * ========================================================================= */
	Nyatten.util = {
		/**
		 * 要素が出現するまで待つ。SPAでのDOM描画待ちに使う。
		 * @param {string} selector
		 * @param {{ timeout?: number, root?: ParentNode }} [opts]
		 * @returns {Promise<Element>}
		 */
		waitForElement(selector, opts = {}) {
			const { timeout = 10000, root = document } = opts;
			const existing = root.querySelector(selector);
			if (existing) return Promise.resolve(existing);

			return new Promise((resolve, reject) => {
				const observer = new MutationObserver(() => {
					const el = root.querySelector(selector);
					if (el) {
						observer.disconnect();
						resolve(el);
					}
				});
				observer.observe(
					root === document ? document.documentElement : root,
					{
						childList: true,
						subtree: true,
					},
				);
				if (timeout > 0) {
					setTimeout(() => {
						observer.disconnect();
						reject(
							new Error(`waitForElement timeout: ${selector}`),
						);
					}, timeout);
				}
			});
		},

		/** 単純なCSSスコープ付きスタイル注入のヘルパー */
		addStyle(css) {
			const style = document.createElement('style');
			style.textContent = css;
			document.documentElement.appendChild(style);
			return style;
		},

		/** 簡易デバウンス */
		debounce(fn, wait = 200) {
			let t = null;
			return (...args) => {
				clearTimeout(t);
				t = setTimeout(() => fn(...args), wait);
			};
		},

		/** Atten の localStorage キーを安全に読み取る */
		getAttenStorage(key, fallback = null) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? fallback : raw;
			} catch {
				return fallback;
			}
		},

		/** Atten の localStorage キーに安全に書き込む */
		setAttenStorage(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch (e) {
				Nyatten.warn('localStorage への保存に失敗しました', e);
			}
		},

	};

	// グローバルに公開(モジュールファイルを別リソースとして分けた場合に参照できるように)
	window.Nyatten = Nyatten;

	let lastNyattenRenderedRoute = null;
	let nyattenCardObserver = null;
	let _configChanged = false;

	function pushRouteState(url) {
		history.pushState(null, '', url);
		// history.pushState は _watchRouteChange ですでに nyatten:locationchange を発火するため
		// ここでは二重発火しないよう dispatchRouteChangeEvent を呼ばない。
	}

	function getModuleById(moduleId) {
		return Nyatten._modules.find((m) => m.id === moduleId);
	}

	function renderPanelHeader(title) {
		return (
			'<div class="flex items-center gap-2">' +
			'<a data-nyatten-back-link class="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors" style="width:36px;height:36px" data-slot="icon-button">' +
			'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<path d="M19 12H5m7-7-7 7 7 7"/>' +
			'</svg>' +
			'</a>' +
			'<h1 class="text-lg font-bold text-foreground">' +
			escHtml(title) +
			'</h1>' +
			'</div>'
		);
	}

	function renderSearchBox(query) {
		return (
			'<div class="nyatten-search-wrap">' +
			'<svg class="nyatten-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' +
			'</svg>' +
			'<input type="text" data-nyatten-search-box placeholder="モジュールを検索..."' +
			' class="nyatten-search-input" value="' +
			escAttr(query) +
			'" />' +
			'</div>'
		);
	}

	/**
	 * panel内の検索ボックスに入力イベントを配線する。
	 * requestAnimationFrameで間引きつつ data-nyatten-search 属性を更新し、
	 * onSearch(再描画用コールバック)を呼ぶ。renderNyattenIndex/renderModuleTab の
	 * 両方で同一の配線が必要なため共通化する。
	 * @param {HTMLElement} panel
	 * @param {() => void} onSearch
	 */
	function wireSearchBox(panel, onSearch) {
		const searchBox = panel.querySelector('[data-nyatten-search-box]');
		if (!searchBox) return;
		let ticking = false;
		searchBox.addEventListener('input', () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				panel.setAttribute('data-nyatten-search', searchBox.value);
				onSearch();
				ticking = false;
			});
		});
	}

	function scoreModule(query, mod) {
		if (!query) return 0;
		const q = query.toLowerCase();
		const id = (mod.id || '').toLowerCase();
		const name = (mod.name || '').toLowerCase();
		const desc = (mod.description || '').toLowerCase();
		let score = 0;
		if (id === q) score += 4;
		else if (id.includes(q)) score += 2;
		else if (id.startsWith(q.slice(0, 2))) score += 0.5;
		if (name === q) score += 3;
		else if (name.includes(q)) score += 1.5;
		else if (name.startsWith(q.slice(0, 2))) score += 0.5;
		if (desc.includes(q)) score += 1;
		else if (desc.startsWith(q.slice(0, 2))) score += 0.3;
		return score;
	}

	function filterAndSortModules(modules, query) {
		if (!query) return modules;
		const withScore = modules.map((m) => ({
			mod: m,
			score: scoreModule(query, m),
		}));
		withScore.sort((a, b) => b.score - a.score);
		return withScore.filter(({ score }) => score > 0).map(({ mod }) => mod);
	}

	/* ===========================================================================
	 * 3. モジュール登録はここに追加していく
	 * ========================================================================= */

	/* ---------------------------------------------------------------------------
	 * ここから下に新しいモジュールを追記していく:
	 *
	 * Nyatten.registerModule({
	 *   id: 'my-feature',
	 *   defaultConfig: { enabled: true },
	 *   init(ctx) {
	 *     // 初回描画時の処理
	 *   },
	 *   onRouteChange(ctx) {
	 *     // ページ遷移のたびの処理(必要な機能のみ実装)
	 *   },
	 * });
	 * ------------------------------------------------------------------------- */

	/* ---------------------------------------------------------------------------
	 * settings-panel: Atten の設定画面に Nyatten タブを追加するモジュール
	 * ------------------------------------------------------------------------- */

	Nyatten.registerModule({
		id: 'settings-panel',
		name: 'Nyatten設定',
		description: 'Attenの設定画面にNyattenの設定を追加',
		defaultConfig: { enabled: true },
		locked: true,
		init(ctx) {
			ctx.log('settings-panel モジュール初期化');
			Nyatten.util.addStyle(
				'.nyatten-search-wrap { position: relative; }' +
					'.nyatten-search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-muted-foreground, #888); pointer-events: none; }' +
					'.nyatten-search-input { width: 100%; border-radius: 16px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); padding: 8px 16px 8px 38px; font-size: 14px; color: var(--foreground, #000); outline: none; box-sizing: border-box; }' +
					'.nyatten-search-input::placeholder { color: var(--text-muted-foreground, #888); }' +
					'.nyatten-search-input:focus { outline: 2px solid var(--primary, #3b82f6); outline-offset: -1px; }',
			);
		},
		onRouteChange(ctx) {
			const config = ctx.getConfig();
			if (!config.enabled) return;

			const path = location.pathname;
			const hash = location.hash;

			if (path !== '/settings') {
				cleanupNyattenPanel();
				if (_configChanged) {
					_configChanged = false;
					location.reload();
				}
				return;
			}

			if (hash === '#nyatten' || hash.startsWith('#nyatten:')) {
				cleanupNyattenPanel();
				renderNyattenSettings(ctx);
			} else if (!hash) {
				cleanupNyattenPanel();
				injectNyattenCard(ctx);
			} else {
				cleanupNyattenPanel();
			}
		},
	});

	Nyatten.registerModule({
		id: 'ngcat',
		name: 'NGCat',
		description: '設定したNGワードを含むポストを自動的に非表示にします',
		defaultConfig: { enabled: false, words: '' },
		init(ctx) {
			ctx.log('NGCat モジュール初期化');
			this._ctx = ctx;
			this._words = [];
			this._scanTimer = null;
			this._observer = null;

			this._refreshWords();
			this._scheduleScan();

			const root = document.body || document.documentElement;
			if (root) {
				this._observer = new MutationObserver(() => {
					this._scheduleScan();
				});
				this._observer.observe(root, {
					childList: true,
					subtree: true,
				});
			}
		},
		onRouteChange(ctx) {
			this._ctx = ctx;
			this._refreshWords();
			this._scheduleScan();
		},
		_refreshWords() {
			const config = this._ctx?.getConfig?.() ?? {};
			const raw = config.words || '';
			const newWords = raw
				.split(/\r?\n|,/)
				.map((word) => word.trim())
				.filter(Boolean);

			const prev = this._words || [];
			const changed =
				prev.length !== newWords.length ||
				prev.some((w, i) => w !== newWords[i]);

			this._words = newWords;
			if (changed) this._scheduleScan();
		},
		_scheduleScan() {
			clearTimeout(this._scanTimer);
			this._scanTimer = setTimeout(() => {
				this._scan(document.body || document.documentElement);
			}, 150);
		},
		_isSettingsElement(el) {
			return !!el.closest(
				'[data-nyatten-settings-panel], [data-nyatten-settings-card], [data-nyatten-module], [data-nyatten-group]',
			);
		},
		_getTargetSelector() {
			return "article, [role='article'], [data-post-card], [data-testid*='post'], [data-testid*='timeline'], [data-testid*='feed']";
		},
		_containsNgWord(text) {
			const normalized = String(text || '').toLowerCase();
			return this._words.some((word) =>
				normalized.includes(word.toLowerCase()),
			);
		},
		_hide(el) {
			if (!el || !(el instanceof Element)) return;
			(el.parentElement || el).style.display = 'none';
		},
		_scan(root) {
			if (!this._ctx?.getConfig?.()?.enabled) return;
			if (!root) return;

			const selector = this._getTargetSelector();

			if (!this._words.length) return;

			const targets = new Set();
			(root.querySelectorAll(selector) || []).forEach((el) => {
				if (!this._isSettingsElement(el)) targets.add(el);
			});

			for (const el of targets) {
				const text = el.textContent || '';
				if (this._containsNgWord(text)) {
					this._hide(el);
				}
			}
		},
	});

	Nyatten.registerModule({
		id: 'nyax-emoji',
		name: 'NyaXEmoji',
		description: 'AttenでもNyaXEmoji',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('NyaXEmoji モジュール初期化');
			this._emojiIds = new Set();
			this._emojiObserver = null;
			this._emojiListUrl = 'https://ntnekochat.pages.dev/emoji/list.json';
			this._emojiImageUrl = 'https://ntnekochat.pages.dev/emoji/';
			this._emojiTokenRx = /_([A-Za-z0-9_-]+)_/g;
			this._ignoredSelectors = [
				'SCRIPT',
				'STYLE',
				'TEXTAREA',
				'OPTION',
				'INPUT',
				'BUTTON',
			];

			this.loadEmojiList().then(() => {
				this.processEmojiReplacements(document.body);
			});

			const observer = new MutationObserver((mutations) => {
				if (!this._emojiIds.size) return;
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (!(node instanceof Element)) continue;
						this.processEmojiReplacements(node);
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			this._emojiObserver = observer;
		},
		async onRouteChange(ctx) {
			const config = ctx.getConfig();
			if (!config.enabled) return;
			await this.loadEmojiList();
			this.processEmojiReplacements(document.body);
		},
		async loadEmojiList() {
			if (this._emojiListPromise) return this._emojiListPromise;
			this._emojiListPromise = fetch(this._emojiListUrl, {
				cache: 'no-cache',
			})
				.then(async (res) => {
					if (!res.ok) {
						throw new Error(
							'NyaXEmoji list fetch failed: ' + res.status,
						);
					}
					return res.json();
				})
				.then((payload) => {
					const ids = new Set();
					if (Array.isArray(payload)) {
						for (const item of payload) {
							if (typeof item === 'string') ids.add(item);
							else if (item && typeof item.id === 'string')
								ids.add(item.id);
						}
					} else if (payload && typeof payload === 'object') {
						for (const key of Object.keys(payload)) {
							ids.add(key);
						}
					}
					this._emojiIds = ids;
					return ids;
				})
				.catch((error) => {
					Nyatten.warn(
						'NyaXEmoji list の読み込みに失敗しました',
						error,
					);
					return this._emojiIds;
				});
			return this._emojiListPromise;
		},
		buildEmojiImage(id) {
			const img = document.createElement('img');
			img.src = this._emojiImageUrl + encodeURIComponent(id) + '.svg';
			img.alt = `_${id}_`;
			img.className = 'inline h-5 w-5 align-text-bottom';
			img.setAttribute('data-nyax-emoji', id);
			img.setAttribute('draggable', 'false');
			return img;
		},
		shouldProcessNode(node) {
			const parent = node.parentElement;
			if (!parent) return false;
			const tagName = parent.tagName;
			if (this._ignoredSelectors.includes(tagName)) return false;
			if (parent.closest('[data-nyax-emoji]')) return false;
			return true;
		},
		processEmojiReplacements(root) {
			if (!this._emojiIds.size || !root) return;
			const walker = document.createTreeWalker(
				root,
				NodeFilter.SHOW_TEXT,
				{
					acceptNode: (node) => {
						if (!node.nodeValue || !node.nodeValue.includes('_'))
							return NodeFilter.FILTER_REJECT;
						if (!this.shouldProcessNode(node))
							return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_ACCEPT;
					},
				},
			);
			const textNodes = [];
			let current;
			while ((current = walker.nextNode())) {
				textNodes.push(current);
			}
			for (const textNode of textNodes) {
				const text = textNode.nodeValue;
				let match;
				let lastIndex = 0;
				const frag = document.createDocumentFragment();
				let replaced = false;
				this._emojiTokenRx.lastIndex = 0;
				while ((match = this._emojiTokenRx.exec(text))) {
					const token = match[0];
					const id = match[1];
					const start = match.index;
					if (lastIndex < start) {
						frag.appendChild(
							document.createTextNode(
								text.slice(lastIndex, start),
							),
						);
					}
					if (this._emojiIds.has(id)) {
						frag.appendChild(this.buildEmojiImage(id));
						replaced = true;
					} else {
						frag.appendChild(document.createTextNode(token));
					}
					lastIndex = start + token.length;
				}
				if (!replaced) continue;
				if (lastIndex < text.length) {
					frag.appendChild(
						document.createTextNode(text.slice(lastIndex)),
					);
				}
				textNode.replaceWith(frag);
			}
		},
	});

	/* ---------------------------------------------------------------------------
	 * direct-call: mirotalk.com のリンクをクリックしたとき直接通話に参加
	 * ------------------------------------------------------------------------- */

	Nyatten.registerModule({
		id: 'direct-call',
		name: '通話ダイレクト参加',
		description: 'MirotalkのURLをクリックしたとき、直接通話に参加します。',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('通話ダイレクト参加 モジュール初期化');

			this._clickHandler = (e) => {
				const config = ctx.getConfig();
				if (config.enabled === false) return;
				if (!localStorage.getItem('atten.acting_user_id')) return;

				const link = e.target.closest('a[href*="mirotalk.com"]');
				if (!link) return;

				const parsed = this._parseMirotalkUrl(link.href);
				if (!parsed) return;

				e.preventDefault();
				e.stopPropagation();

				const userInfo = this._getUserInfo();
				if (!userInfo) return;

				const params = new URLSearchParams({
					room: parsed.roomId,
					name: userInfo.name,
					avatar: userInfo.avatar,
					audio: '0',
					video: '0',
					chat: '1',
					notify: '0',
				});

				window.open(`https://${parsed.host}/join?${params}`, '_blank');
			};

			document.addEventListener('click', this._clickHandler, true);
		},
		onRouteChange(ctx) {},
		_parseMirotalkUrl(url) {
			try {
				const u = new URL(url);
				if (!u.hostname.endsWith('mirotalk.com')) return null;
				const room = u.searchParams.get('room');
				if (room) return { roomId: room, host: u.hostname };
				const parts = u.pathname
					.replace(/\/+$/, '')
					.split('/')
					.filter(Boolean);
				if (parts[0] === 'join' && parts[1])
					return { roomId: parts[1], host: u.hostname };
				if (parts.length === 1 && parts[0])
					return { roomId: parts[0], host: u.hostname };
			} catch (e) {}
			return null;
		},
		_getUserInfo() {
			const links = document.querySelectorAll('a[href^="/users/"]');
			for (const link of links) {
				if (
					link.closest(
						'[data-post-card-interactive], article, [role="article"]',
					)
				)
					continue;
				const img = link.querySelector('img');
				if (!img || !img.src) continue;
				const username = link
					.getAttribute('href')
					.replace('/users/', '')
					.split('/')[0]
					.split('?')[0];
				if (!username) continue;
				return {
					name: link.textContent.trim() || username,
					avatar: img.src,
				};
			}
			return null;
		},
	});

	/* ---------------------------------------------------------------------------
	 * direct-login: ログイン済みのScratchセッションを使って、Atten上のログイン
	 *   ダイアログにワンクリックログインのボタンを追加するモジュール。
	 *
	 *   注意（設計方針・重要）:
	 *   - ScratchのID/パスワードは一切扱わない。パスワード入力欄も作らない。
	 *   - Scratch側の「ログイン中かどうか・ユーザー名」は
	 *     GET https://scratch.mit.edu/session/ を叩いて確認するだけ
	 *     （既にブラウザ側でログイン済みのセッションを読むだけで、
	 *       ログイン処理自体は一切行わない）。
	 *   - Scratch連携に必要なCSRFトークン(scratchcsrftoken)は
	 *     content_script からは読めないため、background.js 経由で
	 *     chrome.cookies.get により該当Cookieの値だけを取得する。
	 *     scratchsessionsid には一切触れない。
	 *   - Attenの認証コード(/auth/codes)をScratchのプロフィールコメントへ
	 *     自動投稿するところまでは自動化するが、CAPTCHA(Turnstile)は
	 *     必ずユーザー自身に解いてもらう。ここは自動化しない。
	 *   - Scratchにログインしていない場合は、自動的に機能を無効表示にする。
	 * ------------------------------------------------------------------------- */

	const ATTEN_API_BASE = 'https://api.atten.win';
	const TURNSTILE_SITE_KEY = '0x4AAAAAACOJlGhSX4w8pOdK';

	Nyatten.registerModule({
		id: 'direct-login',
		name: 'ダイレクトログイン',
		description:
			'ログイン済みのScratchセッションを使って、ログイン画面からワンクリックでAttenにログインします。',
		icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
		defaultConfig: { enabled: true },
		init(ctx) {
			ctx.log('direct-login モジュール初期化');
			this._ctx = ctx;
			this._scratchSession = undefined; // undefined=未確認 null=未ログイン {username}=ログイン中
			this._dialogObserver = null;
			this._turnstileRequestId = null;
			this._turnstileToken = null;
			this._turnstileResultListener = null;

			this._watchLoginDialog();
		},
		onRouteChange(ctx) {
			this._ctx = ctx;
		},

		/* ------------------------------- Scratch側の状態確認 ------------------------------- */

		/**
		 * ログイン処理は一切行わず、既存のブラウザセッションから
		 * 「今scratch.mit.eduにログイン中かどうか」と「そのユーザー名」だけを読み取る。
		 * CORSプリフライトの制約を受けないよう、実際のfetchはbackground.js(service worker)側で行う。
		 */
		async _fetchScratchSession() {
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:get-scratch-session',
				});
				if (res && res.ok && res.username)
					return { username: res.username };
				return null;
			} catch (e) {
				Nyatten.warn(
					'[direct-login] Scratchセッション確認に失敗しました',
					e,
				);
				return null;
			}
		},

		/** キャッシュ済みならそれを返し、無ければ確認する */
		async _getScratchSession(forceRefresh = false) {
			if (!forceRefresh && this._scratchSession !== undefined) {
				return this._scratchSession;
			}
			const session = await this._fetchScratchSession();
			this._scratchSession = session;
			return session;
		},

		/* ------------------------------- ログインダイアログへの注入 ------------------------------- */

		_watchLoginDialog() {
			const tryInject = () => {
				const config = this._ctx?.getConfig?.() ?? {};
				if (config.enabled === false) return;

				const dialog = this._findAuthDialog();
				if (!dialog) return;
				if (dialog.querySelector('[data-nyatten-direct-login]')) return;

				this._injectDirectLoginButton(dialog);
			};

			this._dialogObserver = new MutationObserver(
				Nyatten.util.debounce(tryInject, 80),
			);
			this._dialogObserver.observe(document.documentElement, {
				childList: true,
				subtree: true,
			});

			// 既に開いている場合に備えて一度実行
			tryInject();
		},

		/**
		 * 「ユーザー名を入力して認証方式(プロフィールコメント認証 等)を選ぶ」ダイアログを探す。
		 * Radixの自動生成ID(radix-_r_xx_)は再現性がないため使わず、
		 * 見出しのテキストと、Scratchユーザー名入力欄の有無で判定する。
		 */
		_findAuthDialog() {
			const dialogs = document.querySelectorAll('[role="dialog"]');
			for (const dialog of dialogs) {
				const heading = dialog.querySelector('h1, h2');
				const headingText = (heading?.textContent || '').trim();
				if (headingText !== 'ログイン' && headingText !== 'Log in')
					continue;

				const usernameInput =
					dialog.querySelector('input[type="text"]');
				if (!usernameInput) continue;

				return dialog;
			}
			return null;
		},

		_getUsernameInput(dialog) {
			return dialog.querySelector('input[type="text"]');
		},

		async _injectDirectLoginButton(dialog) {
			const wrap = document.createElement('div');
			wrap.setAttribute('data-nyatten-direct-login', '');
			wrap.className =
				'flex flex-col gap-2 mt-4 pt-4 border-t border-border';

			const session = await this._getScratchSession();

			if (!session) {
				// 未ログイン時は機能自体を出さない（自動的に無効化された状態）
				wrap.innerHTML =
					'<p class="text-xs text-muted-foreground text-center">' +
					'ダイレクトログイン' +
					'</p>';
				this._appendToDialog(dialog, wrap);
				return;
			}

			this._renderInitialButton(dialog, wrap, session.username);
			this._appendToDialog(dialog, wrap);
		},

		/**
		 * Atten側の「ログイン中の全アカウント一覧」(GET /session/users) に、
		 * このボタンが対象とするScratchユーザー名がすでに含まれていれば、
		 * ボタンをグレーアウトして押せないようにする。
		 * （同じScratchアカウントで多重ログインさせないための表示上のガード）
		 */
		async _applyAlreadyLoggedInState(wrap, username) {
			const loggedInNames = await this._fetchLoggedInScratchNames();
			// 取得中にダイアログが閉じられた/差し替えられた場合は何もしない
			if (!wrap.isConnected) return;
			// 既にログインフローが開始されている(ボタンが無い)場合も何もしない
			const button = wrap.querySelector(
				'[data-nyatten-direct-login-button]',
			);
			if (!button) return;

			const isAlreadyLoggedIn = loggedInNames.some(
				(name) => name.toLowerCase() === username.toLowerCase(),
			);
			if (!isAlreadyLoggedIn) return;

			button.disabled = true;
			button.textContent = `ログイン済みのアカウント(${username})`;
			button.classList.add(
				'disabled:opacity-50',
				'disabled:cursor-not-allowed',
			);
		},

		/** 「Nyatten: <username> でダイレクトログイン」ボタン単体（初期表示）を描画する。
		 *  ログイン失敗時のリセットでも再利用する。
		 *  @param {string} [errorMessage] - 直前の失敗理由を示す文言。指定時はボタンの上に残す。 */
		_renderInitialButton(dialog, wrap, username, errorMessage) {
			wrap.innerHTML = '';

			if (errorMessage) {
				const errorEl = document.createElement('p');
				errorEl.setAttribute('data-nyatten-direct-login-error', '');
				errorEl.className = 'text-xs text-destructive text-center';
				errorEl.textContent = errorMessage;
				wrap.appendChild(errorEl);
			}

			// ユーザー名入力欄はAtten本体のReact state管理下にあり、外部からの書き込みは
			// 反映が不安定（3つの認証ボタンのdisabled状態と連動しない）ため触らない。
			// 代わりに、取得済みのusernameをNyattenのボタン自体に明記する。

			const button = document.createElement('button');
			button.type = 'button';
			button.setAttribute('data-nyatten-direct-login-button', '');
			button.className =
				'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border whitespace-nowrap transition-colors outline-none min-h-11 px-5 py-2 h-11 w-full text-base font-semibold border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
			button.textContent = `${username} でダイレクトログイン`;
			button.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (button.disabled) return;
				this._startDirectLogin(dialog, wrap, username);
			});

			wrap.appendChild(button);

			// 描画直後に「既にログイン中のアカウント一覧」と突き合わせ、
			// 含まれていれば非同期でボタンをグレーアウトする
			// (一覧取得を待ってからボタンを出すとログイン操作全体が遅くなるため、後追いで反映する)
			this._applyAlreadyLoggedInState(wrap, username);
		},

		_appendToDialog(dialog, wrap) {
			// 「プロフィールコメント認証」等の認証方式ボタンが並ぶブロックの直後に差し込む
			const usernameInput = this._getUsernameInput(dialog);
			const authButtonsBlock =
				usernameInput?.closest('div')?.nextElementSibling;
			if (authButtonsBlock && authButtonsBlock.parentElement) {
				authButtonsBlock.parentElement.insertBefore(
					wrap,
					authButtonsBlock.nextSibling,
				);
			} else {
				dialog.appendChild(wrap);
			}
		},

		/* ------------------------------- ログインフロー本体 ------------------------------- */

		async _startDirectLogin(dialog, wrap, username) {
			wrap.innerHTML =
				'<p class="text-xs text-muted-foreground text-center">コードを生成…</p>';

			let codeRes;
			try {
				codeRes = await this._apiPost('/auth/codes', {
					username,
					type: 'profileComment',
					mode: 'login',
				});
			} catch (e) {
				wrap.innerHTML =
					'<p class="text-xs text-destructive text-center">コードの生成に失敗しました</p>';
				Nyatten.warn('[direct-login] /auth/codes 失敗', e);
				return;
			}

			const { code, token } = codeRes || {};
			if (!code || !token) {
				wrap.innerHTML =
					'<p class="text-xs text-destructive text-center">コードの取得に失敗しました</p>';
				return;
			}

			// Turnstileの表示はここで即座に開始し、ユーザーが認証している間に
			// プロフィールへのコメント投稿を裏で並行して進める。
			// (投稿完了を待ってからTurnstileを出すと、その分ログイン操作が遅くなるため)
			const postCommentPromise = this._postProfileComment(username, code);

			this._renderTurnstileStep(
				wrap,
				token,
				username,
				postCommentPromise,
				dialog,
			);
		},

		/**
		 * Turnstile(Cloudflareのスクリプト)は、このcontent script自身が動く
		 * isolated worldのCSP(拡張機能専用のCSPで、リモートホストのscript-srcは
		 * 許可されない)ではロードできない。一方でatten.win自体は自前のログイン/
		 * 登録フォームで同じスクリプトを直接読み込んで動かしており、
		 * atten.win側のCSPは元々challenges.cloudflare.comを許可している。
		 *
		 * isolated worldから注入した<script>要素はページのCSPではなく
		 * isolated world側のCSPに縛られてしまう(MAIN worldに注入した場合のみ
		 * ページのCSPが適用される)ため、Turnstileの読み込みと描画は
		 * turnstileBridge.js (world: "MAIN" で登録された別のcontent script)に
		 * 委譲し、document上のCustomEventで結果だけを受け取る。
		 */
		_requestTurnstileRender(hostSelector, action) {
			const requestId = `nyatten-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			this._turnstileRequestId = requestId;

			document.dispatchEvent(
				new CustomEvent('nyatten:mw:turnstile-render-request', {
					detail: {
						requestId,
						sitekey: TURNSTILE_SITE_KEY,
						hostSelector,
						action,
					},
				}),
			);

			return requestId;
		},

		_removeTurnstileWidget(requestId) {
			if (!requestId) return;
			document.dispatchEvent(
				new CustomEvent('nyatten:mw:turnstile-remove-request', {
					detail: { requestId },
				}),
			);
		},

		_renderTurnstileStep(
			wrap,
			token,
			username,
			postCommentPromise,
			dialog,
		) {
			wrap.innerHTML = '';

			const desc = document.createElement('p');
			desc.className = 'text-xs text-muted-foreground text-center';
			desc.textContent = 'コードをコメント…';
			wrap.appendChild(desc);

			// turnstileBridge.js(MAIN world)がこの要素をwidgetのホストとして描画する。
			// MAIN world側はセレクタでしかDOMを参照できない(JS変数を共有できない)ため、
			// 一意な属性値をつけてセレクタで指定する。
			const widgetHostId = `nyatten-turnstile-widget-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const widgetHost = document.createElement('div');
			widgetHost.setAttribute(
				'data-nyatten-turnstile-widget',
				widgetHostId,
			);
			wrap.appendChild(widgetHost);

			const submitBtn = document.createElement('button');
			submitBtn.type = 'button';
			submitBtn.disabled = true;
			submitBtn.className =
				'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border whitespace-nowrap transition-colors outline-none min-h-11 px-5 py-2 h-11 w-full text-base font-semibold border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
			submitBtn.textContent = 'ログイン中…';
			wrap.appendChild(submitBtn);

			this._turnstileToken = null;

			if (this._turnstileResultListener) {
				document.removeEventListener(
					'nyatten:mw:turnstile-result',
					this._turnstileResultListener,
				);
			}

			const requestId = this._requestTurnstileRender(
				`[data-nyatten-turnstile-widget="${widgetHostId}"]`,
				'login',
			);

			const cleanupTurnstile = () => {
				this._removeTurnstileWidget(requestId);
				if (this._turnstileResultListener) {
					document.removeEventListener(
						'nyatten:mw:turnstile-result',
						this._turnstileResultListener,
					);
					this._turnstileResultListener = null;
				}
			};

			// 失敗時共通の後処理: 投稿済みならコメントを削除し、UIを初期表示に戻す。
			// errorMessageを渡すと、リセット後もボタン上部にその文言を残す。
			const resetAfterFailure = async (errorMessage) => {
				cleanupTurnstile();
				try {
					const posted = await postCommentPromise;
					if (posted?.ok && posted.commentId) {
						await this._deleteProfileComment(
							username,
							posted.commentId,
						);
					}
				} catch (e) {
					Nyatten.warn(
						'[direct-login] 失敗後のコメント削除に失敗しました',
						e,
					);
				}
				this._renderInitialButton(dialog, wrap, username, errorMessage);
			};

			// コメント投稿とTurnstile認証、両方が揃った時点で自動的にログイン処理へ進む。
			// ボタンは操作対象ではなく状態表示専用（失敗してリセットされるまでは常に無効）。
			let commentPosting = true;
			let postedResult = null;
			let turnstileReady = false;
			let started = false;

			const maybeStartLogin = () => {
				if (started) return;
				if (commentPosting || !turnstileReady) return;
				started = true;
				runLogin();
			};

			const updateDescForTurnstileState = () => {
				if (commentPosting) return; // コメント投稿の進捗表示を上書きしない
				if (!turnstileReady) desc.textContent = 'キャプチャを待機...';
			};

			postCommentPromise.then((posted) => {
				commentPosting = false;
				postedResult = posted;
				if (!posted?.ok) {
					Nyatten.warn(
						'[direct-login] プロフィールへのコメント投稿に失敗しました',
					);
					resetAfterFailure(
						'コードのコメントに失敗しました。もう一度お試しください',
					);
					return;
				}
				updateDescForTurnstileState();
				maybeStartLogin();
			});

			this._turnstileResultListener = (event) => {
				const detail = event.detail || {};
				if (detail.requestId !== requestId) return;

				if (detail.type === 'token') {
					this._turnstileToken = detail.token;
					turnstileReady = true;
					maybeStartLogin();
				} else if (detail.type === 'error') {
					desc.textContent = 'キャプチャの読み込みに失敗しました';
				} else if (detail.type === 'expired') {
					this._turnstileToken = null;
					turnstileReady = false;
					desc.textContent =
						'キャプチャの有効期限が切れました。もう一度お試しください';
				}
			};
			document.addEventListener(
				'nyatten:mw:turnstile-result',
				this._turnstileResultListener,
			);

			const runLogin = async () => {
				try {
					desc.textContent = 'ログイン…';
					await this._apiPost('/auth/login', {
						cf_turnstile_response: this._turnstileToken,
						token,
					});
					cleanupTurnstile();

					// ログイン成功後、プロフィールに残った認証コードコメントを削除する。
					// 失敗してもログイン自体は既に完了しているのでUIをブロックしない。
					// (ボタン自体のテキストは変えず「ログイン中…」のまま、進捗はdesc側で示す)
					if (postedResult?.commentId) {
						desc.textContent = 'コードを削除…';
						await this._deleteProfileComment(
							username,
							postedResult.commentId,
						);
					}

					window.location.reload();
				} catch (err) {
					Nyatten.warn('[direct-login] /auth/login 失敗', err);
					await resetAfterFailure(this._describeLoginError(err));
				}
			};
		},

		/** /auth/login 失敗時のエラーコードを、ユーザー向けの文言に変換する */
		_describeLoginError(err) {
			const code = err?.body?.code;
			switch (code) {
				case 'scratch_auth_verify_failed':
					return 'コードの確認に失敗しました。もう一度お試しください。';
				case 'scratch_auth_invalid_code':
					return 'コードが無効です。もう一度お試しください。';
				default:
					return 'ログインに失敗しました。もう一度お試しください。';
			}
		},

		/* ------------------------------- Scratchプロフィールコメント投稿 ------------------------------- */

		/** 実際のfetchはbackground.js側で行う（CORSプリフライトの制約を受けないため） */
		async _postProfileComment(username, code) {
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:post-scratch-profile-comment',
					username,
					code,
				});
				if (!res || !res.ok) return { ok: false };
				return { ok: true, commentId: res.commentId ?? null };
			} catch (e) {
				Nyatten.warn(
					'[direct-login] プロフィールコメント投稿に失敗しました',
					e,
				);
				return { ok: false };
			}
		},

		/** ログイン成功後、投稿済みの認証コードコメントを削除する（失敗しても致命的ではないのでUIはブロックしない） */
		async _deleteProfileComment(username, commentId) {
			if (!commentId) return;
			try {
				const res = await chrome.runtime.sendMessage({
					type: 'nyatten:delete-scratch-profile-comment',
					username,
					commentId,
				});
				if (!res || !res.ok) {
					Nyatten.warn(
						'[direct-login] 認証コードコメントの削除に失敗しました',
						res,
					);
				}
			} catch (e) {
				Nyatten.warn(
					'[direct-login] 認証コードコメントの削除に失敗しました',
					e,
				);
			}
		},

		/* ------------------------------- Atten API ヘルパー ------------------------------- */

		/** document.cookie から csrftoken を読む（atten.win上のcontent_scriptなので直接読める） */
		_getAttenCsrfToken() {
			const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
			return match ? decodeURIComponent(match[1]) : null;
		},

		async _ensureAttenCsrfToken() {
			let token = this._getAttenCsrfToken();
			if (token) return token;
			// Cookieがまだ無ければ /csrf-token を叩いて発行してもらう
			try {
				await fetch(ATTEN_API_BASE + '/csrf-token', {
					credentials: 'include',
				});
			} catch (e) {
				Nyatten.warn(
					'[direct-login] /csrf-token の取得に失敗しました',
					e,
				);
			}
			return this._getAttenCsrfToken();
		},

		/**
		 * ログイン中の全アカウント一覧 (GET /session/users) を取得する。
		 * ダイアログ表示時の「既にログイン中のアカウントか」判定にのみ使う。
		 * 未ログイン(401)時はAtten本体同様に空配列として扱う。
		 */
		async _fetchLoggedInScratchNames() {
			try {
				const data = await this._apiGet('/session/users');
				if (!Array.isArray(data)) return [];
				return data
					.map((entry) => entry?.user?.scratch_name)
					.filter((name) => typeof name === 'string' && name);
			} catch (e) {
				Nyatten.warn(
					'[direct-login] /session/users の取得に失敗しました',
					e,
				);
				return [];
			}
		},

		/**
		 * Atten API への共通リクエストヘルパー。
		 * GET/POST とも「CSRFトークン付与 → fetch → JSON化 → エラー判定」の
		 * 流れが同一のため、ここに集約する（method/bodyだけが呼び出し側で異なる）。
		 */
		async _request(method, path, body, _isRetry = false) {
			const csrfToken = await this._ensureAttenCsrfToken();
			const headers = {
				Accept: 'application/json',
				'X-Client-Id': 'atten-web',
			};
			if (method !== 'GET') headers['Content-Type'] = 'application/json';
			if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

			const res = await fetch(ATTEN_API_BASE + path, {
				method,
				credentials: 'include',
				headers,
				body: method === 'GET' ? undefined : JSON.stringify(body),
			});
			const json = await res.json().catch(() => null);
			if (!res.ok || json?.ok === false) {
				const code = json?.code;
				// csrf_validation_failed はCookie反映直後の一時的な失敗のことがあるため1回だけ再試行する
				if (
					method !== 'GET' &&
					code === 'csrf_validation_failed' &&
					!_isRetry
				) {
					return this._request(method, path, body, true);
				}
				const err = new Error(code || `HTTP ${res.status}`);
				err.body = json;
				throw err;
			}
			return json?.data ?? json;
		},

		_apiGet(path) {
			return this._request('GET', path);
		},

		_apiPost(path, body) {
			return this._request('POST', path, body);
		},
	});

	Nyatten.settingsGroups.push({
		moduleId: 'ngcat',
		title: 'NGCat',
		description: 'NGワードを含む投稿を自動で非表示にします',
		fields: [
			{
				key: 'words',
				label: 'NGワード',
				type: 'textarea',
				description: '改行または,区切りで入力してください。',
				placeholder: '例: 犬, おにぎり, NyaX',
				rows: 4,
			},
		],
	});

	function cleanupNyattenPanel() {
		lastNyattenRenderedRoute = null;
		if (nyattenCardObserver) {
			nyattenCardObserver.disconnect();
			nyattenCardObserver = null;
		}

		const container = document.querySelector(
			'div.mx-auto.w-full.max-w-225',
		);
		if (!container) return;

		const panel = container.querySelector('[data-nyatten-settings-panel]');
		if (panel) panel.remove();

		const card = container.querySelector('[data-nyatten-settings-card]');
		if (card) card.remove();

		Array.from(container.children).forEach((el) => {
			if (el.style.display === 'none') {
				el.style.display = '';
			}
		});
	}

	function findSettingsCardContainer() {
		return document.querySelector('section.flex.flex-col.gap-3.px-4.py-6');
	}

	// injectNyattenCard は /settings ルート専用。非同期解決や
	// MutationObserver のコールバックが発火した時点で既にルートを
	// 離れている（例: /settings -> /settings/account）ケースがあるため、
	// 都度 isOnNyattenCardRoute() で現在のパス/ハッシュを確認する。
	function isOnNyattenCardRoute() {
		return location.pathname === '/settings' && !location.hash;
	}

	function injectNyattenCard(ctx) {
		Nyatten.util
			.waitForElement('section.flex.flex-col.gap-3.px-4.py-6')
			.then((container) => {
				if (!isOnNyattenCardRoute()) return;
				if (container.querySelector('[data-nyatten-settings-card]'))
					return;

				appendNyattenCard(container, ctx);

				// React の再描画でカードが消えたら再挿入する
				if (nyattenCardObserver) {
					nyattenCardObserver.disconnect();
				}
				nyattenCardObserver = new MutationObserver(
					Nyatten.util.debounce(() => {
						if (!isOnNyattenCardRoute()) {
							if (nyattenCardObserver) {
								nyattenCardObserver.disconnect();
								nyattenCardObserver = null;
							}
							return;
						}
						const current = findSettingsCardContainer();
						if (!current) return;
						if (
							!current.querySelector(
								'[data-nyatten-settings-card]',
							)
						) {
							appendNyattenCard(current, ctx);
						}
					}, 100),
				);
				nyattenCardObserver.observe(document.documentElement, {
					childList: true,
					subtree: true,
				});
			})
			.catch(() => {});
	}

	function appendNyattenCard(container, ctx) {
		if (container.querySelector('[data-nyatten-settings-card]')) return;
		const card = document.createElement('div');
		card.setAttribute('data-nyatten-settings-card', '');
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		card.className =
			'flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 transition-colors hover:bg-muted/40';
		card.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			pushRouteState('/settings#nyatten');
		});

		card.innerHTML =
			'<div class="flex-1 min-w-0">' +
			'<p class="text-sm font-medium text-foreground">Nyatten</p>' +
			'</div>' +
			'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0">' +
			'<path d="m9 18 6-6-6-6"/>' +
			'</svg>';

		container.appendChild(card);
	}

	function renderNyattenSettings(ctx) {
		const hash = location.hash;
		const currentRoute = `${location.pathname}${hash}`;

		if (lastNyattenRenderedRoute === currentRoute) {
			return;
		}
		lastNyattenRenderedRoute = currentRoute;

		Nyatten.util
			.waitForElement('div.mx-auto.w-full.max-w-225')
			.then((container) => {
				if (container.querySelector('[data-nyatten-settings-panel]'))
					return;

				Array.from(container.children).forEach((el) => {
					el.style.display = 'none';
				});

				const panel = document.createElement('div');
				panel.setAttribute('data-nyatten-settings-panel', '');
				panel.className = 'flex flex-col gap-4 px-4 py-6 md:px-6';

				if (hash === '#nyatten') {
					renderNyattenIndex(panel, ctx);
				} else if (hash.startsWith('#nyatten:')) {
					renderNyattenSubPage(
						panel,
						ctx,
						hash.slice('#nyatten:'.length),
					);
				}

				container.appendChild(panel);

				panel
					.querySelector('[data-nyatten-back-link]')
					.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						pushRouteState(
							panel.getAttribute('data-nyatten-back-to') ||
								'/settings',
						);
					});
			})
			.catch(() => {});
	}

	function renderNyattenIndex(panel, ctx) {
		const query = (panel.getAttribute('data-nyatten-search') || '').trim();
		const cardsContainer = panel.querySelector('[data-nyatten-cards]');

		if (!cardsContainer) {
			panel.innerHTML =
				renderPanelHeader('Nyatten') +
				renderSearchBox(query) +
				'<div class="rounded-2xl border border-border bg-card p-4">' +
				`<p class="text-sm text-muted-foreground">Nyattenは非公式のサードパーティツールです。Nyattenの問題をAttenTeamに報告しないでください。</p>` +
				'</div>' +
				'<div data-nyatten-cards class="flex flex-col gap-3"></div>';

			panel.setAttribute('data-nyatten-back-to', '/settings');

			wireSearchBox(panel, () => renderNyattenIndex(panel, ctx));
		}

		const container = panel.querySelector('[data-nyatten-cards]');
		container.innerHTML =
			renderModuleCards(ctx, query) + renderGroupCards(ctx);
	}

	const CHEVRON_RIGHT_SVG =
		'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0">' +
		'<path d="m9 18 6-6-6-6"/>' +
		'</svg>';

	/**
	 * Nyatten設定一覧のカード行(モジュールカード/グループカード共通の見た目)を描画する。
	 * 両者はアイコン・タイトル・説明・遷移用data属性しか違わないため、共通シェルをここに集約する。
	 * @param {{dataAttr: string, dataValue: string, iconHtml: string, title: string, description?: string, extraHtml?: string}} opts
	 */
	function renderNavCardRow(opts) {
		const { dataAttr, dataValue, iconHtml, title, description, extraHtml } =
			opts;
		return (
			'<div role="button" tabindex="0" ' +
			dataAttr +
			'="' +
			dataValue +
			'" class="flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 transition-colors hover:bg-muted/40">' +
			(iconHtml ? '<div class="shrink-0">' + iconHtml + '</div>' : '') +
			'<div class="flex-1 min-w-0">' +
			'<p class="text-sm font-medium text-foreground">' +
			title +
			'</p>' +
			(description
				? '<p class="text-xs text-muted-foreground truncate">' +
					description +
					'</p>'
				: '') +
			'</div>' +
			(extraHtml || '') +
			CHEVRON_RIGHT_SVG +
			'</div>'
		);
	}

	function renderModuleCards(ctx, query) {
		const nyatten = ctx.nyatten;
		const modules = filterAndSortModules(nyatten._modules || [], query);

		return modules
			.map((mod) => {
				const enabled = nyatten.config[mod.id]?.enabled;
				const isEnabled = enabled !== false;
				const statusBadge =
					'<span class="text-xs ' +
					(isEnabled ? 'text-primary' : 'text-muted-foreground') +
					'">' +
					(isEnabled ? '有効' : '無効') +
					'</span>';
				return renderNavCardRow({
					dataAttr: 'data-nyatten-module',
					dataValue: mod.id,
					iconHtml: renderIcon(mod.icon || mod.id),
					title: escHtml(mod.name || mod.id),
					description: mod.description
						? escHtml(mod.description)
						: '',
					extraHtml: statusBadge,
				});
			})
			.join('');
	}

	function renderGroupCards(ctx) {
		const nyatten = ctx.nyatten;
		const modules = nyatten._modules || [];
		const moduleIds = new Set(modules.map((m) => m.id));
		const groups = (nyatten.settingsGroups || []).filter(
			(g) => !moduleIds.has(g.moduleId),
		);

		return groups
			.map((group) => {
				let groupIcon = group.icon;
				if (!groupIcon) {
					const mod = getModuleById(group.moduleId);
					groupIcon = mod?.icon ?? group.moduleId;
				}
				return renderNavCardRow({
					dataAttr: 'data-nyatten-group',
					dataValue: group.moduleId,
					iconHtml: renderIcon(groupIcon),
					title: group.title,
					description: group.description,
				});
			})
			.join('');
	}

	function renderNyattenSubPage(panel, ctx, groupId) {
		const nyatten = ctx.nyatten;

		if (groupId.startsWith('module:')) {
			renderModuleTab(panel, ctx, groupId.slice('module:'.length));
			return;
		}

		const group = (nyatten.settingsGroups || []).find(
			(g) => g.moduleId === groupId,
		);
		if (!group) {
			renderNyattenIndex(panel, ctx);
			return;
		}

		panel.innerHTML =
			renderPanelHeader(group.title) +
			'<div class="rounded-2xl border border-border bg-card p-4">' +
			'<p class="text-sm text-muted-foreground mb-3">' +
			group.description +
			'</p>' +
			'<div class="flex flex-col gap-3">' +
			group.fields
				.map(function (field) {
					return renderField(field, group.moduleId, ctx);
				})
				.join('') +
			'</div>' +
			'</div>';

		panel.setAttribute('data-nyatten-back-to', '/settings#nyatten');
	}

	function renderModuleTab(panel, ctx, moduleId) {
		const nyatten = ctx.nyatten;
		const module = getModuleById(moduleId);
		if (!module) {
			renderNyattenIndex(panel, ctx);
			return;
		}

		const enabled = nyatten.config[module.id]?.enabled;
		const isEnabled = enabled !== false;
		const moduleGroup = (nyatten.settingsGroups || []).find(
			(g) => g.moduleId === module.id,
		);
		const query = (panel.getAttribute('data-nyatten-search') || '').trim();
		const q = query.toLowerCase();

		const fieldFilter = (f) => {
			if (!query) return true;
			const label = (f.label || '').toLowerCase();
			const desc = (f.description || '').toLowerCase();
			const key = (f.key || '').toLowerCase();
			return label.includes(q) || desc.includes(q) || key.includes(q);
		};

		const toggleHtml = module.locked
			? '<div class="flex items-center justify-between gap-4">' +
				'<div class="text-sm text-muted-foreground">常に有効</div>' +
				renderToggleSwitch(null, null, true, { disabled: true }) +
				'</div>'
			: '<div class="flex items-center justify-between gap-4">' +
				'<div class="text-sm text-foreground">モジュールを有効化</div>' +
				renderToggleSwitch(
					'data-nyatten-module-enabled',
					module.id,
					isEnabled,
					{
						ariaLabel:
							(module.name || module.id) +
							(isEnabled ? ' を無効化' : ' を有効化'),
					},
				) +
				'</div>';

		const fieldsContainer = panel.querySelector('[data-nyatten-fields]');

		if (!fieldsContainer) {
			panel.innerHTML =
				renderPanelHeader(module.name || module.id) +
				renderSearchBox(query) +
				'<div class="rounded-2xl border border-border bg-card p-4 mb-4">' +
				'<div class="flex flex-col gap-4">' +
				'<div class="flex items-center justify-between gap-4">' +
				'<div class="flex-1 min-w-0">' +
				'<p class="text-sm font-medium text-foreground">' +
				escHtml(module.name || module.id) +
				'</p>' +
				(module.description
					? '<p class="text-xs text-muted-foreground mt-0.5">' +
						escHtml(module.description) +
						'</p>'
					: '') +
				'</div>' +
				'</div>' +
				toggleHtml +
				'</div>' +
				'</div>';

			panel.setAttribute('data-nyatten-back-to', '/settings#nyatten');

			wireSearchBox(panel, () => renderModuleTab(panel, ctx, moduleId));
		}

		const oldFields = panel.querySelector('[data-nyatten-fields]');
		if (oldFields) oldFields.remove();

		if (moduleGroup && moduleGroup.fields && moduleGroup.fields.length) {
			const fields = moduleGroup.fields.filter(fieldFilter);
			if (fields.length) {
				const el = document.createElement('div');
				el.setAttribute('data-nyatten-fields', '');
				el.innerHTML =
					'<div class="rounded-2xl border border-border bg-card p-4">' +
					'<div class="flex flex-col gap-3">' +
					fields
						.map(function (f) {
							return renderField(f, module.id, ctx);
						})
						.join('') +
					'</div>' +
					'</div>';
				panel.appendChild(el);
			} else if (query) {
				const el = document.createElement('div');
				el.setAttribute('data-nyatten-fields', '');
				el.innerHTML =
					'<div class="rounded-2xl border border-border bg-card p-4">' +
					'<p class="text-sm text-muted-foreground">該当する設定項目がありません</p>' +
					'</div>';
				panel.appendChild(el);
			}
		}
	}

	// HTMLエスケープ
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}
	function escAttr(s) {
		return escHtml(s).replace(/"/g, '&quot;');
	}

	const FIELD_INPUT_CLASS =
		'rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary transition-colors';

	/** data-nyatten-field 属性値 ("<moduleId>.<key>") を組み立てる */
	function fieldName(moduleId, key) {
		return moduleId + '.' + key;
	}

	/**
	 * text/textarea/number/select 共通の「ラベル + 説明文 + 入力欄」ラッパーを描画する。
	 * @param {Object} field - フィールド定義 (label, description を使用)
	 * @param {string} inputHtml - 中身の入力要素HTML
	 */
	function fieldWrapper(field, inputHtml) {
		return (
			'<div class="flex flex-col gap-1.5">' +
			'<label class="text-sm font-medium text-foreground">' +
			escHtml(field.label) +
			'</label>' +
			(field.description
				? '<p class="text-xs text-muted-foreground">' +
					escHtml(field.description) +
					'</p>'
				: '') +
			inputHtml +
			'</div>'
		);
	}

	/**
	 * toggleスイッチ(role="switch")のHTMLを描画する。設定フィールド・モジュール有効化・
	 * 常時有効(locked)表示のいずれからも使う共通部品。
	 * @param {string} dataAttr - 付与するdata-*属性名 (例: 'data-nyatten-field')
	 * @param {string} dataValue - その属性値
	 * @param {boolean} checked
	 * @param {{ariaLabel?: string, disabled?: boolean}} [opts]
	 */
	function renderToggleSwitch(dataAttr, dataValue, checked, opts = {}) {
		const { ariaLabel, disabled } = opts;
		return (
			'<button type="button" role="switch" ' +
			(dataAttr ? dataAttr + '="' + escAttr(dataValue) + '"' : '') +
			(ariaLabel ? ' aria-label="' + escAttr(ariaLabel) + '"' : '') +
			(disabled ? ' aria-disabled="true"' : '') +
			' class="relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ' +
			(disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer') +
			' ' +
			(checked ? 'bg-primary' : 'bg-border') +
			'"' +
			' style="width:44px;height:24px"' +
			' data-state="' +
			(checked ? 'checked' : 'unchecked') +
			'">' +
			'<span data-slot="switch-thumb" class="pointer-events-none inline-block rounded-full bg-background shadow-sm border-2 border-border transition-transform duration-200"' +
			' style="width:20px;height:20px;transform:translateX(' +
			(checked ? '22px' : '2px') +
			')">' +
			'</span>' +
			'</button>'
		);
	}

	/**
	 * JSONスキーマ定義から設定フィールドのHTMLを生成する。
	 *
	 * @param {Object} field - フィールド定義
	 * @param {string} field.key - 設定キー
	 * @param {string} field.label - 表示ラベル
	 * @param {string} field.type - フィールド種別 (toggle | text | textarea | number | select)
	 * @param {string} [field.description] - 説明文
	 * @param {Array} [field.options] - select型の場合の選択肢 [{label, value}]
	 * @param {string} [field.placeholder] - text/number/textarea型の場合のプレースホルダー
	 * @param {string} [field.unit] - number型の場合の単位
	 */
	function renderSchemaField(field, moduleId, ctx) {
		const nyatten = ctx.nyatten;
		const value = nyatten.config[moduleId]?.[field.key];
		const name = fieldName(moduleId, field.key);

		switch (field.type) {
			case 'toggle':
				return (
					'<div class="flex items-center justify-between gap-4">' +
					'<div class="flex-1 min-w-0">' +
					'<p class="text-sm font-medium text-foreground">' +
					escHtml(field.label) +
					'</p>' +
					(field.description
						? '<p class="text-xs text-muted-foreground mt-0.5">' +
							escHtml(field.description) +
							'</p>'
						: '') +
					'</div>' +
					renderToggleSwitch('data-nyatten-field', name, !!value) +
					'</div>'
				);

			case 'text':
				return fieldWrapper(
					field,
					'<input type="text" data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' value="' +
						escAttr(String(value ?? '')) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="' +
						FIELD_INPUT_CLASS +
						'" />',
				);

			case 'textarea':
				return fieldWrapper(
					field,
					'<textarea data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' rows="' +
						escAttr(String(field.rows || 4)) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="min-h-[88px] ' +
						FIELD_INPUT_CLASS +
						'">' +
						escHtml(String(value ?? '')) +
						'</textarea>',
				);

			case 'number':
				return fieldWrapper(
					field,
					'<div class="flex items-center gap-2">' +
						'<input type="number" data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' value="' +
						escAttr(String(value ?? '')) +
						'"' +
						' placeholder="' +
						escAttr(field.placeholder || '') +
						'"' +
						' class="flex-1 ' +
						FIELD_INPUT_CLASS +
						'" />' +
						(field.unit
							? '<span class="text-sm text-muted-foreground">' +
								escHtml(field.unit) +
								'</span>'
							: '') +
						'</div>',
				);

			case 'select': {
				const optsHtml = (field.options || [])
					.map((opt) => {
						const sel =
							String(value) === String(opt.value)
								? ' selected'
								: '';
						return (
							'<option value="' +
							escAttr(String(opt.value)) +
							'"' +
							sel +
							'>' +
							escHtml(opt.label) +
							'</option>'
						);
					})
					.join('');
				return fieldWrapper(
					field,
					'<select data-nyatten-field="' +
						escAttr(name) +
						'"' +
						' class="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary transition-colors">' +
						optsHtml +
						'</select>',
				);
			}

			default:
				return '';
		}
	}

	function renderField(field, moduleId, ctx) {
		return renderSchemaField(field, moduleId, ctx);
	}

	function renderIcon(icon) {
		if (!icon) return '';

		// インラインアイコンデータ { type, url?, svg? }
		if (typeof icon === 'object') {
			if (icon.type === 'url' && icon.url) {
				return (
					'<img src="' +
					icon.url +
					'" alt="" class="w-5 h-5 shrink-0 rounded" />'
				);
			}
			if (icon.svg) return icon.svg;
			return '';
		}

		// 文字列 → Nyatten.icons から検索
		const iconDef = Nyatten.icons[icon];
		if (!iconDef) return '';
		if (iconDef.type === 'url' && iconDef.url) {
			return (
				'<img src="' +
				iconDef.url +
				'" alt="" class="w-5 h-5 shrink-0 rounded" />'
			);
		}
		if (iconDef.svg) return iconDef.svg;
		return '';
	}

	// イベント委譲: トグルスイッチ・グループカードの変更を監視
	document.addEventListener('click', async (e) => {
		// フィールドトグル（設定項目のON/OFF）
		const fieldBtn = e.target.closest(
			'[role="switch"][data-nyatten-field]',
		);
		if (fieldBtn) {
			e.preventDefault();
			e.stopPropagation();

			const fieldPath = fieldBtn.getAttribute('data-nyatten-field');
			const parts = fieldPath.split('.');
			if (parts.length !== 2) return;
			const moduleId = parts[0];
			const key = parts[1];

			const module = getModuleById(moduleId);
			if (!module) return;

			const modCtx = window.Nyatten._makeContext(module);
			const current = modCtx.getConfig();
			const newValue = !current[key];
			await modCtx.setConfig({ [key]: newValue });

			updateToggleUI(fieldBtn, newValue);
			return;
		}

		// モジュール有効化トグル
		const moduleToggleBtn = e.target.closest(
			'[role="switch"][data-nyatten-module-enabled]',
		);
		if (moduleToggleBtn) {
			e.preventDefault();
			e.stopPropagation();

			const moduleId = moduleToggleBtn.getAttribute(
				'data-nyatten-module-enabled',
			);
			const module = getModuleById(moduleId);
			if (!module || module.locked) return;

			const modCtx = window.Nyatten._makeContext(module);
			const current = modCtx.getConfig();
			const newValue = !(current.enabled !== false); // undefined → true
			await modCtx.setConfig({ enabled: newValue });

			updateToggleUI(moduleToggleBtn, newValue);
			return;
		}

		// モジュールカードのクリック → モジュールタブ遷移
		const moduleCard = e.target.closest('[data-nyatten-module]');
		if (moduleCard) {
			e.preventDefault();
			const moduleId = moduleCard.getAttribute('data-nyatten-module');
			pushRouteState('/settings#nyatten:module:' + moduleId);
			return;
		}

		// グループカードのクリック → サブページ遷移
		const groupCard = e.target.closest('[data-nyatten-group]');
		if (groupCard) {
			e.preventDefault();
			const gid = groupCard.getAttribute('data-nyatten-group');
			pushRouteState('/settings#nyatten:' + gid);
		}
	});

	function updateToggleUI(btn, isChecked) {
		btn.setAttribute('data-state', isChecked ? 'checked' : 'unchecked');
		btn.className = [
			'relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200',
			isChecked ? 'bg-primary' : 'bg-border',
		].join(' ');
		const thumb = btn.querySelector('[data-slot="switch-thumb"]');
		if (thumb) {
			thumb.style.transform =
				'translateX(' + (isChecked ? '22px' : '2px') + ')';
			thumb.className = [
				'pointer-events-none inline-block rounded-full bg-background shadow-sm border-2 border-border transition-transform duration-200',
			].join(' ');
		}
	}

	// change イベント委譲: テキスト・数値・セレクトの変更を保存
	document.addEventListener('change', async (e) => {
		const el = e.target.closest('[data-nyatten-field]');
		if (!el) return;
		const tag = el.tagName;
		// switch (role="switch") は click で処理するので change では無視
		if (tag === 'BUTTON' && el.getAttribute('role') === 'switch') return;

		const fieldPath = el.getAttribute('data-nyatten-field');
		const parts = fieldPath.split('.');
		if (parts.length !== 2) return;
		const moduleId = parts[0];
		const key = parts[1];

		const module = getModuleById(moduleId);
		if (!module) return;

		let newValue;
		if (tag === 'SELECT') {
			newValue = el.value;
		} else if (tag === 'INPUT' || tag === 'TEXTAREA') {
			const type = el.getAttribute('type');
			if (tag === 'INPUT' && type === 'number') {
				newValue = el.value === '' ? '' : Number(el.value);
			} else {
				newValue = el.value;
			}
		} else {
			return;
		}

		const modCtx = window.Nyatten._makeContext(module);
		await modCtx.setConfig({ [key]: newValue });
	});

	/* ===========================================================================
	 * 4. 起動
	 * ========================================================================= */
	Nyatten.init();
})();
