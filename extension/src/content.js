// Isolated-world content script: reads settings from extension storage, hands them
// to the page script, and does the page tweaks CSS can't express on its own.
(function () {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const DEFAULTS = globalThis.PERCH_DEFAULTS;
  const root = document.documentElement;
  let settings = { ...DEFAULTS };

  // The manifest also asks for these in the MAIN world, but Safari versions that
  // ignore "world" run them here, where they can't see X's fetch. Adding them as
  // page <script> tags covers that case; inject.js exits if it is already installed.
  for (const file of ['src/defaults.js', 'src/perch-core.js', 'src/inject.js']) {
    const script = document.createElement('script');
    script.src = api.runtime.getURL(file);
    script.async = false;
    script.onload = () => script.remove();
    (document.head || root).appendChild(script);
  }

  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'perch-ready') {
      window.postMessage({ source: 'perch-settings', settings }, location.origin);
    }
  });

  function apply(stored) {
    settings = { ...DEFAULTS, ...stored };
    root.classList.toggle('perch-style', Boolean(settings.styling));
    root.classList.toggle('perch-hide-composer', Boolean(settings.hideComposer));
    window.postMessage({ source: 'perch-settings', settings }, location.origin);
    schedule();
  }


  // ---------- Following tab ----------

  // Matching by position rather than label keeps it working in every UI language.
  // X can re-select "For you" while it loads, so retry on a timer for a while,
  // then leave the tabs alone so a manual switch is respected.
  const TAB_RETRY_MS = 500;
  const TAB_GIVE_UP_MS = 10000;
  const tab = { since: 0, lastClick: 0, done: false };

  function pickFollowingTab() {
    if (location.pathname !== '/home') {
      tab.since = 0;
      tab.done = false;
      return;
    }
    if (!settings.followingTab || tab.done) return;

    const now = Date.now();
    tab.since ||= now;
    if (now - tab.since > TAB_GIVE_UP_MS) {
      tab.done = true;
      console.info('[perch] could not switch to Following; tabs found:', describeTabs());
      return;
    }

    const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
    if (tabs.length >= 2 && tabs[1].getAttribute('aria-selected') === 'true') {
      tab.done = true;
      console.info('[perch] on Following');
      return;
    }
    if (tabs.length >= 2 && now - tab.lastClick >= TAB_RETRY_MS) {
      tab.lastClick = now;
      tabs[1].click();
    }
    setTimeout(schedule, TAB_RETRY_MS);
  }

  function describeTabs() {
    return [...document.querySelectorAll('[role="tab"]')].map(
      (t) => `${t.tagName.toLowerCase()} "${t.textContent.trim()}" selected=${t.getAttribute('aria-selected')}`,
    );
  }

  // ---------- Perch icon as favicon and logo ----------

  // A data: URL (from icon-data.js) works as a favicon and in CSS without the page
  // loading anything from the extension.
  const iconDataUrl = globalThis.PERCH_ICON;

  // CSS variables live in Perch's own <style> element: X rewrites the <html>
  // element's inline style attribute, which would wipe them.
  const vars = { '--perch-logo': `url("${iconDataUrl}")`, '--perch-bg': 'Canvas' };
  const varsStyle = document.createElement('style');
  varsStyle.id = 'perch-vars';
  function writeVars() {
    varsStyle.textContent = `:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
    if (!varsStyle.isConnected) (document.head || root).appendChild(varsStyle);
  }
  writeVars();

  // X rewrites its favicon (for example to show a notification dot), so this
  // runs on every tick and puts ours back.
  function replaceFavicon() {
    if (!iconDataUrl || !document.head) return;
    // Safari can show the monochrome SVG mask-icon instead; ours is a PNG, so drop it.
    document.head.querySelectorAll('link[rel="mask-icon"]').forEach((link) => link.remove());
    const links = document.head.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]');
    for (const link of links) {
      if (link.href !== iconDataUrl) link.href = iconDataUrl;
    }
    if (links.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = iconDataUrl;
      document.head.appendChild(link);
    }
  }

  // Swap icon links the moment the parser inserts them, before Safari picks a
  // tab icon; replaceFavicon() in the tick only catches X's later rewrites.
  if (iconDataUrl) {
    const earlyIcons = new MutationObserver(() => {
      if (!settings.styling || !document.head) return;
      replaceFavicon();
      retitle();
    });
    earlyIcons.observe(root, { childList: true, subtree: true });
    window.addEventListener('load', () => earlyIcons.disconnect(), { once: true });
  }

  // "Home / X" → "Home · Perch". X rewrites the title on every navigation and
  // when the notification count changes, so the tick keeps applying this.
  function retitle() {
    const title = document.title;
    if (title.endsWith(' / X')) document.title = `${title.slice(0, -4)} · Perch`;
    else if (title === 'X') document.title = 'Perch';
  }

  // ---------- Styling helpers ----------

  let lastBackground = '';
  function syncBackground() {
    const bg = document.body && getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== lastBackground) {
      lastBackground = bg;
      vars['--perch-bg'] = bg;
      writeVars();
    }
    if (!varsStyle.isConnected) writeVars();
  }

  function hasBackdrop(el) {
    const cs = getComputedStyle(el);
    const value = cs.backdropFilter || cs.webkitBackdropFilter;
    return Boolean(value) && value !== 'none';
  }

  // The sticky bar at the top of the column (tabs, or "← Post") blurs whatever
  // scrolls under it. Where the blur lives differs per page: on the home
  // timeline it's a background layer beside the tabs (a child of the sticky
  // element), on a thread it's an ancestor of the title. Check both.
  function solidHeader() {
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (!column) return;
    const rect = column.getBoundingClientRect();
    let el = document.elementFromPoint(rect.left + rect.width / 2, 8);
    for (; el && el !== column && column.contains(el); el = el.parentElement) {
      const layers = getComputedStyle(el).position === 'sticky' ? [el, ...el.children] : [el];
      for (const layer of layers) {
        if (!layer.classList.contains('perch-solid') && hasBackdrop(layer)) layer.classList.add('perch-solid');
      }
    }
  }

  // The home timeline wraps its posts in a box capped at 600px and centered,
  // so posts sit narrower there than in a thread. Walk up from a post to the
  // column and tag any ancestor with a pixel max-width, so CSS can lift it.
  function uncapTimeline() {
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const cell = column?.querySelector('[data-testid="cellInnerDiv"]');
    for (let el = cell; el && el !== column; el = el.parentElement) {
      if (el.classList.contains('perch-full')) return;
      if (getComputedStyle(el).maxWidth.endsWith('px')) el.classList.add('perch-full');
    }
  }

  // Tag the home composer's outermost wrapper: the ancestor of its Post button
  // whose parent is the timeline container (the first one holding post cells).
  function tagComposer() {
    if (location.pathname !== '/home' || document.querySelector('.perch-composer')) return;
    const button = document.querySelector('[data-testid="primaryColumn"] [data-testid="tweetButtonInline"]');
    for (let el = button; el?.parentElement; el = el.parentElement) {
      if (el.parentElement.querySelector('[data-testid="cellInnerDiv"]')) {
        el.classList.add('perch-composer');
        return;
      }
    }
  }

  // Grok and Chat float in the bottom-right corner. Hide the outermost small
  // fixed-position element found there, unless it belongs to the column or nav.
  function hideFloatingButtons() {
    if (window.innerWidth < 700) return; // phone layout: bottom-right is the compose button
    for (const offset of [40, 110, 180]) {
      let el = document.elementFromPoint(window.innerWidth - 40, window.innerHeight - offset);
      if (!el || el.closest('[data-testid="primaryColumn"], header[role="banner"]')) continue;
      let target = null;
      for (; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).position !== 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 320 && r.height < 400) target = el;
      }
      if (target && !target.classList.contains('perch-hidden')) {
        target.classList.add('perch-hidden');
        console.info('[perch] hid floating button', target.getAttribute('data-testid') || target.getAttribute('aria-label') || '');
      }
    }
  }

  // ---------- Loop ----------

  // A short timer, not requestAnimationFrame: rAF callbacks scheduled from this
  // content script never fired in Safari, which left every tweak below dead.
  const TICK_DELAY_MS = 60;
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        tick();
        delete root.dataset.perchError;
      } catch (err) {
        // Visible from the page and Web Inspector, since the isolated world's
        // console is easy to miss.
        root.dataset.perchError = String(err);
        console.warn('[perch] tick failed', err);
      }
    }, TICK_DELAY_MS);
  }

  function tick() {
    root.classList.toggle('perch-home', location.pathname === '/home');
    pickFollowingTab();
    if (!settings.styling || !document.body) return;
    replaceFavicon();
    retitle();
    syncBackground();
    solidHeader();
    uncapTimeline();
    tagComposer();
    hideFloatingButtons();
  }

  // ---------- Start ----------

  // This runs last on purpose: apply() calls schedule(), whose `let` state is
  // declared above, and calling it earlier throws and kills the whole script.
  apply({});
  api.storage.local.get(null).then(apply);
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') api.storage.local.get(null).then(apply);
  });

  const observer = new MutationObserver(schedule);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    if (document.head) {
      // characterData catches X rewriting the <title> text in place.
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['href'],
      });
    }
    window.addEventListener('resize', schedule);
    schedule();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
