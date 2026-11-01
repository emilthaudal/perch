// Runs in the page's own JavaScript world at document_start, before X's code, and
// wraps fetch and XMLHttpRequest so GraphQL responses pass through PerchCore.transform.
(function () {
  'use strict';
  if (window.__perchInstalled || !window.PerchCore) return;
  window.__perchInstalled = true;

  const { operationName, transform } = window.PerchCore;
  let settings = { ...window.PERCH_DEFAULTS };
  const focalAuthors = new Map();

  // The content script can't share variables with this world, so it posts settings.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'perch-settings') return;
    settings = { ...window.PERCH_DEFAULTS, ...event.data.settings };
  });
  window.postMessage({ source: 'perch-ready' }, location.origin);
  console.info('[perch] active');

  function rewrite(json, url) {
    try {
      const stats = {};
      const changed = transform(json, url, settings, focalAuthors, stats);
      if (stats.op === 'TweetDetail' || stats.adsRemoved > 0) {
        console.info(
          `[perch] ${stats.op}: ${stats.repliesSorted ? 'replies sorted' : 'replies NOT sorted'}, ${stats.adsRemoved} ads removed`,
        );
      }
      return changed;
    } catch (err) {
      console.warn('[perch] transform failed, showing the original response', err);
      return false;
    }
  }

  // fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!operationName(url) || !response.ok) return response;
    if (!(response.headers.get('content-type') || '').includes('json')) return response;
    try {
      const json = await response.clone().json();
      if (!rewrite(json, url)) return response;
      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };

  // XMLHttpRequest
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  proto.open = function (method, url, ...rest) {
    this.__perchUrl = operationName(url) ? String(url) : null;
    this.__perchCache = null;
    return originalOpen.call(this, method, url, ...rest);
  };

  for (const prop of ['responseText', 'response']) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get) continue;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const raw = desc.get.call(this);
        if (!this.__perchUrl || this.readyState !== 4) return raw;
        this.__perchCache ??= {};
        if (prop in this.__perchCache) return this.__perchCache[prop];

        let out = raw;
        if (typeof raw === 'string' && raw) {
          try {
            const json = JSON.parse(raw);
            if (rewrite(json, this.__perchUrl)) out = JSON.stringify(json);
          } catch {
            // not JSON; leave it alone
          }
        } else if (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer) && !(raw instanceof Blob)) {
          rewrite(raw, this.__perchUrl);
        }
        this.__perchCache[prop] = out;
        return out;
      },
    });
  }
})();
