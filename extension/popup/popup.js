(async function () {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const form = document.getElementById('settings');

  const settings = { ...globalThis.PERCH_DEFAULTS, ...(await api.storage.local.get(null)) };
  for (const [name, value] of Object.entries(settings)) {
    const el = form.elements[name];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value);
  }

  form.addEventListener('change', (event) => {
    const el = event.target;
    if (!el.name) return;
    api.storage.local.set({ [el.name]: el.type === 'checkbox' ? el.checked : el.value });
  });
})();
