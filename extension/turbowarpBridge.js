(function () {
    'use strict';

    // Save original fetch
    const originalFetch = window.fetch;

    const pendingRequests = new Map();

    window.addEventListener('message', (event) => {
        // Only accept messages from parent
        if (event.source !== window.parent) return;

        const msg = event.data;
        if (msg && msg.type === 'nyatten:fetch-asset-response') {
            const { requestId, success, data, mime, status } = msg;
            const pending = pendingRequests.get(requestId);
            if (pending) {
                pendingRequests.delete(requestId);
                if (success) {
                    // data is an ArrayBuffer
                    const response = new Response(data, {
                        status: status || 200,
                        statusText: 'OK',
                        headers: {
                            'Content-Type': mime || 'application/octet-stream',
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                    pending.resolve(response);
                } else {
                    pending.reject(
                        new TypeError('Failed to fetch (Nyatten Bridge)'),
                    );
                }
            }
        }
    });

    window.fetch = function (input, init) {
        let url = '';
        if (typeof input === 'string') {
            url = input;
        } else if (input instanceof URL) {
            url = input.toString();
        } else if (input && input.url) {
            url = input.url;
        }

        // Intercept requests to atten.win domains (e.g., files-v2.atten.win)
        if (url.includes('atten.win')) {
            const requestId = Math.random().toString(36).slice(2, 11);
            return new Promise((resolve, reject) => {
                pendingRequests.set(requestId, { resolve, reject });
                window.parent.postMessage(
                    {
                        type: 'nyatten:fetch-asset',
                        requestId,
                        url,
                    },
                    '*',
                );
            });
        }

        return originalFetch.apply(this, arguments);
    };

    // Automatically detect and bypass the Extension Security Warning modal using MutationObserver
    const observer = new MutationObserver(() => {
        // Target checkbox for loading unsandboxed extension
        const checkbox = document.querySelector(
            'input.load-extension_unsandboxed-checkbox_1tSmf[type="checkbox"]',
        );
        // Only click to check if it's not already checked
        if (checkbox && !checkbox.checked) {
            checkbox.click();
        }

        // Target 'Allow' button
        const allowBtn = document.querySelector(
            'button.security-manager-modal_allow-button_3tcXk',
        );
        // Only click if the button exists and is not disabled
        if (
            allowBtn &&
            !allowBtn.disabled &&
            !allowBtn.hasAttribute('disabled')
        ) {
            allowBtn.click();
            // Disconnect the observer as the warning has been bypassed
            observer.disconnect();
        }
    });

    // Start observing the document, including attribute changes for 'disabled' state updates
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
    });
})();
