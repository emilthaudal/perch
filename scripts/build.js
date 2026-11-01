// Builds browser-specific copies of the extension from extension/ (which Safari
// uses directly through the Xcode project).
//
//   node scripts/build.js
//
// Output:
//   dist/chrome/    unpacked, for chrome://extensions → Load unpacked
//   dist/firefox/   unpacked, for about:debugging → Load Temporary Add-on
//   dist/perch-chrome.zip, dist/perch-firefox.zip
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension');
const dist = path.join(root, 'dist');

const base = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

// The page (MAIN world) and the content script both load defaults.js. Chrome
// injects a given file only once per page, across worlds, so the content script
// lost its defaults and treated styling as off. Give the page its own copy.
const PAGE_DEFAULTS = 'src/defaults-page.js';
function separatePageDefaults(m, out) {
  fs.copyFileSync(path.join(out, 'src/defaults.js'), path.join(out, PAGE_DEFAULTS));
  const swap = (files) => files.map((f) => (f === 'src/defaults.js' ? PAGE_DEFAULTS : f));
  return {
    ...m,
    content_scripts: m.content_scripts.map((cs) => (cs.world === 'MAIN' ? { ...cs, js: swap(cs.js) } : cs)),
    web_accessible_resources: m.web_accessible_resources.map((r) => ({ ...r, resources: [...r.resources, PAGE_DEFAULTS] })),
  };
}

const targets = {
  chrome: (m) => m,
  firefox: (m) => ({
    ...m,
    browser_specific_settings: {
      gecko: {
        id: 'perch@emilthaudal.dev',
        // 128 added "world": "MAIN" content scripts; 140 is the first desktop
        // release that understands data_collection_permissions below.
        strict_min_version: '140.0',
        // Required by addons.mozilla.org for signing: Perch collects nothing.
        data_collection_permissions: { required: ['none'] },
      },
      // Firefox for Android supports data_collection_permissions from 142.
      gecko_android: { strict_min_version: '142.0' },
    },
  }),
};

// Replace only this script's own outputs: dist/signed/ holds Mozilla-signed
// .xpi files that can't be rebuilt locally.
for (const [name, adapt] of Object.entries(targets)) {
  const out = path.join(dist, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(path.join(dist, `perch-${name}.zip`), { force: true });
  fs.cpSync(src, out, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
  const manifest = adapt(separatePageDefaults(base, out));
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = path.join(dist, `perch-${name}.zip`);
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`built dist/${name}/ and dist/perch-${name}.zip`);
}
